import {readFile} from "node:fs/promises";
import {afterEach, beforeEach, expect, test, vi} from "vitest";
import {snapshotContentSha256, snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations, createEnvironmentRepository} from "../../packages/environment/src/index.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import {withAuthorizedObservationPin} from "../../packages/observations/src/store.js";
import {applyObservationMigrations, createObservationStore} from "../../packages/observations/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import * as queryBoundary from "../../packages/query/src/reader.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "tenant-observations";
const principalId = "logs-importer";
const repositoryId = "commerce";
const serviceId = "orders";
const environment = "uat";
const scopes = ["repository-read", "deployment-read", "contract-read", "source-read"] as const;
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const worker = {workerId: "environment-worker", instanceId: "observations-1", capabilities: ["jobs.execute"]};
const producer = {tenantId, principalId: "deployment-connector", producerId: "deploy",
  allowedEventTypes: ["deployment.changed"], allowedRepositories: [repositoryId],
  allowedServices: [serviceId], deploymentAuthorityGrants: [{repositoryId, serviceId, environment,
    adapterId: "deploy", sourceAuthorityIds: ["inventory"]}], capabilities: ["event.ingest"]};
const importerCredential = Object.freeze({opaque: "host-authenticated"});
const importId = "550e8400-e29b-4d4a-a716-446655440000";
const recordId = "550e8400-e29b-4d4a-a716-446655440001";
const secondRecordId = "550e8400-e29b-4d4a-a716-446655440002";
let database: CatalogTestDatabase;
let snapshot: ContractSnapshot;
let pin: {tenantId: string; repositoryId: string; serviceId: string; environment: string;
  snapshotId: string; revision: string; configFingerprint: string; checkpointVersion: string};
let sourcePayload: ReturnType<typeof batch>;
let readBatchCalls: number;

const event = (eventId: string, payload: unknown) => ({event_version: "1.0.0", event_id: eventId,
  event_type: "deployment.changed", producer: {producer_id: "deploy", adapter_version: "1"},
  occurred_at: "2026-10-09T00:00:00.000Z", received_at: "2026-10-09T00:00:01.000Z",
  subjects: {repository_id: repositoryId, service_ids: [serviceId], environment},
  provider_evidence: {provider: "deploy", provider_reference: eventId}, payload});

const store = () => createObservationStore(database.pool, {schema: database.schema,
  authorizeImporter: async credential => credential === importerCredential
    ? {tenantId, principalId, capabilities: ["observations.import"]} : undefined,
  readBatch: async (_identity, ref) => {
    readBatchCalls += 1;
    expect(ref).toEqual({importId: ref.importId, expectedPin: ref.expectedPin});
    return sourcePayload;
  }});

const batch = (raw: unknown = {url: "https://api.example.test/public/v2/orders/123?token=CANARY_SECRET_123",
  method: "GET", statusCode: 200, revision: snapshot.source.immutable_revision,
  headers: {authorization: "CANARY_SECRET_123"}, body: {email: "CANARY_SECRET_123@example.test"},
  traceId: "CANARY_SECRET_123"}) => ({attestation: {revision: pin.revision, sourceId: "gateway-log", sourceVersion: "artifact-7",
    windowStart: "2026-10-09T00:00:00Z", windowEnd: "2026-10-09T01:00:00Z"},
  mappings: [{mappingId: "gateway-orders", tenantId, repositoryId, serviceId, environment,
    snapshotId: pin.snapshotId, revision: pin.revision, configFingerprint: pin.configFingerprint,
    checkpointVersion: pin.checkpointVersion, publicOrigin: "https://api.example.test",
    publicPathTemplate: "/public/v2/orders/{orderId}", applicationPathTemplate: "/api/orders/:orderId",
    method: "GET", routingEvidenceIds: ["gateway-config-7"]}],
  records: [{recordId, raw}]});
const importRequest = () => ({importId, expectedPin: {...pin}});

const setupDatabase = async (logsEnabled = true): Promise<void> => {
  readBatchCalls = 0;
  database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, {schema: database.schema});
  await applyEnvironmentMigrations(database.pool, {schema: database.schema});
  await applyOpenApiMigrations(database.pool, {schema: database.schema});
  await applyObservationMigrations(database.pool, {schema: database.schema});
  const access = createAccessPolicyStore(database.pool, {schema: database.schema});
  for (const scopeId of scopes) {
    await access.putScope({tenantId}, {scopeId, active: true});
    await access.putGrant({tenantId}, {principalId, scopeId, active: true});
  }
  const orchestration = createOrchestrationRepository(database.pool, {schema: database.schema});
  const configuration = {fingerprint: "sha256:config-a", document: {config_version: "1.0.0",
    access_scopes: scopes.map(access_scope_id => ({access_scope_id, label: access_scope_id})),
    repositories: [{repository_id: repositoryId, provider: "github", locator: "acme/commerce",
      access_scope_id: scopes[0], services: [{service_id: serviceId, root: "services/orders",
        analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
        environments: [{name: environment, intended_branch: "main",
          deployment_authority: {adapter_id: "deploy", access_scope_id: scopes[1]}}]}]}],
    inference: {enabled: false}, logs: logsEnabled ? {enabled: true, adapter_id: "gateway-log",
      credential: {secret_ref: {scheme: "env", locator: "OBSERVATION_LOG_TOKEN"}}} : {enabled: false}}};
  await orchestration.registerConfiguration(admin, configuration);
  await orchestration.activateInitialConfiguration(admin, {fingerprint: configuration.fingerprint});
  snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
     identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'partial',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
  [tenantId, snapshot.snapshot_id, repositoryId, serviceId, snapshot.source.immutable_revision,
    snapshot.ir_version, snapshot.identity_version, snapshot.config.config_fingerprint,
    snapshotIdentitySha256(snapshot), snapshotContentSha256(snapshot), [scopes[2]], JSON.stringify(snapshot)]);
  const environmentRepo = createEnvironmentRepository(database.pool, {schema: database.schema});
  const attempt = event("observations-attempt", {change_kind: "attempt", deployment_id: "observations-attempt",
    environment, attempt_state: "succeeded", effective_order: "1", artifact_id: "artifact-a",
    revision: {state: "known", revision: snapshot.source.immutable_revision}});
  await orchestration.ingestEvent(producer, attempt);
  await environmentRepo.recordAttempt(worker, {tenantId, producerId: "deploy", eventId: "observations-attempt"});
  const serving = event("observations-serving", {change_kind: "serving_observation",
    observation_id: "observations-serving", environment,
    source: {authority_id: "inventory", reference: "observations-serving", access_label: scopes[3]},
    completeness: "complete", effective_order: "1", serving_state: {status: "known",
      inventory: [{artifact_id: "artifact-a", revision: {state: "known", revision: snapshot.source.immutable_revision}}]}});
  await orchestration.ingestEvent(producer, serving);
  await environmentRepo.recordServingObservation(worker,
    {tenantId, producerId: "deploy", eventId: "observations-serving"});
  const selected = await createQueryReader(database.pool, {schema: database.schema}).readContract(
    {tenantId, principalId}, {version: "1", tenantId, repositoryId, serviceId,
      selector: {kind: "environment", environment}});
  expect(selected.status).toBe("resolved");
  if (selected.status !== "resolved") throw new Error("Expected resolved fixture");
  pin = {tenantId, repositoryId, serviceId, environment,
    snapshotId: selected.pin.snapshotId, revision: selected.pin.revision,
    configFingerprint: selected.pin.configFingerprint, checkpointVersion: selected.pin.checkpointVersion!};
  sourcePayload = batch();
};
beforeEach(async () => {await setupDatabase();});
afterEach(async () => {await database.cleanup();});

test("imports only sanitized metadata for an authorized exact serving pin", async () => {
  const before = await database.pool.query(`SELECT content_sha256 FROM ${quoteCatalogTestSchema(database.schema)}.catalog_snapshots
    WHERE tenant_id=$1 AND snapshot_id=$2`, [tenantId, snapshot.snapshot_id]);
  expect(await store().importBatch(importerCredential, importRequest())).toMatchObject({outcome: "inserted", imported: 1});
  const schema = quoteCatalogTestSchema(database.schema);
  const rows = await database.pool.query(`SELECT * FROM ${schema}.observation_records`);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]).toMatchObject({status: "confirmed", endpoint_id: "ep-get", mapping_id: "gateway-orders",
    method: "GET", status_code: 200, completeness: "metadata_only"});
  const imports = await database.pool.query(`SELECT row_to_json(t)::text AS value FROM
    ${schema}.observation_imports t`);
  const records = await database.pool.query(`SELECT row_to_json(t)::text AS value FROM
    ${schema}.observation_records t`);
  expect(JSON.stringify([imports.rows, records.rows])).not.toMatch(/CANARY_SECRET_123|api\.example\.test|\/public\/|\/api\/orders/);
  const after = await database.pool.query(`SELECT content_sha256 FROM ${schema}.catalog_snapshots
    WHERE tenant_id=$1 AND snapshot_id=$2`, [tenantId, snapshot.snapshot_id]);
  expect(after.rows).toEqual(before.rows);
});

test("idempotent replay is accepted, changed safe content collides, rejected raw is never stored", async () => {
  const repository = store();
  expect(await repository.importBatch(importerCredential, importRequest())).toMatchObject({outcome: "inserted"});
  expect(await repository.importBatch(importerCredential, importRequest())).toMatchObject({outcome: "existing"});
  sourcePayload = batch({url: "https://api.example.test/public/v2/orders/123",
    method: "GET", statusCode: 201, revision: pin.revision});
  await expect(repository.importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_IMPORT_COLLISION"});
  sourcePayload = {...batch(), records: [{recordId: secondRecordId, raw: {...batch().records[0]!.raw as object,
    body: Object.defineProperty({}, "secret", {get() {throw new Error("CANARY_SECRET_123");}})}}]};
  await expect(repository.importBatch(importerCredential,
    {importId: "550e8400-e29b-4d4a-a716-446655440010", expectedPin: {...pin}}))
    .rejects.toMatchObject({code: "INVALID_OBSERVATION"});
  const count = await database.pool.query(`SELECT count(*)::int AS count FROM
    ${quoteCatalogTestSchema(database.schema)}.observation_records`);
  expect(count.rows[0]?.count).toBe(1);
});

test("stale checkpoint, revoked reader scope, and unauthenticated importer fail closed", async () => {
  const repository = store();
  await expect(repository.importBatch({capabilities: ["observations.import"]}, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(readBatchCalls).toBe(0);
  await expect(repository.importBatch(importerCredential,
    {...importRequest(), records: [{recordId, raw: {url: "https://attacker.test"}}],
      attestation: {revision: pin.revision}, mappings: []}))
    .rejects.toMatchObject({code: "INVALID_OBSERVATION_IMPORT"});
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`UPDATE ${schema}.environment_serving_checkpoints SET version=version+1
    WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,
  [tenantId, repositoryId, serviceId, environment]);
  await expect(repository.importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_STALE_PIN"});
  expect(readBatchCalls).toBe(0);
  const newPin = {...pin, checkpointVersion: String(Number(pin.checkpointVersion) + 1)};
  sourcePayload = {...batch(), mappings: batch().mappings.map(m =>
    ({...m, checkpointVersion: newPin.checkpointVersion}))};
  await createAccessPolicyStore(database.pool, {schema: database.schema}).putGrant({tenantId},
    {principalId, scopeId: scopes[3], active: false});
  await expect(repository.importBatch(importerCredential,
    {importId: "550e8400-e29b-4d4a-a716-446655440010", expectedPin: newPin}))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(readBatchCalls).toBe(0);
});

test("logs-disabled, stale, and cross-scope requests never fetch from the source", async () => {
  const stale = {...importRequest(), expectedPin: {...pin,
    checkpointVersion: String(Number(pin.checkpointVersion) + 1)}};
  await expect(store().importBatch(importerCredential, stale))
    .rejects.toMatchObject({code: "OBSERVATION_STALE_PIN"});
  expect(readBatchCalls).toBe(0);
  let crossScopeCalls = 0;
  const crossScope = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => ({tenantId, principalId: "other-principal",
      capabilities: ["observations.import"]}),
    readBatch: async () => {crossScopeCalls += 1; return sourcePayload;}});
  await expect(crossScope.importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(crossScopeCalls).toBe(0);
  await database.cleanup();
  await setupDatabase(false);
  await expect(store().importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(readBatchCalls).toBe(0);
  const count = await database.pool.query(`SELECT count(*)::int AS count FROM
    ${quoteCatalogTestSchema(database.schema)}.observation_records`);
  expect(count.rows[0]?.count).toBe(0);
});

test("grant revocation during source read is caught by the second authorization pass", async () => {
  let calls = 0;
  const racing = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => ({tenantId, principalId, capabilities: ["observations.import"]}),
    readBatch: async () => {
      calls += 1;
      await createAccessPolicyStore(database.pool, {schema: database.schema}).putGrant({tenantId},
        {principalId, scopeId: scopes[3], active: false});
      return sourcePayload;
    }});
  await expect(racing.importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(calls).toBe(1);
  const count = await database.pool.query(`SELECT count(*)::int AS count FROM
    ${quoteCatalogTestSchema(database.schema)}.observation_records`);
  expect(count.rows[0]?.count).toBe(0);
});

test("checkpoint change during source read is caught before any insert", async () => {
  let calls = 0;
  const racing = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => ({tenantId, principalId, capabilities: ["observations.import"]}),
    readBatch: async () => {
      calls += 1;
      await database.pool.query(`UPDATE ${quoteCatalogTestSchema(database.schema)}.environment_serving_checkpoints
        SET version=version+1 WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,
      [tenantId, repositoryId, serviceId, environment]);
      return sourcePayload;
    }});
  await expect(racing.importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_STALE_PIN"});
  expect(calls).toBe(1);
  const count = await database.pool.query(`SELECT count(*)::int AS count FROM
    ${quoteCatalogTestSchema(database.schema)}.observation_records`);
  expect(count.rows[0]?.count).toBe(0);
});

test("host port failures expose fixed errors and persist no records", async () => {
  const failedAuth = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => {throw new Error("CANARY_SECRET_123");},
    readBatch: async () => sourcePayload});
  await expect(failedAuth.importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED",
      message: "OBSERVATION_NOT_AUTHORIZED"});
  const failedRead = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => ({tenantId, principalId, capabilities: ["observations.import"]}),
    readBatch: async () => {throw new Error("CANARY_SECRET_123");}});
  await expect(failedRead.importBatch(importerCredential, importRequest()))
    .rejects.toMatchObject({code: "INVALID_SOURCE_BATCH", message: "INVALID_SOURCE_BATCH"});
  const count = await database.pool.query(`SELECT count(*)::int AS count FROM
    ${quoteCatalogTestSchema(database.schema)}.observation_records`);
  expect(count.rows[0]?.count).toBe(0);
});

test("unresolved URL mapping stores safe status without an endpoint link", async () => {
  sourcePayload = batch({url: "https://api.example.test/unmapped?secret=CANARY_SECRET_123",
    method: "GET", statusCode: 404, revision: pin.revision});
  expect(await store().importBatch(importerCredential, importRequest())).toMatchObject({outcome: "inserted", imported: 1});
  const schema = quoteCatalogTestSchema(database.schema);
  const row = await database.pool.query(`SELECT * FROM ${schema}.observation_records`);
  expect(row.rows[0]).toMatchObject({status: "unresolved", reason: "no_mapping",
    endpoint_id: null, mapping_id: null, method: "GET", status_code: 404});
  expect(JSON.stringify(row.rows)).not.toContain("CANARY_SECRET_123");
});

test("mixed serving inventory cannot be imported even with its current checkpoint", async () => {
  const orchestration = createOrchestrationRepository(database.pool, {schema: database.schema});
  const environmentRepo = createEnvironmentRepository(database.pool, {schema: database.schema});
  const mixed = event("observations-mixed", {change_kind: "serving_observation",
    observation_id: "observations-mixed", environment,
    source: {authority_id: "inventory", reference: "observations-mixed", access_label: scopes[3]},
    completeness: "complete", effective_order: "2", serving_state: {status: "known",
      inventory: [{artifact_id: "artifact-a", revision: {state: "known", revision: pin.revision}},
        {artifact_id: "artifact-b", revision: {state: "known", revision: "other-revision"}}]}});
  await orchestration.ingestEvent(producer, mixed);
  await environmentRepo.recordServingObservation(worker,
    {tenantId, producerId: "deploy", eventId: "observations-mixed"});
  const schema = quoteCatalogTestSchema(database.schema);
  const checkpoint = await database.pool.query<{version: string}>(
    `SELECT version::text FROM ${schema}.environment_serving_checkpoints WHERE tenant_id=$1
      AND repository_id=$2 AND service_id=$3 AND environment=$4`,
  [tenantId, repositoryId, serviceId, environment]);
  const mixedPin = {...pin, checkpointVersion: checkpoint.rows[0]!.version};
  sourcePayload = {...batch(), mappings: batch().mappings.map(mapping =>
    ({...mapping, checkpointVersion: mixedPin.checkpointVersion}))};
  await expect(store().importBatch(importerCredential, {importId, expectedPin: mixedPin}))
    .rejects.toMatchObject({code: "OBSERVATION_STALE_PIN"});
  const count = await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_records`);
  expect(count.rows[0]?.count).toBe(0);
});

test("observation rows are immutable and migration checksum drift fails closed", async () => {
  await expect(applyObservationMigrations(database.pool, {schema: database.schema}))
    .resolves.toBeUndefined();
  await store().importBatch(importerCredential, importRequest());
  const schema = quoteCatalogTestSchema(database.schema);
  await expect(database.pool.query(`UPDATE ${schema}.observation_records SET status_code=201`))
    .rejects.toThrow();
  await expect(database.pool.query(`DELETE FROM ${schema}.observation_imports`)).rejects.toThrow();
  await database.pool.query(`UPDATE ${schema}.observation_schema_migrations
    SET checksum_sha256=$1 WHERE version='0001_metadata_imports'`, [`sha256:${"0".repeat(64)}`]);
  await expect(applyObservationMigrations(database.pool, {schema: database.schema}))
    .rejects.toMatchObject({code: "OBSERVATION_STORAGE_ERROR"});
});


test("pinned policy transactions require their exact activation epoch and independent owner grant", async () => {
  const schema = quoteCatalogTestSchema(database.schema);
  const row = await database.pool.query(`SELECT checkpoint_version::text AS epoch FROM ${schema}.orchestration_active_configurations WHERE tenant_id=$1`, [tenantId]);
  const epoch = row.rows[0].epoch as string;
  const identity = {tenantId, principalId, capabilities: ["observations.policy.manage"]};
  let invoked = 0;
  const run = (configActivationCheckpoint = epoch) => withAuthorizedObservationPin(database.pool, schema,
    database.schema, identity, pin, async () => {invoked += 1; return "approved";},
    {configActivationCheckpoint, additionalScopeIds: ["owner-policy-read"]});
  const access = createAccessPolicyStore(database.pool, {schema: database.schema});
  await access.putScope({tenantId}, {scopeId: "owner-policy-read", active: true});
  await expect(run()).rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(invoked).toBe(0);
  await access.putGrant({tenantId}, {principalId, scopeId: "owner-policy-read", active: true});
  await expect(run()).resolves.toBe("approved");
  await expect(run(String(BigInt(epoch) + 1n))).rejects.toMatchObject({code: "OBSERVATION_STALE_PIN"});
  expect(invoked).toBe(1);
  await access.putGrant({tenantId}, {principalId, scopeId: "owner-policy-read", active: false});
  await expect(run()).rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(invoked).toBe(1);
});

test("owner grant revocation waits for the pinned transaction and takes effect on the next read", async () => {
  const schema = quoteCatalogTestSchema(database.schema);
  const access = createAccessPolicyStore(database.pool, {schema: database.schema});
  await access.putScope({tenantId}, {scopeId: "owner-policy-read", active: true});
  await access.putGrant({tenantId}, {principalId, scopeId: "owner-policy-read", active: true});
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {entered = resolve;});
  const transaction = withAuthorizedObservationPin(database.pool, schema, database.schema,
    {tenantId, principalId, capabilities: ["observations.policy.manage"]}, pin,
    async () => {entered(); await hold; return "approved";}, {additionalScopeIds: ["owner-policy-read"]});
  await started;
  let revoked = false;
  const revocation = access.putGrant({tenantId}, {principalId, scopeId: "owner-policy-read", active: false})
    .then(() => {revoked = true;});
  // A separate connection proves the row is already locked, without timing assertions.
  const contender = await database.pool.connect();
  try {
    await contender.query("BEGIN");
    await contender.query(`SELECT 1 FROM ${schema}.principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=$3 FOR UPDATE NOWAIT`,
      [tenantId, principalId, "owner-policy-read"]).then(() => {throw new Error("Expected locked owner grant");},
      error => {expect(error.code).toBe("55P03");});
    await contender.query("ROLLBACK");
    expect(revoked).toBe(false);
  } finally {await contender.query("ROLLBACK").catch(() => undefined);contender.release(); release();}
  await expect(transaction).resolves.toBe("approved");
  await revocation;
  await expect(withAuthorizedObservationPin(database.pool, schema, database.schema,
    {tenantId, principalId, capabilities: ["observations.policy.manage"]}, pin, async () => "unexpected",
    {additionalScopeIds: ["owner-policy-read"]})).rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
});


test("durable transactions reject qualifier-bearing pins before their callback", async () => {
  const reader=createQueryReader(database.pool,{schema:database.schema});
  const selected=await reader.readContract({tenantId,principalId},{version:"1",tenantId,repositoryId,serviceId,
    selector:{kind:"environment",environment,expectedCheckpointVersion:pin.checkpointVersion}});
  if(selected.status!=="resolved")throw new Error("Expected current fixture pin");
  const operation=vi.fn(async()=>"must-not-write");
  const constraints={requireUnqualifiedPin:true,additionalScopeIds:[]};
  for(const qualifier of [{selectedRevision:"f".repeat(40)},{pointerVersion:"1"}]){
    const intercepted=vi.spyOn(queryBoundary,"readQueryContractWithClient").mockResolvedValue({
      ...selected,pin:{...selected.pin,...qualifier}});
    try{
      await expect(withAuthorizedObservationPin(database.pool,quoteCatalogTestSchema(database.schema),database.schema,
        {tenantId,principalId,capabilities:["observations.presence.import"]},pin,operation,constraints))
        .rejects.toMatchObject({code:"OBSERVATION_STALE_PIN"});
      expect(operation).not.toHaveBeenCalled();
    }finally{intercepted.mockRestore();}
  }
});


test("bounded policy transactions apply local lock deadlines before authority work",async()=>{
  const result=await withAuthorizedObservationPin(database.pool,quoteCatalogTestSchema(database.schema),database.schema,
    {tenantId,principalId,capabilities:["observations.presence.import"]},pin,async(client)=>{
      const settings=await client.query("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout");
      return settings.rows[0];
    },{boundedTransaction:true,requireUnqualifiedPin:true});
  expect(result.lock_timeout).toBe("10s");
  // The query reader may tighten the remaining statement budget, but cannot remove it.
  expect(result.statement_timeout).not.toBe("0");
});
