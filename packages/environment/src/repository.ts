import type { Pool, PoolClient } from "pg";

import { parseEvent } from "@api-truth/ir";
import { eventSha256, requireWorkerCapability } from "@api-truth/orchestration";
import { EnvironmentError } from "./errors.js";
import { quoteEnvironmentSchema } from "./migrations.js";
import { classifyServingObservation, type ServingObservationClassification } from "./ordering.js";

type EventIdentity = Readonly<{ tenantId: string; producerId: string; eventId: string }>;
type AttemptPayload = Readonly<{
  change_kind: "attempt"; deployment_id: string; environment: string;
  attempt_state: "pending" | "succeeded" | "failed" | "rollback_requested" | "rolled_back";
  effective_order: string; artifact_id?: string; target_revision?: string;
  configuration_digest?: string;
  revision: Readonly<{ state: "known"; revision: string }> | Readonly<{ state: "unknown"; reason: string }>;
}>;
type ServingPayload = Readonly<{
  change_kind: "serving_observation"; observation_id: string; environment: string;
  source: Readonly<{ authority_id: string; reference: string; access_label: string }>;
  completeness: "complete" | "incomplete" | "transitional";
  effective_order: string; rollback_request_id?: string;
  serving_state: Readonly<{ status: "known"; inventory: Array<Readonly<{ artifact_id: string;
    revision: Readonly<{ state: "known"; revision: string }> | Readonly<{ state: "unknown"; reason: string }> }>> }>
    | Readonly<{ status: "unknown"; reason: string; observed_artifact_ids?: string[] }>;
}>;
type RecordResult = Readonly<{
  outcome: "inserted" | "existing";
  artifactBinding: "inserted" | "existing" | "unavailable";
}>;
type RecordServingResult = Readonly<{
  outcome: "inserted" | "existing";
  disposition: "applied" | "stale" | "replay" | "reconciliation_required";
}>;
export type ServingReconciliationTicket = Readonly<{
  tenantId: string; repositoryId: string; serviceId: string; environment: string;
  pendingProducerId: string; pendingEventId: string; version: string; configFingerprint: string;
}>;

type StoredDeploymentEvent = Readonly<{
  row: Readonly<{ repository_id: string; service_id: string; active_config_fingerprint: string }>;
  event: Extract<ReturnType<typeof parseEvent>, { ok: true }>["value"];
}>;

const loadDeploymentEvent = async (client: PoolClient, identity: EventIdentity,
  kind: "attempt" | "serving_observation"): Promise<StoredDeploymentEvent> => {
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
    || (parsed.value.payload as { change_kind?: unknown }).change_kind !== kind) {
    throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
  }
  const event = parsed.value;
  const payload = event.payload as { environment: string };
  if (eventSha256(event) !== row.event_sha256
    || event.event_id !== identity.eventId || event.producer.producer_id !== identity.producerId
    || event.subjects.repository_id !== row.repository_id
    || event.subjects.repository_id !== row.target_repository_id
    || event.subjects.service_ids.length !== 1 || event.subjects.service_ids[0] !== row.service_id
    || (event.subjects.environment !== undefined && event.subjects.environment !== payload.environment)
    || row.active_config_fingerprint === null) {
    throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
  }
  return { row: { repository_id: row.repository_id, service_id: row.service_id,
    active_config_fingerprint: row.active_config_fingerprint }, event };
};

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

const parseFields = <K extends string>(input: unknown, keys: readonly K[]): Record<K, string> => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== keys.length || !keys.every((key) =>
      descriptors[key] !== undefined && "value" in descriptors[key]
      && typeof descriptors[key].value === "string" && ID.test(descriptors[key].value))) throw new Error();
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]))) as Record<K, string>;
  } catch { throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT"); }
};

const scopeKeys = ["tenantId", "repositoryId", "serviceId", "environment"] as const;
const ticketKeys = [...scopeKeys, "pendingProducerId", "pendingEventId", "version", "configFingerprint"] as const;
const servingInventory = (payload: ServingPayload): string | null => payload.serving_state.status === "known"
  ? JSON.stringify([...payload.serving_state.inventory].sort((left, right) =>
    left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0)
    .map((item) => ({ artifact_id: item.artifact_id,
      revision: item.revision.state === "known"
        ? { state: "known", revision: item.revision.revision } : { state: "unknown" } }))) : null;

const insertServingObservation = async (client: PoolClient, identity: EventIdentity,
  row: StoredDeploymentEvent["row"], payload: ServingPayload,
  disposition: RecordServingResult["disposition"]): Promise<void> => {
  await client.query(
    `INSERT INTO environment_serving_observations
     (tenant_id,producer_id,event_id,repository_id,service_id,environment,observation_id,
      source_authority_id,source_access_label,effective_order,completeness,serving_status,
      inventory,rollback_request_id,active_config_fingerprint,disposition)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
    [identity.tenantId, identity.producerId, identity.eventId, row.repository_id, row.service_id,
      payload.environment, payload.observation_id, payload.source.authority_id,
      payload.source.access_label, payload.effective_order, payload.completeness,
      payload.serving_state.status, servingInventory(payload), payload.rollback_request_id ?? null,
      row.active_config_fingerprint, disposition],
  );
};

export type EnvironmentRepository = Readonly<{
  recordAttempt(workerIdentity: unknown, eventIdentity: unknown): Promise<RecordResult>;
  recordServingObservation(workerIdentity: unknown, eventIdentity: unknown): Promise<RecordServingResult>;
  getPendingServingReconciliation(workerIdentity: unknown, scope: unknown): Promise<ServingReconciliationTicket | undefined>;
  confirmServingReconciliation(workerIdentity: unknown, ticket: unknown, eventIdentity: unknown):
    Promise<Readonly<{ outcome: "applied" | "pending" | "superseded" }>>;
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
        const { row, event } = await loadDeploymentEvent(client, identity, "attempt");
        const payload = event.payload as AttemptPayload;
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
    async recordServingObservation(workerIdentity: unknown, eventIdentity: unknown): Promise<RecordServingResult> {
      requireWorkerCapability(workerIdentity, "jobs.execute");
      const identity = parseIdentity(eventIdentity);
      const client = await pool.connect().catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); });
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
        const { row, event } = await loadDeploymentEvent(client, identity, "serving_observation");
        const payload = event.payload as ServingPayload;
        const scope = [identity.tenantId, row.repository_id, row.service_id, payload.environment];
        await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
          JSON.stringify(["api-truth:environment-serving", ...scope]),
        ]);
        const prior = await client.query<{ disposition: RecordServingResult["disposition"] }>(
          `SELECT disposition FROM environment_serving_observations
           WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`,
          [identity.tenantId, identity.producerId, identity.eventId],
        );
        if (prior.rows[0] !== undefined) {
          await client.query("COMMIT");
          return Object.freeze({ outcome: "existing", disposition: prior.rows[0].disposition });
        }
        const activeConfig = await client.query<{ config_fingerprint: string }>(
          `SELECT config_fingerprint FROM orchestration_active_configurations
           WHERE tenant_id=$1 FOR SHARE`, [identity.tenantId],
        );
        if (activeConfig.rows.length !== 1) throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
        const checkpoint = await client.query<{ current_producer_id: string | null; current_event_id: string | null }>(
          `SELECT current_producer_id,current_event_id FROM environment_serving_checkpoints
           WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4 FOR UPDATE`, scope,
        );
        let currentEvent: unknown;
        if (checkpoint.rows[0]?.current_event_id !== null && checkpoint.rows[0]?.current_event_id !== undefined) {
          const current = await client.query<{ document: unknown }>(
            `SELECT event.document FROM orchestration_events event
             JOIN environment_serving_observations observation ON observation.tenant_id=event.tenant_id
               AND observation.producer_id=event.producer_id AND observation.event_id=event.event_id
             WHERE observation.tenant_id=$1 AND observation.repository_id=$2
               AND observation.service_id=$3 AND observation.environment=$4
               AND observation.producer_id=$5 AND observation.event_id=$6`,
            [...scope, checkpoint.rows[0]!.current_producer_id, checkpoint.rows[0]!.current_event_id],
          );
          if (current.rows.length !== 1) throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
          currentEvent = current.rows[0]!.document;
        }
        const classification: ServingObservationClassification = activeConfig.rows[0]!.config_fingerprint
          === row.active_config_fingerprint ? classifyServingObservation(currentEvent, event) : "reconcile";
        const disposition: RecordServingResult["disposition"] = classification === "apply" ? "applied"
          : classification === "reconcile" ? "reconciliation_required" : classification;
        await insertServingObservation(client, identity, row, payload, disposition);
        if (classification === "apply") {
          const needsReconciliation = payload.completeness !== "complete"
            || payload.serving_state.status === "unknown";
          await client.query(
            `INSERT INTO environment_serving_checkpoints AS checkpoint
             (tenant_id,repository_id,service_id,environment,current_producer_id,current_event_id,
              pending_producer_id,pending_event_id,reconciliation_required)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (tenant_id,repository_id,service_id,environment) DO UPDATE SET
               current_producer_id=EXCLUDED.current_producer_id,current_event_id=EXCLUDED.current_event_id,
               pending_producer_id=EXCLUDED.pending_producer_id,pending_event_id=EXCLUDED.pending_event_id,
               reconciliation_required=EXCLUDED.reconciliation_required,
               version=checkpoint.version+1,updated_at=clock_timestamp()`,
            [...scope, identity.producerId, identity.eventId,
              needsReconciliation ? identity.producerId : null,
              needsReconciliation ? identity.eventId : null, needsReconciliation],
          );
        } else if (classification === "reconcile") {
          await client.query(
            `INSERT INTO environment_serving_checkpoints AS checkpoint
             (tenant_id,repository_id,service_id,environment,pending_producer_id,pending_event_id,reconciliation_required)
             VALUES ($1,$2,$3,$4,$5,$6,true)
             ON CONFLICT (tenant_id,repository_id,service_id,environment) DO UPDATE SET
               pending_producer_id=EXCLUDED.pending_producer_id,pending_event_id=EXCLUDED.pending_event_id,
               reconciliation_required=true,version=checkpoint.version+1,updated_at=clock_timestamp()`,
            [...scope, identity.producerId, identity.eventId],
          );
        }
        await client.query("COMMIT");
        return Object.freeze({ outcome: "inserted", disposition });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof EnvironmentError) throw error;
        throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
      } finally { client.release(); }
    },
    async getPendingServingReconciliation(workerIdentity: unknown, scopeInput: unknown):
      Promise<ServingReconciliationTicket | undefined> {
      requireWorkerCapability(workerIdentity, "jobs.execute");
      const scope = parseFields(scopeInput, scopeKeys);
      const client = await pool.connect().catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); });
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
        const result = await client.query<{ pending_producer_id: string; pending_event_id: string;
          version: string; config_fingerprint: string }>(
          `SELECT checkpoint.pending_producer_id,checkpoint.pending_event_id,checkpoint.version::text,
                  active.config_fingerprint
           FROM environment_serving_checkpoints checkpoint
           JOIN orchestration_active_configurations active ON active.tenant_id=checkpoint.tenant_id
           WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2 AND checkpoint.service_id=$3
             AND checkpoint.environment=$4 AND checkpoint.reconciliation_required=true`,
          [scope.tenantId, scope.repositoryId, scope.serviceId, scope.environment],
        );
        await client.query("COMMIT");
        const pending = result.rows[0];
        return pending === undefined ? undefined : Object.freeze({ ...scope,
          pendingProducerId: pending.pending_producer_id, pendingEventId: pending.pending_event_id,
          version: pending.version, configFingerprint: pending.config_fingerprint });
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
      } finally { client.release(); }
    },
    async confirmServingReconciliation(workerIdentity: unknown, ticketInput: unknown,
      eventIdentity: unknown): Promise<Readonly<{ outcome: "applied" | "pending" | "superseded" }>> {
      requireWorkerCapability(workerIdentity, "jobs.execute");
      const ticket = parseFields(ticketInput, ticketKeys);
      if (!/^[1-9][0-9]*$/.test(ticket.version)) throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
      const identity = parseIdentity(eventIdentity);
      if (identity.tenantId !== ticket.tenantId) throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
      const client = await pool.connect().catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); });
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
        const { row, event } = await loadDeploymentEvent(client, identity, "serving_observation");
        const payload = event.payload as ServingPayload;
        if (row.repository_id !== ticket.repositoryId || row.service_id !== ticket.serviceId
          || payload.environment !== ticket.environment) throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
        const scope = [ticket.tenantId, ticket.repositoryId, ticket.serviceId, ticket.environment];
        await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
          JSON.stringify(["api-truth:environment-serving", ...scope]),
        ]);
        const active = await client.query<{ config_fingerprint: string }>(
          `SELECT config_fingerprint FROM orchestration_active_configurations WHERE tenant_id=$1 FOR SHARE`,
          [ticket.tenantId],
        );
        const checkpoint = await client.query<{ version: string; pending_producer_id: string | null;
          pending_event_id: string | null }>(
          `SELECT version::text,pending_producer_id,pending_event_id
           FROM environment_serving_checkpoints
           WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4 FOR UPDATE`, scope,
        );
        const valid = checkpoint.rows[0]?.version === ticket.version
          && checkpoint.rows[0]?.pending_producer_id === ticket.pendingProducerId
          && checkpoint.rows[0]?.pending_event_id === ticket.pendingEventId
          && active.rows[0]?.config_fingerprint === ticket.configFingerprint
          && row.active_config_fingerprint === ticket.configFingerprint;
        if (!valid) {
          await client.query("COMMIT");
          return Object.freeze({ outcome: "superseded" });
        }
        const prior = await client.query(
          `SELECT 1 FROM environment_serving_observations
           WHERE tenant_id=$1 AND producer_id=$2 AND event_id=$3`,
          [identity.tenantId, identity.producerId, identity.eventId],
        );
        if (prior.rows.length !== 0) throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
        const complete = payload.completeness === "complete" && payload.serving_state.status === "known";
        await insertServingObservation(client, identity, row, payload,
          complete ? "applied" : "reconciliation_required");
        await client.query(
          `UPDATE environment_serving_checkpoints SET
             current_producer_id=$5,current_event_id=$6,
             pending_producer_id=$7,pending_event_id=$8,reconciliation_required=$9,
             version=version+1,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,
          [...scope, identity.producerId, identity.eventId,
            complete ? null : identity.producerId, complete ? null : identity.eventId, !complete],
        );
        await client.query("COMMIT");
        return Object.freeze({ outcome: complete ? "applied" : "pending" });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof EnvironmentError) throw error;
        throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
      } finally { client.release(); }
    },
  });
};
