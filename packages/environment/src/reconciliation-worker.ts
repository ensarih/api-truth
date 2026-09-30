import { randomUUID } from "node:crypto";
import { requireWorkerCapability } from "@api-truth/orchestration";
import type { Pool, PoolClient } from "pg";

import { EnvironmentError, type EnvironmentErrorCode } from "./errors.js";
import { quoteEnvironmentSchema } from "./migrations.js";

export type EnvironmentReconciliationScope = Readonly<{
  tenantId: string; repositoryId: string; serviceId: string; environment: string;
}>;
export type EnvironmentReconciliationPort = Readonly<{
  reconcile(scope: EnvironmentReconciliationScope): Promise<Readonly<{
    outcome: "no_pending" | "applied" | "pending" | "superseded";
  }>>;
}>;
export type EnvironmentReconciliationOutcome = Readonly<{
  scope: EnvironmentReconciliationScope;
  state: "resolved" | "retry_wait" | "exhausted" | "lease_lost";
}>;
export type EnvironmentReconciliationWorker = Readonly<{
  drain(workerIdentity: unknown, limit?: number): Promise<readonly EnvironmentReconciliationOutcome[]>;
}>;
type Claimed = EnvironmentReconciliationScope & Readonly<{
  leaseToken: string; attemptCount: number; maxAttempts: number; requestGeneration: string;
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

export const createEnvironmentReconciliationWorker = (pool: Pool,
  options: { schema: string; reconcileAfterMs?: number },
  port: EnvironmentReconciliationPort): EnvironmentReconciliationWorker => {
  const schema = quoteEnvironmentSchema(options.schema);
  const reconcileAfterMs = options.reconcileAfterMs ?? 3_600_000;
  if (!Number.isSafeInteger(reconcileAfterMs) || reconcileAfterMs < 1 || reconcileAfterMs > 604_800_000)
    throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
  const claimNext = async (): Promise<Claimed | undefined> => withClient(pool, schema, async (client) => {
    await client.query(
      `INSERT INTO environment_serving_checkpoints
         (tenant_id,repository_id,service_id,environment,reconciliation_required)
       SELECT active.tenant_id,repository.document->>'repository_id',service.document->>'service_id',
              environment.document->>'name',true
       FROM orchestration_active_configurations active
       JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
         AND configuration.config_fingerprint=active.config_fingerprint
       CROSS JOIN LATERAL jsonb_array_elements(configuration.document->'repositories') repository(document)
       CROSS JOIN LATERAL jsonb_array_elements(repository.document->'services') service(document)
       CROSS JOIN LATERAL jsonb_array_elements(service.document->'environments') environment(document)
       WHERE NOT EXISTS (
         SELECT 1 FROM environment_serving_checkpoints checkpoint
         WHERE checkpoint.tenant_id=active.tenant_id
           AND checkpoint.repository_id=repository.document->>'repository_id'
           AND checkpoint.service_id=service.document->>'service_id'
           AND checkpoint.environment=environment.document->>'name'
       )
       ORDER BY active.tenant_id COLLATE "C",repository.document->>'repository_id',
                service.document->>'service_id',environment.document->>'name'
       LIMIT 128 ON CONFLICT DO NOTHING`,
    );
    await client.query(
      `UPDATE environment_serving_checkpoints checkpoint
       SET reconciliation_required=true,version=checkpoint.version+1,updated_at=clock_timestamp()
       FROM orchestration_active_configurations active
       JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
         AND configuration.config_fingerprint=active.config_fingerprint
       WHERE checkpoint.tenant_id=active.tenant_id AND NOT checkpoint.reconciliation_required
         AND ((SELECT observation.active_config_fingerprint
              FROM environment_serving_observations observation
              WHERE observation.tenant_id=checkpoint.tenant_id
                AND observation.repository_id=checkpoint.repository_id
                AND observation.service_id=checkpoint.service_id
                AND observation.environment=checkpoint.environment
                AND observation.producer_id=checkpoint.current_producer_id
                AND observation.event_id=checkpoint.current_event_id)
             IS DISTINCT FROM active.config_fingerprint
           OR checkpoint.updated_at<=clock_timestamp()-($1::bigint*interval '1 millisecond'))
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(configuration.document->'repositories') repository(document)
           CROSS JOIN LATERAL jsonb_array_elements(repository.document->'services') service(document)
           CROSS JOIN LATERAL jsonb_array_elements(service.document->'environments') environment(document)
           WHERE repository.document->>'repository_id'=checkpoint.repository_id
             AND service.document->>'service_id'=checkpoint.service_id
             AND environment.document->>'name'=checkpoint.environment
         )`, [reconcileAfterMs],
    );
    await client.query(
      `INSERT INTO environment_reconciliation_tasks AS task
         (tenant_id,repository_id,service_id,environment,checkpoint_version)
       SELECT checkpoint.tenant_id,checkpoint.repository_id,checkpoint.service_id,
              checkpoint.environment,checkpoint.version
       FROM environment_serving_checkpoints checkpoint
       LEFT JOIN environment_reconciliation_tasks existing
         ON existing.tenant_id=checkpoint.tenant_id AND existing.repository_id=checkpoint.repository_id
         AND existing.service_id=checkpoint.service_id AND existing.environment=checkpoint.environment
       WHERE checkpoint.reconciliation_required
         AND (existing.checkpoint_version IS DISTINCT FROM checkpoint.version OR existing.state='resolved')
         AND EXISTS (
           SELECT 1 FROM orchestration_active_configurations active
           JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
             AND configuration.config_fingerprint=active.config_fingerprint
           CROSS JOIN LATERAL jsonb_array_elements(configuration.document->'repositories') repository(document)
           CROSS JOIN LATERAL jsonb_array_elements(repository.document->'services') service(document)
           CROSS JOIN LATERAL jsonb_array_elements(service.document->'environments') environment(document)
           WHERE active.tenant_id=checkpoint.tenant_id
             AND repository.document->>'repository_id'=checkpoint.repository_id
             AND service.document->>'service_id'=checkpoint.service_id
             AND environment.document->>'name'=checkpoint.environment
         )
       ORDER BY checkpoint.tenant_id COLLATE "C",checkpoint.repository_id COLLATE "C",
                checkpoint.service_id COLLATE "C",checkpoint.environment COLLATE "C"
       LIMIT 128
       ON CONFLICT (tenant_id,repository_id,service_id,environment) DO UPDATE SET
         checkpoint_version=EXCLUDED.checkpoint_version,state='queued',attempt_count=0,
         available_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,
         safe_last_error_code=NULL,resolved_at=NULL
       WHERE task.checkpoint_version IS DISTINCT FROM EXCLUDED.checkpoint_version OR task.state='resolved'`,
    );
    await client.query(
      `UPDATE environment_reconciliation_tasks task SET state='resolved',resolved_at=clock_timestamp(),
         lease_token=NULL,lease_expires_at=NULL,safe_last_error_code=NULL
       WHERE task.state<>'resolved' AND NOT EXISTS (
         SELECT 1 FROM orchestration_active_configurations active
         JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
           AND configuration.config_fingerprint=active.config_fingerprint
         CROSS JOIN LATERAL jsonb_array_elements(configuration.document->'repositories') repository(document)
         CROSS JOIN LATERAL jsonb_array_elements(repository.document->'services') service(document)
         CROSS JOIN LATERAL jsonb_array_elements(service.document->'environments') environment(document)
         WHERE active.tenant_id=task.tenant_id
           AND repository.document->>'repository_id'=task.repository_id
           AND service.document->>'service_id'=task.service_id
           AND environment.document->>'name'=task.environment
       )`,
    );
    await client.query(
      `UPDATE environment_reconciliation_tasks task SET state='resolved',resolved_at=clock_timestamp(),
         lease_token=NULL,lease_expires_at=NULL,safe_last_error_code=NULL
       FROM environment_serving_checkpoints checkpoint
       WHERE checkpoint.tenant_id=task.tenant_id AND checkpoint.repository_id=task.repository_id
         AND checkpoint.service_id=task.service_id AND checkpoint.environment=task.environment
         AND NOT checkpoint.reconciliation_required AND task.state<>'resolved'`,
    );
    await client.query(
      `UPDATE environment_reconciliation_tasks SET state='exhausted',lease_token=NULL,lease_expires_at=NULL,
         safe_last_error_code='ENVIRONMENT_STORAGE_ERROR'
       WHERE state='leased' AND lease_expires_at<=clock_timestamp() AND attempt_count>=max_attempts`,
    );
    const selected = await client.query<{ tenant_id: string; repository_id: string;
      service_id: string; environment: string; attempt_count: string; max_attempts: string;
      request_generation: string }>(
      `SELECT task.tenant_id,task.repository_id,task.service_id,task.environment,
              task.attempt_count::text,task.max_attempts::text,checkpoint.request_generation::text
       FROM environment_reconciliation_tasks task
       JOIN environment_serving_checkpoints checkpoint ON checkpoint.tenant_id=task.tenant_id
         AND checkpoint.repository_id=task.repository_id AND checkpoint.service_id=task.service_id
         AND checkpoint.environment=task.environment
       WHERE checkpoint.reconciliation_required AND task.checkpoint_version=checkpoint.version
         AND EXISTS (
           SELECT 1 FROM orchestration_active_configurations active
           JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
             AND configuration.config_fingerprint=active.config_fingerprint
           CROSS JOIN LATERAL jsonb_array_elements(configuration.document->'repositories') repository(document)
           CROSS JOIN LATERAL jsonb_array_elements(repository.document->'services') service(document)
           CROSS JOIN LATERAL jsonb_array_elements(service.document->'environments') environment(document)
           WHERE active.tenant_id=task.tenant_id
             AND repository.document->>'repository_id'=task.repository_id
             AND service.document->>'service_id'=task.service_id
             AND environment.document->>'name'=task.environment
         )
         AND ((task.state IN ('queued','retry_wait') AND task.available_at<=clock_timestamp())
           OR (task.state='leased' AND task.lease_expires_at<=clock_timestamp()
             AND task.attempt_count<task.max_attempts))
       ORDER BY task.available_at,task.created_at,task.tenant_id COLLATE "C",
                task.repository_id COLLATE "C",task.service_id COLLATE "C",task.environment COLLATE "C"
       LIMIT 1 FOR UPDATE OF task SKIP LOCKED`,
    );
    const row = selected.rows[0];
    if (row === undefined) return undefined;
    const leaseToken = randomUUID();
    await client.query(
      `UPDATE environment_reconciliation_tasks SET state='leased',attempt_count=attempt_count+1,
         lease_token=$5,lease_expires_at=clock_timestamp()+interval '30 seconds',
         available_at=clock_timestamp(),safe_last_error_code=NULL
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,
      [row.tenant_id, row.repository_id, row.service_id, row.environment, leaseToken],
    );
    return Object.freeze({ tenantId: row.tenant_id, repositoryId: row.repository_id,
      serviceId: row.service_id, environment: row.environment, leaseToken,
      attemptCount: Number(row.attempt_count) + 1, maxAttempts: Number(row.max_attempts),
      requestGeneration: row.request_generation });
  });

  const finish = async (claimed: Claimed, result: "no_pending" | "applied" | "pending" | "superseded" | undefined,
    code?: EnvironmentErrorCode): Promise<EnvironmentReconciliationOutcome> => withClient(pool, schema,
    async (client) => {
      const scope = [claimed.tenantId, claimed.repositoryId, claimed.serviceId, claimed.environment];
      const state = result === "applied" || result === "no_pending" ? "resolved"
        : code !== undefined && (code !== "ENVIRONMENT_STORAGE_ERROR"
          || claimed.attemptCount >= claimed.maxAttempts) ? "exhausted" : "retry_wait";
      const updated = await client.query(
        `UPDATE environment_reconciliation_tasks task SET state=$6,lease_token=NULL,lease_expires_at=NULL,
           resolved_at=CASE WHEN $6='resolved' THEN clock_timestamp() ELSE NULL END,
           available_at=CASE WHEN $6='retry_wait' THEN clock_timestamp()+
             (LEAST(60000,1000*power(2,LEAST(attempt_count-1,6)))::bigint*interval '1 millisecond')
             ELSE task.available_at END,
           checkpoint_version=CASE WHEN $6='retry_wait' AND $7='pending'
             AND checkpoint.request_generation=$9::bigint
             THEN checkpoint.version ELSE task.checkpoint_version END,
           safe_last_error_code=$8
         FROM environment_serving_checkpoints checkpoint
         WHERE task.tenant_id=$1 AND task.repository_id=$2 AND task.service_id=$3
           AND task.environment=$4 AND task.lease_token=$5 AND task.state='leased'
           AND checkpoint.tenant_id=task.tenant_id AND checkpoint.repository_id=task.repository_id
           AND checkpoint.service_id=task.service_id AND checkpoint.environment=task.environment`,
        [...scope, claimed.leaseToken, state, result ?? null, code ?? null, claimed.requestGeneration],
      );
      return Object.freeze({ scope: Object.freeze({ tenantId: claimed.tenantId,
        repositoryId: claimed.repositoryId, serviceId: claimed.serviceId, environment: claimed.environment }),
        state: updated.rowCount === 1 ? state : "lease_lost" });
    });

  return Object.freeze({
    async drain(workerIdentity: unknown, limit = 32): Promise<readonly EnvironmentReconciliationOutcome[]> {
      requireWorkerCapability(workerIdentity, "jobs.execute");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
        throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
      const outcomes: EnvironmentReconciliationOutcome[] = [];
      for (let index = 0; index < limit; index += 1) {
        const claimed = await claimNext();
        if (claimed === undefined) break;
        const scope = { tenantId: claimed.tenantId, repositoryId: claimed.repositoryId,
          serviceId: claimed.serviceId, environment: claimed.environment };
        let result: "no_pending" | "applied" | "pending" | "superseded" | undefined;
        let code: EnvironmentErrorCode | undefined;
        try { result = (await port.reconcile(Object.freeze(scope))).outcome; }
        catch (error) { code = error instanceof EnvironmentError ? error.code : "ENVIRONMENT_STORAGE_ERROR"; }
        outcomes.push(await finish(claimed, result, code));
      }
      return Object.freeze(outcomes);
    },
  });
};
