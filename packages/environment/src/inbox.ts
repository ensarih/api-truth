import { randomUUID } from "node:crypto";
import { parseEvent } from "@api-truth/ir";
import { requireWorkerCapability } from "@api-truth/orchestration";
import type { Pool, PoolClient } from "pg";

import { EnvironmentError, type EnvironmentErrorCode } from "./errors.js";
import { quoteEnvironmentSchema } from "./migrations.js";
import type { EnvironmentRepository } from "./repository.js";

type Claimed = Readonly<{ tenantId: string; producerId: string; eventId: string;
  leaseToken: string; attemptCount: number; maxAttempts: number; document: unknown }>;
export type EnvironmentInboxOutcome = Readonly<{
  tenantId: string; producerId: string; eventId: string;
  state: "delivered" | "retry_wait" | "exhausted" | "lease_lost";
}>;
export type EnvironmentInboxWorker = Readonly<{
  drain(workerIdentity: unknown, limit?: number): Promise<readonly EnvironmentInboxOutcome[]>;
}>;

const withClient = async <T>(pool: Pool, schema: string,
  operation: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect().catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); });
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
  } finally { client.release(); }
};

export const createEnvironmentInboxWorker = (pool: Pool, options: { schema: string },
  environment: Pick<EnvironmentRepository, "recordAttempt" | "recordServingObservation">): EnvironmentInboxWorker => {
  const schema = quoteEnvironmentSchema(options.schema);
  const claimNext = async (): Promise<Claimed | undefined> => withClient(pool, schema, async (client) => {
    await client.query(
      `UPDATE environment_deployment_inbox SET state='exhausted',lease_token=NULL,lease_expires_at=NULL,
         safe_last_error_code='ENVIRONMENT_STORAGE_ERROR'
       WHERE state='leased' AND lease_expires_at<=clock_timestamp() AND attempt_count>=max_attempts`,
    );
    const selected = await client.query<{ tenant_id: string; producer_id: string; event_id: string;
      attempt_count: string; max_attempts: string; document: unknown }>(
      `SELECT inbox.tenant_id,inbox.producer_id,inbox.event_id,inbox.attempt_count::text,
              inbox.max_attempts::text,event.document
       FROM environment_deployment_inbox inbox
       JOIN orchestration_events event ON event.tenant_id=inbox.tenant_id
         AND event.producer_id=inbox.producer_id AND event.event_id=inbox.event_id
       WHERE (inbox.state IN ('pending','retry_wait') AND inbox.available_at<=clock_timestamp())
          OR (inbox.state='leased' AND inbox.lease_expires_at<=clock_timestamp()
              AND inbox.attempt_count<inbox.max_attempts)
       ORDER BY inbox.available_at,inbox.created_at,inbox.tenant_id COLLATE "C",
                inbox.producer_id COLLATE "C",inbox.event_id COLLATE "C"
       LIMIT 1 FOR UPDATE OF inbox SKIP LOCKED`,
    );
    const row = selected.rows[0];
    if (row === undefined) return undefined;
    const leaseToken = randomUUID();
    await client.query(
      `UPDATE environment_deployment_inbox SET state='leased',attempt_count=attempt_count+1,
         lease_token=$4,lease_expires_at=clock_timestamp()+interval '30 seconds',
         available_at=clock_timestamp(),safe_last_error_code=NULL
       WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`,
      [row.tenant_id, row.producer_id, row.event_id, leaseToken],
    );
    return Object.freeze({ tenantId: row.tenant_id, producerId: row.producer_id, eventId: row.event_id,
      leaseToken, attemptCount: Number(row.attempt_count) + 1,
      maxAttempts: Number(row.max_attempts), document: row.document });
  });

  const finish = async (claimed: Claimed, success: boolean, code?: EnvironmentErrorCode):
    Promise<EnvironmentInboxOutcome> => withClient(pool, schema, async (client) => {
      const state = success ? "delivered" : code !== "ENVIRONMENT_STORAGE_ERROR"
        || claimed.attemptCount >= claimed.maxAttempts ? "exhausted" : "retry_wait";
      const updated = await client.query(
        `UPDATE environment_deployment_inbox SET state=$5,lease_token=NULL,lease_expires_at=NULL,
           delivered_at=CASE WHEN $5='delivered' THEN clock_timestamp() ELSE NULL END,
           available_at=CASE WHEN $5='retry_wait' THEN clock_timestamp()+
             (LEAST(60000,1000*power(2,LEAST(attempt_count-1,6)))::bigint*interval '1 millisecond')
             ELSE available_at END,safe_last_error_code=$6
         WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3 AND lease_token=$4 AND state='leased'`,
        [claimed.tenantId, claimed.producerId, claimed.eventId, claimed.leaseToken, state, code ?? null],
      );
      return Object.freeze({ tenantId: claimed.tenantId, producerId: claimed.producerId,
        eventId: claimed.eventId, state: updated.rowCount === 1 ? state : "lease_lost" });
    });

  return Object.freeze({
    async drain(workerIdentity: unknown, limit = 32): Promise<readonly EnvironmentInboxOutcome[]> {
      requireWorkerCapability(workerIdentity, "jobs.execute");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
        throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
      const outcomes: EnvironmentInboxOutcome[] = [];
      for (let index = 0; index < limit; index += 1) {
        const claimed = await claimNext();
        if (claimed === undefined) break;
        let code: EnvironmentErrorCode | undefined;
        try {
          const parsed = parseEvent(claimed.document);
          if (!parsed.ok || parsed.value.event_type !== "deployment.changed"
            || parsed.value.event_id !== claimed.eventId
            || parsed.value.producer.producer_id !== claimed.producerId)
            throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
          const identity = { tenantId: claimed.tenantId, producerId: claimed.producerId, eventId: claimed.eventId };
          const kind = (parsed.value.payload as { change_kind?: unknown }).change_kind;
          if (kind === "attempt") await environment.recordAttempt(workerIdentity, identity);
          else if (kind === "serving_observation") await environment.recordServingObservation(workerIdentity, identity);
          else throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
        } catch (error) {
          code = error instanceof EnvironmentError ? error.code : "ENVIRONMENT_STORAGE_ERROR";
        }
        outcomes.push(await finish(claimed, code === undefined, code));
      }
      return Object.freeze(outcomes);
    },
  });
};
