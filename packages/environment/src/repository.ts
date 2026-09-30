import type { Pool } from "pg";

import { parseEvent } from "@api-truth/ir";
import { eventSha256, requireWorkerCapability } from "@api-truth/orchestration";
import { EnvironmentError } from "./errors.js";
import { quoteEnvironmentSchema } from "./migrations.js";

type EventIdentity = Readonly<{ tenantId: string; producerId: string; eventId: string }>;
type AttemptPayload = Readonly<{
  change_kind: "attempt"; deployment_id: string; environment: string;
  attempt_state: "pending" | "succeeded" | "failed" | "rollback_requested" | "rolled_back";
  effective_order: string; artifact_id?: string; target_revision?: string;
  configuration_digest?: string;
  revision: Readonly<{ state: "known"; revision: string }> | Readonly<{ state: "unknown"; reason: string }>;
}>;
type RecordResult = Readonly<{
  outcome: "inserted" | "existing";
  artifactBinding: "inserted" | "existing" | "unavailable";
}>;

const ID = /^[^\u0000-\u001f]{1,512}$/;
const parseIdentity = (input: unknown): EventIdentity => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== 3
      || !["tenantId", "producerId", "eventId"].every((key) =>
        descriptors[key] !== undefined && "value" in descriptors[key]
        && typeof descriptors[key].value === "string" && ID.test(descriptors[key].value))) throw new Error();
    return Object.freeze({ tenantId: descriptors.tenantId!.value as string,
      producerId: descriptors.producerId!.value as string, eventId: descriptors.eventId!.value as string });
  } catch { throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT"); }
};

export type EnvironmentRepository = Readonly<{
  recordAttempt(workerIdentity: unknown, eventIdentity: unknown): Promise<RecordResult>;
}>;

export const createEnvironmentRepository = (pool: Pool, options: { schema: string }): EnvironmentRepository => {
  const schema = quoteEnvironmentSchema(options.schema);
  return Object.freeze({
    async recordAttempt(workerIdentity: unknown, eventIdentity: unknown): Promise<RecordResult> {
      requireWorkerCapability(workerIdentity, "jobs.execute");
      const identity = parseIdentity(eventIdentity);
      const client = await pool.connect().catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); });
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
        const selected = await client.query<{
          event_sha256: string; document: unknown; repository_id: string; active_config_fingerprint: string | null;
          target_repository_id: string; service_id: string;
        }>(
          `SELECT event.event_sha256,event.document,event.repository_id,event.active_config_fingerprint,
                  target.repository_id AS target_repository_id,target.service_id
           FROM orchestration_events event
           JOIN orchestration_event_targets target ON target.tenant_id=event.tenant_id
             AND target.producer_id=event.producer_id AND target.event_id=event.event_id
           WHERE event.tenant_id=$1 AND event.producer_id=$2 AND event.event_id=$3
             AND target.scope_key='deferred' AND target.disposition='deferred_handler'`,
          [identity.tenantId, identity.producerId, identity.eventId],
        );
        if (selected.rows.length !== 1) throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
        const row = selected.rows[0]!;
        const parsed = parseEvent(row.document);
        if (!parsed.ok || parsed.value.event_type !== "deployment.changed"
          || (parsed.value.payload as { change_kind?: unknown }).change_kind !== "attempt") {
          throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
        }
        const event = parsed.value;
        const payload = event.payload as AttemptPayload;
        if (eventSha256(event) !== row.event_sha256
          || event.event_id !== identity.eventId || event.producer.producer_id !== identity.producerId
          || event.subjects.repository_id !== row.repository_id
          || event.subjects.repository_id !== row.target_repository_id
          || event.subjects.service_ids.length !== 1 || event.subjects.service_ids[0] !== row.service_id
          || (event.subjects.environment !== undefined && event.subjects.environment !== payload.environment)
          || row.active_config_fingerprint === null) {
          throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
        }
        const revision = payload.revision.state === "known" ? payload.revision.revision : null;
        const insertion = await client.query<{ event_id: string }>(
          `INSERT INTO environment_deployment_attempts
           (tenant_id,producer_id,event_id,repository_id,service_id,environment,deployment_id,
            attempt_state,effective_order,artifact_id,revision_state,revision,target_revision,
            configuration_digest,active_config_fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (tenant_id,producer_id,event_id) DO NOTHING RETURNING event_id`,
          [identity.tenantId, identity.producerId, identity.eventId, row.repository_id,
            row.service_id, payload.environment, payload.deployment_id, payload.attempt_state,
            payload.effective_order, payload.artifact_id ?? null, payload.revision.state, revision,
            payload.target_revision ?? null, payload.configuration_digest ?? null, row.active_config_fingerprint],
        );
        let artifactBinding: RecordResult["artifactBinding"] = "unavailable";
        if (revision !== null && payload.artifact_id !== undefined) {
          const bound = await client.query<{ revision: string }>(
            `INSERT INTO environment_artifact_bindings
             (tenant_id,repository_id,service_id,artifact_id,revision,first_producer_id,first_event_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id,repository_id,service_id,artifact_id) DO NOTHING RETURNING revision`,
            [identity.tenantId, row.repository_id, row.service_id, payload.artifact_id, revision,
              identity.producerId, identity.eventId],
          );
          if (bound.rows[0] !== undefined) artifactBinding = "inserted";
          else {
            const existing = await client.query<{ revision: string }>(
              `SELECT revision FROM environment_artifact_bindings
               WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND artifact_id=$4`,
              [identity.tenantId, row.repository_id, row.service_id, payload.artifact_id],
            );
            if (existing.rows[0]?.revision !== revision) throw new EnvironmentError("ARTIFACT_BINDING_CONFLICT");
            artifactBinding = "existing";
          }
        }
        await client.query("COMMIT");
        return Object.freeze({ outcome: insertion.rows.length === 0 ? "existing" : "inserted", artifactBinding });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof EnvironmentError) throw error;
        throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
      } finally { client.release(); }
    },
  });
};
