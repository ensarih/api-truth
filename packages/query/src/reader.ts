import type { Pool, PoolClient } from "pg";
import { parseConfig, parseContractSnapshot, type ContractSnapshot } from "@api-truth/ir";
import { canonicalOrchestrationHash } from "@api-truth/orchestration";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../catalog/src/canonical.js";
import { compareContractSnapshots, type ContractDifferenceSet } from "@api-truth/updates";
import { quoteEnvironmentSchema } from "../../environment/src/migrations.js";
import { parseQuerySelection, type QuerySelection } from "./selector.js";

export class QueryReadError extends Error {
  readonly code: "INVALID_QUERY_CONTEXT" | "INVALID_QUERY_DETAIL" | "INVALID_QUERY_SEARCH"
    | "QUERY_RESULT_LIMIT_EXCEEDED" | "QUERY_NOT_FOUND_OR_DENIED"
    | "QUERY_STALE_SELECTION" | "QUERY_COMPARISON_UNAVAILABLE" | "QUERY_STORAGE_ERROR";
  constructor(code: QueryReadError["code"]) {
    super(code); this.name = "QueryReadError"; this.code = code;
  }
}

export type QueryPin = Readonly<{
  snapshotId: string; revision: string; configFingerprint: string;
  pointerVersion?: string; checkpointVersion?: string;
}>;
export type QueryContractResult =
  | Readonly<{ status: "resolved"; selector: QuerySelection; pin: QueryPin; snapshot: ContractSnapshot }>
  | Readonly<{ status: "unknown" | "unavailable" | "transitional" | "ambiguous"; selector: QuerySelection }>;
export type QueryDetailResult<Key extends "endpoint" | "schema"> =
  | Readonly<{ status: "resolved"; selector: QuerySelection; pin: QueryPin } &
      (Key extends "endpoint" ? { endpoint: ContractSnapshot["endpoints"][number] }
        : { schema: ContractSnapshot["schemas"][string] })>
  | Exclude<QueryContractResult, { status: "resolved" }>;
export type QueryComparisonResult =
  | Readonly<{ status: "compared"; before: QueryPin; after: QueryPin; differences: ContractDifferenceSet }>
  | Readonly<{ status: "unavailable"; beforeStatus: QueryContractResult["status"];
      afterStatus: QueryContractResult["status"] }>;
export type QuerySearchResult = Readonly<{ services: readonly Readonly<{
  repositoryId: string; serviceId: string;
  environment?: Readonly<{ name: string; status: QueryContractResult["status"]; pin?: QueryPin }>;
}>[]; truncated: false }>;
export type QueryReader = Readonly<{
  readContract(context: unknown, selection: unknown): Promise<QueryContractResult>;
  readEndpoint(context: unknown, selection: unknown, endpointId: unknown): Promise<QueryDetailResult<"endpoint">>;
  readSchema(context: unknown, selection: unknown, schemaId: unknown): Promise<QueryDetailResult<"schema">>;
  compareContracts(context: unknown, before: unknown, after: unknown): Promise<QueryComparisonResult>;
  searchServices(context: unknown, request: unknown): Promise<QuerySearchResult>;
}>;

type SnapshotRow = { snapshot_id: string; repository_id: string; service_id: string;
  immutable_revision: string; config_fingerprint: string; ir_version: string; identity_version: string;
  analyzer_status: string; identity_sha256: string; content_sha256: string;
  required_scope_ids: string[]; document: unknown };
const snapshotColumns = `snapshot_id,repository_id,service_id,immutable_revision,config_fingerprint,
  ir_version,identity_version,analyzer_status,identity_sha256,content_sha256,required_scope_ids,document`;
const granted = (principalParameter: number): string => `cardinality(snapshot.required_scope_ids)>0 AND NOT EXISTS (
  SELECT 1 FROM unnest(snapshot.required_scope_ids) required(access_scope_id)
  LEFT JOIN access_scopes scope ON scope.tenant_id=$1 AND scope.access_scope_id=required.access_scope_id AND scope.active
  LEFT JOIN principal_scope_grants grant_row ON grant_row.tenant_id=$1 AND grant_row.principal_id=$${principalParameter}
    AND grant_row.access_scope_id=required.access_scope_id AND grant_row.active
  WHERE scope.access_scope_id IS NULL OR grant_row.access_scope_id IS NULL)`;
const denied = (): never => { throw new QueryReadError("QUERY_NOT_FOUND_OR_DENIED"); };
const storage = (): never => { throw new QueryReadError("QUERY_STORAGE_ERROR"); };
const bounded = (value: unknown): value is string => typeof value === "string"
  && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);

const parseContext = (input: unknown, tenantId: string): string => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(fields).length !== 2 || !("value" in fields.tenantId!)
      || !("value" in fields.principalId!) || fields.tenantId!.value !== tenantId
      || !bounded(fields.principalId!.value)) throw new Error();
    return fields.principalId!.value as string;
  } catch { throw new QueryReadError("INVALID_QUERY_CONTEXT"); }
};

type SearchRequest = Readonly<{ tenantId: string; query: string; limit: number; environment?: string }>;
const parseSearchRequest = (input: unknown): SearchRequest => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(input);
    const hasEnvironment = Object.prototype.hasOwnProperty.call(fields, "environment");
    const names = hasEnvironment ? ["tenantId", "query", "limit", "environment"]
      : ["tenantId", "query", "limit"];
    if (Reflect.ownKeys(fields).length !== names.length || names.some((name) =>
      fields[name] === undefined || !("value" in fields[name]!))) throw new Error();
    const tenantId = fields.tenantId!.value as unknown;
    const query = fields.query!.value as unknown;
    const limit = fields.limit!.value as unknown;
    const environment = fields.environment?.value as unknown;
    if (!bounded(tenantId) || typeof query !== "string" || query.length > 128
      || /[\u0000-\u001f\u007f]/.test(query) || typeof limit !== "number"
      || !Number.isInteger(limit) || limit < 1 || limit > 50
      || hasEnvironment && !bounded(environment)) throw new Error();
    return Object.freeze({ tenantId, query, limit,
      ...(hasEnvironment ? { environment: environment as string } : {}) });
  } catch { throw new QueryReadError("INVALID_QUERY_SEARCH"); }
};

const hasScopes = async (client: PoolClient, tenantId: string, principalId: string,
  scopes: readonly string[]): Promise<boolean> => {
  if (scopes.length === 0 || scopes.some((scope) => !bounded(scope))) return false;
  const unique = [...new Set(scopes)];
  const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM access_scopes scope
    JOIN principal_scope_grants grant_row ON grant_row.tenant_id=scope.tenant_id
      AND grant_row.access_scope_id=scope.access_scope_id
    WHERE scope.tenant_id=$1 AND grant_row.principal_id=$2
      AND scope.access_scope_id=ANY($3::text[]) AND scope.active AND grant_row.active`,
  [tenantId, principalId, unique]);
  return result.rows[0]?.count === String(unique.length);
};

const verifySnapshot = (row: SnapshotRow, selection: QuerySelection): ContractSnapshot => {
  try {
    const parsed = parseContractSnapshot(row.document);
    if (!parsed.ok) return storage();
    const snapshot = parsed.value;
    if (row.snapshot_id !== snapshot.snapshot_id || row.repository_id !== selection.repositoryId
      || row.service_id !== selection.serviceId || row.repository_id !== snapshot.service.repository_id
      || row.repository_id !== snapshot.source.repository_id || row.service_id !== snapshot.service.service_id
      || row.immutable_revision !== snapshot.source.immutable_revision
      || row.config_fingerprint !== snapshot.config.config_fingerprint
      || row.ir_version !== snapshot.ir_version || row.identity_version !== snapshot.identity_version
      || row.analyzer_status !== (snapshot.coverage.status === "complete" ? "success" : "partial")
      || row.identity_sha256 !== snapshotIdentitySha256(snapshot)
      || row.content_sha256 !== snapshotContentSha256(snapshot)
      || !Array.isArray(row.required_scope_ids) || row.required_scope_ids.length === 0
      || row.required_scope_ids.some((item) => !bounded(item))) return storage();
    return structuredClone(snapshot);
  } catch { return storage(); }
};

const selectAuthorized = async (client: PoolClient, selection: QuerySelection,
  principalId: string, clause: string, values: unknown[]): Promise<SnapshotRow[]> => {
  const query = `SELECT ${snapshotColumns} FROM catalog_snapshots snapshot
    WHERE snapshot.tenant_id=$1 AND snapshot.repository_id=$2 AND snapshot.service_id=$3
      AND ${clause} AND ${granted(4 + values.length)} ORDER BY snapshot.snapshot_id COLLATE "C" LIMIT 2`;
  const result = await client.query<SnapshotRow>(query,
    [selection.tenantId, selection.repositoryId, selection.serviceId, ...values, principalId]);
  return result.rows;
};

const resultState = (selector: QuerySelection, status: Exclude<QueryContractResult["status"], "resolved">): QueryContractResult =>
  Object.freeze({ status, selector });
const resolved = (selector: QuerySelection, row: SnapshotRow, pinExtra: Partial<QueryPin> = {}): QueryContractResult => {
  const snapshot = verifySnapshot(row, selector);
  return Object.freeze({ status: "resolved", selector,
    pin: Object.freeze({ snapshotId: row.snapshot_id, revision: row.immutable_revision,
      configFingerprint: row.config_fingerprint, ...pinExtra }), snapshot });
};

const readRevision = async (client: PoolClient, selector: QuerySelection,
  principalId: string): Promise<QueryContractResult> => {
  if (selector.selector.kind !== "revision") return storage();
  const rows = await selectAuthorized(client, selector, principalId,
    "snapshot.immutable_revision=$4", [selector.selector.revision]);
  if (rows.length === 0) return denied();
  if (rows.length > 1) return resultState(selector, "ambiguous");
  return resolved(selector, rows[0]!);
};

const readBranch = async (client: PoolClient, selector: QuerySelection,
  principalId: string): Promise<QueryContractResult> => {
  if (selector.selector.kind !== "branch") return storage();
  const pointer = (await client.query<{ snapshot_id: string; pointer_version: string }>(
    `SELECT snapshot_id,pointer_version::text FROM catalog_branch_pointers
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
    [selector.tenantId, selector.repositoryId, selector.serviceId, selector.selector.branch],
  )).rows[0];
  if (!pointer) return denied();
  if (selector.selector.expectedPointerVersion !== undefined
    && selector.selector.expectedPointerVersion !== pointer.pointer_version)
    throw new QueryReadError("QUERY_STALE_SELECTION");
  const checkpoint = (await client.query<{ desired_state: string; desired_revision: string | null;
    last_successful_snapshot_id: string | null; latest_outcome: string | null }>(
    `SELECT desired_state,desired_revision,last_successful_snapshot_id,latest_outcome
     FROM orchestration_branch_checkpoints WHERE tenant_id=$1 AND repository_id=$2
       AND service_id=$3 AND branch=$4`,
    [selector.tenantId,selector.repositoryId,selector.serviceId,selector.selector.branch],
  )).rows[0];
  const rows = await selectAuthorized(client, selector, principalId,
    "snapshot.snapshot_id=$4", [pointer.snapshot_id]);
  if (rows.length !== 1) return denied();
  if (checkpoint && (checkpoint.desired_state !== "present"
    || checkpoint.desired_revision !== rows[0]!.immutable_revision
    || checkpoint.last_successful_snapshot_id !== pointer.snapshot_id
    || checkpoint.latest_outcome === "reconciliation_required"))
    throw new QueryReadError("QUERY_STALE_SELECTION");
  return resolved(selector, rows[0]!, { pointerVersion: pointer.pointer_version });
};

const readEnvironment = async (client: PoolClient, selector: QuerySelection,
  principalId: string): Promise<QueryContractResult> => {
  if (selector.selector.kind !== "environment") return storage();
  const active = (await client.query<{ config_fingerprint: string; document_sha256: string; document: unknown }>(
    `SELECT active.config_fingerprint,configuration.document_sha256,configuration.document
     FROM orchestration_active_configurations active
     JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
       AND configuration.config_fingerprint=active.config_fingerprint WHERE active.tenant_id=$1`,
    [selector.tenantId],
  )).rows[0];
  if (!active) return denied();
  const parsed = parseConfig(active.document);
  if (!parsed.ok || canonicalOrchestrationHash(parsed.value) !== active.document_sha256) return storage();
  const repo = parsed.value.repositories.find((item) => item.repository_id === selector.repositoryId);
  const service = repo?.services.find((item) => item.service_id === selector.serviceId);
  const environmentName = selector.selector.environment;
  const environment = service?.environments.find((item) => item.name === environmentName);
  if (!repo || !environment || !await hasScopes(client, selector.tenantId, principalId,
    [repo.access_scope_id, environment.deployment_authority.access_scope_id])) return denied();
  const checkpoint = (await client.query<{ version: string; reconciliation_required: boolean;
    active_config_fingerprint: string | null; source_access_label: string | null;
    completeness: string | null; serving_status: string | null; inventory: unknown }>(
    `SELECT checkpoint.version::text,checkpoint.reconciliation_required,
       observation.active_config_fingerprint,observation.source_access_label,
       observation.completeness,observation.serving_status,observation.inventory
     FROM environment_serving_checkpoints checkpoint
     LEFT JOIN environment_serving_observations observation
       ON observation.tenant_id=checkpoint.tenant_id AND observation.repository_id=checkpoint.repository_id
       AND observation.service_id=checkpoint.service_id AND observation.environment=checkpoint.environment
       AND observation.producer_id=checkpoint.current_producer_id AND observation.event_id=checkpoint.current_event_id
     WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2
       AND checkpoint.service_id=$3 AND checkpoint.environment=$4`,
    [selector.tenantId, selector.repositoryId, selector.serviceId, selector.selector.environment],
  )).rows[0];
  if (checkpoint && checkpoint.active_config_fingerprint === active.config_fingerprint
    && (!checkpoint.source_access_label || !await hasScopes(client, selector.tenantId,
      principalId, [checkpoint.source_access_label]))) return denied();
  if (checkpoint && selector.selector.expectedCheckpointVersion !== undefined
    && selector.selector.expectedCheckpointVersion !== checkpoint.version)
    throw new QueryReadError("QUERY_STALE_SELECTION");
  if (!checkpoint || checkpoint.reconciliation_required
    || checkpoint.active_config_fingerprint !== active.config_fingerprint) return resultState(selector, "unknown");
  if (checkpoint.serving_status !== "known") return resultState(selector, "unknown");
  if (checkpoint.completeness !== "complete") return resultState(selector, "transitional");
  if (!Array.isArray(checkpoint.inventory)) return storage();
  if (checkpoint.inventory.length === 0) return resultState(selector, "unavailable");
  if (checkpoint.inventory.length !== 1) return resultState(selector, "transitional");
  const item = checkpoint.inventory[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) return storage();
  const artifactId = (item as { artifact_id?: unknown }).artifact_id;
  const reference = (item as { revision?: unknown }).revision;
  if (!bounded(artifactId) || !reference || typeof reference !== "object" || Array.isArray(reference)) return storage();
  const revision = (reference as { state?: unknown; revision?: unknown });
  if (revision.state !== "known" || !bounded(revision.revision)) return resultState(selector, "unavailable");
  const binding = (await client.query<{ revision: string }>(
    `SELECT revision FROM environment_artifact_bindings WHERE tenant_id=$1 AND repository_id=$2
      AND service_id=$3 AND artifact_id=$4`,
    [selector.tenantId, selector.repositoryId, selector.serviceId, artifactId],
  )).rows[0];
  if (binding?.revision !== revision.revision) return resultState(selector, "unavailable");
  const rows = await selectAuthorized(client, selector, principalId,
    "snapshot.immutable_revision=$4 AND snapshot.config_fingerprint=$5", [revision.revision, active.config_fingerprint]);
  if (rows.length === 0) return resultState(selector, "unavailable");
  if (rows.length > 1) return resultState(selector, "ambiguous");
  return resolved(selector, rows[0]!, { checkpointVersion: checkpoint.version });
};

const readSelected = (client: PoolClient, selector: QuerySelection, principalId: string): Promise<QueryContractResult> =>
  selector.selector.kind === "revision" ? readRevision(client, selector, principalId)
    : selector.selector.kind === "branch" ? readBranch(client, selector, principalId)
      : readEnvironment(client, selector, principalId);

const searchConfiguredServices = async (client: PoolClient, principalId: string,
  request: SearchRequest): Promise<QuerySearchResult> => {
  const active = (await client.query<{ document: unknown; document_sha256: string }>(
    `SELECT configuration.document,configuration.document_sha256
     FROM orchestration_active_configurations active
     JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
       AND configuration.config_fingerprint=active.config_fingerprint
     WHERE active.tenant_id=$1`, [request.tenantId],
  )).rows[0];
  if (!active) return Object.freeze({ services: Object.freeze([]), truncated: false });
  const parsed = parseConfig(active.document);
  if (!parsed.ok || canonicalOrchestrationHash(parsed.value) !== active.document_sha256) return storage();
  const candidates: { repository: (typeof parsed.value.repositories)[number];
    service: (typeof parsed.value.repositories)[number]["services"][number] }[] = [];
  for (const repository of parsed.value.repositories) {
    for (const service of repository.services) {
      if (candidates.length === 10_000) throw new QueryReadError("QUERY_RESULT_LIMIT_EXCEEDED");
      candidates.push({ repository, service });
    }
  }
  const query = request.query.toLowerCase();
  const matches = candidates.filter(({ repository, service }) =>
    (repository.repository_id.toLowerCase().includes(query) || service.service_id.toLowerCase().includes(query))
    && (request.environment === undefined || service.environments.some((item) => item.name === request.environment)))
    .sort((left, right) => Buffer.compare(Buffer.from(left.repository.repository_id),
      Buffer.from(right.repository.repository_id)) || Buffer.compare(Buffer.from(left.service.service_id),
      Buffer.from(right.service.service_id)));
  const services: QuerySearchResult["services"][number][] = [];
  for (const { repository, service } of matches) {
    if (!await hasScopes(client, request.tenantId, principalId, [repository.access_scope_id])) continue;
    if (request.environment === undefined) {
      services.push(Object.freeze({ repositoryId: repository.repository_id, serviceId: service.service_id }));
    } else {
      const selection = parseQuerySelection({ version: "1", tenantId: request.tenantId,
        repositoryId: repository.repository_id, serviceId: service.service_id,
        selector: { kind: "environment", environment: request.environment } });
      let state: QueryContractResult;
      try { state = await readEnvironment(client, selection, principalId); }
      catch (error) {
        if (error instanceof QueryReadError && error.code === "QUERY_NOT_FOUND_OR_DENIED") continue;
        throw error;
      }
      const environment = Object.freeze({ name: request.environment, status: state.status,
        ...(state.status === "resolved" ? { pin: state.pin } : {}) });
      services.push(Object.freeze({ repositoryId: repository.repository_id,
        serviceId: service.service_id, environment }));
    }
    if (services.length > request.limit) throw new QueryReadError("QUERY_RESULT_LIMIT_EXCEEDED");
  }
  return Object.freeze({ services: Object.freeze(services), truncated: false });
};

/** Reads selector, authorization, and snapshot in one consistent database transaction. */
export const createQueryReader = (pool: Pool, options: { schema: string }): QueryReader => {
  const schema = quoteEnvironmentSchema(options.schema);
  const withRead = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect().catch(() => { throw new QueryReadError("QUERY_STORAGE_ERROR"); });
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof QueryReadError) throw error;
      throw new QueryReadError("QUERY_STORAGE_ERROR");
    } finally { client.release(); }
  };
  const readContract = async (contextInput: unknown, selectionInput: unknown): Promise<QueryContractResult> => {
    const selector = parseQuerySelection(selectionInput);
    const principalId = parseContext(contextInput, selector.tenantId);
    return withRead((client) => readSelected(client, selector, principalId));
  };
  return Object.freeze({
    readContract,
    async searchServices(contextInput: unknown, requestInput: unknown): Promise<QuerySearchResult> {
      const request = parseSearchRequest(requestInput);
      const principalId = parseContext(contextInput, request.tenantId);
      return withRead((client) => searchConfiguredServices(client, principalId, request));
    },
    async readEndpoint(contextInput: unknown, selectionInput: unknown,
      endpointId: unknown): Promise<QueryDetailResult<"endpoint">> {
      if (!bounded(endpointId)) throw new QueryReadError("INVALID_QUERY_DETAIL");
      const result = await readContract(contextInput, selectionInput);
      if (result.status !== "resolved") return result;
      const endpoint = result.snapshot.endpoints.find((item) => item.endpoint_id === endpointId);
      if (!endpoint) return denied();
      return Object.freeze({ status: "resolved", selector: result.selector, pin: result.pin, endpoint });
    },
    async readSchema(contextInput: unknown, selectionInput: unknown,
      schemaId: unknown): Promise<QueryDetailResult<"schema">> {
      if (!bounded(schemaId)) throw new QueryReadError("INVALID_QUERY_DETAIL");
      const result = await readContract(contextInput, selectionInput);
      if (result.status !== "resolved") return result;
      if (!Object.hasOwn(result.snapshot.schemas, schemaId)) return denied();
      const component = result.snapshot.schemas[schemaId]!;
      return Object.freeze({ status: "resolved", selector: result.selector, pin: result.pin, schema: component });
    },
    async compareContracts(contextInput: unknown, beforeInput: unknown,
      afterInput: unknown): Promise<QueryComparisonResult> {
      const before = parseQuerySelection(beforeInput);
      const after = parseQuerySelection(afterInput);
      if (before.tenantId !== after.tenantId || before.repositoryId !== after.repositoryId
        || before.serviceId !== after.serviceId) throw new QueryReadError("INVALID_QUERY_CONTEXT");
      const principalId = parseContext(contextInput, before.tenantId);
      return withRead(async (client) => {
        const base = await readSelected(client, before, principalId);
        const target = await readSelected(client, after, principalId);
        if (base.status !== "resolved" || target.status !== "resolved")
          return Object.freeze({ status: "unavailable", beforeStatus: base.status,
            afterStatus: target.status });
        try {
          const differences = compareContractSnapshots({ base_snapshot: base.snapshot,
            target_snapshot: target.snapshot });
          return Object.freeze({ status: "compared", before: base.pin, after: target.pin, differences });
        } catch { throw new QueryReadError("QUERY_COMPARISON_UNAVAILABLE"); }
      });
    },
  });
};
