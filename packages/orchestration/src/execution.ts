import type { Pool, PoolClient } from "pg";
import {
  CatalogError, createCatalogOrchestrationReader, createCatalogTransactionStore, contractSnapshotFromAnalyzerResult,
  type StoredSnapshot,
} from "@api-truth/catalog";
import {
  parseAnalyzerRequest, parseAnalyzerResult, parseConfig, parseContractSnapshot,
  type AnalyzerRequest, type AnalyzerResult, type InstallationConfig,
} from "@api-truth/ir";
import { executeUpdate, planUpdate, parseUpdatePlan, type UpdateExecutionResult } from "@api-truth/updates";

import { canonicalOrchestrationHash, canonicalOrchestrationJson, detachedFrozen } from "./canonical.js";
import { withOrchestrationTransaction } from "./database.js";
import { OrchestrationError } from "./errors.js";
import {
  emitOrchestrationObservation, orchestrationObserver, type OrchestrationObserver,
} from "./observer.js";
import { semanticOrchestrationId } from "./hashing.js";
import { acquireAdvisoryLocks, catalogBranchLock } from "./locking.js";
import { isMonotoneProviderConfirmation } from "./ordering.js";
import { transitionAdvisoryLocks, type JobLease, type JobOutcome } from "./worker.js";
import type { WorkerIdentity } from "./schemas.js";

type Job = {
  tenant_id: string; job_id: string; kind: string; repository_id: string; service_id: string;
  branch: string | null; pull_request_id: string | null; target_revision: string | null;
  base_revision: string | null;
  config_fingerprint: string; config_document_sha256: string; config_version: string;
  service_root: string; analyzer_adapter_id: string; analyzer_adapter_version: string;
  exchange_version: string; ir_version: string; identity_version: string;
  semantic_identity: unknown; subject_generation: string; provider: string | null;
  provider_reference: string | null; order_kind: "sequence" | "cursor" | "effective_version" | null;
  order_value: string | null; state: string; attempt_count: string; max_attempts: string;
  available_at: Date; created_at: Date; lease_worker_id: string | null; lease_instance_id: string | null;
  lease_token: string | null; lease_expires_at: Date | null; cancellation_requested: boolean;
  superseding_job_id: string | null;
};
type BranchCheckpoint = {
  current_job_id: string | null; analysis_generation: string; desired_state: string;
  desired_revision: string | null; provider: string; provider_reference: string;
  order_kind: "sequence" | "cursor" | "effective_version" | null; order_value: string | null;
  last_successful_selected_revision: string | null; last_successful_snapshot_id: string | null;
  last_successful_association_key: string | null;
};
type AnalysisCheckpoint = { current_job_id: string | null; attempt_generation: string };
type PullRequestCheckpoint = { current_job_id: string | null; analysis_generation: string;
  state: string; base_branch: string | null; base_revision: string | null; head_revision: string | null };
type Configuration = { document: unknown; document_sha256: string; config_version: string };
type Prepared = {
  job: Job; configuration: InstallationConfig; repository: InstallationConfig["repositories"][number];
  service: InstallationConfig["repositories"][number]["services"][number];
};
type Materialized = {
  request: AnalyzerRequest; result?: AnalyzerResult; snapshot: StoredSnapshot["snapshot"];
  analyzerStatus: "success" | "partial"; associationKind: "analyzed" | "reused";
  update?: UpdateExecutionResult;
  baseSelection?: { selectedRevision: string; snapshotId: string; pointerVersion?: string;
    associationKey: string };
};

export type AnalysisWorkerPorts = Readonly<{
  resolver: { resolve(input: { tenantId: string; repository: Prepared["repository"];
    service: Prepared["service"]; immutableRevision: string; baseRevision?: string;
    configFingerprint: string }): Promise<{ request: AnalyzerRequest; changedPaths: string[];
      changedPathsComplete: boolean }> };
  analyzer: { analyze(request: AnalyzerRequest): Promise<AnalyzerResult> };
}>;

function fail(code: "JOB_EXECUTION_FAILED" | "JOB_LEASE_CONFLICT" | "JOB_CANCELLED" | "JOB_SUPERSEDED"
  | "PROMOTION_INELIGIBLE" | "REVISION_ASSOCIATION_CONFLICT"): never { throw new OrchestrationError(code); }
const equal = (left: unknown, right: unknown): boolean => canonicalOrchestrationJson(left) === canonicalOrchestrationJson(right);
const digest = /^sha256:[a-f0-9]{64}$/;

const validateLease = async (client: PoolClient, job: Job | undefined, worker: WorkerIdentity, lease: JobLease): Promise<Job> => {
  if (job === undefined || job.state !== "leased" || job.lease_worker_id !== worker.workerId
    || job.lease_instance_id !== worker.instanceId || job.lease_token !== lease.leaseToken
    || job.lease_expires_at === null) fail("JOB_LEASE_CONFLICT");
  const live = await client.query<{ live: boolean }>(
    `SELECT lease_expires_at>clock_timestamp() AS live FROM orchestration_jobs
     WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
  );
  if (live.rows[0]?.live !== true) fail("JOB_LEASE_CONFLICT");
  if (job.superseding_job_id !== null) fail("JOB_SUPERSEDED");
  if (job.cancellation_requested) fail("JOB_CANCELLED");
  return job;
};

const readPrepared = async (client: PoolClient, worker: WorkerIdentity, lease: JobLease): Promise<Prepared> => {
  const selected = await client.query<Job>(
    `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
  );
  const job = await validateLease(client, selected.rows[0], worker, lease);
  if (job.kind !== "baseline_analysis" && job.kind !== "branch_analysis"
    && job.kind !== "pr_preview_analysis") fail("JOB_EXECUTION_FAILED");
  const stored = await client.query<Configuration>(
    `SELECT document,document_sha256,config_version FROM orchestration_configurations
     WHERE tenant_id=$1 AND config_fingerprint=$2`, [job.tenant_id, job.config_fingerprint],
  );
  const row = stored.rows[0];
  if (row === undefined || row.document_sha256 !== job.config_document_sha256
    || row.config_version !== job.config_version) fail("JOB_EXECUTION_FAILED");
  const parsed = parseConfig(row.document);
  if (!parsed.ok) fail("JOB_EXECUTION_FAILED");
  const repository = parsed.value.repositories.find((candidate) => candidate.repository_id === job.repository_id);
  const service = repository?.services.find((candidate) => candidate.service_id === job.service_id);
  if (repository === undefined || service === undefined || service.root !== job.service_root
    || service.analyzer.adapter_id !== job.analyzer_adapter_id
    || service.analyzer.adapter_version !== job.analyzer_adapter_version
    || job.target_revision === null || job.kind === "pr_preview_analysis" && job.base_revision === null) {
    fail("JOB_EXECUTION_FAILED");
  }
  return { job, configuration: parsed.value, repository, service };
};

const confirmLive = async (pool: Pool, options: { schema: string }, worker: WorkerIdentity,
  lease: JobLease): Promise<void> => {
  await withOrchestrationTransaction(pool, options, async (client) => {
    const selected = await client.query<Job>(
      `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
    );
    await validateLease(client, selected.rows[0], worker, lease);
  });
};

const validatedPorts = (input: unknown): AnalysisWorkerPorts => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) fail("JOB_EXECUTION_FAILED");
    const ports = input as AnalysisWorkerPorts;
    if (typeof ports.resolver?.resolve !== "function" || typeof ports.analyzer?.analyze !== "function") fail("JOB_EXECUTION_FAILED");
    return ports;
  } catch { fail("JOB_EXECUTION_FAILED"); }
};

const resolveRequest = async (prepared: Prepared, ports: AnalysisWorkerPorts,
  baseRevision?: string): Promise<{
  request: AnalyzerRequest; changedPaths: string[]; changedPathsComplete: boolean;
}> => {
  const { job, repository, service } = prepared;
  let raw: Awaited<ReturnType<AnalysisWorkerPorts["resolver"]["resolve"]>>;
  try {
    raw = await ports.resolver.resolve(detachedFrozen({ tenantId: job.tenant_id, repository, service,
      immutableRevision: job.target_revision!, ...(baseRevision === undefined ? {} : { baseRevision }),
      configFingerprint: job.config_fingerprint }));
  } catch { fail("JOB_EXECUTION_FAILED"); }
  try {
    const parsed = parseAnalyzerRequest(raw?.request);
    if (!parsed.ok) fail("JOB_EXECUTION_FAILED");
    const request = parsed.value;
    if (request.exchange_version !== job.exchange_version || request.ir_version !== job.ir_version
      || request.analyzer.analyzer_id !== job.analyzer_adapter_id
      || request.analyzer.analyzer_version !== job.analyzer_adapter_version
      || request.source.repository_id !== job.repository_id || request.source.service_id !== job.service_id
      || request.source.service_root !== job.service_root || request.source.immutable_revision !== job.target_revision
      || request.source.access_label !== repository.access_scope_id || !digest.test(request.source.source_digest)
      || request.resolution_inputs.length === 0
      || !request.resolution_inputs.some((input) => input.kind === "source_tree"
        && input.path === job.service_root && input.digest === request.source.source_digest)
      || request.execution_policy.network_access !== false || request.execution_policy.side_effects !== "none"
      || !Array.isArray(raw.changedPaths) || typeof raw.changedPathsComplete !== "boolean") fail("JOB_EXECUTION_FAILED");
    const paths = [...raw.changedPaths];
    if (paths.some((path) => typeof path !== "string" || !(job.service_root === "."
      || path === job.service_root || path.startsWith(`${job.service_root}/`)))
      || !equal(paths, [...new Set(paths)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
      || !raw.changedPathsComplete && paths.length !== 0
      || !equal(request.changed_paths, paths)) fail("JOB_EXECUTION_FAILED");
    return { request, changedPaths: paths, changedPathsComplete: raw.changedPathsComplete };
  } catch { fail("JOB_EXECUTION_FAILED"); }
};

const analyzeBaseline = async (request: AnalyzerRequest, ports: AnalysisWorkerPorts,
  configFingerprint: string): Promise<Materialized> => {
  if (request.extraction_mode !== "baseline") fail("JOB_EXECUTION_FAILED");
  let raw: unknown;
  try { raw = await ports.analyzer.analyze(detachedFrozen(request)); } catch { fail("JOB_EXECUTION_FAILED"); }
  try {
    const parsed = parseAnalyzerResult(raw);
    if (!parsed.ok || parsed.value.status === "failed") fail("JOB_EXECUTION_FAILED");
    const result = parsed.value;
    if (result.request_id !== request.request_id || result.exchange_version !== request.exchange_version
      || result.ir_version !== request.ir_version || !equal(result.analyzer, request.analyzer)
      || !equal(result.source, request.source)) fail("JOB_EXECUTION_FAILED");
    const converted = contractSnapshotFromAnalyzerResult(result, configFingerprint);
    return { request, result, snapshot: converted.snapshot, analyzerStatus: converted.analyzerStatus,
      associationKind: "analyzed" };
  } catch { fail("JOB_EXECUTION_FAILED"); }
};

const baseForBranch = async (pool: Pool, options: { schema: string }, prepared: Prepared): Promise<{
  stored: StoredSnapshot; selectedRevision: string; exchangeVersion: string;
  pointerVersion: string; associationKey: string;
} | undefined> => {
  const { job } = prepared;
  const reader = createCatalogOrchestrationReader(pool, options);
  let branch: Awaited<ReturnType<typeof reader.readBranch>>;
  try { branch = await reader.readBranch({ tenantId: job.tenant_id, repositoryId: job.repository_id,
    serviceId: job.service_id, branch: job.branch! }); } catch { fail("JOB_EXECUTION_FAILED"); }
  if ("state" in branch) return undefined;
  const selected = await withOrchestrationTransaction(pool, options, (client) => client.query<{
    last_successful_selected_revision: string | null; last_successful_snapshot_id: string | null;
    last_successful_association_key: string | null; immutable_revision: string | null;
    snapshot_id: string | null; source_digest: string | null; service_root: string | null;
    analyzer_adapter_id: string | null; analyzer_adapter_version: string | null;
    exchange_version: string | null; ir_version: string | null; identity_version: string | null;
    config_version: string | null; config_fingerprint: string | null;
  }>(
    `SELECT checkpoint.last_successful_selected_revision,checkpoint.last_successful_snapshot_id,
       checkpoint.last_successful_association_key,association.immutable_revision,
       association.snapshot_id,association.source_digest,association.service_root,
       association.analyzer_adapter_id,association.analyzer_adapter_version,
       association.exchange_version,association.ir_version,association.identity_version,
       association.config_version,association.config_fingerprint
     FROM orchestration_branch_checkpoints checkpoint
     LEFT JOIN orchestration_revision_snapshots association ON
       association.tenant_id=checkpoint.tenant_id AND association.repository_id=checkpoint.repository_id
       AND association.service_id=checkpoint.service_id
       AND association.immutable_revision=checkpoint.last_successful_selected_revision
       AND association.snapshot_id=checkpoint.last_successful_snapshot_id
     WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3
       AND checkpoint.branch=$4`,
    [job.tenant_id, job.repository_id, job.service_id, job.branch],
  ));
  for (const row of selected.rows) {
    if (row.last_successful_selected_revision === null
      || row.last_successful_snapshot_id !== branch.pointer.snapshotId
      || row.snapshot_id !== branch.stored.snapshotId
      || row.immutable_revision !== row.last_successful_selected_revision
      || row.source_digest !== branch.stored.snapshot.source.source_digest
      || row.service_root !== branch.stored.snapshot.service.root
      || row.analyzer_adapter_id !== branch.stored.snapshot.analyzer.analyzer_id
      || row.analyzer_adapter_version !== branch.stored.snapshot.analyzer.analyzer_version
      || row.exchange_version === null || row.ir_version !== branch.stored.snapshot.ir_version
      || row.identity_version !== branch.stored.snapshot.identity_version
      || row.config_version !== branch.stored.snapshot.config.config_version
      || row.config_fingerprint !== branch.stored.snapshot.config.config_fingerprint) continue;
    const key = canonicalOrchestrationHash([job.tenant_id, job.repository_id, job.service_id,
      row.service_root, row.immutable_revision, row.source_digest, row.analyzer_adapter_id,
      row.analyzer_adapter_version, row.exchange_version, row.ir_version, row.identity_version,
      row.config_version, row.config_fingerprint]);
    if (row.last_successful_association_key === key) {
      return { stored: branch.stored, selectedRevision: row.immutable_revision,
        exchangeVersion: row.exchange_version, pointerVersion: branch.pointer.pointerVersion,
        associationKey: key };
    }
  }
  return undefined;
};

const baseForPreview = async (pool: Pool, options: { schema: string }, prepared: Prepared): Promise<{
  stored: StoredSnapshot; selectedRevision: string; exchangeVersion: string;
  associationKey: string;
}> => {
  const { job } = prepared;
  const selected = await withOrchestrationTransaction(pool, options, (client) => client.query<{
    immutable_revision: string; source_digest: string; snapshot_id: string; service_root: string;
    analyzer_adapter_id: string; analyzer_adapter_version: string; exchange_version: string;
    ir_version: string; identity_version: string; config_version: string; config_fingerprint: string;
  }>(
    `SELECT immutable_revision,source_digest,snapshot_id,service_root,analyzer_adapter_id,
            analyzer_adapter_version,exchange_version,ir_version,identity_version,config_version,
            config_fingerprint FROM orchestration_revision_snapshots
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND immutable_revision=$4
       AND service_root=$5 AND analyzer_adapter_id=$6 AND analyzer_adapter_version=$7
       AND exchange_version=$8 AND ir_version=$9 AND identity_version=$10
       AND config_version=$11 AND config_fingerprint=$12`,
    [job.tenant_id, job.repository_id, job.service_id, job.base_revision, job.service_root,
      job.analyzer_adapter_id, job.analyzer_adapter_version, job.exchange_version, job.ir_version,
      job.identity_version, job.config_version, job.config_fingerprint],
  ));
  if (selected.rows.length !== 1) fail("JOB_EXECUTION_FAILED");
  const row = selected.rows[0]!;
  let stored: StoredSnapshot;
  try {
    stored = await createCatalogOrchestrationReader(pool, options).readStoredSnapshot({
      tenantId: job.tenant_id, repositoryId: job.repository_id, serviceId: job.service_id,
      snapshotId: row.snapshot_id,
    });
  } catch { fail("JOB_EXECUTION_FAILED"); }
  if (stored.snapshotId !== row.snapshot_id || stored.snapshot.source.source_digest !== row.source_digest
    || stored.snapshot.service.root !== row.service_root
    || stored.snapshot.analyzer.analyzer_id !== row.analyzer_adapter_id
    || stored.snapshot.analyzer.analyzer_version !== row.analyzer_adapter_version
    || stored.snapshot.ir_version !== row.ir_version
    || stored.snapshot.identity_version !== row.identity_version
    || stored.snapshot.config.config_version !== row.config_version
    || stored.snapshot.config.config_fingerprint !== row.config_fingerprint) fail("JOB_EXECUTION_FAILED");
  return { stored, selectedRevision: row.immutable_revision, exchangeVersion: row.exchange_version,
    associationKey: canonicalOrchestrationHash([job.tenant_id, job.repository_id, job.service_id,
      row.service_root, row.immutable_revision, row.source_digest, row.analyzer_adapter_id,
      row.analyzer_adapter_version, row.exchange_version, row.ir_version, row.identity_version,
      row.config_version, row.config_fingerprint]) };
};

const materialize = async (prepared: Prepared,
  resolved: Awaited<ReturnType<typeof resolveRequest>>, ports: AnalysisWorkerPorts,
  baseSelection: Awaited<ReturnType<typeof baseForBranch>> | Awaited<ReturnType<typeof baseForPreview>>,
  beforeAnalyze: () => Promise<void>): Promise<Materialized> => {
  const { job } = prepared;
  const checkedPorts: AnalysisWorkerPorts = { ...ports, analyzer: { analyze: async (request) => {
    await beforeAnalyze();
    return ports.analyzer.analyze(request);
  } } };
  if (job.kind === "baseline_analysis" || baseSelection === undefined) {
    return analyzeBaseline(resolved.request, checkedPorts, job.config_fingerprint);
  }
  const base = baseSelection.stored;
  const targetKey = { analyzer: resolved.request.analyzer,
    analyzer_exchange_version: job.exchange_version, ir_version: job.ir_version,
    identity_version: job.identity_version, config_version: job.config_version,
    config_fingerprint: job.config_fingerprint };
  const baseKey = { analyzer: base.snapshot.analyzer,
    analyzer_exchange_version: baseSelection.exchangeVersion, ir_version: base.snapshot.ir_version,
    identity_version: base.snapshot.identity_version, config_version: base.snapshot.config.config_version,
    config_fingerprint: base.snapshot.config.config_fingerprint };
  let parsedPlan: ReturnType<typeof parseUpdatePlan>;
  try {
    const plan = planUpdate({ base_snapshot: base.snapshot, base_analysis_key: baseKey,
      target: { repository_id: job.repository_id, service_id: job.service_id, service_root: job.service_root,
        immutable_revision: job.target_revision!, source_digest: resolved.request.source.source_digest,
        analysis_key: targetKey }, changed_paths: resolved.changedPaths,
      changed_paths_complete: resolved.changedPathsComplete });
    parsedPlan = parseUpdatePlan(plan);
    if (!parsedPlan.ok) fail("JOB_EXECUTION_FAILED");
  } catch { fail("JOB_EXECUTION_FAILED"); }
  let result: UpdateExecutionResult;
  try { result = await executeUpdate({ plan: parsedPlan.value, request: resolved.request,
    base_snapshot: base.snapshot, config_fingerprint: job.config_fingerprint }, checkedPorts.analyzer); }
  catch (cause) {
    if (cause instanceof OrchestrationError && ["JOB_CANCELLED", "JOB_SUPERSEDED", "JOB_LEASE_CONFLICT"].includes(cause.code)) {
      throw cause;
    }
    throw Object.defineProperty(new OrchestrationError("JOB_EXECUTION_FAILED"), "cause",
      { value: cause, enumerable: false });
  }
  let parsedSnapshot: ReturnType<typeof parseContractSnapshot>;
  try {
    parsedSnapshot = parseContractSnapshot(result.target_snapshot);
    if (!parsedSnapshot.ok) fail("JOB_EXECUTION_FAILED");
  } catch { fail("JOB_EXECUTION_FAILED"); }
  if (result.plan.action === "reuse_base_snapshot") {
    if (result.analyzer_result !== undefined || result.target_snapshot.snapshot_id !== base.snapshotId
      || result.plan.service.target_revision !== job.target_revision
      || result.plan.service.target_source_digest !== resolved.request.source.source_digest
      || !equal(result.plan.analysis.target, targetKey)) fail("JOB_EXECUTION_FAILED");
    return { request: resolved.request, snapshot: parsedSnapshot.value, analyzerStatus: base.analyzerStatus,
      associationKind: "reused", update: result,
      baseSelection: { selectedRevision: baseSelection.selectedRevision, snapshotId: base.snapshotId,
        ...("pointerVersion" in baseSelection ? { pointerVersion: baseSelection.pointerVersion } : {}),
        associationKey: baseSelection.associationKey } };
  }
  if (result.analyzer_result === undefined) fail("JOB_EXECUTION_FAILED");
  let converted: ReturnType<typeof contractSnapshotFromAnalyzerResult>;
  try { converted = contractSnapshotFromAnalyzerResult(result.analyzer_result, job.config_fingerprint); }
  catch { fail("JOB_EXECUTION_FAILED"); }
  if (!equal(converted.snapshot, parsedSnapshot.value)) fail("JOB_EXECUTION_FAILED");
  return { request: resolved.request, result: result.analyzer_result, snapshot: converted.snapshot,
    analyzerStatus: converted.analyzerStatus, associationKind: "analyzed", update: result,
    baseSelection: { selectedRevision: baseSelection.selectedRevision, snapshotId: base.snapshotId,
      ...("pointerVersion" in baseSelection ? { pointerVersion: baseSelection.pointerVersion } : {}),
      associationKey: baseSelection.associationKey } };
};

const provider = (row: { provider: string; provider_reference: string;
  order_kind: "sequence" | "cursor" | "effective_version" | null; order_value: string | null }) => ({
  provider: row.provider, provider_reference: row.provider_reference,
  ...(row.order_kind === null || row.order_value === null ? {} : {
    order: { kind: row.order_kind, value: row.order_value },
  }),
});

type AnalysisCompletion = Readonly<{
  outcome: JobOutcome;
  snapshotOutcome: "inserted" | "existing";
  branchOutcome?: "promoted" | "existing";
}>;

const completion = async (pool: Pool, options: { schema: string }, worker: WorkerIdentity,
  lease: JobLease, material: Materialized): Promise<AnalysisCompletion> => withOrchestrationTransaction(pool, options, async (client) => {
  const discovery = await client.query<Job>(
    `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
  );
  const discovered = discovery.rows[0];
  if (discovered === undefined) fail("JOB_LEASE_CONFLICT");
  const locks = transitionAdvisoryLocks([discovered]);
  if (discovered.kind === "branch_analysis" && discovered.branch !== null) {
    locks.push(catalogBranchLock(discovered.tenant_id, discovered.repository_id,
      discovered.service_id, discovered.branch));
  }
  await acquireAdvisoryLocks(client, locks);
  const configuration = await client.query<Configuration>(
    `SELECT document,document_sha256,config_version FROM orchestration_configurations
     WHERE tenant_id=$1 AND config_fingerprint=$2 FOR SHARE`, [lease.tenantId, discovered.config_fingerprint],
  );
  const active = await client.query<{ config_fingerprint: string }>(
    `SELECT config_fingerprint FROM orchestration_active_configurations WHERE tenant_id=$1 FOR SHARE`, [lease.tenantId],
  );
  if (configuration.rows[0] === undefined || active.rows[0]?.config_fingerprint !== discovered.config_fingerprint) {
    fail("PROMOTION_INELIGIBLE");
  }
  const parsed = parseConfig(configuration.rows[0].document);
  if (!parsed.ok) fail("JOB_EXECUTION_FAILED");
  const repo = parsed.value.repositories.find((row) => row.repository_id === discovered.repository_id);
  const service = repo?.services.find((row) => row.service_id === discovered.service_id);
  if (repo === undefined || service === undefined || service.root !== discovered.service_root) fail("PROMOTION_INELIGIBLE");
  if (discovered.kind === "branch_analysis" && (discovered.branch === null
    || !service.intended_branches.includes(discovered.branch))) fail("PROMOTION_INELIGIBLE");
  if (discovered.kind === "pr_preview_analysis" && (discovered.pull_request_id === null
    || service.intended_branches.length === 0)) fail("PROMOTION_INELIGIBLE");
  let branch: BranchCheckpoint | undefined;
  let analysis: AnalysisCheckpoint | undefined;
  let pullRequest: PullRequestCheckpoint | undefined;
  if (discovered.kind === "branch_analysis") {
    const selected = await client.query<BranchCheckpoint>(
      `SELECT current_job_id,analysis_generation::text,desired_state,desired_revision,provider,provider_reference,
              order_kind,order_value,last_successful_selected_revision,last_successful_snapshot_id,
              last_successful_association_key
       FROM orchestration_branch_checkpoints WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4
       FOR UPDATE`, [lease.tenantId, discovered.repository_id, discovered.service_id, discovered.branch],
    );
    branch = selected.rows[0];
  } else if (discovered.kind === "pr_preview_analysis") {
    const selected = await client.query<PullRequestCheckpoint>(
      `SELECT current_job_id,analysis_generation::text,state,base_branch,base_revision,head_revision
       FROM orchestration_pr_checkpoints WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
         AND pull_request_id=$4 FOR UPDATE`,
      [lease.tenantId, discovered.repository_id, discovered.service_id, discovered.pull_request_id],
    );
    pullRequest = selected.rows[0];
  } else {
    const selected = await client.query<AnalysisCheckpoint>(
      `SELECT current_job_id,attempt_generation::text FROM orchestration_analysis_checkpoints
       WHERE tenant_id=$1 AND current_job_id=$2 FOR UPDATE`, [lease.tenantId, lease.jobId],
    );
    analysis = selected.rows[0];
  }
  const selected = await client.query<Job>(
    `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`, [lease.tenantId, lease.jobId],
  );
  const job = await validateLease(client, selected.rows[0], worker, lease);
  if (job.kind !== discovered.kind || job.config_fingerprint !== discovered.config_fingerprint
    || job.target_revision !== material.request.source.immutable_revision
    || job.repository_id !== material.request.source.repository_id
    || job.service_id !== material.request.source.service_id) fail("PROMOTION_INELIGIBLE");
  if (job.kind === "branch_analysis") {
    if (branch?.current_job_id !== job.job_id || branch.analysis_generation !== job.subject_generation
      || branch.desired_state !== "present" || branch.desired_revision !== job.target_revision
      || job.provider === null || job.provider_reference === null
      || !isMonotoneProviderConfirmation({ evidence: provider({ provider: job.provider,
        provider_reference: job.provider_reference, order_kind: job.order_kind, order_value: job.order_value }),
        relevantPayload: { state: "present", revision: job.target_revision } },
        { evidence: provider(branch), relevantPayload: { state: branch.desired_state,
          revision: branch.desired_revision } })) fail("PROMOTION_INELIGIBLE");
    if (material.baseSelection !== undefined && (branch.last_successful_selected_revision
      !== material.baseSelection.selectedRevision
      || branch.last_successful_snapshot_id !== material.baseSelection.snapshotId
      || branch.last_successful_association_key !== material.baseSelection.associationKey)) {
      fail("PROMOTION_INELIGIBLE");
    }
  } else if (job.kind === "pr_preview_analysis") {
    if (pullRequest?.current_job_id !== job.job_id
      || pullRequest.analysis_generation !== job.subject_generation
      || !["open", "updated"].includes(pullRequest.state)
      || !service.intended_branches.includes(pullRequest.base_branch ?? "")
      || pullRequest.base_revision !== job.base_revision || pullRequest.head_revision !== job.target_revision
      || material.baseSelection?.selectedRevision !== job.base_revision) fail("PROMOTION_INELIGIBLE");
  } else if (analysis?.current_job_id !== job.job_id || analysis.attempt_generation !== job.subject_generation) {
    fail("PROMOTION_INELIGIBLE");
  }
  const snapshot = material.snapshot;
  if (snapshot.service.repository_id !== job.repository_id || snapshot.service.service_id !== job.service_id
    || snapshot.service.root !== job.service_root || snapshot.source.source_digest !== material.request.source.source_digest
    || snapshot.analyzer.analyzer_id !== job.analyzer_adapter_id
    || snapshot.analyzer.analyzer_version !== job.analyzer_adapter_version
    || snapshot.ir_version !== job.ir_version || snapshot.identity_version !== job.identity_version
    || snapshot.config.config_version !== job.config_version
    || snapshot.config.config_fingerprint !== job.config_fingerprint
    || material.associationKind === "analyzed" && snapshot.source.immutable_revision !== job.target_revision) {
    fail("REVISION_ASSOCIATION_CONFLICT");
  }
  const association = [job.tenant_id, job.repository_id, job.service_id, job.service_root,
    job.target_revision!, material.request.source.source_digest, job.analyzer_adapter_id,
    job.analyzer_adapter_version, job.exchange_version, job.ir_version, job.identity_version,
    job.config_version, job.config_fingerprint] as const;
  const associationKey = canonicalOrchestrationHash(association);
  if (material.update !== undefined && (material.update.plan.service.target_revision !== job.target_revision
    || material.update.plan.service.target_source_digest !== material.request.source.source_digest
    || !equal(material.update.plan.analysis.target, {
      analyzer: material.request.analyzer, analyzer_exchange_version: job.exchange_version,
      ir_version: job.ir_version, identity_version: job.identity_version,
      config_version: job.config_version, config_fingerprint: job.config_fingerprint,
    }) || material.update.target_snapshot.snapshot_id !== snapshot.snapshot_id)) {
    fail("REVISION_ASSOCIATION_CONFLICT");
  }
  if (job.kind === "branch_analysis") {
    await client.query(
      `UPDATE orchestration_branch_checkpoints SET latest_outcome='succeeded',last_successful_job_id=$5,
         last_successful_snapshot_id=$6,last_successful_selected_revision=$7,last_successful_association_key=$8,
         updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [job.tenant_id, job.repository_id, job.service_id, job.branch, job.job_id,
        snapshot.snapshot_id, job.target_revision, associationKey],
    );
  } else if (job.kind === "pr_preview_analysis") {
    await client.query(
      `UPDATE orchestration_pr_checkpoints SET last_preview_result_job_id=$5,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND pull_request_id=$4`,
      [job.tenant_id, job.repository_id, job.service_id, job.pull_request_id, job.job_id],
    );
  } else {
    await client.query(
      `UPDATE orchestration_analysis_checkpoints SET last_terminal_outcome='succeeded',updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND current_job_id=$2`, [job.tenant_id, job.job_id],
    );
  }
  await client.query(
    `UPDATE orchestration_jobs SET state='succeeded',lease_worker_id=NULL,lease_instance_id=NULL,
       lease_token=NULL,lease_expires_at=NULL,result_snapshot_id=$3,completed_at=clock_timestamp(),
       updated_at=clock_timestamp(),row_version=row_version+1 WHERE tenant_id=$1 AND job_id=$2`,
    [job.tenant_id, job.job_id, snapshot.snapshot_id],
  );
  await client.query(
    `INSERT INTO orchestration_revision_snapshots
       (tenant_id,repository_id,service_id,service_root,immutable_revision,source_digest,
        analyzer_adapter_id,analyzer_adapter_version,exchange_version,ir_version,identity_version,
        config_version,config_fingerprint,snapshot_id,analyzer_status,association_kind,producing_job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING`,
    [...association, snapshot.snapshot_id, material.analyzerStatus, material.associationKind, job.job_id],
  );
  const storedAssociation = await client.query<{ snapshot_id: string; analyzer_status: string; association_kind: string }>(
    `SELECT snapshot_id,analyzer_status,association_kind FROM orchestration_revision_snapshots
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND service_root=$4 AND immutable_revision=$5
       AND source_digest=$6 AND analyzer_adapter_id=$7 AND analyzer_adapter_version=$8 AND exchange_version=$9
       AND ir_version=$10 AND identity_version=$11 AND config_version=$12 AND config_fingerprint=$13`,
    [...association],
  );
  if (storedAssociation.rows[0]?.snapshot_id !== snapshot.snapshot_id
    || storedAssociation.rows[0]?.analyzer_status !== material.analyzerStatus
    || storedAssociation.rows[0]?.association_kind !== material.associationKind) fail("REVISION_ASSOCIATION_CONFLICT");
  if (job.kind === "branch_analysis") {
    const eligibility = await client.query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM orchestration_branch_checkpoints checkpoint
         JOIN orchestration_jobs pinned ON pinned.tenant_id=checkpoint.tenant_id
           AND pinned.job_id=checkpoint.current_job_id
         JOIN orchestration_revision_snapshots target ON target.tenant_id=pinned.tenant_id
           AND target.repository_id=pinned.repository_id AND target.service_id=pinned.service_id
           AND target.service_root=pinned.service_root AND target.immutable_revision=pinned.target_revision
           AND target.source_digest=$5 AND target.analyzer_adapter_id=pinned.analyzer_adapter_id
           AND target.analyzer_adapter_version=pinned.analyzer_adapter_version
           AND target.exchange_version=pinned.exchange_version AND target.ir_version=pinned.ir_version
           AND target.identity_version=pinned.identity_version AND target.config_version=pinned.config_version
           AND target.config_fingerprint=pinned.config_fingerprint AND target.snapshot_id=$6
         WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3
           AND checkpoint.branch=$4 AND checkpoint.analysis_generation=pinned.subject_generation::bigint
           AND checkpoint.desired_state='present' AND checkpoint.desired_revision=pinned.target_revision
           AND pinned.job_id=$7 AND pinned.state='succeeded'
       ) AS eligible`,
      [job.tenant_id, job.repository_id, job.service_id, job.branch,
        material.request.source.source_digest, snapshot.snapshot_id, job.job_id],
    );
    if (eligibility.rows[0]?.eligible !== true) fail("PROMOTION_INELIGIBLE");
  }
  await client.query(
    `INSERT INTO orchestration_job_results
       (tenant_id,job_id,repository_id,service_id,scope_kind,plan_version,difference_version,
        plan_document,difference_document,target_snapshot_id,coverage_status,base_selected_revision,base_snapshot_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [job.tenant_id, job.job_id, job.repository_id, job.service_id,
      job.kind === "branch_analysis" ? "branch" : job.kind === "pr_preview_analysis" ? "pr_preview" : "baseline",
      material.update?.plan.update_plan_version ?? null,
      material.update?.differences.contract_difference_version ?? null,
      material.update?.plan ?? null, material.update?.differences ?? null,
      snapshot.snapshot_id, snapshot.coverage.status,
      material.baseSelection?.selectedRevision ?? null, material.baseSelection?.snapshotId ?? null],
  );
  const notice = { kind: "job.state_changed", tenantId: job.tenant_id, jobId: job.job_id,
    state: "succeeded" };
  await client.query(
    `INSERT INTO orchestration_outbox
       (tenant_id,outbox_id,dedupe_key,message_kind,job_id,payload,state,max_attempts)
     VALUES ($1,$2,$3,'job.state_changed',$4,$5,'pending',8) ON CONFLICT (tenant_id,dedupe_key) DO NOTHING`,
    [job.tenant_id, semanticOrchestrationId("outbox", notice), canonicalOrchestrationHash(notice),
      job.job_id, { jobId: job.job_id, state: "succeeded" }],
  );
  const catalog = createCatalogTransactionStore(client, options);
  let snapshotOutcome: "inserted" | "existing" = "existing";
  if (material.associationKind === "analyzed") {
    const ingested = await catalog.ingestAnalyzerResult({ tenantId: job.tenant_id, result: material.result!,
      configFingerprint: job.config_fingerprint });
    snapshotOutcome = ingested.outcome;
  }
  let branchOutcome: "promoted" | "existing" | undefined;
  if (job.kind === "branch_analysis") {
    const pointer = await client.query<{ pointer_version: string; snapshot_id: string }>(
      `SELECT pointer_version::text,snapshot_id FROM catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [job.tenant_id, job.repository_id, job.service_id, job.branch],
    );
    if (material.baseSelection !== undefined && (pointer.rows[0]?.snapshot_id
      !== material.baseSelection.snapshotId || pointer.rows[0]?.pointer_version
      !== material.baseSelection.pointerVersion)) fail("PROMOTION_INELIGIBLE");
    const promoted = await catalog.promoteBranch({ tenantId: job.tenant_id, repositoryId: job.repository_id,
      serviceId: job.service_id, branch: job.branch!, snapshotId: snapshot.snapshot_id,
      provider: provider(branch!), expected: pointer.rows[0] === undefined
        ? { state: "absent" } : { state: "present", pointerVersion: pointer.rows[0].pointer_version } });
    branchOutcome = promoted.outcome;
  }
  return detachedFrozen({
    outcome: { tenantId: job.tenant_id, jobId: job.job_id, state: "succeeded", attemptCount: job.attempt_count },
    snapshotOutcome, ...(branchOutcome === undefined ? {} : { branchOutcome }),
  });
});

export const executeLeasedAnalysisJob = async (pool: Pool, options: { schema: string },
  worker: WorkerIdentity, lease: JobLease, portsInput: unknown,
  observer: OrchestrationObserver = orchestrationObserver({})): Promise<JobOutcome> => {
  const ports = validatedPorts(portsInput);
  const prepared = await withOrchestrationTransaction(pool, options, (client) => readPrepared(client, worker, lease));
  await confirmLive(pool, options, worker, lease);
  const baseSelection = prepared.job.kind === "branch_analysis"
    ? await baseForBranch(pool, options, prepared)
    : prepared.job.kind === "pr_preview_analysis" ? await baseForPreview(pool, options, prepared) : undefined;
  await confirmLive(pool, options, worker, lease);
  const resolved = await resolveRequest(prepared, ports, baseSelection?.selectedRevision);
  await confirmLive(pool, options, worker, lease);
  const material = await materialize(prepared, resolved, ports, baseSelection,
    () => confirmLive(pool, options, worker, lease));
  await confirmLive(pool, options, worker, lease);
  let completed: AnalysisCompletion;
  try {
    completed = await completion(pool, options, worker, lease, material);
  } catch (error) {
    if (error instanceof CatalogError
      && (error.code === "BRANCH_POINTER_STALE" || error.code === "BRANCH_POINTER_CONFLICT")) {
      emitOrchestrationObservation(observer, { name: "catalog.branch", outcome: "conflict", count: 1 });
    }
    throw error;
  }
  emitOrchestrationObservation(observer, {
    name: "catalog.snapshot", outcome: completed.snapshotOutcome, count: 1,
  });
  if (completed.branchOutcome !== undefined) emitOrchestrationObservation(observer, {
    name: "catalog.branch", outcome: completed.branchOutcome, count: 1,
  });
  emitOrchestrationObservation(observer, { name: "outbox.lifecycle", outcome: "pending", count: 1 });
  return completed.outcome;
};
