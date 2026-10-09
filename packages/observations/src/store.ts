import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig, type ContractSnapshot} from "../../ir/src/index.js";
import {canonicalOrchestrationHash} from "../../orchestration/src/canonical.js";
import {readQueryContractWithClient, QueryReadError} from "../../query/src/reader.js";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";
import {correlateMetadataObservation, OBSERVATION_POLICY_VERSION} from "./matcher.js";
import type {ObservationContext, SanitizedObservationResult, TrustedRouteMapping} from "./types.js";

export class ObservationImportError extends Error {
  readonly code: "INVALID_OBSERVATION_IMPORT" | "OBSERVATION_NOT_AUTHORIZED" | "OBSERVATION_STALE_PIN"
    | "INVALID_SOURCE_BATCH" | "INVALID_OBSERVATION" | "OBSERVATION_IMPORT_COLLISION" | "OBSERVATION_STORAGE_ERROR";
  constructor(code: ObservationImportError["code"]) {super(code); this.name = "ObservationImportError"; this.code = code;}
}

export type ExpectedObservationPin = Readonly<{tenantId: string; repositoryId: string; serviceId: string; environment: string;
  snapshotId: string; revision: string; configFingerprint: string; checkpointVersion: string}>;
type SafeImportRef = Readonly<{importId: string; expectedPin: ExpectedObservationPin}>;
type AuthenticatedImporter = Readonly<{tenantId: string; principalId: string;
  capabilities: readonly string[]}>;
type SourceBatch = Readonly<{attestation: ObservationContext["attestation"];
  mappings: readonly TrustedRouteMapping[]; records: readonly Readonly<{recordId: string; raw: unknown}>[]}>;
type ImportOutcome = Readonly<{outcome: "inserted" | "existing"; imported: number}>;

const opaqueId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = (value: unknown): value is string => typeof value === "string" &&
  value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const version = (value: unknown): value is string => typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

const fields = (input: unknown, names: readonly string[]): Record<string, unknown> | undefined => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key)))
      return undefined;
    const output: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !("value" in descriptor)) return undefined;
      output[name] = descriptor.value;
    }
    return output;
  } catch {return undefined;}
};

const arrayValues = (input: unknown, minimum: number, maximum: number): unknown[] | undefined => {
  try {
    if (!Array.isArray(input) || isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype)
      return undefined;
    const length = Object.getOwnPropertyDescriptor(input, "length")?.value as unknown;
    if (typeof length !== "number" || !Number.isInteger(length) || length < minimum || length > maximum)
      return undefined;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) return undefined;
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      values.push(descriptor.value);
    }
    return values;
  } catch {return undefined;}
};

const pinKeys = ["tenantId", "repositoryId", "serviceId", "environment", "snapshotId",
  "revision", "configFingerprint", "checkpointVersion"] as const;

const parseImportRef = (input: unknown): SafeImportRef => {
  const outer = fields(input, ["importId", "expectedPin"]);
  const pin = fields(outer?.expectedPin, pinKeys);
  if (!outer || typeof outer.importId !== "string" || !opaqueId.test(outer.importId) || !pin ||
    pinKeys.slice(0, -1).some(key => !identifier(pin[key])) || !version(pin.checkpointVersion))
    throw new ObservationImportError("INVALID_OBSERVATION_IMPORT");
  return Object.freeze({importId: outer.importId as string, expectedPin: Object.freeze(pin) as ExpectedObservationPin});
};

const parseImporter = (value: unknown, pin: ExpectedObservationPin): AuthenticatedImporter => {
  const record = fields(value, ["tenantId", "principalId", "capabilities"]);
  const capabilities = arrayValues(record?.capabilities, 1, 16);
  if (!record || record.tenantId !== pin.tenantId || !identifier(record.principalId)
    || !capabilities || !capabilities.includes("observations.import")
    || capabilities.some(item => !identifier(item)))
    throw new ObservationImportError("OBSERVATION_NOT_AUTHORIZED");
  return Object.freeze({tenantId: pin.tenantId, principalId: record.principalId,
    capabilities: Object.freeze(capabilities as string[])});
};

const parseSourceBatch = (input: unknown): SourceBatch => {
  const batch = fields(input, ["attestation", "mappings", "records"]);
  const attestation = fields(batch?.attestation,
    ["revision", "sourceId", "sourceVersion", "windowStart", "windowEnd"]);
  const mappings = arrayValues(batch?.mappings, 0, 32);
  const sourceRecords = arrayValues(batch?.records, 1, 100);
  if (!batch || !attestation || !["revision", "sourceId", "sourceVersion"]
    .every(key => identifier(attestation[key])) || !["windowStart", "windowEnd"]
      .every(key => typeof attestation[key] === "string" && (attestation[key] as string).length <= 32)
    || !mappings || !sourceRecords)
    throw new ObservationImportError("INVALID_SOURCE_BATCH");
  const mappingKeys = [...pinKeys, "mappingId", "publicOrigin", "publicPathTemplate",
    "applicationPathTemplate", "method", "routingEvidenceIds"];
  const safeMappings = mappings.map(mapping => {
    const parsed = fields(mapping, mappingKeys);
    const evidenceIds = arrayValues(parsed?.routingEvidenceIds, 1, 16);
    if (!parsed || !evidenceIds || evidenceIds.some(id => !identifier(id)))
      throw new ObservationImportError("INVALID_SOURCE_BATCH");
    return Object.freeze({...parsed, routingEvidenceIds: Object.freeze(evidenceIds)}) as unknown as TrustedRouteMapping;
  });
  const ids = new Set<string>();
  const records = sourceRecords.map(record => {
    const parsed = fields(record, ["recordId", "raw"]);
    if (!parsed || typeof parsed.recordId !== "string" || !opaqueId.test(parsed.recordId)
      || ids.has(parsed.recordId)) throw new ObservationImportError("INVALID_SOURCE_BATCH");
    ids.add(parsed.recordId);
    return Object.freeze({recordId: parsed.recordId, raw: parsed.raw});
  });
  return Object.freeze({attestation: Object.freeze(attestation) as SourceBatch["attestation"],
    mappings: Object.freeze(safeMappings), records: Object.freeze(records)});
};

type ConfiguredScope = {configFingerprint: string; configActivationCheckpoint: string; requiredScopes: string[]; logAdapterId: string};
const loadConfiguredScopes = async (client: PoolClient, pin: ExpectedObservationPin): Promise<ConfiguredScope> => {
  const active = await client.query<{config_fingerprint: string; checkpoint_version: string; document_sha256: string; document: unknown}>(
    `SELECT active.config_fingerprint,active.checkpoint_version::text,configuration.document_sha256,configuration.document
     FROM orchestration_active_configurations active
     JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
       AND configuration.config_fingerprint=active.config_fingerprint
     WHERE active.tenant_id=$1 FOR SHARE OF active`, [pin.tenantId]);
  const row = active.rows[0];
  if (!row || row.config_fingerprint !== pin.configFingerprint)
    throw new ObservationImportError("OBSERVATION_STALE_PIN");
  const parsed = parseConfig(row.document);
  if (!parsed.ok || canonicalOrchestrationHash(parsed.value) !== row.document_sha256)
    throw new ObservationImportError("OBSERVATION_STORAGE_ERROR");
  const repository = parsed.value.repositories.find(item => item.repository_id === pin.repositoryId);
  const service = repository?.services.find(item => item.service_id === pin.serviceId);
  const environment = service?.environments.find(item => item.name === pin.environment);
  if (!repository || !environment || parsed.value.logs?.enabled !== true)
    throw new ObservationImportError("OBSERVATION_NOT_AUTHORIZED");
  const snapshot = await client.query<{required_scope_ids: string[]}>(
    `SELECT required_scope_ids FROM catalog_snapshots WHERE tenant_id=$1 AND repository_id=$2
       AND service_id=$3 AND snapshot_id=$4 AND immutable_revision=$5 AND config_fingerprint=$6`,
    [pin.tenantId, pin.repositoryId, pin.serviceId, pin.snapshotId, pin.revision, pin.configFingerprint]);
  const scopes = snapshot.rows[0]?.required_scope_ids;
  if (!scopes || !Array.isArray(scopes) || !scopes.length || scopes.length > 1024)
    throw new ObservationImportError("OBSERVATION_STALE_PIN");
  const unique = [...new Set([repository.access_scope_id,
    environment.deployment_authority.access_scope_id, ...scopes])].sort();
  if (unique.length > 1024 || unique.some(scope => !identifier(scope)))
    throw new ObservationImportError("OBSERVATION_STORAGE_ERROR");
  return {configFingerprint: row.config_fingerprint, configActivationCheckpoint: row.checkpoint_version, requiredScopes: unique,
    logAdapterId: parsed.value.logs.adapter_id};
};

const lockAuthorizedScopes = async (client: PoolClient, pin: ExpectedObservationPin, principalId: string,
  required: string[]): Promise<void> => {
  const scopes = await client.query<{access_scope_id: string; active: boolean}>(
    `SELECT access_scope_id,active FROM access_scopes WHERE tenant_id=$1
       AND access_scope_id=ANY($2::text[]) ORDER BY access_scope_id FOR SHARE`, [pin.tenantId, required]);
  const grants = await client.query<{access_scope_id: string; active: boolean}>(
    `SELECT access_scope_id,active FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2
       AND access_scope_id=ANY($3::text[]) ORDER BY access_scope_id FOR SHARE`,
    [pin.tenantId, principalId, required]);
  if (scopes.rows.length !== required.length || grants.rows.length !== required.length ||
    scopes.rows.some((row, index) => row.access_scope_id !== required[index] || !row.active) ||
    grants.rows.some((row, index) => row.access_scope_id !== required[index] || !row.active))
    throw new ObservationImportError("OBSERVATION_NOT_AUTHORIZED");
};

const lockCheckpoint = async (client: PoolClient, pin: ExpectedObservationPin): Promise<string | undefined> => {
  const checkpoint = await client.query<{version: string; reconciliation_required: boolean;
    source_access_label: string | null}>(
    `SELECT checkpoint.version::text,checkpoint.reconciliation_required,
       observation.source_access_label
     FROM environment_serving_checkpoints checkpoint
     LEFT JOIN environment_serving_observations observation
       ON observation.tenant_id=checkpoint.tenant_id
       AND observation.repository_id=checkpoint.repository_id
       AND observation.service_id=checkpoint.service_id
       AND observation.environment=checkpoint.environment
       AND observation.producer_id=checkpoint.current_producer_id
       AND observation.event_id=checkpoint.current_event_id
     WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id=$2
       AND checkpoint.service_id=$3 AND checkpoint.environment=$4 FOR UPDATE OF checkpoint`,
    [pin.tenantId, pin.repositoryId, pin.serviceId, pin.environment]);
  if (checkpoint.rows[0]?.version !== pin.checkpointVersion || checkpoint.rows[0]?.reconciliation_required)
    throw new ObservationImportError("OBSERVATION_STALE_PIN");
  return checkpoint.rows[0]?.source_access_label ?? undefined;
};

type AuthorizedPin = Readonly<{snapshot: ContractSnapshot; logAdapterId: string}>;
const authorizePinned = async (client: PoolClient, schema: string, identity: AuthenticatedImporter,
  pin: ExpectedObservationPin, constraints: ObservationPinConstraints): Promise<AuthorizedPin> => {
  await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
    [JSON.stringify(["api-truth:environment-serving", pin.tenantId, pin.repositoryId,
      pin.serviceId, pin.environment])]);
  const configured = await loadConfiguredScopes(client, pin);
  if (constraints.configActivationCheckpoint !== undefined
    && configured.configActivationCheckpoint !== constraints.configActivationCheckpoint)
    throw new ObservationImportError("OBSERVATION_STALE_PIN");
  const sourceScope = await lockCheckpoint(client, pin);
  const required = [...new Set([...configured.requiredScopes, ...(sourceScope === undefined ? [] : [sourceScope]),
    ...(constraints.additionalScopeIds ?? [])])].sort();
  if (required.length > 1024 || required.some(scope => !identifier(scope)))
    throw new ObservationImportError("OBSERVATION_STORAGE_ERROR");
  await lockAuthorizedScopes(client, pin, identity.principalId, required);
  const selected = await readQueryContractWithClient(client, {schema},
    {tenantId: pin.tenantId, principalId: identity.principalId},
    {version: "1", tenantId: pin.tenantId, repositoryId: pin.repositoryId,
      serviceId: pin.serviceId, selector: {kind: "environment", environment: pin.environment,
        expectedCheckpointVersion: pin.checkpointVersion}});
  if (selected.status !== "resolved" || selected.pin.snapshotId !== pin.snapshotId
    || selected.pin.revision !== pin.revision || selected.pin.configFingerprint !== pin.configFingerprint
    || selected.pin.checkpointVersion !== pin.checkpointVersion)
    throw new ObservationImportError("OBSERVATION_STALE_PIN");
  return Object.freeze({snapshot: selected.snapshot, logAdapterId: configured.logAdapterId});
};

export type ObservationPinConstraints = Readonly<{configActivationCheckpoint?: string; additionalScopeIds?: readonly string[]}>;

/** Internal transaction boundary; callers must independently authenticate their capability first. */
export const withAuthorizedObservationPin = async <T>(pool: Pool, schemaSql: string, schemaName: string,
  identity: AuthenticatedImporter, pin: ExpectedObservationPin,
  operation: (client: PoolClient, authorized: AuthorizedPin) => Promise<T>,
  constraints: ObservationPinConstraints = {}): Promise<T> => {
  const client = await pool.connect().catch(() => {throw new ObservationImportError("OBSERVATION_STORAGE_ERROR");});
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schemaSql}, pg_catalog`);
    const authorized = await authorizePinned(client, schemaName, identity, pin, constraints);
    const result = await operation(client, authorized);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof ObservationImportError) throw error;
    if (error instanceof QueryReadError && error.code === "QUERY_NOT_FOUND_OR_DENIED")
      throw new ObservationImportError("OBSERVATION_NOT_AUTHORIZED");
    if (error instanceof QueryReadError && error.code === "QUERY_STALE_SELECTION")
      throw new ObservationImportError("OBSERVATION_STALE_PIN");
    throw new ObservationImportError("OBSERVATION_STORAGE_ERROR");
  } finally {client.release();}
};

type SafeRecord = Readonly<{recordId: string; result: Exclude<SanitizedObservationResult, {status: "rejected"}>}>;
const safeManifest = (records: readonly SafeRecord[]): string => JSON.stringify(records
  .map(record => ({recordId: record.recordId, result: record.result}))
  .sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));

const persist = async (client: PoolClient, ref: SafeImportRef, batch: SourceBatch,
  records: readonly SafeRecord[]): Promise<ImportOutcome> => {
  const pin = ref.expectedPin;
  const manifest = safeManifest(records);
  const params = [pin.tenantId, pin.repositoryId, pin.serviceId, pin.environment, ref.importId,
    pin.snapshotId, pin.revision, pin.configFingerprint, pin.checkpointVersion,
    batch.attestation.sourceId, batch.attestation.sourceVersion,
    batch.attestation.windowStart, batch.attestation.windowEnd, OBSERVATION_POLICY_VERSION, manifest];
  const inserted = await client.query(
    `INSERT INTO observation_imports
     (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,
      checkpoint_version,source_id,source_version,window_start,window_end,policy_version,safe_manifest)
     VALUES($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9::bigint,$10,$11,$12::timestamptz,$13::timestamptz,$14,$15::jsonb)
     ON CONFLICT (tenant_id,repository_id,service_id,environment,import_id) DO NOTHING
     RETURNING import_id`, params);
  if (!inserted.rows.length) {
    const existing = await client.query<{matched: boolean}>(
      `SELECT (snapshot_id=$6 AND revision=$7 AND config_fingerprint=$8 AND checkpoint_version=$9::bigint
        AND source_id=$10 AND source_version=$11 AND window_start=$12::timestamptz
        AND window_end=$13::timestamptz AND policy_version=$14 AND safe_manifest=$15::jsonb) AS matched
       FROM observation_imports WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3
         AND environment=$4 AND import_id=$5::uuid`, params);
    if (existing.rows[0]?.matched !== true) throw new ObservationImportError("OBSERVATION_IMPORT_COLLISION");
    return Object.freeze({outcome: "existing", imported: records.length});
  }
  for (const record of records) {
    const result = record.result;
    await client.query(`INSERT INTO observation_records
      (tenant_id,repository_id,service_id,environment,import_id,record_id,status,reason,endpoint_id,
       mapping_id,method,status_code,completeness,policy_version)
      VALUES($1,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [pin.tenantId, pin.repositoryId, pin.serviceId, pin.environment, ref.importId, record.recordId,
      result.status, result.status === "unresolved" ? result.reason : null,
      result.status === "confirmed" ? result.endpointId : null,
      result.status === "confirmed" ? result.mappingId : null,
      result.method ?? null, result.statusCode ?? null, result.completeness, result.policyVersion]);
  }
  return Object.freeze({outcome: "inserted", imported: records.length});
};

export const createObservationStore = (pool: Pool, options: {schema: string;
  authorizeImporter: (credential: unknown) => Promise<unknown>;
  readBatch: (identity: AuthenticatedImporter, ref: SafeImportRef) => Promise<unknown>}) => {
  let schema: string;
  try {schema = quoteEnvironmentSchema(options.schema);} catch {throw new ObservationImportError("INVALID_OBSERVATION_IMPORT");}
  return Object.freeze({
    async importBatch(credential: unknown, input: unknown): Promise<ImportOutcome> {
      const ref = parseImportRef(input);
      let identity: AuthenticatedImporter;
      try {identity = parseImporter(await options.authorizeImporter(credential), ref.expectedPin);}
      catch {throw new ObservationImportError("OBSERVATION_NOT_AUTHORIZED");}
      await withAuthorizedObservationPin(pool, schema, options.schema, identity, ref.expectedPin,
        async () => undefined);
      let batch: SourceBatch;
      try {batch = parseSourceBatch(await options.readBatch(identity, ref));}
      catch {throw new ObservationImportError("INVALID_SOURCE_BATCH");}
      return withAuthorizedObservationPin(pool, schema, options.schema, identity, ref.expectedPin,
        async (client, authorized) => {
        const pin = ref.expectedPin;
        if (authorized.logAdapterId !== batch.attestation.sourceId)
          throw new ObservationImportError("INVALID_SOURCE_BATCH");
        if (batch.attestation.revision !== pin.revision) throw new ObservationImportError("INVALID_SOURCE_BATCH");
        const context: ObservationContext = {pin: {state: "resolved_single_revision", ...pin},
          snapshot: authorized.snapshot, attestation: batch.attestation, mappings: batch.mappings};
        const records: SafeRecord[] = [];
        for (const item of batch.records) {
          const result = correlateMetadataObservation(item.raw, context);
          if (result.status === "rejected") throw new ObservationImportError("INVALID_OBSERVATION");
          records.push({recordId: item.recordId, result});
        }
        return persist(client, ref, batch, records);
      });
    },
  });
};
