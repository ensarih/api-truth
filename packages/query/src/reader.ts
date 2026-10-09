import type { Pool, PoolClient } from "pg";
import {isProxy} from "node:util/types";
import { configuredAnalyzerIrVersion, parseConfig, parseContractSnapshot,
  type ContractSnapshot, type InstallationConfig } from "@api-truth/ir";
import { canonicalOrchestrationHash } from "@api-truth/orchestration";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../catalog/src/canonical.js";
import { compareContractSnapshots, parseContractDifferenceSet, parseUpdatePlan,
  type ContractDifferenceSet } from "@api-truth/updates";
import { OpenApiStorageError, readCurrentOpenApiWithClient, readPublicationOpenApiWithClient,
  type OpenApiPublicationSelector, type PublicationKey } from "@api-truth/openapi";
import { quoteEnvironmentSchema } from "../../environment/src/migrations.js";
import { parseQuerySelection, type QuerySelection } from "./selector.js";
import {searchOperationCandidates, validateOperationSearchOptions, type OperationCandidate,
  type OperationSearchResult} from "./operation-search.js";

export class QueryReadError extends Error {
  readonly code: "INVALID_QUERY_CONTEXT" | "INVALID_QUERY_DETAIL" | "INVALID_QUERY_SEARCH"
    | "INVALID_QUERY_OBSERVATION"
    | "QUERY_RESULT_LIMIT_EXCEEDED" | "QUERY_NOT_FOUND_OR_DENIED"
    | "QUERY_STALE_SELECTION" | "QUERY_COMPARISON_UNAVAILABLE" | "QUERY_STORAGE_ERROR";
  constructor(code: QueryReadError["code"]) {
    super(code); this.name = "QueryReadError"; this.code = code;
  }
}

export type QueryPin = Readonly<{
  snapshotId: string; revision: string; configFingerprint: string;
  /** Present only when a complete source snapshot is selected by a later, proven reused revision. */
  selectedRevision?: string;
  pointerVersion?: string; checkpointVersion?: string;
}>;
export type QueryPublication = Readonly<{ status: "current"; publicationId: string;
  contentSha256: string; pointerVersion?: string; selector: OpenApiPublicationSelector }>
  | Readonly<{ status: "absent" }>;
export type QueryContractResult =
  | Readonly<{ status: "resolved"; selector: QuerySelection; pin: QueryPin; snapshot: ContractSnapshot;
      publication: QueryPublication }>
  | Readonly<{ status: "unknown" | "unavailable" | "transitional" | "ambiguous"; selector: QuerySelection }>;
type QueryCoreResult = Exclude<QueryContractResult, { status: "resolved" }>
  | Readonly<{ status: "resolved"; selector: QuerySelection; pin: QueryPin; snapshot: ContractSnapshot }>;
export type QueryDetailResult<Key extends "endpoint" | "schema"> =
  | Readonly<{ status: "resolved"; selector: QuerySelection; pin: QueryPin; publication: QueryPublication } &
      (Key extends "endpoint" ? { endpoint: ContractSnapshot["endpoints"][number] }
        : { schema: ContractSnapshot["schemas"][string] })>
  | Exclude<QueryContractResult, { status: "resolved" }>;
export type QueryComparisonResult =
  | Readonly<{ status: "compared"; before: QueryPin; after: QueryPin;
      beforePublication: QueryPublication; afterPublication: QueryPublication;
      differences: ContractDifferenceSet }>
  | Readonly<{ status: "unavailable"; beforeStatus: QueryContractResult["status"];
      afterStatus: QueryContractResult["status"] }>;
export type QuerySearchResult = Readonly<{ services: readonly Readonly<{
  repositoryId: string; serviceId: string;
  environment?: Readonly<{ name: string; status: QueryContractResult["status"];
    pin?: QueryPin; publication?: QueryPublication }>;
}>[]; truncated: false }>;
export type QueryHistoricalPublication = Readonly<{ publicationId: string; contentSha256: string;
  bytes: Uint8Array; selector: OpenApiPublicationSelector; pin: QueryPin }>;
export type QueryObservationRecord = Readonly<{importId:string; recordId:string; sourceId:string; sourceVersion:string;
  windowStart:string; windowEnd:string; importedAt:string; status:"confirmed"|"unresolved"; reason?:string;
  endpointId?:string; mappingId?:string; method?:string; statusCode?:number; completeness:"metadata_only";
  policyVersion:"metadata-only-1"}>;
export type QueryObservationResult = Readonly<{status:"resolved"; selector:QuerySelection; pin:QueryPin;
  records:readonly QueryObservationRecord[]; truncated:boolean}> | Readonly<{status:"unknown"|"unavailable"|"transitional"|"ambiguous";
  selector:QuerySelection}>;
export type QueryObservationOptions = Readonly<{limit:number; endpointId?:string}>;
export interface QueryObservationReader {
  readMetadataObservations(context:unknown,selection:unknown,options:unknown):Promise<QueryObservationResult>;
}
export interface QueryOperationReader {
  readOperationCandidates(context:unknown,selection:unknown,options:unknown):Promise<OperationSearchResult>;
}
export type CorpusOperationCandidate=OperationCandidate & Readonly<{repositoryId:string;serviceId:string;
  selector:QuerySelection;pin:QueryPin}>;
export type CorpusOperationSearchResult=
  | Readonly<{status:"candidates";matchMode:"keyword";scope:"visible_authorized_services";
      environment:string;candidates:readonly CorpusOperationCandidate[];complete:boolean;truncated:boolean;
      incompleteReason?:"incomplete_scan"|"scan_limit"}>
  | Readonly<{status:"no_match";matchMode:"keyword";scope:"visible_authorized_services";
      environment:string;complete:true;truncated:false}>
  | Readonly<{status:"unknown";matchMode:"keyword";scope:"visible_authorized_services";
      environment:string;reason:"no_visible_services"|"incomplete_scan"|"scan_limit"}>;
export interface QueryCorpusOperationReader {
  searchOperationCandidatesAcrossServices(context:unknown,request:unknown):Promise<CorpusOperationSearchResult>;
}
export type QueryReader = Readonly<{
  readContract(context: unknown, selection: unknown): Promise<QueryContractResult>;
  readEndpoint(context: unknown, selection: unknown, endpointId: unknown): Promise<QueryDetailResult<"endpoint">>;
  readSchema(context: unknown, selection: unknown, schemaId: unknown): Promise<QueryDetailResult<"schema">>;
  compareContracts(context: unknown, before: unknown, after: unknown): Promise<QueryComparisonResult>;
  searchServices(context: unknown, request: unknown): Promise<QuerySearchResult>;
  readPublication(context: unknown, key: unknown): Promise<QueryHistoricalPublication>;
}>;

type SnapshotRow = { snapshot_id: string; repository_id: string; service_id: string;
  immutable_revision: string; config_fingerprint: string; ir_version: string; identity_version: string;
  analyzer_status: string; identity_sha256: string; content_sha256: string;
  required_scope_ids: string[]; document: unknown; document_bytes?: string };
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
const parsePublicationKey = (input: unknown): Readonly<{ tenantId: string; repositoryId: string;
  serviceId: string; publicationId: string }> => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const names = ["tenantId", "repositoryId", "serviceId", "publicationId"];
    if (Reflect.ownKeys(descriptors).length !== names.length || names.some((name) =>
      descriptors[name] === undefined || !("value" in descriptors[name]!))) throw new Error();
    const values = Object.fromEntries(names.map((name) => [name, descriptors[name]!.value]));
    if (!bounded(values.tenantId) || !bounded(values.repositoryId) || !bounded(values.serviceId)
      || typeof values.publicationId !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(values.publicationId)) throw new Error();
    return Object.freeze(values) as { tenantId: string; repositoryId: string;
      serviceId: string; publicationId: string };
  } catch { throw new QueryReadError("INVALID_QUERY_DETAIL"); }
};

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

type CorpusSearchRequest=Readonly<{tenantId:string;environment:string;intentQuery:string;limit:number}>;
const parseCorpusSearchRequest=(input:unknown):CorpusSearchRequest=>{
  try{
    if(!input||typeof input!=="object"||Array.isArray(input)||isProxy(input)
      ||Object.getPrototypeOf(input)!==Object.prototype)throw new Error();
    const fields=Object.getOwnPropertyDescriptors(input);
    const names=Object.hasOwn(fields,"limit")?["tenantId","environment","intentQuery","limit"]
      :["tenantId","environment","intentQuery"];
    if(Reflect.ownKeys(fields).length!==names.length||names.some(name=>!fields[name]
      ||!("value" in fields[name]!)))throw new Error();
    const tenantId=fields.tenantId!.value as unknown,environment=fields.environment!.value as unknown;
    const options=validateOperationSearchOptions({intentQuery:fields.intentQuery!.value,
      ...(Object.hasOwn(fields,"limit")?{limit:fields.limit!.value}:{})});
    if(!bounded(tenantId)||!bounded(environment)||!options)throw new Error();
    return Object.freeze({tenantId,environment,intentQuery:options.intentQuery,limit:options.limit??20});
  }catch{throw new QueryReadError("INVALID_QUERY_SEARCH");}
};

const parseObservationOptions = (input:unknown):QueryObservationOptions => {
  try {
    if(!input||typeof input!=="object"||Array.isArray(input)||isProxy(input)||Object.getPrototypeOf(input)!==Object.prototype)throw new Error();
    const descriptors=Object.getOwnPropertyDescriptors(input);
    const hasEndpoint=Object.hasOwn(descriptors,"endpointId");
    const names=hasEndpoint?["limit","endpointId"]:["limit"];
    if(Reflect.ownKeys(descriptors).length!==names.length||names.some(name=>!descriptors[name]||!("value" in descriptors[name]!)))throw new Error();
    const limit=descriptors.limit!.value as unknown;
    const endpointId=descriptors.endpointId?.value as unknown;
    if(typeof limit!=="number"||!Number.isInteger(limit)||limit<1||limit>100
      ||hasEndpoint&&!bounded(endpointId))throw new Error();
    return Object.freeze({limit,...(hasEndpoint?{endpointId:endpointId as string}:{})});
  }catch{throw new QueryReadError("INVALID_QUERY_OBSERVATION");}
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
  principalId: string, clause: string, values: unknown[], maxDocumentBytes?: number): Promise<SnapshotRow[]> => {
  const boundedDocument=maxDocumentBytes===undefined?"snapshot.document":
    `CASE WHEN octet_length(snapshot.document::text)<=$${5+values.length}
      THEN snapshot.document ELSE NULL END`;
  const byteCount=maxDocumentBytes===undefined?"":`,octet_length(snapshot.document::text)::text AS document_bytes`;
  const query = `SELECT ${snapshotColumns.replace("document",`${boundedDocument} AS document${byteCount}`)} FROM catalog_snapshots snapshot
    WHERE snapshot.tenant_id=$1 AND snapshot.repository_id=$2 AND snapshot.service_id=$3
      AND ${clause} AND ${granted(4 + values.length)} ORDER BY snapshot.snapshot_id COLLATE "C" LIMIT 2`;
  const result = await client.query<SnapshotRow>(query,
    [selection.tenantId, selection.repositoryId, selection.serviceId, ...values, principalId,
      ...(maxDocumentBytes===undefined?[]:[maxDocumentBytes])]);
  return result.rows;
};

const resultState = (selector: QuerySelection, status: Exclude<QueryContractResult["status"], "resolved">): QueryCoreResult =>
  Object.freeze({ status, selector });
const resolved = (selector: QuerySelection, row: SnapshotRow, pinExtra: Partial<QueryPin> = {}): QueryCoreResult => {
  const snapshot = verifySnapshot(row, selector);
  return Object.freeze({ status: "resolved", selector,
    pin: Object.freeze({ snapshotId: row.snapshot_id, revision: row.immutable_revision,
      configFingerprint: row.config_fingerprint, ...pinExtra }), snapshot });
};

type ReusedAssociationRow = {
  snapshot_id: string; immutable_revision: string; source_digest: string; service_root: string;
  analyzer_adapter_id: string; analyzer_adapter_version: string; ir_version: string;
  exchange_version: string; identity_version: string; config_version: string; config_fingerprint: string;
  resolution_inputs_fingerprint: string | null; config_document_sha256: string; config_document: unknown;
  base_selected_revision: string; plan_version: string | null; difference_version: string | null;
  plan_document: unknown; difference_document: unknown;
};
type ReusedSnapshot = { row: SnapshotRow; selectedRevision: string; associationKey: string };

/** Resolve only a completed D07 source-tree reuse; the original snapshot and its evidence stay untouched. */
const readAuthorizedSourceReuse = async (client: PoolClient, selector: QuerySelection, principalId: string,
  selectedRevision: string, snapshotId?: string, configFingerprint?: string,
  maxDocumentBytes?: number, validatedConfiguration?:ValidatedActiveConfiguration): Promise<ReusedSnapshot[]> => {
  const selected = await client.query<ReusedAssociationRow>(`
    SELECT association.snapshot_id,association.immutable_revision,association.source_digest,association.service_root,
      association.analyzer_adapter_id,association.analyzer_adapter_version,association.ir_version,
      association.exchange_version,association.identity_version,association.config_version,association.config_fingerprint,
      association.resolution_inputs_fingerprint,configuration.document_sha256 AS config_document_sha256,
      CASE WHEN $8::boolean OR octet_length(configuration.document::text)>4194304
        THEN NULL ELSE configuration.document END AS config_document,result.base_selected_revision,
      result.plan_version,result.difference_version,
      CASE WHEN octet_length(result.plan_document::text)<=65536 THEN result.plan_document ELSE NULL END AS plan_document,
      CASE WHEN octet_length(result.difference_document::text)<=65536
        THEN result.difference_document ELSE NULL END AS difference_document
    FROM orchestration_revision_snapshots association
    JOIN catalog_snapshots snapshot ON snapshot.tenant_id=association.tenant_id
      AND snapshot.repository_id=association.repository_id AND snapshot.service_id=association.service_id
      AND snapshot.snapshot_id=association.snapshot_id
    JOIN orchestration_jobs job ON job.tenant_id=association.tenant_id
      AND job.job_id=association.producing_job_id AND job.state='succeeded'
      AND job.kind IN ('branch_analysis','pr_preview_analysis')
      AND job.repository_id=association.repository_id AND job.service_id=association.service_id
      AND job.service_root=association.service_root AND job.target_revision=association.immutable_revision
      AND job.result_snapshot_id=association.snapshot_id AND job.config_fingerprint=association.config_fingerprint
      AND job.config_version=association.config_version
      AND job.analyzer_adapter_id=association.analyzer_adapter_id
      AND job.analyzer_adapter_version=association.analyzer_adapter_version
      AND job.exchange_version=association.exchange_version
      AND job.ir_version=association.ir_version AND job.identity_version=association.identity_version
    JOIN orchestration_job_results result ON result.tenant_id=job.tenant_id AND result.job_id=job.job_id
      AND result.repository_id=association.repository_id AND result.service_id=association.service_id
      AND result.target_snapshot_id=association.snapshot_id AND result.base_snapshot_id=association.snapshot_id
      AND result.base_selected_revision IS NOT NULL AND result.coverage_status='complete'
      AND result.plan_document->>'action'='reuse_base_snapshot'
    JOIN orchestration_configurations configuration ON configuration.tenant_id=association.tenant_id
      AND configuration.config_fingerprint=association.config_fingerprint
      AND configuration.config_version=association.config_version
    WHERE association.tenant_id=$1 AND association.repository_id=$2 AND association.service_id=$3
      AND association.immutable_revision=$4 AND association.association_kind='reused'
      AND association.analyzer_status='success' AND snapshot.analyzer_status='success'
      AND snapshot.immutable_revision<>association.immutable_revision
      AND ($6::text IS NULL OR association.snapshot_id=$6)
      AND ($7::text IS NULL OR association.config_fingerprint=$7)
      AND ${granted(5)}
      AND EXISTS (SELECT 1 FROM orchestration_revision_snapshots base
        WHERE base.tenant_id=association.tenant_id AND base.repository_id=association.repository_id
          AND base.service_id=association.service_id AND base.service_root=association.service_root
          AND base.immutable_revision=result.base_selected_revision
          AND base.source_digest=association.source_digest
          AND base.analyzer_adapter_id=association.analyzer_adapter_id
          AND base.analyzer_adapter_version=association.analyzer_adapter_version
          AND base.exchange_version=association.exchange_version
          AND base.ir_version=association.ir_version AND base.identity_version=association.identity_version
          AND base.config_version=association.config_version
          AND base.config_fingerprint=association.config_fingerprint
          AND base.snapshot_id=result.base_snapshot_id)
    ORDER BY association.snapshot_id COLLATE "C" LIMIT 2`,
    [selector.tenantId,selector.repositoryId,selector.serviceId,selectedRevision,principalId,
      snapshotId??null,configFingerprint??null,validatedConfiguration!==undefined]);
  const matches: ReusedSnapshot[] = [];
  for (const association of selected.rows) {
    const parsedConfig = validatedConfiguration===undefined ? parseConfig(association.config_document)
      : {ok:true as const,value:validatedConfiguration.document};
    if (!parsedConfig.ok || validatedConfiguration!==undefined
        && validatedConfiguration.configFingerprint!==association.config_fingerprint
      || canonicalOrchestrationHash(parsedConfig.value) !== association.config_document_sha256
      || parsedConfig.value.config_version !== association.config_version) return storage();
    const repository = parsedConfig.value.repositories.find(item => item.repository_id === selector.repositoryId);
    const service = repository?.services.find(item => item.service_id === selector.serviceId);
    if (!repository || !service || service.root !== association.service_root
      || (service.analyzer.resolution_inputs ?? []).length !== 0
      || service.analyzer.adapter_id !== association.analyzer_adapter_id
      || service.analyzer.adapter_version !== association.analyzer_adapter_version
      || configuredAnalyzerIrVersion(service.analyzer) !== association.ir_version
      || !await hasScopes(client, selector.tenantId, principalId, [repository.access_scope_id])) return denied();
    const rows = await selectAuthorized(client, selector, principalId,
      "snapshot.snapshot_id=$4", [association.snapshot_id], maxDocumentBytes);
    if (rows.length !== 1) return storage();
    const row = rows[0]!;
    if (maxDocumentBytes !== undefined && (row.document === null || Number(row.document_bytes) > maxDocumentBytes))
      throw new CorpusBudgetExceeded();
    const snapshot = verifySnapshot(row, selector);
    const plan = parseUpdatePlan(association.plan_document);
    const differences = parseContractDifferenceSet(association.difference_document);
    if (!plan.ok || !differences.ok || plan.value.update_plan_version !== association.plan_version
      || differences.value.contract_difference_version !== association.difference_version
      || plan.value.action !== "reuse_base_snapshot" || plan.value.dependency_coverage !== "complete"
      || plan.value.changed_paths.length !== 0 || plan.value.affected_endpoint_ids.length !== 0
      || plan.value.service.repository_id !== selector.repositoryId
      || plan.value.service.service_id !== selector.serviceId
      || plan.value.service.service_root !== association.service_root
      || plan.value.service.base_snapshot_id !== association.snapshot_id
      || plan.value.service.base_revision !== snapshot.source.immutable_revision
      || plan.value.service.target_revision !== selectedRevision
      || plan.value.service.base_source_digest !== association.source_digest
      || plan.value.service.target_source_digest !== association.source_digest
      || plan.value.analysis.target.analyzer.analyzer_id !== association.analyzer_adapter_id
      || plan.value.analysis.target.analyzer.analyzer_version !== association.analyzer_adapter_version
      || plan.value.analysis.target.analyzer_exchange_version !== association.exchange_version
      || plan.value.analysis.target.ir_version !== association.ir_version
      || plan.value.analysis.target.identity_version !== association.identity_version
      || plan.value.analysis.target.config_version !== association.config_version
      || plan.value.analysis.target.config_fingerprint !== association.config_fingerprint
      || differences.value.service_id !== selector.serviceId
      || differences.value.comparison_status !== "complete"
      || differences.value.incomplete_reason_codes.length !== 0
      || differences.value.differences.length !== 0
      || differences.value.base.snapshot_id !== association.snapshot_id
      || differences.value.target.snapshot_id !== association.snapshot_id
      || differences.value.base.immutable_revision !== snapshot.source.immutable_revision
      || differences.value.target.immutable_revision !== snapshot.source.immutable_revision
      || !bounded(association.base_selected_revision)) return storage();
    const expectedInputs = canonicalOrchestrationHash({version: "orchestration-resolution-inputs-1",
      resolutionInputs: [{kind: "source_tree", path: association.service_root,
        digest: association.source_digest}]});
    if (snapshot.coverage.status !== "complete" || snapshot.source.source_digest !== association.source_digest
      || snapshot.service.root !== association.service_root
      || snapshot.analyzer.analyzer_id !== association.analyzer_adapter_id
      || snapshot.analyzer.analyzer_version !== association.analyzer_adapter_version
      || snapshot.ir_version !== association.ir_version
      || snapshot.identity_version !== association.identity_version
      || snapshot.config.config_version !== association.config_version
      || snapshot.config.config_fingerprint !== association.config_fingerprint
      || association.resolution_inputs_fingerprint !== null
        && association.resolution_inputs_fingerprint !== expectedInputs) return storage();
    const associationKey = canonicalOrchestrationHash([selector.tenantId, selector.repositoryId,
      selector.serviceId, association.service_root, selectedRevision, association.source_digest,
      association.analyzer_adapter_id, association.analyzer_adapter_version, association.exchange_version,
      association.ir_version, association.identity_version, association.config_version,
      association.config_fingerprint]);
    matches.push({row,selectedRevision,associationKey});
  }
  return matches;
};

const readRevision = async (client: PoolClient, selector: QuerySelection,
  principalId: string): Promise<QueryCoreResult> => {
  if (selector.selector.kind !== "revision") return storage();
  const rows = await selectAuthorized(client, selector, principalId,
    "snapshot.immutable_revision=$4", [selector.selector.revision]);
  const reused = await readAuthorizedSourceReuse(client, selector, principalId, selector.selector.revision);
  if (rows.length + reused.length === 0) return denied();
  if (rows.length + reused.length > 1) return resultState(selector, "ambiguous");
  return rows.length === 1 ? resolved(selector, rows[0]!)
    : resolved(selector, reused[0]!.row, {selectedRevision: reused[0]!.selectedRevision});
};

const readBranch = async (client: PoolClient, selector: QuerySelection,
  principalId: string): Promise<QueryCoreResult> => {
  if (selector.selector.kind !== "branch") return storage();
  const pointer = (await client.query<{ snapshot_id: string; pointer_version: string }>(
    `SELECT snapshot_id,pointer_version::text FROM catalog_branch_pointers
     WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch=$4`,
    [selector.tenantId, selector.repositoryId, selector.serviceId, selector.selector.branch],
  )).rows[0];
  if (!pointer) return denied();
  const checkpoint = (await client.query<{ desired_state: string; desired_revision: string | null;
    last_successful_snapshot_id: string | null; last_successful_selected_revision: string | null;
    last_successful_association_key: string | null; latest_outcome: string | null }>(
    `SELECT desired_state,desired_revision,last_successful_snapshot_id,
       last_successful_selected_revision,last_successful_association_key,latest_outcome
     FROM orchestration_branch_checkpoints WHERE tenant_id=$1 AND repository_id=$2
       AND service_id=$3 AND branch=$4`,
    [selector.tenantId,selector.repositoryId,selector.serviceId,selector.selector.branch],
  )).rows[0];
  const rows = await selectAuthorized(client, selector, principalId,
    "snapshot.snapshot_id=$4", [pointer.snapshot_id]);
  if (rows.length !== 1) return denied();
  if (selector.selector.expectedPointerVersion !== undefined
    && selector.selector.expectedPointerVersion !== pointer.pointer_version)
    throw new QueryReadError("QUERY_STALE_SELECTION");
  if (checkpoint && (checkpoint.desired_state !== "present"
    || checkpoint.last_successful_snapshot_id !== pointer.snapshot_id
    || checkpoint.latest_outcome === "reconciliation_required"))
    throw new QueryReadError("QUERY_STALE_SELECTION");
  if (checkpoint && checkpoint.desired_revision !== rows[0]!.immutable_revision) {
    if (!checkpoint.desired_revision || checkpoint.last_successful_selected_revision !== checkpoint.desired_revision)
      throw new QueryReadError("QUERY_STALE_SELECTION");
    const reused = await readAuthorizedSourceReuse(client, selector, principalId,
      checkpoint.desired_revision, pointer.snapshot_id, rows[0]!.config_fingerprint);
    if (reused.length !== 1 || checkpoint.last_successful_association_key !== reused[0]!.associationKey)
      throw new QueryReadError("QUERY_STALE_SELECTION");
    return resolved(selector, rows[0]!, {pointerVersion: pointer.pointer_version,
      selectedRevision: checkpoint.desired_revision});
  }
  return resolved(selector, rows[0]!, { pointerVersion: pointer.pointer_version });
};

class CorpusBudgetExceeded extends Error {}
type ValidatedActiveConfiguration=Readonly<{configFingerprint:string;document:InstallationConfig}>;
const readEnvironment = async (client: PoolClient, selector: QuerySelection,
  principalId: string, maxDocumentBytes?: number,
  validatedConfiguration?:ValidatedActiveConfiguration): Promise<QueryCoreResult> => {
  if (selector.selector.kind !== "environment") return storage();
  let configFingerprint:string,configuration:InstallationConfig;
  if(validatedConfiguration){
    configFingerprint=validatedConfiguration.configFingerprint;
    configuration=validatedConfiguration.document;
  }else{
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
    configFingerprint=active.config_fingerprint;
    configuration=parsed.value;
  }
  const repo = configuration.repositories.find((item) => item.repository_id === selector.repositoryId);
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
  if (checkpoint && checkpoint.active_config_fingerprint === configFingerprint
    && (!checkpoint.source_access_label || !await hasScopes(client, selector.tenantId,
      principalId, [checkpoint.source_access_label]))) return denied();
  if (!checkpoint || checkpoint.reconciliation_required
    || checkpoint.active_config_fingerprint !== configFingerprint) return resultState(selector, "unknown");
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
    "snapshot.immutable_revision=$4 AND snapshot.config_fingerprint=$5", [revision.revision, configFingerprint],
    maxDocumentBytes);
  const reused = await readAuthorizedSourceReuse(client, selector, principalId, revision.revision,
    undefined, configFingerprint, maxDocumentBytes, validatedConfiguration);
  if (rows.length + reused.length === 0) return resultState(selector, "unavailable");
  if (rows.length + reused.length > 1) return resultState(selector, "ambiguous");
  const chosen = rows[0] ?? reused[0]!.row;
  if(maxDocumentBytes!==undefined&&(chosen.document===null
    ||Number(chosen.document_bytes)>maxDocumentBytes))throw new CorpusBudgetExceeded();
  if (selector.selector.expectedCheckpointVersion !== undefined
    && selector.selector.expectedCheckpointVersion !== checkpoint.version)
    throw new QueryReadError("QUERY_STALE_SELECTION");
  return resolved(selector, chosen, { checkpointVersion: checkpoint.version,
    ...(reused.length ? {selectedRevision: revision.revision} : {}) });
};

const publicationKey = (selection: QuerySelection): PublicationKey => {
  const base = { repositoryId: selection.repositoryId, serviceId: selection.serviceId };
  if (selection.selector.kind === "revision") return { ...base, kind: "revision", revision: selection.selector.revision };
  if (selection.selector.kind === "branch") return { ...base, kind: "branch", branch: selection.selector.branch };
  return { ...base, kind: "environment", environment: selection.selector.environment };
};

const readSelected = async (client: PoolClient, selector: QuerySelection,
  principalId: string): Promise<QueryContractResult> => {
  const selected = selector.selector.kind === "revision" ? await readRevision(client, selector, principalId)
    : selector.selector.kind === "branch" ? await readBranch(client, selector, principalId)
      : await readEnvironment(client, selector, principalId);
  if (selected.status !== "resolved") return selected;
  let publication: QueryPublication = Object.freeze({ status: "absent" });
  if (selected.pin.selectedRevision !== undefined) return Object.freeze({ ...selected, publication });
  try {
    const validated = await readCurrentOpenApiWithClient(client,
      { tenantId: selector.tenantId, principalId }, publicationKey(selector));
    const published = validated.selector;
    if (published.snapshotId === selected.pin.snapshotId
      && published.revision === selected.pin.revision
      && published.configFingerprint === selected.pin.configFingerprint
      && (published.kind !== "branch" || published.pointerVersion === selected.pin.pointerVersion)
      && (published.kind !== "environment" || published.checkpointVersion === selected.pin.checkpointVersion)) {
      publication = Object.freeze({ status: "current", publicationId: validated.publication.publicationId,
        contentSha256: validated.publication.contentSha256,
        ...(validated.publication.pointerVersion === undefined ? {}
          : { pointerVersion: validated.publication.pointerVersion }), selector: published });
    }
  } catch (error) {
    if (!(error instanceof OpenApiStorageError)) throw error;
    if (error.code !== "NOT_FOUND_OR_DENIED" && error.code !== "STALE_POINTER")
      throw new QueryReadError("QUERY_STORAGE_ERROR");
  }
  return Object.freeze({ ...selected, publication });
};

type ObservationDbRow = {import_id:string; record_id:string; source_id:string; source_version:string;
  window_start:Date|string; window_end:Date|string; imported_at:Date|string; status:string; reason:string|null;
  endpoint_id:string|null; mapping_id:string|null; method:string|null; status_code:number|null;
  completeness:string; policy_version:string};
const timestamp = (value:Date|string):string => {
  const parsed=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(parsed.getTime()))return storage();
  return parsed.toISOString();
};
const readMetadataObservationsWithClient = async (client:PoolClient,selector:QuerySelection,
  principalId:string,options:QueryObservationOptions):Promise<QueryObservationResult> => {
  if(selector.selector.kind!=="environment")throw new QueryReadError("INVALID_QUERY_OBSERVATION");
  const selected=await readSelected(client,selector,principalId);
  if(selected.status!=="resolved")return Object.freeze({status:selected.status,selector});
  if(selected.pin.selectedRevision!==undefined)return Object.freeze({status:"unknown",selector});
  if(options.endpointId!==undefined&&!selected.snapshot.endpoints.some(endpoint=>endpoint.endpoint_id===options.endpointId))return denied();
  const result=await client.query<ObservationDbRow>(
    `SELECT imported.import_id::text,observed.record_id::text,imported.source_id,imported.source_version,
       imported.window_start,imported.window_end,imported.imported_at,observed.status,observed.reason,
       observed.endpoint_id,observed.mapping_id,observed.method,observed.status_code,
       observed.completeness,observed.policy_version
     FROM observation_records observed
     JOIN observation_imports imported ON imported.tenant_id=observed.tenant_id
       AND imported.repository_id=observed.repository_id AND imported.service_id=observed.service_id
       AND imported.environment=observed.environment AND imported.import_id=observed.import_id
     WHERE observed.tenant_id=$1 AND observed.repository_id=$2 AND observed.service_id=$3
       AND observed.environment=$4 AND imported.snapshot_id=$5 AND imported.revision=$6
       AND imported.config_fingerprint=$7 AND imported.checkpoint_version=$8::bigint
       AND ($9::text IS NULL OR observed.endpoint_id=$9)
     ORDER BY imported.imported_at DESC, imported.import_id::text COLLATE "C" DESC,
       observed.record_id::text COLLATE "C" ASC LIMIT $10`,
    [selector.tenantId,selector.repositoryId,selector.serviceId,selector.selector.environment,
      selected.pin.snapshotId,selected.pin.revision,selected.pin.configFingerprint,
      selected.pin.checkpointVersion,options.endpointId??null,options.limit+1]);
  const truncated=result.rows.length>options.limit;
  const records=result.rows.slice(0,options.limit).map(row=>{
    const safeToken=(value:string|null):value is string=>value!==null&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    const safeUuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
    const reasons=new Set(["environment_unresolved","revision_unknown","revision_mismatch","invalid_url","no_mapping",
      "ambiguous_mapping","no_endpoint","ambiguous_endpoint","unsupported_route_selectors"]);
    if(!safeUuid(row.import_id)||!safeUuid(row.record_id)||!safeToken(row.source_id)||!safeToken(row.source_version)
      ||!(["confirmed","unresolved"].includes(row.status))||row.completeness!=="metadata_only"
      ||row.policy_version!=="metadata-only-1"||row.status_code!==null&&(!Number.isInteger(row.status_code)
        ||row.status_code<100||row.status_code>599)||row.method!==null&&!(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"].includes(row.method)))return storage();
    if(row.status==="confirmed"&&(!row.endpoint_id||!selected.snapshot.endpoints.some(endpoint=>endpoint.endpoint_id===row.endpoint_id)
      ||!safeToken(row.mapping_id)||!row.method||row.status_code===null||row.reason!==null)
      ||row.status==="unresolved"&&(row.endpoint_id!==null||row.mapping_id!==null||!row.reason||!reasons.has(row.reason)))return storage();
    return Object.freeze({importId:row.import_id,recordId:row.record_id,sourceId:row.source_id,
      sourceVersion:row.source_version,windowStart:timestamp(row.window_start),windowEnd:timestamp(row.window_end),
      importedAt:timestamp(row.imported_at),status:row.status as "confirmed"|"unresolved",
      ...(row.reason===null?{}:{reason:row.reason}),...(row.endpoint_id===null?{}:{endpointId:row.endpoint_id}),
      ...(row.mapping_id===null?{}:{mappingId:row.mapping_id}),...(row.method===null?{}:{method:row.method}),
      ...(row.status_code===null?{}:{statusCode:row.status_code}),completeness:"metadata_only" as const,
      policyVersion:"metadata-only-1" as const});
  });
  return Object.freeze({status:"resolved",selector,pin:selected.pin,records:Object.freeze(records),truncated});
};

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
      try { state = await readSelected(client, selection, principalId); }
      catch (error) {
        if (error instanceof QueryReadError && error.code === "QUERY_NOT_FOUND_OR_DENIED") continue;
        throw error;
      }
      const environment = Object.freeze({ name: request.environment, status: state.status,
        ...(state.status === "resolved" ? { pin: state.pin, publication: state.publication } : {}) });
      services.push(Object.freeze({ repositoryId: repository.repository_id,
        serviceId: service.service_id, environment }));
    }
    if (services.length > request.limit) throw new QueryReadError("QUERY_RESULT_LIMIT_EXCEEDED");
  }
  return Object.freeze({ services: Object.freeze(services), truncated: false });
};

const MAX_CORPUS_SERVICES=20,MAX_CONFIGURED_INSPECTED=200,MAX_CORPUS_ENDPOINTS=5_000;
const MAX_CORPUS_BYTES=4*1024*1024,CORPUS_DEADLINE_MS=10_000;
const byteOrder=(left:string,right:string):number=>Buffer.compare(Buffer.from(left),Buffer.from(right));

const withCorpusDeadline=(client:PoolClient,started:number):PoolClient=>{
  const rawQuery=client.query.bind(client);
  const run=async(...args:unknown[]):Promise<unknown>=>{
    const remaining=Math.floor(CORPUS_DEADLINE_MS-(performance.now()-started));
    if(remaining<=0)throw new CorpusBudgetExceeded();
    const operation=(rawQuery as (...queryArgs:unknown[])=>Promise<unknown>)(...args);
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new CorpusBudgetExceeded()),remaining);
      timer.unref?.();
    });
    try{return await Promise.race([operation,deadline]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  const query=(async(...args:unknown[])=>{
    const remaining=Math.floor(CORPUS_DEADLINE_MS-(performance.now()-started));
    if(remaining<=0)throw new CorpusBudgetExceeded();
    try{
      await run("SELECT set_config('statement_timeout',$1,true)",[`${remaining}ms`]);
      if(CORPUS_DEADLINE_MS-(performance.now()-started)<=0)throw new CorpusBudgetExceeded();
      return await run(...args);
    }catch(error){
      if(error instanceof CorpusBudgetExceeded)throw error;
      if(error&&typeof error==="object"&&(error as {code?:unknown}).code==="57014")
        throw new CorpusBudgetExceeded();
      throw error;
    }
  }) as PoolClient["query"];
  return new Proxy(client,{get(target,property){
    if(property==="query")return query;
    const value=Reflect.get(target,property,target);
    return typeof value==="function"?value.bind(target):value;
  }});
};

/** A lexical search over currently serving, visible contracts in one database snapshot. */
const searchCorpusWithClient=async(client:PoolClient,principalId:string,
  request:CorpusSearchRequest):Promise<CorpusOperationSearchResult>=>{
  const started=performance.now();
  const budgetClient=withCorpusDeadline(client,started);
  let scanLimit=false,incomplete=false,anyServiceTruncated=false,visible=0,bytes=0,endpoints=0;
  const tighten=async()=>{
    const remaining=CORPUS_DEADLINE_MS-(performance.now()-started);
    if(remaining<=0){scanLimit=true;return false;}
    return true;
  };
  await budgetClient.query("SET LOCAL statement_timeout TO '10s'");
  const active=(await budgetClient.query<{config_fingerprint:string;document:unknown;document_sha256:string;document_bytes:string}>(
    `SELECT CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document
        ELSE NULL END AS document,active.config_fingerprint,configuration.document_sha256,
       octet_length(configuration.document::text)::text AS document_bytes
     FROM orchestration_active_configurations active
     JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
       AND configuration.config_fingerprint=active.config_fingerprint
     WHERE active.tenant_id=$1`,[request.tenantId,MAX_CORPUS_BYTES])).rows[0];
  if(!active)return Object.freeze({status:"unknown",matchMode:"keyword",scope:"visible_authorized_services",
    environment:request.environment,reason:"no_visible_services"});
  if(active.document===null||Number(active.document_bytes)>MAX_CORPUS_BYTES)return Object.freeze({status:"unknown",
    matchMode:"keyword",scope:"visible_authorized_services",environment:request.environment,reason:"scan_limit"});
  const parsed=parseConfig(active.document);
  if(!parsed.ok||canonicalOrchestrationHash(parsed.value)!==active.document_sha256)return storage();
  const validatedConfiguration:ValidatedActiveConfiguration=Object.freeze({
    configFingerprint:active.config_fingerprint,document:parsed.value,
  });
  bytes=Buffer.byteLength(JSON.stringify(active.document),"utf8");
  if(bytes>MAX_CORPUS_BYTES)return Object.freeze({status:"unknown",matchMode:"keyword",
    scope:"visible_authorized_services",environment:request.environment,reason:"scan_limit"});
  type Configured=Readonly<{repositoryId:string;serviceId:string;repositoryScope:string;environmentScope:string}>;
  const configured:Configured[]=[];
  let inspected=0;
  for(const repository of parsed.value.repositories){
    for(const service of repository.services){
      if(++inspected>MAX_CONFIGURED_INSPECTED){scanLimit=true;break;}
      const environment=service.environments.find(item=>item.name===request.environment);
      if(!environment)continue;
      configured.push({repositoryId:repository.repository_id,serviceId:service.service_id,
        repositoryScope:repository.access_scope_id,
        environmentScope:environment.deployment_authority.access_scope_id});
    }
    if(scanLimit)break;
  }
  configured.sort((a,b)=>byteOrder(a.repositoryId,b.repositoryId)||byteOrder(a.serviceId,b.serviceId));
  if(!await tighten())return Object.freeze({status:"unknown",matchMode:"keyword",
    scope:"visible_authorized_services",environment:request.environment,reason:"scan_limit"});
  const grantRows=(await budgetClient.query<{access_scope_id:string}>(
    `SELECT scope.access_scope_id FROM access_scopes scope
     JOIN principal_scope_grants grant_row ON grant_row.tenant_id=scope.tenant_id
       AND grant_row.access_scope_id=scope.access_scope_id
     WHERE scope.tenant_id=$1 AND grant_row.principal_id=$2
       AND scope.active AND grant_row.active
     ORDER BY scope.access_scope_id COLLATE "C" LIMIT 1025`,
    [request.tenantId,principalId])).rows;
  if(grantRows.length>1024)return Object.freeze({status:"unknown",matchMode:"keyword",
    scope:"visible_authorized_services",environment:request.environment,reason:"scan_limit"});
  const grantedScopes=new Set(grantRows.map(row=>row.access_scope_id));
  const authorized=configured.filter(item=>grantedScopes.has(item.repositoryScope)
    &&grantedScopes.has(item.environmentScope));
  if(authorized.length>MAX_CORPUS_SERVICES)scanLimit=true;
  const found:CorpusOperationCandidate[]=[];
  for(const service of authorized.slice(0,MAX_CORPUS_SERVICES)){
    if(bytes>MAX_CORPUS_BYTES||!await tighten()){scanLimit=true;break;}
    const selector=parseQuerySelection({version:"1",tenantId:request.tenantId,
      repositoryId:service.repositoryId,serviceId:service.serviceId,
      selector:{kind:"environment",environment:request.environment}});
    let selected:QueryCoreResult;
    try{selected=await readEnvironment(budgetClient,selector,principalId,
      Math.max(0,MAX_CORPUS_BYTES-bytes),validatedConfiguration);}
    catch(error){if(error instanceof QueryReadError&&error.code==="QUERY_NOT_FOUND_OR_DENIED")continue;
      if(error instanceof CorpusBudgetExceeded)throw error;
      throw error;}
    if(selected.status!=="resolved"){visible++;incomplete=true;continue;}
    const scopes=[...new Set(selected.snapshot.evidence.map(item=>item.access_label))];
    if(scopes.length>1024){scanLimit=true;break;}
    if(scopes.length>0){
      if(!await tighten()){scanLimit=true;break;}
      if(!await hasScopes(budgetClient,request.tenantId,principalId,scopes))continue;
    }
    visible++;
    endpoints+=selected.snapshot.endpoints.length;
    bytes+=Buffer.byteLength(JSON.stringify(selected.snapshot),"utf8");
    if(endpoints>MAX_CORPUS_ENDPOINTS||bytes>MAX_CORPUS_BYTES){scanLimit=true;break;}
    const pinnedSelector=parseQuerySelection({...selector,selector:{kind:"environment",
      environment:request.environment,expectedCheckpointVersion:selected.pin.checkpointVersion}});
    const matched=searchOperationCandidates({status:"resolved",selector:pinnedSelector,
      pin:selected.pin,snapshot:selected.snapshot},{intentQuery:request.intentQuery,limit:20});
    if(matched.status==="candidates"){
      if(!matched.complete)incomplete=true;
      for(const candidate of matched.candidates)found.push(Object.freeze({...candidate,
        repositoryId:service.repositoryId,serviceId:service.serviceId,
        selector:pinnedSelector,pin:selected.pin}));
      if(matched.truncated)anyServiceTruncated=true;
    }else if(matched.status==="unknown")incomplete=true;
    if(performance.now()-started>=CORPUS_DEADLINE_MS){scanLimit=true;break;}
  }
  found.sort((a,b)=>b.score-a.score||byteOrder(a.repositoryId,b.repositoryId)
    ||byteOrder(a.serviceId,b.serviceId)||byteOrder(a.endpointId,b.endpointId));
  const complete=!scanLimit&&!incomplete;
  if(found.length>0)return Object.freeze({status:"candidates",matchMode:"keyword",
    scope:"visible_authorized_services",environment:request.environment,
    candidates:Object.freeze(found.slice(0,request.limit)),complete,
    truncated:anyServiceTruncated||found.length>request.limit,
    ...(complete?{}:{incompleteReason:scanLimit?"scan_limit" as const:"incomplete_scan" as const})});
  if(complete&&visible>0)return Object.freeze({status:"no_match",matchMode:"keyword",
    scope:"visible_authorized_services",environment:request.environment,complete:true,truncated:false});
  return Object.freeze({status:"unknown",matchMode:"keyword",scope:"visible_authorized_services",
    environment:request.environment,reason:scanLimit?"scan_limit":visible===0?"no_visible_services":"incomplete_scan"});
};

/** Read within a caller-owned transaction; retains the same selector and authorization checks. */
export async function readQueryContractWithClient(client:PoolClient, options:{schema:string},
  contextInput:unknown, selectionInput:unknown):Promise<QueryContractResult> {
  const selector=parseQuerySelection(selectionInput);
  const principalId=parseContext(contextInput,selector.tenantId);
  const schema=quoteEnvironmentSchema(options.schema);
  try {
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    const selected=await readSelected(client,selector,principalId);
    // Transaction consumers currently require one revision for both serving selection and evidence.
    // They must opt in to this two-revision lineage before using it for imports or model egress.
    return selected.status==="resolved"&&selected.pin.selectedRevision!==undefined
      ? Object.freeze({status:"unknown",selector}) : selected;
  } catch(error) {
    if(error instanceof QueryReadError)throw error;
    throw new QueryReadError("QUERY_STORAGE_ERROR");
  }
}

/** Reads selector, authorization, and snapshot in one consistent database transaction. */
export const createQueryReader = (pool: Pool, options: { schema: string }): QueryReader & QueryObservationReader & QueryOperationReader & QueryCorpusOperationReader => {
  const schema = quoteEnvironmentSchema(options.schema);
  const withRead = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect().catch(() => { throw new QueryReadError("QUERY_STORAGE_ERROR"); });
    let destroyClient=false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if(error instanceof CorpusBudgetExceeded){destroyClient=true;throw error;}
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof QueryReadError) throw error;
      throw new QueryReadError("QUERY_STORAGE_ERROR");
    } finally { client.release(destroyClient); }
  };
  const readContract = async (contextInput: unknown, selectionInput: unknown): Promise<QueryContractResult> => {
    const selector = parseQuerySelection(selectionInput);
    const principalId = parseContext(contextInput, selector.tenantId);
    return withRead((client) => readSelected(client, selector, principalId));
  };
  return Object.freeze({
    readContract,
    async searchOperationCandidatesAcrossServices(contextInput:unknown,requestInput:unknown):Promise<CorpusOperationSearchResult>{
      const request=parseCorpusSearchRequest(requestInput);
      const principalId=parseContext(contextInput,request.tenantId);
      try{return await withRead(client=>searchCorpusWithClient(client,principalId,request));}
      catch(error){if(error instanceof CorpusBudgetExceeded)return Object.freeze({status:"unknown",
        matchMode:"keyword",scope:"visible_authorized_services",environment:request.environment,
        reason:"scan_limit"});throw error;}
    },
    async readOperationCandidates(contextInput:unknown,selectionInput:unknown,optionsInput:unknown):Promise<OperationSearchResult>{
      const options=validateOperationSearchOptions(optionsInput);
      if(!options)throw new QueryReadError("INVALID_QUERY_SEARCH");
      const selector=parseQuerySelection(selectionInput);
      if(selector.selector.kind!=="environment"||selector.selector.expectedCheckpointVersion===undefined)
        throw new QueryReadError("INVALID_QUERY_SEARCH");
      const principalId=parseContext(contextInput,selector.tenantId);
      return withRead(async client=>{
        const selected=await readSelected(client,selector,principalId);
        if(selected.status==="resolved"){
          const scopes=selected.snapshot.evidence.map(item=>item.access_label);
          if(scopes.length>0&&!await hasScopes(client,selector.tenantId,principalId,scopes))return denied();
        }
        return searchOperationCandidates(selected,options);
      });
    },
    async readMetadataObservations(contextInput:unknown,selectionInput:unknown,optionsInput:unknown):Promise<QueryObservationResult>{
      const selector=parseQuerySelection(selectionInput);
      if(selector.selector.kind!=="environment")throw new QueryReadError("INVALID_QUERY_OBSERVATION");
      const options=parseObservationOptions(optionsInput);
      const principalId=parseContext(contextInput,selector.tenantId);
      return withRead(client=>readMetadataObservationsWithClient(client,selector,principalId,options));
    },
    async readPublication(contextInput: unknown, keyInput: unknown): Promise<QueryHistoricalPublication> {
      const key = parsePublicationKey(keyInput);
      const principalId = parseContext(contextInput, key.tenantId);
      return withRead(async (client) => {
        let validated;
        try { validated = await readPublicationOpenApiWithClient(client,
          { tenantId: key.tenantId, principalId }, key.publicationId); }
        catch (error) {
          if (error instanceof OpenApiStorageError && error.code === "NOT_FOUND_OR_DENIED")
            return denied();
          throw new QueryReadError("QUERY_STORAGE_ERROR");
        }
        if (validated.selector.repositoryId !== key.repositoryId
          || validated.selector.serviceId !== key.serviceId) return denied();
        const selector = validated.selector;
        return Object.freeze({ publicationId: validated.publication.publicationId,
          contentSha256: validated.publication.contentSha256,
          bytes: validated.publication.bytes, selector, pin: Object.freeze({
            snapshotId: selector.snapshotId, revision: selector.revision,
            configFingerprint: selector.configFingerprint,
            ...(selector.kind === "branch" ? { pointerVersion: selector.pointerVersion } : {}),
            ...(selector.kind === "environment" ? { checkpointVersion: selector.checkpointVersion } : {}),
          }) });
      });
    },
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
      return Object.freeze({ status: "resolved", selector: result.selector, pin: result.pin, publication: result.publication, endpoint });
    },
    async readSchema(contextInput: unknown, selectionInput: unknown,
      schemaId: unknown): Promise<QueryDetailResult<"schema">> {
      if (!bounded(schemaId)) throw new QueryReadError("INVALID_QUERY_DETAIL");
      const result = await readContract(contextInput, selectionInput);
      if (result.status !== "resolved") return result;
      if (!Object.hasOwn(result.snapshot.schemas, schemaId)) return denied();
      const component = result.snapshot.schemas[schemaId]!;
      return Object.freeze({ status: "resolved", selector: result.selector, pin: result.pin, publication: result.publication, schema: component });
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
          return Object.freeze({ status: "compared", before: base.pin, after: target.pin,
            beforePublication: base.publication, afterPublication: target.publication, differences });
        } catch { throw new QueryReadError("QUERY_COMPARISON_UNAVAILABLE"); }
      });
    },
  });
};
