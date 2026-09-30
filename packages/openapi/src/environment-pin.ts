import type { PoolClient } from "pg";
import { parseConfig } from "@api-truth/ir";
import { canonicalOrchestrationHash } from "@api-truth/orchestration";
import type { PrincipalContext } from "@api-truth/catalog";
import type { OpenApiPublicationSelector } from "./preparation.js";

export type EnvironmentSelector = Extract<OpenApiPublicationSelector, { kind: "environment" }>;
export type EnvironmentPinCheck = Readonly<{ status: "match"; scopeIds: readonly string[] }>
  | Readonly<{ status: "stale" | "denied" | "corrupt" }>;
const stale = (): EnvironmentPinCheck => ({ status: "stale" });
const denied = (): EnvironmentPinCheck => ({ status: "denied" });
const corrupt = (): EnvironmentPinCheck => ({ status: "corrupt" });

/** Called in the same transaction that promotes the publication pointer. */
export const checkEnvironmentPin = async (
  client: PoolClient, context: PrincipalContext, selector: EnvironmentSelector,
): Promise<EnvironmentPinCheck> => {
  const active = await client.query<{ config_fingerprint: string; document_sha256: string; document: unknown }>(
    `SELECT active.config_fingerprint, configuration.document_sha256, configuration.document
     FROM orchestration_active_configurations active
     JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
       AND configuration.config_fingerprint=active.config_fingerprint
     WHERE active.tenant_id=$1 FOR SHARE OF active, configuration`, [context.tenantId]);
  const configuration = active.rows[0];
  if (!configuration) return stale();
  const parsed = parseConfig(configuration.document);
  if (!parsed.ok || canonicalOrchestrationHash(parsed.value) !== configuration.document_sha256) return corrupt();
  if (configuration.config_fingerprint !== selector.configFingerprint) return stale();
  const repository = parsed.value.repositories.find((item) => item.repository_id === selector.repositoryId);
  const service = repository?.services.find((item) => item.service_id === selector.serviceId);
  const environment = service?.environments.find((item) => item.name === selector.environment);
  if (!repository || !environment) return denied();

  const hasScopes = async (scopeIds: readonly string[]): Promise<boolean> => {
    const scopes = [...new Set(scopeIds)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const activeScopes = await client.query<{ access_scope_id: string }>(
      `SELECT access_scope_id FROM access_scopes
       WHERE tenant_id=$1 AND access_scope_id=ANY($2::text[]) AND active
       ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [context.tenantId, scopes]);
    const grants = await client.query<{ access_scope_id: string }>(
      `SELECT access_scope_id FROM principal_scope_grants
       WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=ANY($3::text[]) AND active
       ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [context.tenantId, context.principalId, scopes]);
    return activeScopes.rows.length === scopes.length && grants.rows.length === scopes.length
      && scopes.every((scope, index) => activeScopes.rows[index]?.access_scope_id === scope
        && grants.rows[index]?.access_scope_id === scope);
  };
  if (!await hasScopes([repository.access_scope_id, environment.deployment_authority.access_scope_id]))
    return denied();

  const scope = [context.tenantId, selector.repositoryId, selector.serviceId, selector.environment];
  const checkpoint = await client.query<{ version: string; reconciliation_required: boolean;
    current_producer_id: string | null; current_event_id: string | null }>(
    `SELECT version::text,reconciliation_required,current_producer_id,current_event_id
     FROM environment_serving_checkpoints
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4 FOR SHARE`, scope);
  const state = checkpoint.rows[0];
  if (!state || state.version !== selector.checkpointVersion || state.reconciliation_required
    || !state.current_producer_id || !state.current_event_id) return stale();
  const observed = await client.query<{ active_config_fingerprint: string; source_access_label: string;
    completeness: string; serving_status: string; inventory: unknown }>(
    `SELECT active_config_fingerprint,source_access_label,completeness,serving_status,inventory
     FROM environment_serving_observations
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4
       AND producer_id=$5 AND event_id=$6 FOR SHARE`,
    [...scope, state.current_producer_id, state.current_event_id]);
  const observation = observed.rows[0];
  if (!observation) return corrupt();
  if (observation.active_config_fingerprint !== configuration.config_fingerprint) return stale();
  if (!await hasScopes([observation.source_access_label])) return denied();
  if (observation.completeness !== "complete" || observation.serving_status !== "known"
    || !Array.isArray(observation.inventory) || observation.inventory.length !== 1) return stale();
  const item = observation.inventory[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) return corrupt();
  const artifactId = (item as { artifact_id?: unknown }).artifact_id;
  const reference = (item as { revision?: unknown }).revision;
  if (typeof artifactId !== "string" || artifactId.length === 0
    || !reference || typeof reference !== "object" || Array.isArray(reference)) return corrupt();
  const revision = (reference as { state?: unknown; revision?: unknown });
  if (revision.state !== "known" || typeof revision.revision !== "string"
    || revision.revision.length === 0) return stale();
  if (revision.revision !== selector.revision) return stale();
  const binding = await client.query<{ revision: string }>(
    `SELECT revision FROM environment_artifact_bindings
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND artifact_id=$4 FOR SHARE`,
    [context.tenantId, selector.repositoryId, selector.serviceId, artifactId]);
  if (binding.rows[0]?.revision !== selector.revision) return stale();

  const candidates = await client.query<{ snapshot_id: string; required_scope_ids: string[] }>(
    `SELECT snapshot_id,required_scope_ids FROM catalog_snapshots
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
       AND immutable_revision=$4 AND config_fingerprint=$5
     ORDER BY snapshot_id COLLATE "C" FOR SHARE`,
    [context.tenantId, selector.repositoryId, selector.serviceId, selector.revision,
      selector.configFingerprint]);
  const authorized: string[] = [];
  for (const candidate of candidates.rows) {
    if (!Array.isArray(candidate.required_scope_ids) || candidate.required_scope_ids.length === 0)
      return corrupt();
    if (await hasScopes(candidate.required_scope_ids)) authorized.push(candidate.snapshot_id);
    else if (candidate.snapshot_id === selector.snapshotId) return denied();
  }
  return authorized.length === 1 && authorized[0] === selector.snapshotId
    && selector.resolvedSnapshotIds.length === 1 && selector.resolvedSnapshotIds[0] === selector.snapshotId
    ? { status: "match", scopeIds: Object.freeze([...new Set([repository.access_scope_id,
      environment.deployment_authority.access_scope_id, observation.source_access_label])].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)))) }
    : stale();
};
