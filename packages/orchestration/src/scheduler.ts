import {
  ANALYZER_EXCHANGE_VERSION,
  IDENTITY_VERSION,
  IR_VERSION,
  type EventEnvelope,
  type InstallationConfig,
} from "@api-truth/ir";
import type { PoolClient } from "pg";

import { isConfiguredBranch, selectPullRequestScope, selectReconciliationBranches } from "./branch-selection.js";
import { canonicalOrchestrationHash, canonicalOrchestrationJson } from "./canonical.js";
import { OrchestrationError } from "./errors.js";
import { semanticOrchestrationId } from "./hashing.js";
import {
  analysisCheckpointLock,
  branchLock,
  capacityGlobalLock,
  capacityRepositoryLock,
  capacityServiceLock,
  pullRequestLock,
  reconciliationBranchLock,
  reconciliationPullRequestLock,
  type AdvisoryLockKey,
} from "./locking.js";
import { classifyProviderUpdate } from "./ordering.js";
import type { EventDisposition } from "./repository.js";

type RepositoryConfig = InstallationConfig["repositories"][number];
type ServiceConfig = RepositoryConfig["services"][number];

export type SchedulingConfiguration = Readonly<{
  fingerprint: string;
  documentSha256: string;
  document: InstallationConfig;
}>;

export type ScheduledTarget = Readonly<{
  repositoryId: string;
  serviceId: string;
  scopeKey: string;
  disposition: EventDisposition;
  safeReason?: string;
  jobId?: string;
  reconciliationId?: string;
}>;

type PreparedJob = Readonly<{
  jobId: string;
  dedupeKey: string;
  identity: Record<string, unknown>;
  event?: EventEnvelope;
  evidence: EventEnvelope["provider_evidence"];
  configuration: SchedulingConfiguration;
  input: JobInput;
}>;

type PreparedTransition = Readonly<{
  kind: "cancel" | "supersede";
  oldJobId: string;
  nextJobId?: string;
}>;

type SchedulerState = {
  jobs: Map<string, PreparedJob>;
  transitions: PreparedTransition[];
  dependencies: Array<Readonly<{ jobId: string; prerequisiteJobId: string }>>;
};

export type SchedulingPlan = Readonly<{
  targets: readonly ScheduledTarget[];
  jobs: readonly PreparedJob[];
  transitions: readonly PreparedTransition[];
  dependencies: readonly Readonly<{ jobId: string; prerequisiteJobId: string }>[];
}>;

type ConfigurationTransitionDiscovery = Readonly<{
  locks: readonly AdvisoryLockKey[];
  affectedServiceIds: readonly string[];
}>;

type TargetConfig = { repository: RepositoryConfig; service: ServiceConfig };
type AnalysisScopeRow = {
  repository_id: string;
  service_id: string;
  service_root: string;
  immutable_revision: string;
  analyzer_adapter_id: string;
  analyzer_adapter_version: string;
  exchange_version: string;
  ir_version: string;
  identity_version: string;
  config_version: string;
  config_fingerprint: string;
  current_job_id?: unknown;
};

const storedAnalysisIdentity = (row: AnalysisScopeRow): Record<string, string> => ({
  repositoryId: row.repository_id,
  serviceId: row.service_id,
  serviceRoot: row.service_root,
  immutableRevision: row.immutable_revision,
  analyzerAdapterId: row.analyzer_adapter_id,
  analyzerAdapterVersion: row.analyzer_adapter_version,
  exchangeVersion: row.exchange_version,
  irVersion: row.ir_version,
  identityVersion: row.identity_version,
  configVersion: row.config_version,
  configFingerprint: row.config_fingerprint,
});

const targetConfig = (document: InstallationConfig, serviceId: string): TargetConfig => {
  for (const repository of document.repositories) {
    const service = repository.services.find((candidate) => candidate.service_id === serviceId);
    if (service !== undefined) return { repository, service };
  }
  throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
};

const byTarget = (left: ScheduledTarget, right: ScheduledTarget): number => Buffer.compare(
  Buffer.from(`${left.repositoryId}\u0000${left.serviceId}\u0000${left.scopeKey}`, "utf8"),
  Buffer.from(`${right.repositoryId}\u0000${right.serviceId}\u0000${right.scopeKey}`, "utf8"),
);

const analysisIdentity = (configuration: SchedulingConfiguration, target: TargetConfig, revision: string): Record<string, string> => ({
  repositoryId: target.repository.repository_id,
  serviceId: target.service.service_id,
  serviceRoot: target.service.root,
  immutableRevision: revision,
  analyzerAdapterId: target.service.analyzer.adapter_id,
  analyzerAdapterVersion: target.service.analyzer.adapter_version,
  exchangeVersion: ANALYZER_EXCHANGE_VERSION,
  irVersion: IR_VERSION,
  identityVersion: IDENTITY_VERSION,
  configVersion: configuration.document.config_version,
  configFingerprint: configuration.fingerprint,
});

export const discoverSchedulingLocks = (
  tenantId: string,
  event: EventEnvelope,
  configuration: SchedulingConfiguration,
): AdvisoryLockKey[] => {
  const locks: AdvisoryLockKey[] = [];
  for (const serviceId of event.subjects.service_ids) {
    const target = targetConfig(configuration.document, serviceId);
    if (["branch.updated", "pull_request.updated", "reconciliation.requested"].includes(event.event_type)) {
      locks.push(capacityGlobalLock(tenantId));
      locks.push(capacityRepositoryLock(tenantId, target.repository.repository_id));
      locks.push(capacityServiceLock(tenantId, target.repository.repository_id, serviceId));
    }
    if (event.event_type === "branch.updated") {
      const payload = event.payload as { branch: string; new_revision: string };
      locks.push(branchLock(tenantId, target.repository.repository_id, serviceId, payload.branch));
      locks.push(reconciliationBranchLock(tenantId, target.repository.repository_id, serviceId, payload.branch));
      locks.push(analysisCheckpointLock(tenantId, target.repository.repository_id, serviceId,
        canonicalOrchestrationHash(analysisIdentity(configuration, target, payload.new_revision))));
    } else if (event.event_type === "pull_request.updated") {
      const payload = event.payload as { pull_request_id: string; base_revision: string; head_revision: string };
      locks.push(pullRequestLock(tenantId, target.repository.repository_id, serviceId, payload.pull_request_id));
      locks.push(reconciliationPullRequestLock(tenantId, target.repository.repository_id, serviceId, payload.pull_request_id));
      locks.push(analysisCheckpointLock(tenantId, target.repository.repository_id, serviceId,
        canonicalOrchestrationHash(analysisIdentity(configuration, target, payload.base_revision))));
      locks.push(analysisCheckpointLock(tenantId, target.repository.repository_id, serviceId,
        canonicalOrchestrationHash(analysisIdentity(configuration, target, payload.head_revision))));
    } else if (event.event_type === "repository.baseline_requested") {
      const revision = (event.payload as { immutable_revision: string }).immutable_revision;
      locks.push(analysisCheckpointLock(tenantId, target.repository.repository_id, serviceId,
        canonicalOrchestrationHash(analysisIdentity(configuration, target, revision))));
    } else if (event.event_type === "reconciliation.requested") {
      const environments = (event.payload as { scope: { environments: string[] } }).scope.environments;
      for (const branch of selectReconciliationBranches(target.service, environments)) {
        locks.push(branchLock(tenantId, target.repository.repository_id, serviceId, branch));
        locks.push(reconciliationBranchLock(tenantId, target.repository.repository_id, serviceId, branch));
      }
    }
  }
  return locks;
};

type JobInput = {
  kind: "baseline_analysis" | "branch_analysis" | "pr_preview_analysis" | "branch_reconciliation" | "pr_reconciliation";
  target: TargetConfig;
  branch?: string;
  pullRequestId?: string;
  baseRevision?: string;
  targetRevision?: string;
  generation: string;
};

const insertJobStateOutbox = async (
  client: PoolClient,
  tenantId: string,
  jobId: string,
  state: "queued" | "cancelled" | "superseded",
  transitionIdentity: unknown,
): Promise<void> => {
  const identity = { kind: "job.state_changed", tenantId, jobId, state, transitionIdentity };
  await client.query(
    `INSERT INTO orchestration_outbox
       (tenant_id,outbox_id,dedupe_key,message_kind,job_id,payload,state,max_attempts)
     VALUES ($1,$2,$3,'job.state_changed',$4,$5,'pending',8)
     ON CONFLICT (tenant_id,dedupe_key) DO NOTHING`,
    [tenantId, semanticOrchestrationId("outbox", identity), canonicalOrchestrationHash(identity), jobId, { jobId, state }],
  );
};

const stageJob = (
  state: SchedulerState,
  tenantId: string,
  event: EventEnvelope | undefined,
  configuration: SchedulingConfiguration,
  input: JobInput,
  evidence: EventEnvelope["provider_evidence"] = event!.provider_evidence,
): string => {
  const identity = {
    tenantId,
    kind: input.kind,
    repositoryId: input.target.repository.repository_id,
    serviceId: input.target.service.service_id,
    branch: input.branch ?? null,
    pullRequestId: input.pullRequestId ?? null,
    baseRevision: input.baseRevision ?? null,
    targetRevision: input.targetRevision ?? null,
    generation: input.generation,
    analysis: input.targetRevision === undefined ? null : analysisIdentity(configuration, input.target, input.targetRevision),
    configFingerprint: configuration.fingerprint,
  };
  const dedupeKey = canonicalOrchestrationHash(identity);
  const jobId = semanticOrchestrationId("job", identity);
  const prepared: PreparedJob = {
    jobId, dedupeKey, identity, evidence, configuration, input,
    ...(event === undefined ? {} : { event }),
  };
  const prior = state.jobs.get(jobId);
  if (prior !== undefined && canonicalOrchestrationJson(prior.identity) !== canonicalOrchestrationJson(identity)) {
    throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  }
  state.jobs.set(jobId, prepared);
  return jobId;
};

const persistJob = async (client: PoolClient, tenantId: string, prepared: PreparedJob): Promise<boolean> => {
  const { jobId, dedupeKey, identity, event, evidence, configuration, input } = prepared;
  const inserted = await client.query(
    `INSERT INTO orchestration_jobs
       (tenant_id, job_id, dedupe_key, kind, event_producer_id, event_id, repository_id, service_id,
        branch, pull_request_id, base_revision, target_revision, service_root, analyzer_adapter_id,
        analyzer_adapter_version, exchange_version, ir_version, identity_version, config_version,
        config_fingerprint, config_document_sha256, provider, provider_reference, order_kind, order_value,
        subject_generation, semantic_identity, state, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'queued',5)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [tenantId, jobId, dedupeKey, input.kind, event?.producer.producer_id ?? null, event?.event_id ?? null,
      input.target.repository.repository_id, input.target.service.service_id, input.branch ?? null,
      input.pullRequestId ?? null, input.baseRevision ?? null, input.targetRevision ?? null,
      input.target.service.root, input.target.service.analyzer.adapter_id, input.target.service.analyzer.adapter_version,
      ANALYZER_EXCHANGE_VERSION, IR_VERSION, IDENTITY_VERSION, configuration.document.config_version,
      configuration.fingerprint, configuration.documentSha256, evidence.provider, evidence.provider_reference,
      evidence.order?.kind ?? null, evidence.order?.value ?? null, input.generation, identity],
  );
  const stored = await client.query<{ job_id: unknown; semantic_identity: unknown }>(
    "SELECT job_id, semantic_identity FROM orchestration_jobs WHERE tenant_id=$1 AND dedupe_key=$2",
    [tenantId, dedupeKey],
  );
  if (stored.rows[0]?.job_id !== jobId
    || canonicalOrchestrationJson(stored.rows[0]?.semantic_identity) !== canonicalOrchestrationJson(identity)) {
    throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  }
  return inserted.rowCount === 1;
};

const stageSupersede = (state: SchedulerState, oldJobId: unknown, nextJobId: string): void => {
  if (typeof oldJobId !== "string" || oldJobId.length === 0 || oldJobId === nextJobId) return;
  state.transitions.push({ kind: "supersede", oldJobId, nextJobId });
};

const persistSupersede = async (
  client: PoolClient,
  tenantId: string,
  oldJobId: string,
  nextJobId: string,
): Promise<Readonly<{ jobId: string; state: "superseded"; identity: unknown }> | undefined> => {
  await client.query(
    `UPDATE orchestration_jobs
     SET state = CASE WHEN state = 'leased' THEN state ELSE 'superseded' END,
         cancellation_requested = true,
         superseding_job_id = $3,
         completed_at = CASE WHEN state = 'leased' THEN completed_at ELSE clock_timestamp() END,
         updated_at = clock_timestamp(), row_version = row_version + 1
     WHERE tenant_id = $1 AND job_id = $2 AND state IN ('queued', 'retry_wait', 'leased')`,
    [tenantId, oldJobId, nextJobId],
  );
  const state = await client.query<{ state: string }>(
    "SELECT state FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2",
    [tenantId, oldJobId],
  );
  if (state.rows[0]?.state === "superseded") {
    return { jobId: oldJobId, state: "superseded", identity: { supersedingJobId: nextJobId } };
  }
  return undefined;
};

const stageCancel = (state: SchedulerState, oldJobId: unknown): void => {
  if (typeof oldJobId !== "string" || oldJobId.length === 0) return;
  state.transitions.push({ kind: "cancel", oldJobId });
};

const persistCancel = async (
  client: PoolClient,
  tenantId: string,
  oldJobId: string,
): Promise<Readonly<{ jobId: string; state: "cancelled"; identity: unknown }> | undefined> => {
  await client.query(
    `UPDATE orchestration_jobs
     SET state = CASE WHEN state = 'leased' THEN state ELSE 'cancelled' END,
         cancellation_requested = CASE WHEN state = 'leased' THEN true ELSE cancellation_requested END,
         completed_at = CASE WHEN state = 'leased' THEN completed_at ELSE clock_timestamp() END,
         updated_at = clock_timestamp(), row_version = row_version + 1
     WHERE tenant_id = $1 AND job_id = $2 AND state IN ('queued', 'retry_wait', 'leased')`,
    [tenantId, oldJobId],
  );
  const state = await client.query<{ state: string }>(
    "SELECT state FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2",
    [tenantId, oldJobId],
  );
  if (state.rows[0]?.state === "cancelled") {
    return { jobId: oldJobId, state: "cancelled", identity: { reason: "subject_closed" } };
  }
  return undefined;
};

type AnalysisCheckpointRow = { attempt_generation: string; current_job_id: unknown; last_terminal_outcome: unknown };
type DeferredAnalysisCheckpoint = Readonly<{ sortKey: string; persist: () => Promise<void> }>;
type DeferredBaselineRequest = Readonly<{
  target: TargetConfig;
  revision: string;
  dependentJobId: string;
}>;
type DeferredBranchReconciliation = Readonly<{
  resultIndex: number;
  target: TargetConfig;
  branch: string;
  reference: string;
}>;

const scheduleBaseline = async (
  client: PoolClient,
  state: SchedulerState,
  tenantId: string,
  event: EventEnvelope,
  configuration: SchedulingConfiguration,
  target: TargetConfig,
  revision: string,
): Promise<{
  jobId: string;
  generation: string;
  coalesced: boolean;
  checkpoint: DeferredAnalysisCheckpoint;
}> => {
  const key = analysisIdentity(configuration, target, revision);
  const sortKey = canonicalOrchestrationJson([
    key.repositoryId, key.serviceId, key.serviceRoot, key.immutableRevision, key.analyzerAdapterId,
    key.analyzerAdapterVersion, key.exchangeVersion, key.irVersion, key.identityVersion,
    key.configVersion, key.configFingerprint,
  ]);
  const selected = await client.query<AnalysisCheckpointRow>(
    `SELECT attempt_generation::text, current_job_id, last_terminal_outcome
     FROM orchestration_analysis_checkpoints
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND service_root=$4 AND immutable_revision=$5
       AND analyzer_adapter_id=$6 AND analyzer_adapter_version=$7 AND exchange_version=$8 AND ir_version=$9
       AND identity_version=$10 AND config_version=$11 AND config_fingerprint=$12
     FOR UPDATE`,
    [tenantId, key.repositoryId, key.serviceId, key.serviceRoot, key.immutableRevision, key.analyzerAdapterId,
      key.analyzerAdapterVersion, key.exchangeVersion, key.irVersion, key.identityVersion, key.configVersion, key.configFingerprint],
  );
  const current = selected.rows[0];
  if (current !== undefined && typeof current.current_job_id === "string" && current.last_terminal_outcome === null) {
    return { jobId: current.current_job_id, generation: current.attempt_generation, coalesced: true,
      checkpoint: { sortKey, persist: async () => undefined } };
  }
  const generation = current === undefined ? "1" : (BigInt(current.attempt_generation) + 1n).toString();
  const jobId = stageJob(state, tenantId, event, configuration, {
    kind: "baseline_analysis", target, targetRevision: revision, generation,
  });
  const persistCheckpoint = async (): Promise<void> => { await client.query(
    `INSERT INTO orchestration_analysis_checkpoints
       (tenant_id, repository_id, service_id, service_root, immutable_revision, analyzer_adapter_id,
        analyzer_adapter_version, exchange_version, ir_version, identity_version, config_version,
        config_fingerprint, attempt_generation, current_job_id, last_terminal_outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL)
     ON CONFLICT (tenant_id, repository_id, service_id, service_root, immutable_revision, analyzer_adapter_id,
       analyzer_adapter_version, exchange_version, ir_version, identity_version, config_version, config_fingerprint)
     DO UPDATE SET attempt_generation=EXCLUDED.attempt_generation, current_job_id=EXCLUDED.current_job_id,
       last_terminal_outcome=NULL, updated_at=clock_timestamp()`,
    [tenantId, key.repositoryId, key.serviceId, key.serviceRoot, key.immutableRevision, key.analyzerAdapterId,
      key.analyzerAdapterVersion, key.exchangeVersion, key.irVersion, key.identityVersion, key.configVersion,
      key.configFingerprint, generation, jobId],
  ); };
  return { jobId, generation, coalesced: false, checkpoint: { sortKey, persist: persistCheckpoint } };
};

type BranchRow = {
  desired_state: string; desired_revision: unknown; provider: unknown; provider_reference: unknown;
  order_kind: unknown; order_value: unknown; checkpoint_version: string; analysis_generation: string;
  current_job_id: unknown; latest_outcome: unknown;
  current_job_state: unknown; current_job_config_fingerprint: unknown;
};

const checkpointEvidence = (row: BranchRow | PrRow): { evidence: Record<string, unknown>; relevantPayload: unknown } => ({
  evidence: {
    provider: row.provider,
    provider_reference: row.provider_reference,
    ...(typeof row.order_kind === "string" && typeof row.order_value === "string"
      ? { order: { kind: row.order_kind, value: row.order_value } } : {}),
  },
  relevantPayload: "desired_state" in row
    ? { state: row.desired_state, revision: row.desired_revision }
    : { state: row.state, base_branch: row.base_branch, base_revision: row.base_revision,
      head_branch: row.head_branch, head_revision: row.head_revision },
});

const scheduleBranch = async (
  client: PoolClient,
  state: SchedulerState,
  tenantId: string,
  event: EventEnvelope,
  configuration: SchedulingConfiguration,
  target: TargetConfig,
): Promise<Readonly<{ target: ScheduledTarget; reconciliation?: Omit<DeferredBranchReconciliation, "resultIndex"> }>> => {
  const payload = event.payload as { branch: string; new_revision: string; reference_state: string };
  const base = { repositoryId: target.repository.repository_id, serviceId: target.service.service_id, scopeKey: `branch:${payload.branch}` };
  if (!isConfiguredBranch(target.service, payload.branch)) {
    return { target: { ...base, disposition: "ignored_unconfigured_branch", safeReason: "unconfigured_branch" } };
  }
  const selected = await client.query<BranchRow>(
    `SELECT checkpoint.desired_state, checkpoint.desired_revision, checkpoint.provider, checkpoint.provider_reference,
            checkpoint.order_kind, checkpoint.order_value, checkpoint.checkpoint_version::text,
            checkpoint.analysis_generation::text, checkpoint.current_job_id, checkpoint.latest_outcome,
            job.state AS current_job_state, job.config_fingerprint AS current_job_config_fingerprint
     FROM orchestration_branch_checkpoints checkpoint
     LEFT JOIN orchestration_jobs job ON job.tenant_id=checkpoint.tenant_id AND job.job_id=checkpoint.current_job_id
     WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3 AND checkpoint.branch=$4
     FOR UPDATE OF checkpoint`,
    [tenantId, target.repository.repository_id, target.service.service_id, payload.branch],
  );
  const current = selected.rows[0];
  const desiredState = payload.reference_state === "deleted" ? "absent" : "present";
  const relevantPayload = { state: desiredState, revision: desiredState === "present" ? payload.new_revision : null };
  const classification = classifyProviderUpdate(current === undefined ? undefined : checkpointEvidence(current), {
    evidence: event.provider_evidence, relevantPayload,
  });
  if (classification === "conflict") throw new OrchestrationError("EVENT_ORDER_CONFLICT");
  if (classification === "stale") return { target: { ...base, disposition: "ignored_stale", safeReason: "stale" } };
  if (classification === "exact_replay") return { target: { ...base, disposition: "no_work", safeReason: "no_work" } };
  if (classification === "incomparable") {
    return {
      target: { ...base, disposition: "reconciliation_required", safeReason: "reconciliation_required" },
      reconciliation: { target, branch: payload.branch, reference: event.provider_evidence.provider_reference },
    };
  }
  const checkpointVersion = current === undefined ? "1" : (BigInt(current.checkpoint_version) + 1n).toString();
  const sameSemanticTarget = current !== undefined
    && current.desired_state === desiredState
    && (desiredState === "absent" || current.desired_revision === payload.new_revision)
    && (desiredState === "absent" || current.current_job_config_fingerprint === configuration.fingerprint);
  if (sameSemanticTarget) {
    await client.query(
      `UPDATE orchestration_branch_checkpoints SET provider=$5,provider_reference=$6,order_kind=$7,order_value=$8,
         checkpoint_version=$9,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [tenantId, target.repository.repository_id, target.service.service_id, payload.branch,
        event.provider_evidence.provider, event.provider_evidence.provider_reference,
        event.provider_evidence.order?.kind ?? null, event.provider_evidence.order?.value ?? null, checkpointVersion],
    );
    const nonterminal = current.current_job_state === "queued" || current.current_job_state === "leased"
      || current.current_job_state === "retry_wait";
    return { target: { ...base, disposition: nonterminal ? "scheduled" : "no_work",
      ...(nonterminal && typeof current.current_job_id === "string" ? { jobId: current.current_job_id } : {}),
      ...(nonterminal ? {} : { safeReason: "no_work" }) } };
  }
  if (desiredState === "absent") {
    stageCancel(state, current?.current_job_id);
    await client.query(
      `INSERT INTO orchestration_branch_checkpoints
         (tenant_id,repository_id,service_id,branch,desired_state,desired_revision,provider,provider_reference,
          order_kind,order_value,checkpoint_version,analysis_generation,current_job_id,latest_outcome)
       VALUES ($1,$2,$3,$4,'absent',NULL,$5,$6,$7,$8,$9,$10,NULL,'absent')
       ON CONFLICT (tenant_id,repository_id,service_id,branch) DO UPDATE SET desired_state='absent', desired_revision=NULL,
         provider=EXCLUDED.provider, provider_reference=EXCLUDED.provider_reference, order_kind=EXCLUDED.order_kind,
         order_value=EXCLUDED.order_value, checkpoint_version=EXCLUDED.checkpoint_version, current_job_id=NULL,
         latest_outcome='absent', updated_at=clock_timestamp()`,
      [tenantId, target.repository.repository_id, target.service.service_id, payload.branch,
        event.provider_evidence.provider, event.provider_evidence.provider_reference, event.provider_evidence.order?.kind ?? null,
        event.provider_evidence.order?.value ?? null, checkpointVersion, current?.analysis_generation ?? "0"],
    );
    return { target: { ...base, disposition: "scheduled" } };
  }
  const generation = current === undefined ? "1" : (BigInt(current.analysis_generation) + 1n).toString();
  const jobId = stageJob(state, tenantId, event, configuration, {
    kind: "branch_analysis", target, branch: payload.branch, targetRevision: payload.new_revision, generation,
  });
  stageSupersede(state, current?.current_job_id, jobId);
  await client.query(
    `INSERT INTO orchestration_branch_checkpoints
       (tenant_id,repository_id,service_id,branch,desired_state,desired_revision,provider,provider_reference,
        order_kind,order_value,checkpoint_version,analysis_generation,current_job_id,latest_outcome)
     VALUES ($1,$2,$3,$4,'present',$5,$6,$7,$8,$9,$10,$11,$12,'queued')
     ON CONFLICT (tenant_id,repository_id,service_id,branch) DO UPDATE SET desired_state='present', desired_revision=EXCLUDED.desired_revision,
       provider=EXCLUDED.provider, provider_reference=EXCLUDED.provider_reference, order_kind=EXCLUDED.order_kind,
       order_value=EXCLUDED.order_value, checkpoint_version=EXCLUDED.checkpoint_version,
       analysis_generation=EXCLUDED.analysis_generation, current_job_id=EXCLUDED.current_job_id,
       latest_outcome='queued', updated_at=clock_timestamp()`,
    [tenantId, target.repository.repository_id, target.service.service_id, payload.branch, payload.new_revision,
      event.provider_evidence.provider, event.provider_evidence.provider_reference, event.provider_evidence.order?.kind ?? null,
      event.provider_evidence.order?.value ?? null, checkpointVersion, generation, jobId],
  );
  return { target: { ...base, disposition: "scheduled", jobId } };
};

const scheduleBranchReconciliation = async (
  client: PoolClient,
  state: SchedulerState,
  tenantId: string,
  event: EventEnvelope,
  configuration: SchedulingConfiguration,
  target: TargetConfig,
  branch: string,
  reference: string,
): Promise<string> => {
  if (!isConfiguredBranch(target.service, branch)) throw new OrchestrationError("EVENT_SUBJECT_MISMATCH");
  const selected = await client.query<{ generation: string; current_job_id: unknown; requested_provider_snapshot_reference: string; job_state: unknown }>(
    `SELECT checkpoint.generation::text, checkpoint.current_job_id, checkpoint.requested_provider_snapshot_reference,
            job.state AS job_state
     FROM orchestration_reconciliation_checkpoints checkpoint
     LEFT JOIN orchestration_jobs job ON job.tenant_id=checkpoint.tenant_id AND job.job_id=checkpoint.current_job_id
     WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3 AND checkpoint.branch=$4
     FOR UPDATE OF checkpoint`,
    [tenantId, target.repository.repository_id, target.service.service_id, branch],
  );
  const current = selected.rows[0];
  if (current?.requested_provider_snapshot_reference === reference
    && typeof current.current_job_id === "string"
    && (current.job_state === "queued" || current.job_state === "leased" || current.job_state === "retry_wait")) {
    return current.current_job_id;
  }
  const generation = current === undefined ? "1" : (BigInt(current.generation) + 1n).toString();
  const jobId = stageJob(state, tenantId, event, configuration, {
    kind: "branch_reconciliation", target, branch, generation,
  });
  stageSupersede(state, current?.current_job_id, jobId);
  await client.query(
    `INSERT INTO orchestration_reconciliation_checkpoints
       (tenant_id,repository_id,service_id,branch,requested_provider_snapshot_reference,generation,current_job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id,repository_id,service_id,branch) DO UPDATE SET
       requested_provider_snapshot_reference=EXCLUDED.requested_provider_snapshot_reference,
       generation=EXCLUDED.generation,current_job_id=EXCLUDED.current_job_id,last_outcome=NULL,
       safe_last_error_code=NULL,updated_at=clock_timestamp()`,
    [tenantId, target.repository.repository_id, target.service.service_id, branch, reference, generation, jobId],
  );
  return jobId;
};

type PrRow = {
  state: string; base_branch: string; base_revision: string; head_branch: string; head_revision: string;
  provider: unknown; provider_reference: unknown; order_kind: unknown; order_value: unknown;
  checkpoint_version: string; analysis_generation: string; reconciliation_generation: string; current_job_id: unknown;
  current_job_kind: unknown; current_job_state: unknown;
};

const schedulePullRequest = async (
  client: PoolClient,
  schedulerState: SchedulerState,
  tenantId: string,
  event: EventEnvelope,
  configuration: SchedulingConfiguration,
  target: TargetConfig,
  deferredBaselineRequests: DeferredBaselineRequest[],
): Promise<ScheduledTarget> => {
  const payload = event.payload as { pull_request_id: string; state: string; base_branch: string; base_revision: string; head_branch: string; head_revision: string };
  const base = { repositoryId: target.repository.repository_id, serviceId: target.service.service_id, scopeKey: `pr:${payload.pull_request_id}` };
  if (selectPullRequestScope(target.service, payload.base_branch, payload.head_branch) === undefined) {
    return { ...base, disposition: "ignored_unconfigured_branch", safeReason: "unconfigured_branch" };
  }
  const selected = await client.query<PrRow>(
    `SELECT checkpoint.state,checkpoint.base_branch,checkpoint.base_revision,checkpoint.head_branch,checkpoint.head_revision,
            checkpoint.provider,checkpoint.provider_reference,checkpoint.order_kind,checkpoint.order_value,
            checkpoint.checkpoint_version::text,checkpoint.analysis_generation::text,
            checkpoint.reconciliation_generation::text,checkpoint.current_job_id,
            job.kind AS current_job_kind,job.state AS current_job_state
     FROM orchestration_pr_checkpoints checkpoint
     LEFT JOIN orchestration_jobs job ON job.tenant_id=checkpoint.tenant_id AND job.job_id=checkpoint.current_job_id
     WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3
       AND checkpoint.pull_request_id=$4 FOR UPDATE OF checkpoint`,
    [tenantId, target.repository.repository_id, target.service.service_id, payload.pull_request_id],
  );
  const current = selected.rows[0];
  const relevantPayload = { state: payload.state, base_branch: payload.base_branch, base_revision: payload.base_revision,
    head_branch: payload.head_branch, head_revision: payload.head_revision };
  const classification = classifyProviderUpdate(current === undefined ? undefined : checkpointEvidence(current), {
    evidence: event.provider_evidence, relevantPayload,
  });
  if (classification === "conflict") throw new OrchestrationError("EVENT_ORDER_CONFLICT");
  if (classification === "stale") return { ...base, disposition: "ignored_stale", safeReason: "stale" };
  if (classification === "exact_replay") return { ...base, disposition: "no_work", safeReason: "no_work" };
  if (classification === "incomparable") {
    if (current?.current_job_kind === "pr_reconciliation"
      && (current.current_job_state === "queued" || current.current_job_state === "leased"
        || current.current_job_state === "retry_wait")
      && typeof current.current_job_id === "string") {
      return { ...base, disposition: "reconciliation_required", safeReason: "reconciliation_required",
        reconciliationId: current.current_job_id };
    }
    const generation = current === undefined ? "1" : (BigInt(current.reconciliation_generation) + 1n).toString();
    const reconciliationId = stageJob(schedulerState, tenantId, event, configuration, {
      kind: "pr_reconciliation", target, pullRequestId: payload.pull_request_id,
      baseRevision: payload.base_revision, targetRevision: payload.head_revision, generation,
    });
    stageSupersede(schedulerState, current?.current_job_id, reconciliationId);
    await client.query(
      `INSERT INTO orchestration_pr_checkpoints
         (tenant_id,repository_id,service_id,pull_request_id,state,base_branch,base_revision,head_branch,head_revision,
          provider,provider_reference,order_kind,order_value,checkpoint_version,analysis_generation,reconciliation_generation,current_job_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,0,$14,$15)
       ON CONFLICT (tenant_id,repository_id,service_id,pull_request_id) DO UPDATE SET
         reconciliation_generation=EXCLUDED.reconciliation_generation,current_job_id=EXCLUDED.current_job_id,
         updated_at=clock_timestamp()`,
      [tenantId, target.repository.repository_id, target.service.service_id, payload.pull_request_id, payload.state,
        payload.base_branch, payload.base_revision, payload.head_branch, payload.head_revision,
        event.provider_evidence.provider, event.provider_evidence.provider_reference,
        event.provider_evidence.order?.kind ?? null, event.provider_evidence.order?.value ?? null,
        generation, reconciliationId],
    );
    return { ...base, disposition: "reconciliation_required", safeReason: "reconciliation_required", reconciliationId };
  }
  const terminal = payload.state === "closed" || payload.state === "merged";
  const checkpointVersion = current === undefined ? "1" : (BigInt(current.checkpoint_version) + 1n).toString();
  const generation = current === undefined ? "1" : (BigInt(current.analysis_generation) + 1n).toString();
  let jobId: string | undefined;
  if (terminal) {
    stageCancel(schedulerState, current?.current_job_id);
  } else {
    jobId = stageJob(schedulerState, tenantId, event, configuration, {
      kind: "pr_preview_analysis", target, pullRequestId: payload.pull_request_id,
      baseRevision: payload.base_revision, targetRevision: payload.head_revision, generation,
    });
    deferredBaselineRequests.push({ target, revision: payload.base_revision, dependentJobId: jobId });
    stageSupersede(schedulerState, current?.current_job_id, jobId);
    await client.query(
      `INSERT INTO orchestration_pr_checkpoints
         (tenant_id,repository_id,service_id,pull_request_id,state,base_branch,base_revision,head_branch,head_revision,
          provider,provider_reference,order_kind,order_value,checkpoint_version,analysis_generation,reconciliation_generation,current_job_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (tenant_id,repository_id,service_id,pull_request_id) DO UPDATE SET state=EXCLUDED.state,
         base_branch=EXCLUDED.base_branch,base_revision=EXCLUDED.base_revision,head_branch=EXCLUDED.head_branch,
         head_revision=EXCLUDED.head_revision,provider=EXCLUDED.provider,provider_reference=EXCLUDED.provider_reference,
         order_kind=EXCLUDED.order_kind,order_value=EXCLUDED.order_value,checkpoint_version=EXCLUDED.checkpoint_version,
         analysis_generation=EXCLUDED.analysis_generation,current_job_id=EXCLUDED.current_job_id,updated_at=clock_timestamp()`,
      [tenantId, target.repository.repository_id, target.service.service_id, payload.pull_request_id, payload.state,
        payload.base_branch, payload.base_revision, payload.head_branch, payload.head_revision,
        event.provider_evidence.provider, event.provider_evidence.provider_reference, event.provider_evidence.order?.kind ?? null,
        event.provider_evidence.order?.value ?? null, checkpointVersion, generation,
        current?.reconciliation_generation ?? "0", jobId],
    );
    return { ...base, disposition: "scheduled", jobId };
  }
  await client.query(
    `INSERT INTO orchestration_pr_checkpoints
       (tenant_id,repository_id,service_id,pull_request_id,state,base_branch,base_revision,head_branch,head_revision,
        provider,provider_reference,order_kind,order_value,checkpoint_version,analysis_generation,reconciliation_generation,current_job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (tenant_id,repository_id,service_id,pull_request_id) DO UPDATE SET state=EXCLUDED.state,
       base_branch=EXCLUDED.base_branch,base_revision=EXCLUDED.base_revision,head_branch=EXCLUDED.head_branch,
       head_revision=EXCLUDED.head_revision,provider=EXCLUDED.provider,provider_reference=EXCLUDED.provider_reference,
       order_kind=EXCLUDED.order_kind,order_value=EXCLUDED.order_value,checkpoint_version=EXCLUDED.checkpoint_version,
       analysis_generation=EXCLUDED.analysis_generation,current_job_id=EXCLUDED.current_job_id,updated_at=clock_timestamp()`,
    [tenantId, target.repository.repository_id, target.service.service_id, payload.pull_request_id, payload.state,
      payload.base_branch, payload.base_revision, payload.head_branch, payload.head_revision,
      event.provider_evidence.provider, event.provider_evidence.provider_reference, event.provider_evidence.order?.kind ?? null,
      event.provider_evidence.order?.value ?? null, checkpointVersion, generation,
      current?.reconciliation_generation ?? "0", jobId ?? null],
  );
  return { ...base, disposition: terminal ? "scheduled" : "scheduled", ...(jobId === undefined ? {} : { jobId }) };
};

export const scheduleEventTargets = async (
  client: PoolClient,
  tenantId: string,
  event: EventEnvelope,
  configuration: SchedulingConfiguration,
): Promise<SchedulingPlan> => {
  const results: ScheduledTarget[] = [];
  const schedulerState: SchedulerState = { jobs: new Map(), transitions: [], dependencies: [] };
  const deferredAnalysisCheckpoints: DeferredAnalysisCheckpoint[] = [];
  const deferredBaselineRequests: DeferredBaselineRequest[] = [];
  const deferredBranchReconciliations: DeferredBranchReconciliation[] = [];
  const serviceIds = [...event.subjects.service_ids].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"), Buffer.from(right, "utf8"),
  ));
  for (const serviceId of serviceIds) {
    const target = targetConfig(configuration.document, serviceId);
    if (event.event_type === "deployment.changed" || event.event_type === "source_document.changed") {
      results.push({ repositoryId: target.repository.repository_id, serviceId, scopeKey: "deferred",
        disposition: "deferred_handler", safeReason: "deferred_handler" });
    } else if (event.event_type === "branch.updated") {
      const scheduled = await scheduleBranch(client, schedulerState, tenantId, event, configuration, target);
      const resultIndex = results.push(scheduled.target) - 1;
      if (scheduled.reconciliation !== undefined) {
        deferredBranchReconciliations.push({ resultIndex, ...scheduled.reconciliation });
      }
    } else if (event.event_type === "pull_request.updated") {
      results.push(await schedulePullRequest(
        client, schedulerState, tenantId, event, configuration, target, deferredBaselineRequests,
      ));
    } else if (event.event_type === "repository.baseline_requested") {
      const scheduled = await scheduleBaseline(client, schedulerState, tenantId, event, configuration, target,
        (event.payload as { immutable_revision: string }).immutable_revision);
      deferredAnalysisCheckpoints.push(scheduled.checkpoint);
      results.push({ repositoryId: target.repository.repository_id, serviceId, scopeKey: "baseline",
        disposition: scheduled.coalesced ? "no_work" : "scheduled",
        ...(scheduled.coalesced ? {} : { jobId: scheduled.jobId }),
        ...(scheduled.coalesced ? { safeReason: "no_work" } : {}) });
    } else if (event.event_type === "reconciliation.requested") {
      const payload = event.payload as { scope: { environments: string[] }; provider_snapshot_reference: string };
      const branches = selectReconciliationBranches(target.service, payload.scope.environments);
      if (branches.length === 0) {
        results.push({ repositoryId: target.repository.repository_id, serviceId, scopeKey: "reconciliation",
          disposition: "ignored_unconfigured_branch", safeReason: "unconfigured_branch" });
      }
      for (const branch of [...branches].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
        const jobId = await scheduleBranchReconciliation(client, schedulerState, tenantId, event, configuration, target, branch,
          payload.provider_snapshot_reference);
        results.push({ repositoryId: target.repository.repository_id, serviceId, scopeKey: `reconciliation:${branch}`,
          disposition: "scheduled", jobId });
      }
    } else {
      results.push({ repositoryId: target.repository.repository_id, serviceId, scopeKey: "configuration", disposition: "scheduled" });
    }
  }
  for (const request of deferredBranchReconciliations.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.target.repository.repository_id}\u0000${left.target.service.service_id}\u0000${left.branch}`, "utf8"),
    Buffer.from(`${right.target.repository.repository_id}\u0000${right.target.service.service_id}\u0000${right.branch}`, "utf8"),
  ))) {
    const reconciliationId = await scheduleBranchReconciliation(
      client, schedulerState, tenantId, event, configuration, request.target, request.branch, request.reference,
    );
    results[request.resultIndex] = { ...results[request.resultIndex]!, reconciliationId };
  }
  for (const request of deferredBaselineRequests.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.target.repository.repository_id}\u0000${left.target.service.service_id}\u0000${left.revision}`, "utf8"),
    Buffer.from(`${right.target.repository.repository_id}\u0000${right.target.service.service_id}\u0000${right.revision}`, "utf8"),
  ))) {
    const prerequisite = await scheduleBaseline(
      client, schedulerState, tenantId, event, configuration, request.target, request.revision,
    );
    deferredAnalysisCheckpoints.push(prerequisite.checkpoint);
    schedulerState.dependencies.push({ jobId: request.dependentJobId, prerequisiteJobId: prerequisite.jobId });
  }
  for (const checkpoint of deferredAnalysisCheckpoints.sort((left, right) => Buffer.compare(
    Buffer.from(left.sortKey, "utf8"), Buffer.from(right.sortKey, "utf8"),
  ))) {
    await checkpoint.persist();
  }
  return Object.freeze({
    targets: Object.freeze(results.sort(byTarget)),
    jobs: Object.freeze([...schedulerState.jobs.values()].sort((left, right) => Buffer.compare(
      Buffer.from(left.jobId, "utf8"), Buffer.from(right.jobId, "utf8"),
    ))),
    transitions: Object.freeze([...schedulerState.transitions]),
    dependencies: Object.freeze([...schedulerState.dependencies]),
  });
};

export const persistScheduledJobs = async (
  client: PoolClient,
  tenantId: string,
  plan: SchedulingPlan,
): Promise<void> => {
  const inserted: PreparedJob[] = [];
  const transitioned: Array<Readonly<{ jobId: string; state: "cancelled" | "superseded"; identity: unknown }>> = [];
  for (const job of plan.jobs) {
    if (await persistJob(client, tenantId, job)) inserted.push(job);
  }
  for (const transition of [...plan.transitions].sort((left, right) => Buffer.compare(
    Buffer.from(left.oldJobId, "utf8"), Buffer.from(right.oldJobId, "utf8"),
  ))) {
    let result;
    if (transition.kind === "supersede") {
      result = await persistSupersede(client, tenantId, transition.oldJobId, transition.nextJobId!);
    } else {
      result = await persistCancel(client, tenantId, transition.oldJobId);
    }
    if (result !== undefined) transitioned.push(result);
  }
  for (const dependency of [...plan.dependencies].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.jobId}\u0000${left.prerequisiteJobId}`, "utf8"),
    Buffer.from(`${right.jobId}\u0000${right.prerequisiteJobId}`, "utf8"),
  ))) {
    await client.query(
      `INSERT INTO orchestration_job_dependencies (tenant_id,job_id,prerequisite_job_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tenantId, dependency.jobId, dependency.prerequisiteJobId],
    );
  }
  for (const job of inserted) {
    await insertJobStateOutbox(client, tenantId, job.jobId, "queued", job.identity);
  }
  for (const transition of transitioned) {
    await insertJobStateOutbox(client, tenantId, transition.jobId, transition.state, transition.identity);
  }
};

const serviceTargets = (document: InstallationConfig): Map<string, TargetConfig> => new Map(
  document.repositories.flatMap((repository) => repository.services.map((service) => [
    service.service_id,
    { repository, service },
  ] as const)),
);

export const discoverConfigurationTransitionLocks = async (
  client: PoolClient,
  tenantId: string,
  current: SchedulingConfiguration,
  next: SchedulingConfiguration,
  affectedServiceIds: readonly string[],
): Promise<ConfigurationTransitionDiscovery> => {
  const oldTargets = serviceTargets(current.document);
  const newTargets = serviceTargets(next.document);
  const locks: AdvisoryLockKey[] = [];
  for (const serviceId of affectedServiceIds) {
    const targets = [oldTargets.get(serviceId), newTargets.get(serviceId)].filter(
      (target): target is TargetConfig => target !== undefined,
    );
    if (targets.length === 0) throw new OrchestrationError("CONFIGURATION_CONFLICT");
    locks.push(capacityGlobalLock(tenantId));
    for (const target of targets) {
      locks.push(capacityRepositoryLock(tenantId, target.repository.repository_id));
      locks.push(capacityServiceLock(tenantId, target.repository.repository_id, serviceId));
    }
    const nextTarget = newTargets.get(serviceId);
    for (const branch of nextTarget?.service.intended_branches ?? []) {
      locks.push(branchLock(tenantId, nextTarget!.repository.repository_id, serviceId, branch));
      locks.push(reconciliationBranchLock(tenantId, nextTarget!.repository.repository_id, serviceId, branch));
    }
  }
  if (affectedServiceIds.length > 0) {
    const branches = await client.query<{ repository_id: string; service_id: string; branch: string }>(
      `SELECT repository_id,service_id,branch FROM orchestration_branch_checkpoints
       WHERE tenant_id=$1 AND service_id=ANY($2::text[])`, [tenantId, affectedServiceIds],
    );
    for (const row of branches.rows) {
      locks.push(capacityGlobalLock(tenantId));
      locks.push(capacityRepositoryLock(tenantId, row.repository_id));
      locks.push(capacityServiceLock(tenantId, row.repository_id, row.service_id));
      locks.push(branchLock(tenantId, row.repository_id, row.service_id, row.branch));
    }
    const prs = await client.query<{ repository_id: string; service_id: string; pull_request_id: string }>(
      `SELECT repository_id,service_id,pull_request_id FROM orchestration_pr_checkpoints
       WHERE tenant_id=$1 AND service_id=ANY($2::text[])`, [tenantId, affectedServiceIds],
    );
    for (const row of prs.rows) {
      locks.push(capacityGlobalLock(tenantId));
      locks.push(capacityRepositoryLock(tenantId, row.repository_id));
      locks.push(capacityServiceLock(tenantId, row.repository_id, row.service_id));
      locks.push(pullRequestLock(tenantId, row.repository_id, row.service_id, row.pull_request_id));
    }
    const reconciliations = await client.query<{ repository_id: string; service_id: string; branch: string }>(
      `SELECT repository_id,service_id,branch FROM orchestration_reconciliation_checkpoints
       WHERE tenant_id=$1 AND service_id=ANY($2::text[])`, [tenantId, affectedServiceIds],
    );
    for (const row of reconciliations.rows) {
      locks.push(capacityGlobalLock(tenantId));
      locks.push(capacityRepositoryLock(tenantId, row.repository_id));
      locks.push(capacityServiceLock(tenantId, row.repository_id, row.service_id));
      locks.push(branchLock(tenantId, row.repository_id, row.service_id, row.branch));
      locks.push(reconciliationBranchLock(tenantId, row.repository_id, row.service_id, row.branch));
    }
    const analyses = await client.query<AnalysisScopeRow>(
      `SELECT repository_id,service_id,service_root,immutable_revision,analyzer_adapter_id,analyzer_adapter_version,
              exchange_version,ir_version,identity_version,config_version,config_fingerprint
       FROM orchestration_analysis_checkpoints
       WHERE tenant_id=$1 AND service_id=ANY($2::text[])`, [tenantId, affectedServiceIds],
    );
    for (const row of analyses.rows) {
      locks.push(capacityGlobalLock(tenantId));
      locks.push(capacityRepositoryLock(tenantId, row.repository_id));
      locks.push(capacityServiceLock(tenantId, row.repository_id, row.service_id));
      locks.push(analysisCheckpointLock(
        tenantId, row.repository_id, row.service_id, canonicalOrchestrationHash(storedAnalysisIdentity(row)),
      ));
    }
  }
  return { locks, affectedServiceIds };
};

export const scheduleConfigurationTransition = async (
  client: PoolClient,
  tenantId: string,
  current: SchedulingConfiguration,
  next: SchedulingConfiguration,
  affectedServiceIds: readonly string[],
  evidence: EventEnvelope["provider_evidence"],
  event?: EventEnvelope,
): Promise<SchedulingPlan> => {
  const schedulerState: SchedulerState = { jobs: new Map(), transitions: [], dependencies: [] };
  const newTargets = serviceTargets(next.document);
  if (affectedServiceIds.length === 0) {
    return { targets: [], jobs: [], transitions: [], dependencies: [] };
  }
  const branchRows = await client.query<{ repository_id: string; service_id: string; branch: string; current_job_id: unknown }>(
    `SELECT repository_id,service_id,branch,current_job_id FROM orchestration_branch_checkpoints
     WHERE tenant_id=$1 AND service_id=ANY($2::text[])
     ORDER BY repository_id COLLATE "C",service_id COLLATE "C",branch COLLATE "C" FOR UPDATE`,
    [tenantId, affectedServiceIds],
  );
  const prRows = await client.query<{ repository_id: string; service_id: string; pull_request_id: string; current_job_id: unknown }>(
    `SELECT repository_id,service_id,pull_request_id,current_job_id FROM orchestration_pr_checkpoints
     WHERE tenant_id=$1 AND service_id=ANY($2::text[])
     ORDER BY repository_id COLLATE "C",service_id COLLATE "C",pull_request_id COLLATE "C" FOR UPDATE`,
    [tenantId, affectedServiceIds],
  );
  const reconciliationRows = await client.query<{
    repository_id: string; service_id: string; branch: string; generation: string; current_job_id: unknown;
  }>(
    `SELECT repository_id,service_id,branch,generation::text,current_job_id
     FROM orchestration_reconciliation_checkpoints
     WHERE tenant_id=$1 AND service_id=ANY($2::text[])
     ORDER BY repository_id COLLATE "C",service_id COLLATE "C",branch COLLATE "C" FOR UPDATE`,
    [tenantId, affectedServiceIds],
  );
  for (const row of branchRows.rows) {
    stageCancel(schedulerState, row.current_job_id);
    await client.query(
      `UPDATE orchestration_branch_checkpoints SET current_job_id=NULL,latest_outcome='cancelled',updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [tenantId, row.repository_id, row.service_id, row.branch],
    );
  }
  for (const row of prRows.rows) {
    stageCancel(schedulerState, row.current_job_id);
    await client.query(
      `UPDATE orchestration_pr_checkpoints SET current_job_id=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND pull_request_id=$4`,
      [tenantId, row.repository_id, row.service_id, row.pull_request_id],
    );
  }
  const reconciliationByScope = new Map(reconciliationRows.rows.map((row) => [
    `${row.repository_id}\u0000${row.service_id}\u0000${row.branch}`, row,
  ]));
  const desiredReconciliations = new Map<string, Readonly<{ target: TargetConfig; serviceId: string; branch: string }>>();
  for (const serviceId of [...affectedServiceIds].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const target = newTargets.get(serviceId);
    if (target === undefined) continue;
    for (const branch of [...target.service.intended_branches].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      const key = `${target.repository.repository_id}\u0000${serviceId}\u0000${branch}`;
      desiredReconciliations.set(key, { target, serviceId, branch });
    }
  }
  const reconciliationKeys = [...new Set([
    ...reconciliationByScope.keys(), ...desiredReconciliations.keys(),
  ])].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const key of reconciliationKeys) {
    const desired = desiredReconciliations.get(key);
    const prior = reconciliationByScope.get(key);
    if (desired !== undefined) {
      const generation = prior === undefined ? "1" : (BigInt(prior.generation) + 1n).toString();
      const jobId = stageJob(schedulerState, tenantId, event, next, {
        kind: "branch_reconciliation", target: desired.target, branch: desired.branch, generation,
      }, evidence);
      stageSupersede(schedulerState, prior?.current_job_id, jobId);
      await client.query(
        `INSERT INTO orchestration_reconciliation_checkpoints
           (tenant_id,repository_id,service_id,branch,requested_provider_snapshot_reference,generation,current_job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,repository_id,service_id,branch) DO UPDATE SET
           requested_provider_snapshot_reference=EXCLUDED.requested_provider_snapshot_reference,
           generation=EXCLUDED.generation,current_job_id=EXCLUDED.current_job_id,last_outcome=NULL,
           safe_last_error_code=NULL,updated_at=clock_timestamp()`,
        [tenantId, desired.target.repository.repository_id, desired.serviceId, desired.branch,
          evidence.provider_reference, generation, jobId],
      );
      continue;
    }
    stageCancel(schedulerState, prior!.current_job_id);
    await client.query(
      `UPDATE orchestration_reconciliation_checkpoints SET current_job_id=NULL,last_outcome='obsolete',updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [tenantId, prior!.repository_id, prior!.service_id, prior!.branch],
    );
  }
  const analysisRows = await client.query<AnalysisScopeRow & { current_job_id: unknown; current_job_state: unknown }>(
    `SELECT checkpoint.repository_id,checkpoint.service_id,checkpoint.service_root,checkpoint.immutable_revision,
            checkpoint.analyzer_adapter_id,checkpoint.analyzer_adapter_version,checkpoint.exchange_version,
            checkpoint.ir_version,checkpoint.identity_version,checkpoint.config_version,checkpoint.config_fingerprint,
            checkpoint.current_job_id,job.state AS current_job_state
     FROM orchestration_analysis_checkpoints checkpoint
     LEFT JOIN orchestration_jobs job ON job.tenant_id=checkpoint.tenant_id AND job.job_id=checkpoint.current_job_id
     WHERE checkpoint.tenant_id=$1 AND checkpoint.service_id=ANY($2::text[])
     ORDER BY checkpoint.repository_id COLLATE "C",checkpoint.service_id COLLATE "C",checkpoint.service_root COLLATE "C",
       checkpoint.immutable_revision COLLATE "C",checkpoint.analyzer_adapter_id COLLATE "C",
       checkpoint.analyzer_adapter_version COLLATE "C",checkpoint.exchange_version COLLATE "C",
       checkpoint.ir_version COLLATE "C",checkpoint.identity_version COLLATE "C",checkpoint.config_version COLLATE "C",
       checkpoint.config_fingerprint COLLATE "C"
     FOR UPDATE OF checkpoint`,
    [tenantId, affectedServiceIds],
  );
  for (const row of analysisRows.rows) {
    if (row.current_job_state !== "queued" && row.current_job_state !== "retry_wait" && row.current_job_state !== "leased") continue;
    stageCancel(schedulerState, row.current_job_id);
    await client.query(
      `UPDATE orchestration_analysis_checkpoints
       SET current_job_id=NULL,last_terminal_outcome='cancelled',updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND service_root=$4 AND immutable_revision=$5
         AND analyzer_adapter_id=$6 AND analyzer_adapter_version=$7 AND exchange_version=$8 AND ir_version=$9
         AND identity_version=$10 AND config_version=$11 AND config_fingerprint=$12`,
      [tenantId, row.repository_id, row.service_id, row.service_root, row.immutable_revision,
        row.analyzer_adapter_id, row.analyzer_adapter_version, row.exchange_version, row.ir_version,
        row.identity_version, row.config_version, row.config_fingerprint],
    );
  }
  return Object.freeze({
    targets: Object.freeze([]),
    jobs: Object.freeze([...schedulerState.jobs.values()].sort((left, right) => Buffer.compare(Buffer.from(left.jobId), Buffer.from(right.jobId)))),
    transitions: Object.freeze([...schedulerState.transitions]),
    dependencies: Object.freeze([]),
  });
};
