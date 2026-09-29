import type { Pool } from "pg";

import { detachedFrozen } from "./canonical.js";
import { requireControlCapability } from "./authorization.js";
import { withOrchestrationTransaction } from "./database.js";
import { OrchestrationError } from "./errors.js";
import { parseEventStatus, parseJobStatus, parseOutboxStatus,
  type EventStatus, type JobStatus } from "./schemas.js";
import type { OutboxStatus } from "./schemas.js";

const invalidStored = (): never => { throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false }); };
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || /[\u0000-\u001f]/.test(value)) throw new OrchestrationError("JOB_NOT_FOUND_OR_DENIED");
  return value;
};
const iso = (value: Date | null): string | undefined => value === null ? undefined : value.toISOString();

export const readEventStatus = async (pool: Pool, options: { schema: string }, contextInput: unknown,
  producerInput: unknown, eventInput: unknown): Promise<EventStatus> => {
  const context = requireControlCapability(contextInput, "orchestration.status.read");
  const producerId = identifier(producerInput);
  const eventId = identifier(eventInput);
  return withOrchestrationTransaction(pool, options, async (client) => {
    const event = await client.query<{ event_sha256: string; first_received_at: Date }>(
      `SELECT event_sha256,first_received_at FROM orchestration_events
       WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`, [context.tenantId, producerId, eventId],
    );
    const stored = event.rows[0];
    if (stored === undefined) throw new OrchestrationError("JOB_NOT_FOUND_OR_DENIED");
    if (!/^sha256:[0-9a-f]{64}$/.test(stored.event_sha256)) invalidStored();
    const targets = await client.query<{ disposition: string; count: number }>(
      `SELECT disposition,count(*)::int AS count FROM orchestration_event_targets
       WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3 GROUP BY disposition`,
      [context.tenantId, producerId, eventId],
    );
    const deliveries = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM orchestration_event_deliveries
       WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`, [context.tenantId, producerId, eventId],
    );
    if (targets.rows.length === 0 || deliveries.rows[0]?.count === 0) invalidStored();
    const counts: Record<string, number> = {};
    for (const row of targets.rows) counts[row.disposition] = row.count;
    const status = { eventId: `event-${stored.event_sha256.slice("sha256:".length)}`,
      outcome: deliveries.rows[0]!.count > 1 ? "duplicate" : "accepted",
      disposition: targets.rows.length === 1 ? targets.rows[0]!.disposition : "mixed",
      dispositionCounts: counts, receivedAt: iso(stored.first_received_at) };
    const parsed = parseEventStatus(status);
    if (!parsed.ok) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
    return detachedFrozen(parsed.value);
  });
};

export const readJobStatus = async (pool: Pool, options: { schema: string }, contextInput: unknown,
  jobInput: unknown): Promise<JobStatus> => {
  const context = requireControlCapability(contextInput, "orchestration.status.read");
  const jobId = identifier(jobInput);
  return withOrchestrationTransaction(pool, options, async (client) => {
    const selected = await client.query<{
      kind: string; state: string; attempt_count: string; max_attempts: string;
      created_at: Date; started_at: Date | null; completed_at: Date | null;
      coverage_status: string | null; safe_last_error_code: string | null;
    }>(
      `SELECT job.kind,job.state,job.attempt_count::text,job.max_attempts::text,
              job.created_at,job.started_at,job.completed_at,job.safe_last_error_code,
              result.coverage_status
       FROM orchestration_jobs job
       LEFT JOIN orchestration_job_results result ON result.tenant_id=job.tenant_id
         AND result.job_id=job.job_id
       WHERE job.tenant_id=$1 AND job.job_id=$2`, [context.tenantId, jobId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new OrchestrationError("JOB_NOT_FOUND_OR_DENIED");
    const status = { jobId, kind: row.kind, state: row.state,
      attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
      createdAt: iso(row.created_at),
      ...(iso(row.started_at) === undefined ? {} : { startedAt: iso(row.started_at) }),
      ...(iso(row.completed_at) === undefined ? {} : { completedAt: iso(row.completed_at) }),
      ...(row.coverage_status === null ? {} : { coverageStatus: row.coverage_status }),
      ...(row.safe_last_error_code === null ? {} : { safeErrorCode: row.safe_last_error_code }) };
    const parsed = parseJobStatus(status);
    if (!parsed.ok) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
    return detachedFrozen(parsed.value);
  });
};

export const readOutboxStatus = async (pool: Pool, options: { schema: string }, contextInput: unknown,
  outboxInput: unknown): Promise<OutboxStatus> => {
  const context = requireControlCapability(contextInput, "orchestration.status.read");
  const outboxId = identifier(outboxInput);
  return withOrchestrationTransaction(pool, options, async (client) => {
    const selected = await client.query<{ state: string; attempt_count: string; max_attempts: string;
      safe_last_error_code: string | null }>(
      `SELECT state,attempt_count::text,max_attempts::text,safe_last_error_code
       FROM orchestration_outbox WHERE tenant_id=$1 AND outbox_id=$2`, [context.tenantId, outboxId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new OrchestrationError("JOB_NOT_FOUND_OR_DENIED");
    const status = { outboxId, state: row.state, attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      ...(row.safe_last_error_code === null ? {} : { safeErrorCode: row.safe_last_error_code }) };
    const parsed = parseOutboxStatus(status);
    if (!parsed.ok) throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
    return detachedFrozen(parsed.value);
  });
};
