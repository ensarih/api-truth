import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig, type ContractSnapshot} from "../../ir/src/index.js";
import {canonicalOrchestrationHash} from "../../orchestration/src/canonical.js";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";
import {parseQuerySelection, readQueryContractWithClient, QueryReadError,
  type QueryPin, type QuerySelection} from "../../query/src/index.js";
import {runGroundedSemanticAnalysis} from "./kernel.js";
import type {SemanticAnalysisResult, SemanticProviderId, SemanticProviderPort} from "./types.js";

export class SemanticServiceError extends Error {
  readonly code: "SEMANTIC_INVALID_REQUEST" | "SEMANTIC_NOT_FOUND_OR_DENIED"
    | "SEMANTIC_STALE_CONTEXT" | "SEMANTIC_STORAGE_ERROR";
  constructor(code: SemanticServiceError["code"]) {
    super(code); this.name = "SemanticServiceError"; this.code = code;
  }
}

type Context = Readonly<{tenantId: string; principalId: string}>;
type Authorized = Readonly<{snapshot: ContractSnapshot; pin: QueryPin; selection: QuerySelection;
  inference: Readonly<{enabled: false} | {enabled: true; provider: SemanticProviderId; model: string}>;
  configurationHash: string}>;
const id = (value: unknown): value is string => typeof value === "string"
  && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string"
  && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);

const fields = (value: unknown, names: readonly string[]): Record<string, unknown> | undefined => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key)))
      return undefined;
    const output: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor)) return undefined;
      output[name] = descriptor.value;
    }
    return output;
  } catch {return undefined;}
};

const parseRequest = (rawContext: unknown, rawSelection: unknown, rawEndpointIds: unknown):
  {context: Context; selection: QuerySelection; endpointIds: string[]} => {
  const context = fields(rawContext, ["tenantId", "principalId"]);
  if (!context || !id(context.tenantId) || !id(context.principalId))
    throw new SemanticServiceError("SEMANTIC_INVALID_REQUEST");
  let selection: QuerySelection;
  try {
    const top = fields(rawSelection, ["version", "tenantId", "repositoryId", "serviceId", "selector"]);
    const selector = top && fields(top.selector, top.selector && typeof top.selector === "object"
      && !isProxy(top.selector) && Object.hasOwn(top.selector, "expectedCheckpointVersion")
      ? ["kind", "environment", "expectedCheckpointVersion"]
      : top?.selector && typeof top.selector === "object" && !isProxy(top.selector)
        && Object.hasOwn(top.selector, "expectedPointerVersion")
        ? ["kind", "branch", "expectedPointerVersion"]
        : top?.selector && typeof top.selector === "object" && !isProxy(top.selector)
          && Object.hasOwn(top.selector, "branch") ? ["kind", "branch"]
          : top?.selector && typeof top.selector === "object" && !isProxy(top.selector)
            && Object.hasOwn(top.selector, "environment") ? ["kind", "environment"]
            : ["kind", "revision"]);
    if (!top || !selector) throw new Error();
    selection = parseQuerySelection({...top, selector});
  } catch {
    throw new SemanticServiceError("SEMANTIC_INVALID_REQUEST");
  }
  if (context.tenantId !== selection.tenantId
    || selection.selector.kind === "environment" && !selection.selector.expectedCheckpointVersion
    || selection.selector.kind === "branch" && !selection.selector.expectedPointerVersion)
    throw new SemanticServiceError("SEMANTIC_INVALID_REQUEST");
  let endpointIds: string[];
  try {
    if (!Array.isArray(rawEndpointIds) || isProxy(rawEndpointIds)
      || Object.getPrototypeOf(rawEndpointIds) !== Array.prototype
      || rawEndpointIds.length < 1 || rawEndpointIds.length > 16
      || Reflect.ownKeys(rawEndpointIds).length !== rawEndpointIds.length + 1)
      throw new Error();
    endpointIds = [];
    for (let index = 0; index < rawEndpointIds.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawEndpointIds, String(index));
      if (!descriptor || !("value" in descriptor) || !token(descriptor.value)) throw new Error();
      endpointIds.push(descriptor.value as string);
    }
    if (new Set(endpointIds).size !== endpointIds.length) throw new Error();
  } catch {throw new SemanticServiceError("SEMANTIC_INVALID_REQUEST");}
  return {context: Object.freeze({tenantId: context.tenantId, principalId: context.principalId}),
    selection, endpointIds};
};

const lockScopes = async (client: PoolClient, context: Context, required: string[]): Promise<void> => {
  if (!required.length || required.length > 1024 || required.some(scope => !id(scope)))
    throw new SemanticServiceError("SEMANTIC_STORAGE_ERROR");
  const scopes = await client.query<{access_scope_id: string; active: boolean}>(
    `SELECT access_scope_id,active FROM access_scopes WHERE tenant_id=$1
       AND access_scope_id=ANY($2::text[]) ORDER BY access_scope_id FOR SHARE`,
    [context.tenantId, required]);
  const grants = await client.query<{access_scope_id: string; active: boolean}>(
    `SELECT access_scope_id,active FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2
       AND access_scope_id=ANY($3::text[]) ORDER BY access_scope_id FOR SHARE`,
    [context.tenantId, context.principalId, required]);
  if (scopes.rows.length !== required.length || grants.rows.length !== required.length
    || scopes.rows.some((row, index) => row.access_scope_id !== required[index] || !row.active)
    || grants.rows.some((row, index) => row.access_scope_id !== required[index] || !row.active))
    throw new SemanticServiceError("SEMANTIC_NOT_FOUND_OR_DENIED");
};

const readAuthorized = async (client: PoolClient, schema: string, context: Context,
  selection: QuerySelection, endpointIds: readonly string[]): Promise<Authorized> => {
  if (selection.selector.kind === "environment") {
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
      [JSON.stringify(["api-truth:environment-serving", context.tenantId, selection.repositoryId,
        selection.serviceId, selection.selector.environment])]);
  }
  const active = await client.query<{config_fingerprint: string; document_sha256: string; document: unknown}>(
    `SELECT active.config_fingerprint,configuration.document_sha256,configuration.document
     FROM orchestration_active_configurations active
     JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
       AND configuration.config_fingerprint=active.config_fingerprint
     WHERE active.tenant_id=$1 FOR SHARE OF active`, [context.tenantId]);
  const row = active.rows[0];
  if (!row) throw new SemanticServiceError("SEMANTIC_NOT_FOUND_OR_DENIED");
  const parsed = parseConfig(row.document);
  if (!parsed.ok || canonicalOrchestrationHash(parsed.value) !== row.document_sha256)
    throw new SemanticServiceError("SEMANTIC_STORAGE_ERROR");
  const repository = parsed.value.repositories.find(item => item.repository_id === selection.repositoryId);
  const service = repository?.services.find(item => item.service_id === selection.serviceId);
  const selector = selection.selector;
  const environment = selector.kind === "environment"
    ? service?.environments.find(item => item.name === selector.environment) : undefined;
  if (!repository || !service || selection.selector.kind === "environment" && !environment)
    throw new SemanticServiceError("SEMANTIC_NOT_FOUND_OR_DENIED");
  const selected = await readQueryContractWithClient(client, {schema}, context, selection);
  if (selected.status !== "resolved")
    throw new SemanticServiceError("SEMANTIC_NOT_FOUND_OR_DENIED");
  if (selected.pin.configFingerprint !== row.config_fingerprint)
    throw new SemanticServiceError("SEMANTIC_STALE_CONTEXT");
  if (endpointIds.some(endpointId => !selected.snapshot.endpoints.some(e => e.endpoint_id === endpointId)))
    throw new SemanticServiceError("SEMANTIC_INVALID_REQUEST");
  const snapshotRow = await client.query<{required_scope_ids: string[]}>(
    `SELECT required_scope_ids FROM catalog_snapshots WHERE tenant_id=$1 AND repository_id=$2
       AND service_id=$3 AND snapshot_id=$4 AND immutable_revision=$5 AND config_fingerprint=$6`,
    [context.tenantId, selection.repositoryId, selection.serviceId,
      selected.pin.snapshotId, selected.pin.revision, selected.pin.configFingerprint]);
  const snapshotScopes = snapshotRow.rows[0]?.required_scope_ids;
  if (!Array.isArray(snapshotScopes) || !snapshotScopes.length || snapshotScopes.length > 1024)
    throw new SemanticServiceError("SEMANTIC_STORAGE_ERROR");
  const evidenceScopes = selected.snapshot.evidence.filter(evidence => !evidence.scope.endpoint_id
    || endpointIds.includes(evidence.scope.endpoint_id)).map(evidence => evidence.access_label);
  let sourceScope: string | null = null;
  if (selection.selector.kind === "environment") {
    const checkpoint = await client.query<{version: string; source_access_label: string | null}>(
      `SELECT checkpoint.version::text,observation.source_access_label
       FROM environment_serving_checkpoints checkpoint
       LEFT JOIN environment_serving_observations observation
         ON observation.tenant_id=checkpoint.tenant_id
         AND observation.repository_id=checkpoint.repository_id
         AND observation.service_id=checkpoint.service_id
         AND observation.environment=checkpoint.environment
         AND observation.producer_id=checkpoint.current_producer_id
         AND observation.event_id=checkpoint.current_event_id
       WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2
         AND checkpoint.service_id=$3 AND checkpoint.environment=$4 FOR SHARE OF checkpoint`,
      [context.tenantId, selection.repositoryId, selection.serviceId, selection.selector.environment]);
    if (checkpoint.rows[0]?.version !== selected.pin.checkpointVersion)
      throw new SemanticServiceError("SEMANTIC_STALE_CONTEXT");
    sourceScope = checkpoint.rows[0]?.source_access_label ?? null;
  }
  const required = [...new Set([repository.access_scope_id, ...snapshotScopes,
    ...(environment ? [environment.deployment_authority.access_scope_id] : []),
    ...(sourceScope ? [sourceScope] : []), ...evidenceScopes])].sort();
  await lockScopes(client, context, required);
  const reselected = await readQueryContractWithClient(client, {schema}, context, selection);
  if (reselected.status !== "resolved" || JSON.stringify(reselected.pin) !== JSON.stringify(selected.pin))
    throw new SemanticServiceError("SEMANTIC_STALE_CONTEXT");
  const config = parsed.value.inference;
  const inference = config?.enabled === true
    ? {enabled: true as const, provider: config.provider, model: config.model}
    : {enabled: false as const};
  return Object.freeze({snapshot: reselected.snapshot, pin: reselected.pin, selection,
    inference, configurationHash: row.document_sha256});
};

const sameAuthorized = (before: Authorized, after: Authorized): boolean =>
  JSON.stringify(before.pin) === JSON.stringify(after.pin)
  && before.configurationHash === after.configurationHash
  && JSON.stringify(before.inference) === JSON.stringify(after.inference);

/** Resolves auth and exact source context before and after inference, with no transaction during provider I/O. */
export const createSemanticService = (pool: Pool, options: {schema: string; providerPort: SemanticProviderPort}) => {
  const configured = fields(options, ["schema", "providerPort"]);
  if (!configured || typeof configured.schema !== "string"
    || typeof configured.providerPort !== "function")
    throw new SemanticServiceError("SEMANTIC_INVALID_REQUEST");
  const schemaName = configured.schema;
  const providerPort = configured.providerPort as SemanticProviderPort;
  let schema: string;
  try {schema = quoteEnvironmentSchema(schemaName);}
  catch {throw new SemanticServiceError("SEMANTIC_INVALID_REQUEST");}
  const read = async (context: Context, selection: QuerySelection, endpointIds: readonly string[]): Promise<Authorized> => {
    const client = await pool.connect().catch(() => {throw new SemanticServiceError("SEMANTIC_STORAGE_ERROR");});
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
      const result = await readAuthorized(client, schemaName, context, selection, endpointIds);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof SemanticServiceError) throw error;
      if (error instanceof QueryReadError && error.code === "QUERY_NOT_FOUND_OR_DENIED")
        throw new SemanticServiceError("SEMANTIC_NOT_FOUND_OR_DENIED");
      if (error instanceof QueryReadError && error.code === "QUERY_STALE_SELECTION")
        throw new SemanticServiceError("SEMANTIC_STALE_CONTEXT");
      throw new SemanticServiceError("SEMANTIC_STORAGE_ERROR");
    } finally {client.release();}
  };
  return Object.freeze({analyze: async (rawContext: unknown, rawSelection: unknown,
    rawEndpointIds: unknown): Promise<SemanticAnalysisResult> => {
    const {context, selection, endpointIds} = parseRequest(rawContext, rawSelection, rawEndpointIds);
    const before = await read(context, selection, endpointIds);
    const result = await runGroundedSemanticAnalysis({snapshot: before.snapshot, pin: before.pin,
      selection: before.selection, inference: before.inference, endpointIds}, providerPort);
    if (result.status === "disabled" || result.status === "no_context") return result;
    let after: Authorized;
    try {after = await read(context, selection, endpointIds);}
    catch {throw new SemanticServiceError("SEMANTIC_STALE_CONTEXT");}
    if (!sameAuthorized(before, after)) throw new SemanticServiceError("SEMANTIC_STALE_CONTEXT");
    return result;
  }});
};
