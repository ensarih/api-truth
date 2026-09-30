import { parseConfig } from "@api-truth/ir";
import { createCatalogOrchestrationReader } from "@api-truth/catalog";
import { canonicalOrchestrationHash } from "@api-truth/orchestration";
import type { Pool, PoolClient } from "pg";

import { EnvironmentError } from "./errors.js";
import { quoteEnvironmentSchema } from "./migrations.js";
import { resolveEnvironment, type EnvironmentResolution, type EnvironmentResolutionInput } from "./resolution.js";

type Principal = Readonly<{ tenantId: string; principalId: string }>;
type EnvironmentKey = Readonly<{ repositoryId: string; serviceId: string; environment: string }>;
export type EnvironmentView = Readonly<EnvironmentResolution & {
  repositoryId: string; serviceId: string; environment: string;
  configFingerprint: string; checkpointVersion?: string; reconciliationRequired: boolean;
}>;
export type EnvironmentViewRepository = Readonly<{
  getEnvironment(context: unknown, key: unknown): Promise<EnvironmentView>;
}>;

const ID = /^[^\u0000-\u001f]{1,512}$/;
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

const hasScopes = async (client: PoolClient, principal: Principal, scopes: readonly string[]): Promise<boolean> => {
  const unique = [...new Set(scopes)];
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM access_scopes scope
     JOIN principal_scope_grants grant_row ON grant_row.tenant_id=scope.tenant_id
       AND grant_row.access_scope_id=scope.access_scope_id
     WHERE scope.tenant_id=$1 AND grant_row.principal_id=$2
       AND scope.access_scope_id=ANY($3::text[]) AND scope.active AND grant_row.active`,
    [principal.tenantId, principal.principalId, unique],
  );
  return result.rows[0]?.count === String(unique.length);
};

const readInventory = (value: unknown): NonNullable<EnvironmentResolutionInput["observation"]>["serving_state"] => {
  if (!Array.isArray(value)) throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
  const inventory = value.map((item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
    const row = item as Record<string, unknown>;
    const reference = row.revision;
    if (typeof row.artifact_id !== "string" || row.artifact_id.length === 0
      || reference === null || typeof reference !== "object" || Array.isArray(reference))
      throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
    const revision = reference as Record<string, unknown>;
    if (revision.state === "known" && typeof revision.revision === "string" && revision.revision.length > 0)
      return { artifact_id: row.artifact_id, revision: { state: "known" as const, revision: revision.revision } };
    if (revision.state === "unknown")
      return { artifact_id: row.artifact_id, revision: { state: "unknown" as const, reason: "unavailable" } };
    throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
  });
  return { status: "known", inventory };
};

const latestComparableAttempt = (rows: readonly Readonly<{ producer_id: string; deployment_id: string;
  attempt_state: "pending" | "succeeded" | "failed" | "rollback_requested" | "rolled_back";
  effective_order: string }>[]): EnvironmentResolutionInput["latestAttempt"] => {
  if (rows.length === 0 || rows.some((row) => !/^(0|[1-9][0-9]*)$/.test(row.effective_order)
    || row.producer_id !== rows[0]!.producer_id)) return undefined;
  const ordered = [...rows].sort((left, right) => right.effective_order.length - left.effective_order.length
    || (left.effective_order < right.effective_order ? 1 : left.effective_order > right.effective_order ? -1 : 0));
  if (ordered[1]?.effective_order === ordered[0]!.effective_order) return undefined;
  return { deploymentId: ordered[0]!.deployment_id, state: ordered[0]!.attempt_state };
};

export const createEnvironmentViewRepository = (pool: Pool, options: { schema: string }): EnvironmentViewRepository => {
  const schema = quoteEnvironmentSchema(options.schema);
  const catalog = createCatalogOrchestrationReader(pool, options);
  return Object.freeze({
    async getEnvironment(contextInput: unknown, keyInput: unknown): Promise<EnvironmentView> {
      const principal = parseFields(contextInput, ["tenantId", "principalId"]);
      const key = parseFields(keyInput, ["repositoryId", "serviceId", "environment"]);
      const client = await pool.connect().catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); });
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
        const active = await client.query<{ config_fingerprint: string; document_sha256: string; document: unknown }>(
          `SELECT active.config_fingerprint,configuration.document_sha256,configuration.document
           FROM orchestration_active_configurations active
           JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
             AND configuration.config_fingerprint=active.config_fingerprint
           WHERE active.tenant_id=$1`, [principal.tenantId],
        );
        const current = active.rows[0];
        if (current === undefined) throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
        const parsed = parseConfig(current.document);
        if (!parsed.ok || canonicalOrchestrationHash(parsed.value) !== current.document_sha256)
          throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
        const repository = parsed.value.repositories.find((entry) => entry.repository_id === key.repositoryId);
        const service = repository?.services.find((entry) => entry.service_id === key.serviceId);
        const environment = service?.environments.find((entry) => entry.name === key.environment);
        if (repository === undefined || environment === undefined
          || !await hasScopes(client, principal, [repository.access_scope_id,
            environment.deployment_authority.access_scope_id])) {
          throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
        }
        const scope = [principal.tenantId, key.repositoryId, key.serviceId, key.environment];
        const checkpoint = await client.query<{ version: string; reconciliation_required: boolean;
          active_config_fingerprint: string | null; source_access_label: string | null;
          completeness: "complete" | "incomplete" | "transitional" | null;
          serving_status: "known" | "unknown" | null; inventory: unknown }>(
          `SELECT checkpoint.version::text,checkpoint.reconciliation_required,
                  observation.active_config_fingerprint,observation.source_access_label,
                  observation.completeness,observation.serving_status,observation.inventory
           FROM environment_serving_checkpoints checkpoint
           LEFT JOIN environment_serving_observations observation
             ON observation.tenant_id=checkpoint.tenant_id
             AND observation.repository_id=checkpoint.repository_id
             AND observation.service_id=checkpoint.service_id
             AND observation.environment=checkpoint.environment
             AND observation.producer_id=checkpoint.current_producer_id
             AND observation.event_id=checkpoint.current_event_id
           WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2
             AND checkpoint.service_id=$3 AND checkpoint.environment=$4`, scope,
        );
        const state = checkpoint.rows[0];
        const observationCurrent = state?.active_config_fingerprint === current.config_fingerprint;
        if (observationCurrent && (state?.source_access_label === null || state?.source_access_label === undefined
          || !await hasScopes(client, principal, [state.source_access_label]))) {
          throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
        }
        const observation: EnvironmentResolutionInput["observation"] = observationCurrent
          && state?.completeness !== null && state?.completeness !== undefined
          && state.serving_status !== null && state.serving_status !== undefined
          ? { completeness: state.completeness,
            serving_state: state.serving_status === "known"
              ? readInventory(state.inventory) : { status: "unknown", reason: "unavailable" } }
          : undefined;
        const artifactIds = observation?.serving_state.status === "known"
          ? observation.serving_state.inventory.map((item) => item.artifact_id) : [];
        const bindings = artifactIds.length === 0 ? [] : (await client.query<{ artifact_id: string; revision: string }>(
          `SELECT artifact_id,revision FROM environment_artifact_bindings
           WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
             AND artifact_id=ANY($4::text[])`,
          [principal.tenantId, key.repositoryId, key.serviceId, artifactIds],
        )).rows.map((row) => ({ artifactId: row.artifact_id, revision: row.revision }));
        const revisions = observation?.serving_state.status === "known"
          ? observation.serving_state.inventory.flatMap((item) =>
            item.revision.state === "known" ? [item.revision.revision] : []) : [];
        const snapshots = revisions.length === 0 ? [] : (await client.query<{
          immutable_revision: string; snapshot_id: string }>(
          `SELECT snapshot.immutable_revision,snapshot.snapshot_id FROM catalog_snapshots snapshot
           WHERE snapshot.tenant_id=$1 AND snapshot.repository_id=$2 AND snapshot.service_id=$3
             AND snapshot.config_fingerprint=$4 AND snapshot.immutable_revision=ANY($5::text[])
             AND cardinality(snapshot.required_scope_ids)>0 AND NOT EXISTS (
               SELECT 1 FROM unnest(snapshot.required_scope_ids) required(access_scope_id)
               LEFT JOIN access_scopes scope ON scope.tenant_id=snapshot.tenant_id
                 AND scope.access_scope_id=required.access_scope_id AND scope.active
               LEFT JOIN principal_scope_grants grant_row ON grant_row.tenant_id=snapshot.tenant_id
                 AND grant_row.access_scope_id=required.access_scope_id
                 AND grant_row.principal_id=$6 AND grant_row.active
               WHERE scope.access_scope_id IS NULL OR grant_row.access_scope_id IS NULL
             )`,
          [principal.tenantId, key.repositoryId, key.serviceId, current.config_fingerprint,
            revisions, principal.principalId],
        )).rows.map((row) => ({ revision: row.immutable_revision, snapshotId: row.snapshot_id }));
        for (const candidate of snapshots) {
          const stored = await catalog.readStoredSnapshot({ tenantId: principal.tenantId,
            repositoryId: key.repositoryId, serviceId: key.serviceId, snapshotId: candidate.snapshotId });
          if (stored.snapshot.source.immutable_revision !== candidate.revision
            || stored.snapshot.config.config_fingerprint !== current.config_fingerprint)
            throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
        }
        const attempts = await client.query<{ producer_id: string; deployment_id: string;
          attempt_state: "pending" | "succeeded" | "failed" | "rollback_requested" | "rolled_back";
          effective_order: string }>(
          `SELECT producer_id,deployment_id,attempt_state,effective_order
           FROM environment_deployment_attempts
           WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4
             AND active_config_fingerprint=$5`, [...scope, current.config_fingerprint],
        );
        const latestAttempt = latestComparableAttempt(attempts.rows);
        const resolution = resolveEnvironment({ ...(observation === undefined ? {} : { observation }),
          ...(latestAttempt === undefined ? {} : { latestAttempt }),
          artifactBindings: bindings, revisionSnapshots: snapshots });
        const view = Object.freeze({ ...resolution, ...key, configFingerprint: current.config_fingerprint,
          ...(state === undefined ? {} : { checkpointVersion: state.version }),
          reconciliationRequired: state?.reconciliation_required === true || state !== undefined && !observationCurrent });
        await client.query("COMMIT");
        return view;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof EnvironmentError) throw error;
        throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
      } finally { client.release(); }
    },
  });
};
