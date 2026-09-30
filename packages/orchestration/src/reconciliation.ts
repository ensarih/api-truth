import type { Pool, PoolClient } from "pg";
import { parseConfig, parseEvent, type EventEnvelope, type InstallationConfig } from "@api-truth/ir";

import { canonicalOrchestrationHash, canonicalOrchestrationJson, detachedFrozen } from "./canonical.js";
import { withOrchestrationTransaction, withRestartingOrchestrationTransaction } from "./database.js";
import { OrchestrationError } from "./errors.js";
import {
  emitOrchestrationObservation, orchestrationObserver, type OrchestrationObserver,
} from "./observer.js";
import { semanticOrchestrationId } from "./hashing.js";
import { acquireAdvisoryLocks, requireDiscoveredLocks } from "./locking.js";
import { classifyProviderUpdate } from "./ordering.js";
import { parseProviderEvidence, type ProviderEvidence, type WorkerIdentity } from "./schemas.js";
import { discoverSchedulingLocks, persistScheduledJobs, scheduleAuthoritativeBranch,
  scheduleAuthoritativePullRequest,
  stageScheduledJobCheckpoints } from "./scheduler.js";
import { discoverTransitionClosure, transitionAdvisoryLocks, type JobLease, type JobOutcome } from "./worker.js";

type Repository = InstallationConfig["repositories"][number];
export type ReconciliationWorkerPorts = Readonly<{
  exactBranchReconciler?: { observe(input: { tenantId: string; repository: Repository; serviceId: string;
    branch: string; providerSnapshotReference?: string }): Promise<unknown> };
  exactPullRequestReconciler?: { observe(input: { tenantId: string; repository: Repository; serviceId: string;
    pullRequestId: string; configuredBaseBranch: string }): Promise<unknown> };
}>;

type Job = { tenant_id: string; job_id: string; kind: string; repository_id: string; service_id: string;
  branch: string | null; pull_request_id: string | null; config_fingerprint: string; config_document_sha256: string;
  config_version: string; service_root: string; analyzer_adapter_id: string; analyzer_adapter_version: string;
  target_revision: string | null; exchange_version: string; ir_version: string; identity_version: string;
  semantic_identity: unknown; max_attempts: string; available_at: Date; created_at: Date;
  subject_generation: string; state: string; attempt_count: string; lease_worker_id: string | null;
  lease_instance_id: string | null; lease_token: string | null; lease_expires_at: Date | null;
  cancellation_requested: boolean; superseding_job_id: string | null;
  event_producer_id: string | null; event_id: string | null };
type BranchCheckpoint = { desired_state: string; desired_revision: string | null;
  current_job_id: string | null; latest_outcome: string; last_successful_selected_revision: string | null;
  last_successful_snapshot_id: string | null; current_job_state: string | null;
  current_job_config_fingerprint: string | null; provider: string; provider_reference: string;
  order_kind: string | null; order_value: string | null };
type ReconciliationCheckpoint = { generation: string; current_job_id: string | null;
  requested_provider_snapshot_reference: string };
type PullRequestCheckpoint = { reconciliation_generation: string; current_job_id: string | null;
  state: string; base_branch: string | null; base_revision: string | null;
  head_branch: string | null; head_revision: string | null;
  provider: string | null; provider_reference: string | null; order_kind: string | null;
  order_value: string | null };

const fail = (code: "RECONCILIATION_FAILED" | "JOB_LEASE_CONFLICT" | "JOB_CANCELLED"
  | "JOB_SUPERSEDED"): never => { throw new OrchestrationError(code); };
const revision = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f]/.test(value);

const validLease = async (client: PoolClient, job: Job | undefined, worker: WorkerIdentity,
  lease: JobLease): Promise<Job> => {
  if (job === undefined) throw new OrchestrationError("JOB_LEASE_CONFLICT");
  if (job.state !== "leased" || job.lease_worker_id !== worker.workerId
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

const observedBranch = (raw: unknown, job: Job, repository: Repository): {
  state: "present" | "absent"; immutableRevision?: string; providerEvidence: ProviderEvidence;
} => {
  let value: Record<string, unknown> = {};
  try {
    const detached: unknown = JSON.parse(canonicalOrchestrationJson(raw));
    if (detached === null || typeof detached !== "object" || Array.isArray(detached)) fail("RECONCILIATION_FAILED");
    value = detached as Record<string, unknown>;
  } catch { fail("RECONCILIATION_FAILED"); }
  const keys = Object.keys(value).sort();
  const expected = (value.state === "present"
    ? ["branch", "immutableRevision", "providerEvidence", "repositoryId", "state"]
    : ["branch", "providerEvidence", "repositoryId", "state"]).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || value.repositoryId !== job.repository_id || value.branch !== job.branch
    || value.state !== "present" && value.state !== "absent"
    || value.state === "present" && !revision(value.immutableRevision)) fail("RECONCILIATION_FAILED");
  const evidence = parseProviderEvidence(value.providerEvidence);
  if (!evidence.ok) throw new OrchestrationError("RECONCILIATION_FAILED");
  if (evidence.value.provider !== repository.provider
    || evidence.value.order?.kind === "sequence"
      && !/^(0|[1-9][0-9]*)$/.test(evidence.value.order.value)) fail("RECONCILIATION_FAILED");
  return { state: value.state as "present" | "absent",
    ...(value.state === "present" ? { immutableRevision: value.immutableRevision as string } : {}),
    providerEvidence: evidence.value };
};

const observedPullRequest = (raw: unknown, job: Job, repository: Repository,
  configuredBaseBranch: string): {
  state: "open" | "closed" | "merged"; baseBranch: string; baseRevision: string;
  headBranch: string; headRevision: string; providerEvidence: ProviderEvidence;
} => {
  let value: Record<string, unknown> = {};
  try {
    const detached: unknown = JSON.parse(canonicalOrchestrationJson(raw));
    if (detached === null || typeof detached !== "object" || Array.isArray(detached)) fail("RECONCILIATION_FAILED");
    value = detached as Record<string, unknown>;
  } catch { fail("RECONCILIATION_FAILED"); }
  const expected = ["repositoryId", "serviceId", "pullRequestId", "state", "baseBranch",
    "baseRevision", "headBranch", "headRevision", "providerEvidence"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || value.repositoryId !== job.repository_id || value.serviceId !== job.service_id
    || value.pullRequestId !== job.pull_request_id || value.baseBranch !== configuredBaseBranch
    || !["open", "closed", "merged"].includes(String(value.state))
    || !revision(value.baseRevision) || !revision(value.headRevision)
    || !revision(value.headBranch)) fail("RECONCILIATION_FAILED");
  const evidence = parseProviderEvidence(value.providerEvidence);
  if (!evidence.ok) throw new OrchestrationError("RECONCILIATION_FAILED");
  if (evidence.value.provider !== repository.provider
    || evidence.value.order?.kind === "sequence"
      && !/^(0|[1-9][0-9]*)$/.test(evidence.value.order.value)) fail("RECONCILIATION_FAILED");
  return { state: value.state as "open" | "closed" | "merged", baseBranch: configuredBaseBranch,
    baseRevision: value.baseRevision as string, headBranch: value.headBranch as string,
    headRevision: value.headRevision as string, providerEvidence: evidence.value };
};

const finishReconciliation = async (client: PoolClient, worker: WorkerIdentity, lease: JobLease): Promise<JobOutcome> => {
  const lockedJob = await client.query<Job>(
    `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`, [lease.tenantId, lease.jobId],
  );
  const job = await validLease(client, lockedJob.rows[0], worker, lease);
  await client.query(
    `UPDATE orchestration_jobs SET state='succeeded',lease_worker_id=NULL,lease_instance_id=NULL,
       lease_token=NULL,lease_expires_at=NULL,completed_at=clock_timestamp(),
       updated_at=clock_timestamp(),row_version=row_version+1
     WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
  );
  const notice = { kind: "job.state_changed", tenantId: lease.tenantId, jobId: lease.jobId, state: "succeeded" };
  await client.query(
    `INSERT INTO orchestration_outbox
       (tenant_id,outbox_id,dedupe_key,message_kind,job_id,payload,state,max_attempts)
     VALUES ($1,$2,$3,'job.state_changed',$4,$5,'pending',8)
     ON CONFLICT (tenant_id,dedupe_key) DO NOTHING`,
    [lease.tenantId, semanticOrchestrationId("outbox", notice), canonicalOrchestrationHash(notice),
      lease.jobId, { jobId: lease.jobId, state: "succeeded" }],
  );
  return detachedFrozen({ tenantId: lease.tenantId, jobId: lease.jobId, state: "succeeded" as const,
    attemptCount: job.attempt_count });
};

export const executeLeasedReconciliationJob = async (pool: Pool, options: { schema: string },
  worker: WorkerIdentity, lease: JobLease, portsInput: unknown,
  observer: OrchestrationObserver = orchestrationObserver({})): Promise<JobOutcome> => {
  const kind = await withOrchestrationTransaction(pool, options, async (client) => {
    const selected = await client.query<{ kind: string }>(
      `SELECT kind FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
    );
    return selected.rows[0]?.kind;
  });
  if (kind === "pr_reconciliation") return executeLeasedPullRequestReconciliationJob(pool, options,
    worker, lease, portsInput, observer);
  const prepared = await withOrchestrationTransaction(pool, options, async (client) => {
    const selected = await client.query<Job>(
      `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
    );
    const job = await validLease(client, selected.rows[0], worker, lease);
    if (job.kind !== "branch_reconciliation" || job.branch === null) {
      throw new OrchestrationError("RECONCILIATION_FAILED");
    }
    const stored = await client.query<{ document: unknown; document_sha256: string; config_version: string }>(
      `SELECT document,document_sha256,config_version FROM orchestration_configurations
       WHERE tenant_id=$1 AND config_fingerprint=$2`, [job.tenant_id, job.config_fingerprint],
    );
    const config = stored.rows[0];
    const parsed = parseConfig(config?.document);
    if (config === undefined || !parsed.ok) throw new OrchestrationError("RECONCILIATION_FAILED");
    if (config.document_sha256 !== job.config_document_sha256
      || config.config_version !== job.config_version) fail("RECONCILIATION_FAILED");
    const repository = parsed.value.repositories.find((candidate) => candidate.repository_id === job.repository_id);
    const service = repository?.services.find((candidate) => candidate.service_id === job.service_id);
    if (repository === undefined || service === undefined || !service.intended_branches.includes(job.branch)
      || service.root !== job.service_root || service.analyzer.adapter_id !== job.analyzer_adapter_id
      || service.analyzer.adapter_version !== job.analyzer_adapter_version) {
      throw new OrchestrationError("RECONCILIATION_FAILED");
    }
    const checkpoint = await client.query<ReconciliationCheckpoint>(
      `SELECT generation::text,current_job_id,requested_provider_snapshot_reference
       FROM orchestration_reconciliation_checkpoints WHERE tenant_id=$1 AND repository_id=$2
         AND service_id=$3 AND branch=$4`, [job.tenant_id, job.repository_id, job.service_id, job.branch],
    );
    const current = checkpoint.rows[0];
    if (current === undefined || current.generation !== job.subject_generation
      || current.current_job_id !== job.job_id) throw new OrchestrationError("JOB_SUPERSEDED");
    return { job, configuration: parsed.value, repository, reference: current.requested_provider_snapshot_reference };
  });
  if (portsInput === null || typeof portsInput !== "object" || Array.isArray(portsInput)
    || typeof (portsInput as ReconciliationWorkerPorts).exactBranchReconciler?.observe !== "function") {
    fail("RECONCILIATION_FAILED");
  }
  let raw: unknown;
  try {
    raw = await (portsInput as ReconciliationWorkerPorts).exactBranchReconciler!.observe(detachedFrozen({
      tenantId: prepared.job.tenant_id, repository: prepared.repository, serviceId: prepared.job.service_id,
      branch: prepared.job.branch!, providerSnapshotReference: prepared.reference,
    }));
  } catch { fail("RECONCILIATION_FAILED"); }
  const observation = observedBranch(raw, prepared.job, prepared.repository);
  const event = await withOrchestrationTransaction(pool, options, async (client): Promise<EventEnvelope | undefined> => {
    if (prepared.job.event_producer_id === null && prepared.job.event_id === null) return undefined;
    const stored = await client.query<{ document: unknown }>(
      `SELECT document FROM orchestration_events WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`,
      [prepared.job.tenant_id, prepared.job.event_producer_id, prepared.job.event_id],
    );
    const parsed = parseEvent(stored.rows[0]?.document);
    if (!parsed.ok) throw new OrchestrationError("RECONCILIATION_FAILED");
    return parsed.value;
  });
  const subjectEvent = observation.state === "present"
    ? { ...(event ?? { subjects: { service_ids: [prepared.job.service_id] } }),
      event_type: "branch.updated" as const, payload: { branch: prepared.job.branch!,
        prior_revision: null, new_revision: observation.immutableRevision!, reference_state: "fast_forward" as const } } as EventEnvelope
    : undefined;
  const initialLocks = [...transitionAdvisoryLocks([prepared.job]),
    ...(subjectEvent === undefined ? [] : discoverSchedulingLocks(prepared.job.tenant_id, subjectEvent,
      { fingerprint: prepared.job.config_fingerprint, documentSha256: prepared.job.config_document_sha256,
        document: prepared.configuration }))];

  const completed = await withRestartingOrchestrationTransaction(pool, options, initialLocks, async (client, carriedLocks) => {
    const current = await client.query<Job>(
      `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
    );
    const job = current.rows[0];
    const prior = await client.query<{ current_job_id: string | null }>(
      `SELECT current_job_id FROM orchestration_branch_checkpoints
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [prepared.job.tenant_id, prepared.job.repository_id, prepared.job.service_id, prepared.job.branch],
    );
    const closure = await discoverTransitionClosure(client, prior.rows[0]?.current_job_id === null
      || prior.rows[0]?.current_job_id === undefined ? []
      : [{ tenant_id: prepared.job.tenant_id, job_id: prior.rows[0].current_job_id }]);
    const acquired = await acquireAdvisoryLocks(client, [...carriedLocks, ...initialLocks,
      ...transitionAdvisoryLocks(closure)]);
    await validLease(client, job, worker, lease);
    const active = await client.query<{ config_fingerprint: string }>(
      `SELECT config_fingerprint FROM orchestration_active_configurations WHERE tenant_id=$1 FOR SHARE`,
      [job!.tenant_id],
    );
    if (active.rows[0]?.config_fingerprint !== job!.config_fingerprint) fail("JOB_SUPERSEDED");
    const latest = await client.query<ReconciliationCheckpoint>(
      `SELECT generation::text,current_job_id,requested_provider_snapshot_reference
       FROM orchestration_reconciliation_checkpoints WHERE tenant_id=$1 AND repository_id=$2
         AND service_id=$3 AND branch=$4`, [job!.tenant_id, job!.repository_id, job!.service_id, job!.branch],
    );
    if (latest.rows[0]?.generation !== job!.subject_generation
      || latest.rows[0]?.current_job_id !== job!.job_id
      || latest.rows[0]?.requested_provider_snapshot_reference !== prepared.reference) fail("JOB_SUPERSEDED");
    const branch = await client.query<BranchCheckpoint>(
      `SELECT checkpoint.desired_state,checkpoint.desired_revision,checkpoint.current_job_id,
              checkpoint.latest_outcome,checkpoint.last_successful_selected_revision,
              checkpoint.last_successful_snapshot_id,checkpoint.provider,checkpoint.provider_reference,
              checkpoint.order_kind,checkpoint.order_value,job.state AS current_job_state,
              job.config_fingerprint AS current_job_config_fingerprint
       FROM orchestration_branch_checkpoints checkpoint
       LEFT JOIN orchestration_jobs job ON job.tenant_id=checkpoint.tenant_id AND job.job_id=checkpoint.current_job_id
       WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3
         AND checkpoint.branch=$4`, [job!.tenant_id, job!.repository_id, job!.service_id, job!.branch],
    );
    const requiredClosure = await discoverTransitionClosure(client, branch.rows[0]?.current_job_id === null
      || branch.rows[0]?.current_job_id === undefined ? []
      : [{ tenant_id: job!.tenant_id, job_id: branch.rows[0].current_job_id }]);
    requireDiscoveredLocks(acquired, transitionAdvisoryLocks(requiredClosure));
    const pointer = await client.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM catalog_branch_pointers WHERE tenant_id=$1 AND repository_id=$2
         AND service_id=$3 AND branch=$4`, [job!.tenant_id, job!.repository_id, job!.service_id, job!.branch],
    );
    const priorBranch = branch.rows[0];
    if (priorBranch !== undefined) {
      const classification = classifyProviderUpdate({ evidence: {
        provider: priorBranch.provider, provider_reference: priorBranch.provider_reference,
        ...(priorBranch.order_kind === null || priorBranch.order_value === null ? {} : {
          order: { kind: priorBranch.order_kind, value: priorBranch.order_value },
        }),
      }, relevantPayload: { state: priorBranch.desired_state, revision: priorBranch.desired_revision } },
      { evidence: observation.providerEvidence, relevantPayload: { state: observation.state,
        revision: observation.immutableRevision ?? null } });
      if (classification === "stale" || classification === "conflict") fail("RECONCILIATION_FAILED");
    }
    const inProgress = priorBranch?.current_job_config_fingerprint === job!.config_fingerprint
      && ["queued", "leased", "retry_wait"].includes(priorBranch.current_job_state ?? "");
    const fullyPromoted = priorBranch?.latest_outcome === "succeeded"
      && priorBranch.last_successful_selected_revision === observation.immutableRevision
      && priorBranch.last_successful_snapshot_id !== null
      && pointer.rows[0]?.snapshot_id === priorBranch.last_successful_snapshot_id;
    const sameTarget = priorBranch?.desired_state === "present"
      && priorBranch.desired_revision === observation.immutableRevision;
    const forceRepair = observation.state === "present" && !(sameTarget && (inProgress || fullyPromoted));
    const plan = await scheduleAuthoritativeBranch(client, job!.tenant_id, event,
      { fingerprint: job!.config_fingerprint, documentSha256: job!.config_document_sha256,
        document: prepared.configuration }, { repositoryId: job!.repository_id, serviceId: job!.service_id,
        branch: job!.branch!, ...(observation.immutableRevision === undefined ? {} : { revision: observation.immutableRevision }),
        evidence: observation.providerEvidence, forceRepair });
    const staged = await stageScheduledJobCheckpoints(client, job!.tenant_id, plan);
    const locked = await client.query<ReconciliationCheckpoint>(
      `SELECT generation::text,current_job_id,requested_provider_snapshot_reference
       FROM orchestration_reconciliation_checkpoints WHERE tenant_id=$1 AND repository_id=$2
         AND service_id=$3 AND branch=$4 FOR UPDATE`,
      [job!.tenant_id, job!.repository_id, job!.service_id, job!.branch],
    );
    if (locked.rows[0]?.generation !== job!.subject_generation
      || locked.rows[0]?.current_job_id !== job!.job_id) fail("JOB_SUPERSEDED");
    const outcome: "absent" | "repaired" | "no_work" = observation.state === "absent"
      ? "absent" : forceRepair ? "repaired" : "no_work";
    await client.query(
      `UPDATE orchestration_reconciliation_checkpoints SET last_outcome=$5,last_completed_reference=$6,
         safe_last_error_code=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [job!.tenant_id, job!.repository_id, job!.service_id, job!.branch, outcome, prepared.reference],
    );
    const persisted = await persistScheduledJobs(client, job!.tenant_id, plan, staged);
    return {
      outcome: await finishReconciliation(client, worker, lease), reconciliationOutcome: outcome,
      queuedKinds: persisted.queuedKinds, terminalOutcomes: persisted.terminalOutcomes,
      pendingOutboxes: persisted.outboxCount + 1,
    };
  });
  emitOrchestrationObservation(observer, {
    name: "reconciliation.lifecycle", kind: "branch", outcome: completed.reconciliationOutcome, count: 1,
  });
  for (const queuedKind of completed.queuedKinds) emitOrchestrationObservation(observer, {
    name: "job.lifecycle", kind: queuedKind, outcome: "queued", count: 1,
  });
  for (const terminal of completed.terminalOutcomes) emitOrchestrationObservation(observer, {
    name: "job.lifecycle", kind: terminal.kind, outcome: terminal.outcome, count: 1,
  });
  emitOrchestrationObservation(observer, {
    name: "outbox.lifecycle", outcome: "pending", count: completed.pendingOutboxes,
  });
  return completed.outcome;
};

const executeLeasedPullRequestReconciliationJob = async (pool: Pool, options: { schema: string },
  worker: WorkerIdentity, lease: JobLease, portsInput: unknown,
  observer: OrchestrationObserver = orchestrationObserver({})): Promise<JobOutcome> => {
  const prepared = await withOrchestrationTransaction(pool, options, async (client) => {
    const selected = await client.query<Job>(
      `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
    );
    const job = await validLease(client, selected.rows[0], worker, lease);
    if (job.kind !== "pr_reconciliation" || job.pull_request_id === null) {
      throw new OrchestrationError("RECONCILIATION_FAILED");
    }
    const configRows = await client.query<{ document: unknown; document_sha256: string; config_version: string }>(
      `SELECT document,document_sha256,config_version FROM orchestration_configurations
       WHERE tenant_id=$1 AND config_fingerprint=$2`, [job.tenant_id, job.config_fingerprint],
    );
    const config = configRows.rows[0];
    const parsed = parseConfig(config?.document);
    if (config === undefined || !parsed.ok || config.document_sha256 !== job.config_document_sha256
      || config.config_version !== job.config_version) throw new OrchestrationError("RECONCILIATION_FAILED");
    const repository = parsed.value.repositories.find((candidate) => candidate.repository_id === job.repository_id);
    const service = repository?.services.find((candidate) => candidate.service_id === job.service_id);
    const eventRows = await client.query<{ document: unknown }>(
      `SELECT document FROM orchestration_events WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`,
      [job.tenant_id, job.event_producer_id, job.event_id],
    );
    const eventParsed = parseEvent(eventRows.rows[0]?.document);
    if (!eventParsed.ok || eventParsed.value.event_type !== "pull_request.updated") {
      throw new OrchestrationError("RECONCILIATION_FAILED");
    }
    const payload = eventParsed.value.payload as Record<string, unknown>;
    const baseBranch = payload.base_branch;
    if (repository === undefined || service === undefined || typeof baseBranch !== "string"
      || !service.intended_branches.includes(baseBranch) || service.root !== job.service_root
      || service.analyzer.adapter_id !== job.analyzer_adapter_id
      || service.analyzer.adapter_version !== job.analyzer_adapter_version) {
      throw new OrchestrationError("RECONCILIATION_FAILED");
    }
    const checkpoint = await client.query<PullRequestCheckpoint>(
      `SELECT reconciliation_generation::text,current_job_id,state,base_branch,base_revision,
              head_branch,head_revision,provider,provider_reference,order_kind,order_value
       FROM orchestration_pr_checkpoints WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
         AND pull_request_id=$4`, [job.tenant_id, job.repository_id, job.service_id, job.pull_request_id],
    );
    if (checkpoint.rows[0]?.reconciliation_generation !== job.subject_generation
      || checkpoint.rows[0]?.current_job_id !== job.job_id) throw new OrchestrationError("JOB_SUPERSEDED");
    return { job, repository, configuration: parsed.value, event: eventParsed.value, baseBranch };
  });
  if (portsInput === null || typeof portsInput !== "object" || Array.isArray(portsInput)
    || typeof (portsInput as ReconciliationWorkerPorts).exactPullRequestReconciler?.observe !== "function") {
    fail("RECONCILIATION_FAILED");
  }
  let raw: unknown;
  try {
    raw = await (portsInput as ReconciliationWorkerPorts).exactPullRequestReconciler!.observe(detachedFrozen({
      tenantId: prepared.job.tenant_id, repository: prepared.repository, serviceId: prepared.job.service_id,
      pullRequestId: prepared.job.pull_request_id!, configuredBaseBranch: prepared.baseBranch,
    }));
  } catch { fail("RECONCILIATION_FAILED"); }
  const observation = observedPullRequest(raw, prepared.job, prepared.repository, prepared.baseBranch);
  const subjectEvent = { ...prepared.event, event_type: "pull_request.updated" as const,
    payload: { pull_request_id: prepared.job.pull_request_id!, state: observation.state,
      base_branch: observation.baseBranch, base_revision: observation.baseRevision,
      head_branch: observation.headBranch, head_revision: observation.headRevision } };
  const initialLocks = [...transitionAdvisoryLocks([prepared.job]),
    ...discoverSchedulingLocks(prepared.job.tenant_id, subjectEvent, {
      fingerprint: prepared.job.config_fingerprint, documentSha256: prepared.job.config_document_sha256,
      document: prepared.configuration,
    })];
  const completed = await withRestartingOrchestrationTransaction(pool, options, initialLocks, async (client, carriedLocks) => {
    await acquireAdvisoryLocks(client, [...carriedLocks, ...initialLocks]);
    const selected = await client.query<Job>(
      `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`, [lease.tenantId, lease.jobId],
    );
    const job = await validLease(client, selected.rows[0], worker, lease);
    const active = await client.query<{ config_fingerprint: string }>(
      `SELECT config_fingerprint FROM orchestration_active_configurations WHERE tenant_id=$1 FOR SHARE`,
      [job.tenant_id],
    );
    if (active.rows[0]?.config_fingerprint !== job.config_fingerprint) fail("JOB_SUPERSEDED");
    const current = await client.query<PullRequestCheckpoint>(
      `SELECT reconciliation_generation::text,current_job_id,state,base_branch,base_revision,
              head_branch,head_revision,provider,provider_reference,order_kind,order_value
       FROM orchestration_pr_checkpoints WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
         AND pull_request_id=$4`, [job.tenant_id, job.repository_id, job.service_id, job.pull_request_id],
    );
    const checkpoint = current.rows[0];
    if (checkpoint === undefined || checkpoint.reconciliation_generation !== job.subject_generation
      || checkpoint.current_job_id !== job.job_id) throw new OrchestrationError("JOB_SUPERSEDED");
    if (checkpoint.state !== "pending") {
      const classification = classifyProviderUpdate({ evidence: {
        provider: checkpoint.provider, provider_reference: checkpoint.provider_reference,
        ...(checkpoint.order_kind === null || checkpoint.order_value === null ? {} : {
          order: { kind: checkpoint.order_kind, value: checkpoint.order_value },
        }),
      }, relevantPayload: { state: checkpoint.state, base_branch: checkpoint.base_branch,
        base_revision: checkpoint.base_revision, head_branch: checkpoint.head_branch,
        head_revision: checkpoint.head_revision } }, { evidence: observation.providerEvidence,
        relevantPayload: { state: observation.state, base_branch: observation.baseBranch,
          base_revision: observation.baseRevision, head_branch: observation.headBranch,
          head_revision: observation.headRevision } });
      if (classification === "stale" || classification === "conflict"
        || observation.state === "open" && (checkpoint.state === "closed" || checkpoint.state === "merged")
          && classification !== "newer") fail("RECONCILIATION_FAILED");
    }
    const plan = await scheduleAuthoritativePullRequest(client, job.tenant_id, prepared.event,
      { fingerprint: job.config_fingerprint, documentSha256: job.config_document_sha256,
        document: prepared.configuration }, { repositoryId: job.repository_id, serviceId: job.service_id,
        pullRequestId: job.pull_request_id!, state: observation.state, baseBranch: observation.baseBranch,
        baseRevision: observation.baseRevision, headBranch: observation.headBranch,
        headRevision: observation.headRevision, evidence: observation.providerEvidence,
        reconciliationJobId: job.job_id });
    const staged = await stageScheduledJobCheckpoints(client, job.tenant_id, plan);
    const persisted = await persistScheduledJobs(client, job.tenant_id, plan, staged);
    return {
      outcome: await finishReconciliation(client, worker, lease),
      reconciliationOutcome: observation.state === "closed" || observation.state === "merged"
        ? "obsolete" as const : plan.jobs.length === 0 ? "no_work" as const : "repaired" as const,
      queuedKinds: persisted.queuedKinds, terminalOutcomes: persisted.terminalOutcomes,
      pendingOutboxes: persisted.outboxCount + 1,
    };
  });
  emitOrchestrationObservation(observer, {
    name: "reconciliation.lifecycle", kind: "pull_request", outcome: completed.reconciliationOutcome, count: 1,
  });
  for (const queuedKind of completed.queuedKinds) emitOrchestrationObservation(observer, {
    name: "job.lifecycle", kind: queuedKind, outcome: "queued", count: 1,
  });
  for (const terminal of completed.terminalOutcomes) emitOrchestrationObservation(observer, {
    name: "job.lifecycle", kind: terminal.kind, outcome: terminal.outcome, count: 1,
  });
  emitOrchestrationObservation(observer, {
    name: "outbox.lifecycle", outcome: "pending", count: completed.pendingOutboxes,
  });
  return completed.outcome;
};
