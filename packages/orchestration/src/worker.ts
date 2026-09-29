import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseConfig, type InstallationConfig } from "@api-truth/ir";

import { requireControlCapability, requireWorkerCapability } from "./authorization.js";
import { canonicalOrchestrationHash, canonicalOrchestrationJson, detachedFrozen } from "./canonical.js";
import { withOrchestrationTransaction, withRestartingOrchestrationTransaction } from "./database.js";
import { OrchestrationError } from "./errors.js";
import { semanticOrchestrationId } from "./hashing.js";
import {
  acquireAdvisoryLocks, analysisCheckpointLock, branchLock, capacityGlobalLock, capacityRepositoryLock,
  capacityServiceLock, configurationLock, pullRequestLock, reconciliationBranchLock,
  reconciliationPullRequestLock, requireDiscoveredLocks, type AdvisoryLockKey,
} from "./locking.js";
import { computeRetryDelayMs } from "./state.js";
import type { WorkerIdentity } from "./schemas.js";

const CANDIDATE_LIMIT = 128;
const MAX_CLAIM_BATCH = 32;
const LEASE_DURATION_MS = 30_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "superseded"]);

type JobRow = {
  tenant_id: string; job_id: string; kind: string; repository_id: string; service_id: string;
  config_fingerprint: string; branch: string | null; pull_request_id: string | null;
  semantic_identity: unknown;
  state: string; attempt_count: string; max_attempts: string; available_at: Date; created_at: Date;
  lease_worker_id: string | null; lease_instance_id: string | null; lease_token: string | null;
  lease_expires_at: Date | null; cancellation_requested: boolean; superseding_job_id: string | null;
};
type OutboxRow = {
  tenant_id: string; outbox_id: string; message_kind: string; payload: unknown; state: string;
  attempt_count: string; max_attempts: string; available_at: Date; created_at: Date;
  lease_worker_id: string | null; lease_instance_id: string | null; lease_token: string | null;
  lease_expires_at: Date | null;
};

export type JobLease = Readonly<{ tenantId: string; jobId: string; leaseToken: string }>;
export type LeasedJob = Readonly<{
  tenantId: string; jobId: string; kind: string; attemptCount: string; maxAttempts: string;
  leaseExpiresAt: string; lease: JobLease;
}>;
export type JobOutcome = Readonly<{
  tenantId: string; jobId: string; state: "retry_wait" | "failed" | "cancelled" | "superseded";
  attemptCount: string; safeErrorCode?: string;
}>;
export type OutboxLease = Readonly<{ tenantId: string; outboxId: string; leaseToken: string }>;
export type LeasedOutboxRecord = Readonly<{
  tenantId: string; outboxId: string; messageKind: string; payload: Readonly<Record<string, string>>;
  attemptCount: string; maxAttempts: string; leaseExpiresAt: string; lease: OutboxLease;
}>;
export type OutboxOutcome = Readonly<{
  tenantId: string; outboxId: string; state: "retry_wait" | "exhausted"; attemptCount: string;
  safeErrorCode?: "OUTBOX_DELIVERY_FAILED";
}>;
export type ConcurrencyPolicySummary = Readonly<{
  tenantId: string; policyVersion: string; globalLimit: number; repositoryLimit: number; serviceLimit: number;
}>;
export type OrchestrationWorker = Readonly<{
  claimJobs(worker: unknown, options?: unknown): Promise<LeasedJob[]>;
  heartbeatJob(worker: unknown, lease: unknown): Promise<JobLease>;
  failJob(worker: unknown, lease: unknown, failure: unknown): Promise<JobOutcome>;
  claimOutbox(worker: unknown, options?: unknown): Promise<LeasedOutboxRecord[]>;
  acknowledgeOutbox(worker: unknown, lease: unknown): Promise<void>;
  failOutbox(worker: unknown, lease: unknown, failure: unknown): Promise<OutboxOutcome>;
  putConcurrencyPolicy(context: unknown, policy: unknown): Promise<ConcurrencyPolicySummary>;
}>;

const strictObject = (input: unknown, keys: readonly string[], errorCode: "INVALID_ORCHESTRATION_INPUT" | "JOB_LEASE_CONFLICT" | "OUTBOX_LEASE_CONFLICT") => {
  let value: unknown;
  try { value = JSON.parse(canonicalOrchestrationJson(input)); } catch { throw new OrchestrationError(errorCode); }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new OrchestrationError(errorCode);
  return value as Record<string, unknown>;
};

const requiredIdentity = (value: unknown, code: "JOB_LEASE_CONFLICT" | "OUTBOX_LEASE_CONFLICT"): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new OrchestrationError(code);
  return value;
};

const parseJobLease = (input: unknown): JobLease => {
  const value = strictObject(input, ["tenantId", "jobId", "leaseToken"], "JOB_LEASE_CONFLICT");
  if (Object.keys(value).length !== 3) throw new OrchestrationError("JOB_LEASE_CONFLICT");
  return detachedFrozen({ tenantId: requiredIdentity(value.tenantId, "JOB_LEASE_CONFLICT"),
    jobId: requiredIdentity(value.jobId, "JOB_LEASE_CONFLICT"),
    leaseToken: requiredIdentity(value.leaseToken, "JOB_LEASE_CONFLICT") });
};

const parseOutboxLease = (input: unknown): OutboxLease => {
  const value = strictObject(input, ["tenantId", "outboxId", "leaseToken"], "OUTBOX_LEASE_CONFLICT");
  if (Object.keys(value).length !== 3) throw new OrchestrationError("OUTBOX_LEASE_CONFLICT");
  return detachedFrozen({ tenantId: requiredIdentity(value.tenantId, "OUTBOX_LEASE_CONFLICT"),
    outboxId: requiredIdentity(value.outboxId, "OUTBOX_LEASE_CONFLICT"),
    leaseToken: requiredIdentity(value.leaseToken, "OUTBOX_LEASE_CONFLICT") });
};

const parseClaimLimit = (input: unknown): number => {
  if (input === undefined) return MAX_CLAIM_BATCH;
  const value = strictObject(input, ["limit"], "INVALID_ORCHESTRATION_INPUT");
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_CLAIM_BATCH) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  return value.limit as number;
};

const parsePolicy = (input: unknown) => {
  const value = strictObject(input, ["globalLimit", "repositoryLimit", "serviceLimit", "expectedVersion"], "INVALID_ORCHESTRATION_INPUT");
  const globalLimit = value.globalLimit;
  const repositoryLimit = value.repositoryLimit;
  const serviceLimit = value.serviceLimit;
  if (![globalLimit, repositoryLimit, serviceLimit].every((limit) => Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 1024)
    || (serviceLimit as number) > (repositoryLimit as number) || (repositoryLimit as number) > (globalLimit as number)
    || value.expectedVersion !== undefined && (typeof value.expectedVersion !== "string" || !/^[1-9][0-9]*$/.test(value.expectedVersion))) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  return { globalLimit: globalLimit as number, repositoryLimit: repositoryLimit as number,
    serviceLimit: serviceLimit as number, expectedVersion: value.expectedVersion as string | undefined };
};

const jobLocks = (jobs: readonly Pick<JobRow, "tenant_id" | "repository_id" | "service_id">[]): AdvisoryLockKey[] =>
  jobs.flatMap((job) => [configurationLock(job.tenant_id), capacityGlobalLock(job.tenant_id),
    capacityRepositoryLock(job.tenant_id, job.repository_id),
    capacityServiceLock(job.tenant_id, job.repository_id, job.service_id)]);

export const transitionAdvisoryLocks = (jobs: readonly JobRow[]): AdvisoryLockKey[] => {
  const locks = jobLocks(jobs);
  for (const job of jobs) {
    if (job.branch !== null) {
      locks.push(branchLock(job.tenant_id, job.repository_id, job.service_id, job.branch));
      if (job.kind === "branch_reconciliation") {
        locks.push(reconciliationBranchLock(job.tenant_id, job.repository_id, job.service_id, job.branch));
      }
    }
    if (job.pull_request_id !== null) {
      locks.push(pullRequestLock(job.tenant_id, job.repository_id, job.service_id, job.pull_request_id));
      if (job.kind === "pr_reconciliation") {
        locks.push(reconciliationPullRequestLock(job.tenant_id, job.repository_id, job.service_id, job.pull_request_id));
      }
    }
    const identity = job.semantic_identity;
    if (identity !== null && typeof identity === "object" && !Array.isArray(identity)
      && "analysis" in identity && identity.analysis !== null) {
      locks.push(analysisCheckpointLock(job.tenant_id, job.repository_id, job.service_id,
        canonicalOrchestrationHash(identity.analysis)));
    }
  }
  return locks;
};

export const lockTransitionCheckpoints = async (client: PoolClient, jobs: readonly Pick<JobRow, "tenant_id" | "job_id">[]) => {
  const byTenant = new Map<string, string[]>();
  for (const job of jobs) byTenant.set(job.tenant_id, [...(byTenant.get(job.tenant_id) ?? []), job.job_id]);
  const tableKeys = [
    ["orchestration_branch_checkpoints", "repository_id,service_id,branch"],
    ["orchestration_pr_checkpoints", "repository_id,service_id,pull_request_id"],
    ["orchestration_reconciliation_checkpoints", "repository_id,service_id,branch"],
    ["orchestration_analysis_checkpoints", "repository_id,service_id,service_root,immutable_revision,analyzer_adapter_id,analyzer_adapter_version,exchange_version,ir_version,identity_version,config_version,config_fingerprint"],
  ] as const;
  for (const [table, keyColumns] of tableKeys) {
    const order = keyColumns.split(",").map((key) => `${key} COLLATE "C"`).join(",");
    for (const tenantId of [...byTenant.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      await client.query(
        `SELECT 1 FROM ${table} WHERE tenant_id=$1 AND current_job_id=ANY($2::text[])
         ORDER BY ${order} FOR UPDATE`, [tenantId, byTenant.get(tenantId)],
      );
    }
  }
};

export const lockTransitionJobs = async (client: PoolClient, jobs: readonly Pick<JobRow, "tenant_id" | "job_id">[],
  skipLocked = false): Promise<JobRow[]> => {
  const byTenant = new Map<string, string[]>();
  for (const job of jobs) byTenant.set(job.tenant_id, [...(byTenant.get(job.tenant_id) ?? []), job.job_id]);
  const locked: JobRow[] = [];
  for (const tenantId of [...byTenant.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const result = await client.query<JobRow>(
      `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=ANY($2::text[])
       ORDER BY job_id COLLATE "C" FOR UPDATE${skipLocked ? " SKIP LOCKED" : ""}`,
      [tenantId, byTenant.get(tenantId)],
    );
    locked.push(...result.rows);
  }
  return locked;
};

const safeCount = (value: string): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  return count;
};

const executionFailureCode = (kind: string): "RECONCILIATION_FAILED" | "JOB_EXECUTION_FAILED" =>
  kind.endsWith("reconciliation") ? "RECONCILIATION_FAILED" : "JOB_EXECUTION_FAILED";

const insertStateOutbox = async (client: PoolClient, job: Pick<JobRow, "tenant_id" | "job_id">,
  state: string, reason?: string): Promise<void> => {
  const identity = { kind: "job.state_changed", tenantId: job.tenant_id, jobId: job.job_id, state,
    ...(reason === undefined ? {} : { reason }) };
  await client.query(
    `INSERT INTO orchestration_outbox
       (tenant_id,outbox_id,dedupe_key,message_kind,job_id,payload,state,max_attempts)
     VALUES ($1,$2,$3,'job.state_changed',$4,$5,'pending',8)
     ON CONFLICT (tenant_id,dedupe_key) DO NOTHING`,
    [job.tenant_id, semanticOrchestrationId("outbox", identity), canonicalOrchestrationHash(identity),
      job.job_id, { jobId: job.job_id, state }],
  );
};

type StateNotification = { job: Pick<JobRow, "tenant_id" | "job_id">; state: string; reason?: string };
const flushNotifications = async (client: PoolClient, notifications: readonly StateNotification[]): Promise<void> => {
  for (const notification of notifications) await insertStateOutbox(client, notification.job, notification.state, notification.reason);
};

const failedPrerequisite = async (client: PoolClient, tenantId: string, jobId: string): Promise<boolean> => {
  const result = await client.query(
    `SELECT 1 FROM orchestration_job_dependencies dependency
     JOIN orchestration_jobs prerequisite ON prerequisite.tenant_id=dependency.tenant_id
       AND prerequisite.job_id=dependency.prerequisite_job_id
     WHERE dependency.tenant_id=$1 AND dependency.job_id=$2
       AND prerequisite.state IN ('failed','cancelled','superseded') LIMIT 1`, [tenantId, jobId],
  );
  return result.rowCount !== null && result.rowCount > 0;
};

const readyPrerequisites = async (client: PoolClient, tenantId: string, jobId: string): Promise<boolean> => {
  const result = await client.query(
    `SELECT 1 FROM orchestration_job_dependencies dependency
     JOIN orchestration_jobs prerequisite ON prerequisite.tenant_id=dependency.tenant_id
       AND prerequisite.job_id=dependency.prerequisite_job_id
     WHERE dependency.tenant_id=$1 AND dependency.job_id=$2 AND prerequisite.state <> 'succeeded' LIMIT 1`,
    [tenantId, jobId],
  );
  return result.rowCount === 0;
};

const terminalState = (job: JobRow, dependencyFailed: boolean): { state: "superseded" | "cancelled" | "failed"; code?: string } | undefined => {
  if (job.superseding_job_id !== null) return { state: "superseded" };
  if (job.cancellation_requested) return { state: "cancelled" };
  if (dependencyFailed) return { state: "failed", code: "JOB_DEPENDENCY_FAILED" };
  return undefined;
};

const updateCheckpointState = async (client: PoolClient, job: JobRow, state: string, code?: string): Promise<void> => {
  const values = [job.tenant_id, job.job_id, state];
  if (job.kind === "branch_analysis") {
    await client.query(
      `UPDATE orchestration_branch_checkpoints SET latest_outcome=$3,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND current_job_id=$2`, values,
    );
  } else if (job.kind === "pr_preview_analysis" || job.kind === "pr_reconciliation") {
    await client.query(
      `UPDATE orchestration_pr_checkpoints SET latest_outcome=$3,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND current_job_id=$2`, values,
    );
  } else if (job.kind === "branch_reconciliation" && TERMINAL.has(state)) {
    await client.query(
      `UPDATE orchestration_reconciliation_checkpoints SET last_outcome=$3,safe_last_error_code=$4,
         updated_at=clock_timestamp() WHERE tenant_id=$1 AND current_job_id=$2`,
      [job.tenant_id, job.job_id, state === "failed" ? "failed" : "obsolete", state === "failed" ? code ?? "RECONCILIATION_FAILED" : null],
    );
  } else if (job.kind === "baseline_analysis" && TERMINAL.has(state)) {
    await client.query(
      `UPDATE orchestration_analysis_checkpoints SET last_terminal_outcome=$3,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND current_job_id=$2`, values,
    );
  }
};

const finishJob = async (client: PoolClient, job: JobRow, state: "failed" | "cancelled" | "superseded",
  code: string | undefined, notifications: StateNotification[]): Promise<void> => {
  await updateCheckpointState(client, job, state, code);
  await client.query(
    `UPDATE orchestration_jobs SET state=$3,lease_worker_id=NULL,lease_instance_id=NULL,lease_token=NULL,
       lease_expires_at=NULL,safe_last_error_code=$4,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
       row_version=row_version+1 WHERE tenant_id=$1 AND job_id=$2`,
    [job.tenant_id, job.job_id, state, code ?? null],
  );
  notifications.push({ job, state, ...(code === undefined ? {} : { reason: code }) });
};

/** Caller holds all tenant and affected capacity locks before touching job rows. */
export const propagateTerminalDependencies = async (
  client: PoolClient, tenantId: string, roots: readonly string[], notifications: StateNotification[],
): Promise<void> => {
  if (roots.length === 0) return;
  const closure = await discoverTransitionClosure(client, roots.map((jobId) => ({ tenant_id: tenantId, job_id: jobId })));
  const rootSet = new Set(roots);
  const dependentIds = closure.map((row) => row.job_id).filter((jobId) => !rootSet.has(jobId));
  if (dependentIds.length === 0) return;
  const edges = await client.query<{ job_id: string; prerequisite_job_id: string }>(
    `SELECT job_id,prerequisite_job_id FROM orchestration_job_dependencies
     WHERE tenant_id=$1 AND job_id=ANY($2::text[])
     ORDER BY prerequisite_job_id COLLATE "C",job_id COLLATE "C"`, [tenantId, dependentIds],
  );
  const children = new Map<string, string[]>();
  for (const edge of edges.rows) children.set(edge.prerequisite_job_id,
    [...(children.get(edge.prerequisite_job_id) ?? []), edge.job_id]);
  const locked = await client.query<JobRow>(
    `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=ANY($2::text[])
     ORDER BY job_id COLLATE "C" FOR UPDATE`, [tenantId, dependentIds],
  );
  const jobs = new Map(locked.rows.map((row) => [row.job_id, row]));
  const queue = [...rootSet].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const visited = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    for (const childId of children.get(queue[index]!) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      queue.push(childId);
    }
    if (index < rootSet.size) continue;
    const job = jobs.get(queue[index]!);
    if (job === undefined || TERMINAL.has(job.state) || !await failedPrerequisite(client, tenantId, job.job_id)) continue;
    if (job.state === "leased") {
      await client.query(
        `UPDATE orchestration_jobs SET cancellation_requested=true,updated_at=clock_timestamp(),row_version=row_version+1
         WHERE tenant_id=$1 AND job_id=$2 AND cancellation_requested=false`, [tenantId, job.job_id],
      );
      continue;
    }
    const outcome = terminalState(job, true)!;
    await finishJob(client, job, outcome.state, outcome.code, notifications);
  }
};

export const propagateAndNotifyTerminalDependencies = async (
  client: PoolClient, tenantId: string, roots: readonly string[],
): Promise<void> => {
  const notifications: StateNotification[] = [];
  await propagateTerminalDependencies(client, tenantId, roots, notifications);
  await flushNotifications(client, notifications);
};

const validateLiveJobLease = async (client: PoolClient, job: JobRow | undefined,
  worker: WorkerIdentity, lease: JobLease): Promise<JobRow> => {
  if (job === undefined || job.state !== "leased" || job.lease_worker_id !== worker.workerId
    || job.lease_instance_id !== worker.instanceId || job.lease_token !== lease.leaseToken
    || job.lease_expires_at === null || !await jobLeaseIsLive(client, job)) {
    throw new OrchestrationError("JOB_LEASE_CONFLICT");
  }
  return job;
};

const validateLiveOutboxLease = async (client: PoolClient, row: OutboxRow | undefined,
  worker: WorkerIdentity, lease: OutboxLease): Promise<OutboxRow> => {
  if (row === undefined || row.state !== "leased" || row.lease_worker_id !== worker.workerId
    || row.lease_instance_id !== worker.instanceId || row.lease_token !== lease.leaseToken
    || row.lease_expires_at === null || !await outboxLeaseIsLive(client, row)) {
    throw new OrchestrationError("OUTBOX_LEASE_CONFLICT");
  }
  return row;
};

const jobLeaseIsLive = async (client: PoolClient, job: Pick<JobRow, "tenant_id" | "job_id">): Promise<boolean> => {
  const result = await client.query<{ live: boolean }>(
    `SELECT lease_expires_at>clock_timestamp() AS live FROM orchestration_jobs
     WHERE tenant_id=$1 AND job_id=$2`, [job.tenant_id, job.job_id],
  );
  return result.rows[0]?.live === true;
};

const jobAvailable = async (client: PoolClient, job: Pick<JobRow, "tenant_id" | "job_id">): Promise<boolean> => {
  const result = await client.query<{ due: boolean }>(
    `SELECT available_at<=clock_timestamp() AS due FROM orchestration_jobs
     WHERE tenant_id=$1 AND job_id=$2`, [job.tenant_id, job.job_id],
  );
  return result.rows[0]?.due === true;
};

const outboxLeaseIsLive = async (client: PoolClient, row: Pick<OutboxRow, "tenant_id" | "outbox_id">): Promise<boolean> => {
  const result = await client.query<{ live: boolean }>(
    `SELECT lease_expires_at>clock_timestamp() AS live FROM orchestration_outbox
     WHERE tenant_id=$1 AND outbox_id=$2`, [row.tenant_id, row.outbox_id],
  );
  return result.rows[0]?.live === true;
};

const outboxAvailable = async (client: PoolClient, row: Pick<OutboxRow, "tenant_id" | "outbox_id">): Promise<boolean> => {
  const result = await client.query<{ due: boolean }>(
    `SELECT available_at<=clock_timestamp() AS due FROM orchestration_outbox
     WHERE tenant_id=$1 AND outbox_id=$2`, [row.tenant_id, row.outbox_id],
  );
  return result.rows[0]?.due === true;
};

const jobDiscovery = async (client: PoolClient) => client.query<JobRow>(
  `SELECT job.* FROM orchestration_jobs job
   LEFT JOIN orchestration_concurrency_policies policy ON policy.tenant_id=job.tenant_id
   WHERE (job.state IN ('queued','retry_wait') AND (
      (job.available_at<=clock_timestamp() AND NOT EXISTS (
        SELECT 1 FROM orchestration_job_dependencies dependency
        JOIN orchestration_jobs prerequisite ON prerequisite.tenant_id=dependency.tenant_id
          AND prerequisite.job_id=dependency.prerequisite_job_id
        WHERE dependency.tenant_id=job.tenant_id
          AND dependency.job_id=job.job_id
          AND prerequisite.state <> 'succeeded'
      ) AND (
        SELECT count(*) FROM orchestration_jobs live
        WHERE live.tenant_id=job.tenant_id AND live.state='leased'
          AND live.lease_expires_at>clock_timestamp()
      ) < COALESCE(policy.global_limit,16) AND (
        SELECT count(*) FROM orchestration_jobs live
        WHERE live.tenant_id=job.tenant_id AND live.repository_id=job.repository_id
          AND live.state='leased' AND live.lease_expires_at>clock_timestamp()
      ) < COALESCE(policy.repository_limit,4) AND (
        SELECT count(*) FROM orchestration_jobs live
        WHERE live.tenant_id=job.tenant_id AND live.repository_id=job.repository_id
          AND live.service_id=job.service_id AND live.state='leased'
          AND live.lease_expires_at>clock_timestamp()
      ) < COALESCE(policy.service_limit,1)) OR EXISTS (
        SELECT 1 FROM orchestration_job_dependencies dependency
        JOIN orchestration_jobs prerequisite ON prerequisite.tenant_id=dependency.tenant_id
          AND prerequisite.job_id=dependency.prerequisite_job_id
        WHERE dependency.tenant_id=job.tenant_id
          AND dependency.job_id=job.job_id
          AND prerequisite.state IN ('failed','cancelled','superseded')
      )))
      OR (job.state='leased' AND job.lease_expires_at<=clock_timestamp())
   ORDER BY job.available_at,job.created_at,job.job_id COLLATE "C" LIMIT ${CANDIDATE_LIMIT}`,
);

export const discoverTransitionClosure = async (client: PoolClient,
  roots: readonly Pick<JobRow, "tenant_id" | "job_id">[]): Promise<JobRow[]> => {
  if (roots.length === 0) return [];
  const tenantIds = roots.map((row) => row.tenant_id);
  const jobIds = roots.map((row) => row.job_id);
  const result = await client.query<JobRow>(
    `WITH RECURSIVE descendants(tenant_id,job_id) AS (
       SELECT input.tenant_id,input.job_id
       FROM unnest($1::text[],$2::text[]) AS input(tenant_id,job_id)
       UNION
       SELECT dependency.tenant_id,dependency.job_id
       FROM orchestration_job_dependencies dependency
       JOIN descendants prior ON prior.tenant_id=dependency.tenant_id
         AND prior.job_id=dependency.prerequisite_job_id
     ) SELECT job.* FROM descendants
       JOIN orchestration_jobs job ON job.tenant_id=descendants.tenant_id AND job.job_id=descendants.job_id
       ORDER BY job.tenant_id COLLATE "C",job.job_id COLLATE "C" LIMIT 2049`,
    [tenantIds, jobIds],
  );
  if (result.rows.length > 2048) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: true });
  return result.rows;
};

export const discoverActiveTransitionJobs = async (client: PoolClient, tenantId: string,
  serviceIds: readonly string[]): Promise<JobRow[]> => {
  if (serviceIds.length === 0) return [];
  const roots = await client.query<JobRow>(
    `SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND service_id=ANY($2::text[])
       AND state IN ('queued','retry_wait','leased')
     ORDER BY job_id COLLATE "C" LIMIT 2049`, [tenantId, serviceIds],
  );
  if (roots.rows.length > 2048) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: true });
  return discoverTransitionClosure(client, roots.rows);
};

const outboxDiscovery = async (client: PoolClient) => client.query<OutboxRow>(
  `SELECT * FROM orchestration_outbox
   WHERE (state IN ('pending','retry_wait') AND available_at<=clock_timestamp())
      OR (state='leased' AND lease_expires_at<=clock_timestamp())
   ORDER BY available_at,created_at,outbox_id COLLATE "C" LIMIT ${CANDIDATE_LIMIT}`,
);

const orderJobsByDatabaseQueue = async (client: PoolClient, rows: readonly JobRow[]): Promise<JobRow[]> => {
  if (rows.length === 0) return [];
  const order = await client.query<{ tenant_id: string; job_id: string }>(
    `SELECT job.tenant_id,job.job_id FROM orchestration_jobs job
     JOIN unnest($1::text[],$2::text[]) AS input(tenant_id,job_id)
       ON input.tenant_id=job.tenant_id AND input.job_id=job.job_id
     ORDER BY job.available_at,job.created_at,job.tenant_id COLLATE "C",job.job_id COLLATE "C"`,
    [rows.map((row) => row.tenant_id), rows.map((row) => row.job_id)],
  );
  const byKey = new Map(rows.map((row) => [`${row.tenant_id}\u0000${row.job_id}`, row]));
  return order.rows.flatMap((row) => {
    const found = byKey.get(`${row.tenant_id}\u0000${row.job_id}`);
    return found === undefined ? [] : [found];
  });
};

const orderOutboxByDatabaseQueue = async (client: PoolClient, rows: readonly OutboxRow[]): Promise<OutboxRow[]> => {
  if (rows.length === 0) return [];
  const order = await client.query<{ tenant_id: string; outbox_id: string }>(
    `SELECT record.tenant_id,record.outbox_id FROM orchestration_outbox record
     JOIN unnest($1::text[],$2::text[]) AS input(tenant_id,outbox_id)
       ON input.tenant_id=record.tenant_id AND input.outbox_id=record.outbox_id
     ORDER BY record.available_at,record.created_at,record.tenant_id COLLATE "C",record.outbox_id COLLATE "C"`,
    [rows.map((row) => row.tenant_id), rows.map((row) => row.outbox_id)],
  );
  const byKey = new Map(rows.map((row) => [`${row.tenant_id}\u0000${row.outbox_id}`, row]));
  return order.rows.flatMap((row) => {
    const found = byKey.get(`${row.tenant_id}\u0000${row.outbox_id}`);
    return found === undefined ? [] : [found];
  });
};

type CapacityLimits = { global_limit: number; repository_limit: number; service_limit: number };
const capacityAvailable = async (client: PoolClient, job: JobRow, limits: CapacityLimits): Promise<boolean> => {
  const counts = await client.query<{ global_count: string; repository_count: string; service_count: string }>(
    `SELECT count(*)::text AS global_count,
       count(*) FILTER (WHERE repository_id=$2)::text AS repository_count,
       count(*) FILTER (WHERE repository_id=$2 AND service_id=$3)::text AS service_count
     FROM orchestration_jobs WHERE tenant_id=$1 AND state='leased' AND lease_expires_at>clock_timestamp()`,
    [job.tenant_id, job.repository_id, job.service_id],
  );
  const count = counts.rows[0]!;
  return Number(count.global_count) < limits.global_limit
    && Number(count.repository_count) < limits.repository_limit
    && Number(count.service_count) < limits.service_limit;
};

type ActiveScope = { fingerprint: string; document: InstallationConfig };
const activeScopes = async (client: PoolClient, tenantIds: readonly string[]): Promise<Map<string, ActiveScope>> => {
  const scopes = new Map<string, ActiveScope>();
  for (const tenantId of tenantIds) {
    const result = await client.query<{ config_fingerprint: string; document: unknown }>(
      `SELECT active.config_fingerprint,configuration.document
       FROM orchestration_active_configurations active
       JOIN orchestration_configurations configuration
         ON configuration.tenant_id=active.tenant_id
         AND configuration.config_fingerprint=active.config_fingerprint
       WHERE active.tenant_id=$1 FOR SHARE OF active`, [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) continue;
    const parsed = parseConfig(row.document);
    if (!parsed.ok) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
    scopes.set(tenantId, { fingerprint: row.config_fingerprint, document: parsed.value });
  }
  return scopes;
};

const isAllowedByActiveConfig = (job: JobRow, active: ActiveScope | undefined): boolean => {
  if (active === undefined || active.fingerprint !== job.config_fingerprint) return false;
  const repository = active.document.repositories.find((entry) => entry.repository_id === job.repository_id);
  const service = repository?.services.find((entry) => entry.service_id === job.service_id);
  if (service === undefined) return false;
  if (job.kind === "branch_analysis" || job.kind === "branch_reconciliation") {
    return job.branch !== null && service.intended_branches.includes(job.branch);
  }
  if (job.kind === "pr_preview_analysis" || job.kind === "pr_reconciliation") {
    return service.intended_branches.length > 0;
  }
  return true;
};

const jobOutcome = (job: JobRow, state: JobOutcome["state"], code?: string): JobOutcome => detachedFrozen({
  tenantId: job.tenant_id, jobId: job.job_id, state, attemptCount: job.attempt_count,
  ...(code === undefined ? {} : { safeErrorCode: code }),
});

const outboxPayload = (input: unknown): Readonly<Record<string, string>> => {
  const value = strictObject(input, ["eventId", "disposition", "jobId", "state", "serviceId", "repositoryId", "scopeKey", "fingerprint"],
    "INVALID_ORCHESTRATION_INPUT");
  if (Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
  }
  return detachedFrozen(value as Record<string, string>);
};

export const createOrchestrationWorker = (pool: Pool, options: { schema: string }): OrchestrationWorker => ({
  async claimJobs(workerInput, optionsInput) {
    const worker = requireWorkerCapability(workerInput, "jobs.execute");
    const limit = parseClaimLimit(optionsInput);
    return withRestartingOrchestrationTransaction(pool, options, [], async (client, carriedLocks) => {
      const discovered = (await jobDiscovery(client)).rows;
      if (discovered.length === 0) return [];
      const discoveredClosure = await discoverTransitionClosure(client, discovered);
      const acquired = await acquireAdvisoryLocks(client, [...carriedLocks, ...transitionAdvisoryLocks(discoveredClosure)]);
      const affected = await discoverTransitionClosure(client, discovered);
      requireDiscoveredLocks(acquired, transitionAdvisoryLocks(affected));
      const tenantIds = [...new Set(affected.map((row) => row.tenant_id))]
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      const scopes = await activeScopes(client, tenantIds);
      const policies = new Map<string, CapacityLimits>();
      for (const tenantId of tenantIds) {
        const stored = await client.query<CapacityLimits>(
          `SELECT global_limit,repository_limit,service_limit FROM orchestration_concurrency_policies
           WHERE tenant_id=$1 FOR SHARE`, [tenantId],
        );
        policies.set(tenantId, stored.rows[0] ?? { global_limit: 16, repository_limit: 4, service_limit: 1 });
      }
      await lockTransitionCheckpoints(client, affected);
      const locked = await lockTransitionJobs(client, affected, true);
      if (locked.length !== affected.length) return [];
      const candidateSet = new Set(discovered.map((row) => `${row.tenant_id}\u0000${row.job_id}`));
      const notifications: StateNotification[] = [];
      const terminalRoots = new Map<string, string[]>();
      const claimed: LeasedJob[] = [];
      for (const job of await orderJobsByDatabaseQueue(client,
        locked.filter((row) => candidateSet.has(`${row.tenant_id}\u0000${row.job_id}`)))) {
        if (job.state === "leased" && job.lease_expires_at !== null
          && !await jobLeaseIsLive(client, job)) {
          const dependentFailed = await failedPrerequisite(client, job.tenant_id, job.job_id);
          const requested = terminalState(job, dependentFailed);
          const outcome = requested ?? (safeCount(job.attempt_count) >= safeCount(job.max_attempts)
            ? { state: "failed" as const, code: executionFailureCode(job.kind) } : undefined);
          if (outcome !== undefined) {
            await finishJob(client, job, outcome.state, outcome.code, notifications);
            terminalRoots.set(job.tenant_id, [...(terminalRoots.get(job.tenant_id) ?? []), job.job_id]);
          } else {
            const delay = computeRetryDelayMs({ attempt: safeCount(job.attempt_count), baseDelayMs: RETRY_BASE_MS,
              maxDelayMs: RETRY_MAX_MS });
            await updateCheckpointState(client, job, "retry_wait");
            await client.query(
              `UPDATE orchestration_jobs SET state='retry_wait',lease_worker_id=NULL,lease_instance_id=NULL,
                 lease_token=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+($3::bigint * interval '1 millisecond'),
                 updated_at=clock_timestamp(),row_version=row_version+1 WHERE tenant_id=$1 AND job_id=$2`,
              [job.tenant_id, job.job_id, delay],
            );
            notifications.push({ job, state: "retry_wait", reason: `attempt:${job.attempt_count}` });
          }
          continue;
        }
        if (claimed.length >= limit || !["queued", "retry_wait"].includes(job.state)
          || !await jobAvailable(client, job)) continue;
        if (!isAllowedByActiveConfig(job, scopes.get(job.tenant_id))) {
          await finishJob(client, job, "cancelled", undefined, notifications);
          terminalRoots.set(job.tenant_id, [...(terminalRoots.get(job.tenant_id) ?? []), job.job_id]);
          continue;
        }
        const dependentFailed = await failedPrerequisite(client, job.tenant_id, job.job_id);
        const requested = terminalState(job, dependentFailed);
        if (requested !== undefined) {
          await finishJob(client, job, requested.state, requested.code, notifications);
          terminalRoots.set(job.tenant_id, [...(terminalRoots.get(job.tenant_id) ?? []), job.job_id]);
          continue;
        }
        if (safeCount(job.attempt_count) >= safeCount(job.max_attempts)) {
          await finishJob(client, job, "failed", executionFailureCode(job.kind), notifications);
          terminalRoots.set(job.tenant_id, [...(terminalRoots.get(job.tenant_id) ?? []), job.job_id]);
          continue;
        }
        if (!await readyPrerequisites(client, job.tenant_id, job.job_id)
          || !await capacityAvailable(client, job, policies.get(job.tenant_id)!)) continue;
        const token = randomBytes(32).toString("hex");
        await updateCheckpointState(client, job, "leased");
        const updated = await client.query<{ lease_expires_at: Date }>(
          `UPDATE orchestration_jobs SET state='leased',attempt_count=attempt_count+1,
             lease_worker_id=$3,lease_instance_id=$4,lease_token=$5,safe_last_error_code=NULL,
             lease_expires_at=clock_timestamp()+($6::bigint * interval '1 millisecond'),
             started_at=COALESCE(started_at,clock_timestamp()),updated_at=clock_timestamp(),row_version=row_version+1
           WHERE tenant_id=$1 AND job_id=$2 RETURNING lease_expires_at`,
          [job.tenant_id, job.job_id, worker.workerId, worker.instanceId, token, LEASE_DURATION_MS],
        );
        claimed.push(detachedFrozen({ tenantId: job.tenant_id, jobId: job.job_id, kind: job.kind,
          attemptCount: (BigInt(job.attempt_count) + 1n).toString(), maxAttempts: job.max_attempts,
          leaseExpiresAt: updated.rows[0]!.lease_expires_at.toISOString(),
          lease: { tenantId: job.tenant_id, jobId: job.job_id, leaseToken: token } }));
      }
      for (const [tenantId, roots] of terminalRoots) await propagateTerminalDependencies(client, tenantId, roots, notifications);
      await flushNotifications(client, notifications);
      return claimed;
    });
  },

  async heartbeatJob(workerInput, leaseInput) {
    const worker = requireWorkerCapability(workerInput, "jobs.execute");
    const lease = parseJobLease(leaseInput);
    return withOrchestrationTransaction(pool, options, async (client) => {
      const discovered = await client.query<JobRow>("SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2",
        [lease.tenantId, lease.jobId]);
      if (discovered.rows[0] === undefined) throw new OrchestrationError("JOB_LEASE_CONFLICT");
      await acquireAdvisoryLocks(client, jobLocks(discovered.rows));
      const locked = await client.query<JobRow>(
        "SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE", [lease.tenantId, lease.jobId],
      );
      const job = await validateLiveJobLease(client, locked.rows[0], worker, lease);
      if (job.superseding_job_id !== null) throw new OrchestrationError("JOB_SUPERSEDED");
      if (job.cancellation_requested) throw new OrchestrationError("JOB_CANCELLED");
      if (await failedPrerequisite(client, job.tenant_id, job.job_id)) throw new OrchestrationError("JOB_DEPENDENCY_FAILED");
      await client.query(
        `UPDATE orchestration_jobs SET lease_expires_at=clock_timestamp()+($3::bigint * interval '1 millisecond'),
           updated_at=clock_timestamp(),row_version=row_version+1 WHERE tenant_id=$1 AND job_id=$2`,
        [lease.tenantId, lease.jobId, LEASE_DURATION_MS],
      );
      return lease;
    });
  },

  async failJob(workerInput, leaseInput, _failure) {
    const worker = requireWorkerCapability(workerInput, "jobs.execute");
    const lease = parseJobLease(leaseInput);
    return withRestartingOrchestrationTransaction(pool, options, [], async (client, carriedLocks) => {
      const discovered = await client.query<JobRow>("SELECT * FROM orchestration_jobs WHERE tenant_id=$1 AND job_id=$2",
        [lease.tenantId, lease.jobId]);
      if (discovered.rows[0] === undefined) throw new OrchestrationError("JOB_LEASE_CONFLICT");
      const discoveredClosure = await discoverTransitionClosure(client, discovered.rows);
      const acquired = await acquireAdvisoryLocks(client, [...carriedLocks, ...transitionAdvisoryLocks(discoveredClosure)]);
      const closure = await discoverTransitionClosure(client, discovered.rows);
      requireDiscoveredLocks(acquired, transitionAdvisoryLocks(closure));
      await lockTransitionCheckpoints(client, closure);
      const locked = await lockTransitionJobs(client, closure);
      const job = await validateLiveJobLease(client, locked.find((row) => row.job_id === lease.jobId), worker, lease);
      const notifications: StateNotification[] = [];
      const requested = terminalState(job, await failedPrerequisite(client, job.tenant_id, job.job_id));
      const exhausted = safeCount(job.attempt_count) >= safeCount(job.max_attempts);
      if (requested !== undefined || exhausted) {
        const state = requested?.state ?? "failed";
        const code = requested?.code ?? (state === "failed"
          ? executionFailureCode(job.kind) : undefined);
        await finishJob(client, job, state, code, notifications);
        await propagateTerminalDependencies(client, job.tenant_id, [job.job_id], notifications);
        await flushNotifications(client, notifications);
        return jobOutcome(job, state, code);
      }
      const code = executionFailureCode(job.kind);
      const delay = computeRetryDelayMs({ attempt: safeCount(job.attempt_count), baseDelayMs: RETRY_BASE_MS,
        maxDelayMs: RETRY_MAX_MS });
      await updateCheckpointState(client, job, "retry_wait");
      await client.query(
        `UPDATE orchestration_jobs SET state='retry_wait',lease_worker_id=NULL,lease_instance_id=NULL,
           lease_token=NULL,lease_expires_at=NULL,safe_last_error_code=$3,
           available_at=clock_timestamp()+($4::bigint * interval '1 millisecond'),
           updated_at=clock_timestamp(),row_version=row_version+1 WHERE tenant_id=$1 AND job_id=$2`,
        [job.tenant_id, job.job_id, code, delay],
      );
      await flushNotifications(client, [{ job, state: "retry_wait", reason: `attempt:${job.attempt_count}` }]);
      return jobOutcome(job, "retry_wait", code);
    });
  },

  async claimOutbox(workerInput, optionsInput) {
    const worker = requireWorkerCapability(workerInput, "outbox.deliver");
    const limit = parseClaimLimit(optionsInput);
    return withOrchestrationTransaction(pool, options, async (client) => {
      const discovered = (await outboxDiscovery(client)).rows;
      if (discovered.length === 0) return [];
      await acquireAdvisoryLocks(client, discovered.map((row) => configurationLock(row.tenant_id)));
      const byTenant = new Map<string, string[]>();
      for (const row of discovered) byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row.outbox_id]);
      const locked: OutboxRow[] = [];
      for (const tenantId of [...byTenant.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
        const rows = await client.query<OutboxRow>(
          `SELECT * FROM orchestration_outbox WHERE tenant_id=$1 AND outbox_id=ANY($2::text[])
           ORDER BY outbox_id COLLATE "C" FOR UPDATE SKIP LOCKED`, [tenantId, byTenant.get(tenantId)],
        );
        locked.push(...rows.rows);
      }
      const claimed: LeasedOutboxRecord[] = [];
      for (const row of await orderOutboxByDatabaseQueue(client, locked)) {
        if (row.state === "leased" && row.lease_expires_at !== null && !await outboxLeaseIsLive(client, row)) {
          const exhausted = safeCount(row.attempt_count) >= safeCount(row.max_attempts);
          const delay = exhausted ? 0 : computeRetryDelayMs({ attempt: safeCount(row.attempt_count),
            baseDelayMs: RETRY_BASE_MS, maxDelayMs: RETRY_MAX_MS });
          await client.query(
            `UPDATE orchestration_outbox SET state=$3,lease_worker_id=NULL,lease_instance_id=NULL,
               lease_token=NULL,lease_expires_at=NULL,
               available_at=clock_timestamp()+($4::bigint * interval '1 millisecond'),
               updated_at=clock_timestamp() WHERE tenant_id=$1 AND outbox_id=$2`,
            [row.tenant_id, row.outbox_id, exhausted ? "exhausted" : "retry_wait", delay],
          );
          continue;
        }
        if (claimed.length >= limit || !["pending", "retry_wait"].includes(row.state)
          || !await outboxAvailable(client, row)) continue;
        const token = randomBytes(32).toString("hex");
        const updated = await client.query<{ lease_expires_at: Date }>(
          `UPDATE orchestration_outbox SET state='leased',attempt_count=attempt_count+1,
             lease_worker_id=$3,lease_instance_id=$4,lease_token=$5,safe_last_error_code=NULL,
             lease_expires_at=clock_timestamp()+($6::bigint * interval '1 millisecond'),updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND outbox_id=$2 RETURNING lease_expires_at`,
          [row.tenant_id, row.outbox_id, worker.workerId, worker.instanceId, token, LEASE_DURATION_MS],
        );
        claimed.push(detachedFrozen({ tenantId: row.tenant_id, outboxId: row.outbox_id,
          messageKind: row.message_kind, payload: outboxPayload(row.payload),
          attemptCount: (BigInt(row.attempt_count) + 1n).toString(), maxAttempts: row.max_attempts,
          leaseExpiresAt: updated.rows[0]!.lease_expires_at.toISOString(),
          lease: { tenantId: row.tenant_id, outboxId: row.outbox_id, leaseToken: token } }));
      }
      return claimed;
    });
  },

  async acknowledgeOutbox(workerInput, leaseInput) {
    const worker = requireWorkerCapability(workerInput, "outbox.deliver");
    const lease = parseOutboxLease(leaseInput);
    return withOrchestrationTransaction(pool, options, async (client) => {
      await acquireAdvisoryLocks(client, [configurationLock(lease.tenantId)]);
      const locked = await client.query<OutboxRow>(
        "SELECT * FROM orchestration_outbox WHERE tenant_id=$1 AND outbox_id=$2 FOR UPDATE",
        [lease.tenantId, lease.outboxId],
      );
      await validateLiveOutboxLease(client, locked.rows[0], worker, lease);
      await client.query(
        `UPDATE orchestration_outbox SET state='delivered',lease_worker_id=NULL,lease_instance_id=NULL,
           lease_token=NULL,lease_expires_at=NULL,delivered_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND outbox_id=$2`, [lease.tenantId, lease.outboxId],
      );
    });
  },

  async failOutbox(workerInput, leaseInput, _failure) {
    const worker = requireWorkerCapability(workerInput, "outbox.deliver");
    const lease = parseOutboxLease(leaseInput);
    return withOrchestrationTransaction(pool, options, async (client) => {
      await acquireAdvisoryLocks(client, [configurationLock(lease.tenantId)]);
      const locked = await client.query<OutboxRow>(
        "SELECT * FROM orchestration_outbox WHERE tenant_id=$1 AND outbox_id=$2 FOR UPDATE",
        [lease.tenantId, lease.outboxId],
      );
      const row = await validateLiveOutboxLease(client, locked.rows[0], worker, lease);
      const exhausted = safeCount(row.attempt_count) >= safeCount(row.max_attempts);
      const delay = exhausted ? 0 : computeRetryDelayMs({ attempt: safeCount(row.attempt_count),
        baseDelayMs: RETRY_BASE_MS, maxDelayMs: RETRY_MAX_MS });
      const state = exhausted ? "exhausted" : "retry_wait";
      await client.query(
        `UPDATE orchestration_outbox SET state=$3,lease_worker_id=NULL,lease_instance_id=NULL,
           lease_token=NULL,lease_expires_at=NULL,safe_last_error_code='OUTBOX_DELIVERY_FAILED',
           available_at=clock_timestamp()+($4::bigint * interval '1 millisecond'),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND outbox_id=$2`, [lease.tenantId, lease.outboxId, state, delay],
      );
      return detachedFrozen({ tenantId: lease.tenantId, outboxId: lease.outboxId, state,
        attemptCount: row.attempt_count, safeErrorCode: "OUTBOX_DELIVERY_FAILED" });
    });
  },

  async putConcurrencyPolicy(contextInput, policyInput) {
    const context = requireControlCapability(contextInput, "configuration.admin");
    const policy = parsePolicy(policyInput);
    return withOrchestrationTransaction(pool, options, async (client) => {
      await acquireAdvisoryLocks(client, [configurationLock(context.tenantId), capacityGlobalLock(context.tenantId)]);
      const current = await client.query<{ policy_version: string }>(
        "SELECT policy_version::text FROM orchestration_concurrency_policies WHERE tenant_id=$1 FOR UPDATE",
        [context.tenantId],
      );
      const version = current.rows[0]?.policy_version;
      if (policy.expectedVersion !== undefined && version !== policy.expectedVersion) {
        throw new OrchestrationError("CONFIGURATION_CONFLICT");
      }
      if (version === undefined) {
        await client.query(
          `INSERT INTO orchestration_concurrency_policies
             (tenant_id,global_limit,repository_limit,service_limit)
           VALUES ($1,$2,$3,$4)`, [context.tenantId, policy.globalLimit, policy.repositoryLimit, policy.serviceLimit],
        );
      } else {
        await client.query(
          `UPDATE orchestration_concurrency_policies SET policy_version=policy_version+1,
             global_limit=$2,repository_limit=$3,service_limit=$4,updated_at=clock_timestamp()
           WHERE tenant_id=$1`, [context.tenantId, policy.globalLimit, policy.repositoryLimit, policy.serviceLimit],
        );
      }
      return detachedFrozen({ tenantId: context.tenantId,
        policyVersion: version === undefined ? "1" : (BigInt(version) + 1n).toString(),
        globalLimit: policy.globalLimit, repositoryLimit: policy.repositoryLimit, serviceLimit: policy.serviceLimit });
    });
  },
});
