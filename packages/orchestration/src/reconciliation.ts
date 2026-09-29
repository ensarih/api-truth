import type { Pool, PoolClient } from "pg";
import { parseConfig, parseEvent, type InstallationConfig } from "@api-truth/ir";

import { canonicalOrchestrationHash, canonicalOrchestrationJson, detachedFrozen } from "./canonical.js";
import { withOrchestrationTransaction, withRestartingOrchestrationTransaction } from "./database.js";
import { OrchestrationError } from "./errors.js";
import { semanticOrchestrationId } from "./hashing.js";
import { acquireAdvisoryLocks, requireDiscoveredLocks } from "./locking.js";
import { parseProviderEvidence, type ProviderEvidence, type WorkerIdentity } from "./schemas.js";
import { discoverSchedulingLocks, persistScheduledJobs, scheduleAuthoritativeBranch,
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
  current_job_config_fingerprint: string | null };
type ReconciliationCheckpoint = { generation: string; current_job_id: string | null;
  requested_provider_snapshot_reference: string };

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

export const executeLeasedReconciliationJob = async (pool: Pool, options: { schema: string },
  worker: WorkerIdentity, lease: JobLease, portsInput: unknown): Promise<JobOutcome> => {
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
  const event = await withOrchestrationTransaction(pool, options, async (client) => {
    const stored = await client.query<{ document: unknown }>(
      `SELECT document FROM orchestration_events WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`,
      [prepared.job.tenant_id, prepared.job.event_producer_id, prepared.job.event_id],
    );
    const parsed = parseEvent(stored.rows[0]?.document);
    if (!parsed.ok) throw new OrchestrationError("RECONCILIATION_FAILED");
    return parsed.value;
  });
  const subjectEvent = observation.state === "present"
    ? { ...event, event_type: "branch.updated" as const, payload: { branch: prepared.job.branch!,
      prior_revision: null, new_revision: observation.immutableRevision!, reference_state: "fast_forward" as const } }
    : undefined;
  const initialLocks = [...transitionAdvisoryLocks([prepared.job]),
    ...(subjectEvent === undefined ? [] : discoverSchedulingLocks(prepared.job.tenant_id, subjectEvent,
      { fingerprint: prepared.job.config_fingerprint, documentSha256: prepared.job.config_document_sha256,
        document: prepared.configuration }))];

  return withRestartingOrchestrationTransaction(pool, options, initialLocks, async (client, carriedLocks) => {
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
              checkpoint.last_successful_snapshot_id,job.state AS current_job_state,
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
    const outcome = observation.state === "absent" ? "absent" : forceRepair ? "repaired" : "no_work";
    await client.query(
      `UPDATE orchestration_reconciliation_checkpoints SET last_outcome=$5,last_completed_reference=$6,
         safe_last_error_code=NULL,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
      [job!.tenant_id, job!.repository_id, job!.service_id, job!.branch, outcome, prepared.reference],
    );
    await persistScheduledJobs(client, job!.tenant_id, plan, staged);
    const lockedJob = await client.query<Job>(
      `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`, [lease.tenantId, lease.jobId],
    );
    await validLease(client, lockedJob.rows[0], worker, lease);
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
      attemptCount: job!.attempt_count });
  });
};
