import {generateKeyPairSync, sign, type KeyObject} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, expect, test} from "vitest";
import {createSignedObservationFileReader} from "../../connectors/observation-file/src/index.js";
import {snapshotContentSha256, snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations, createEnvironmentRepository} from "../../packages/environment/src/index.js";
import {canonicalJsonStringify, type ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyObservationMigrations, createObservationStore} from "../../packages/observations/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "tenant-signed-file";
const principalId = "signed-file-importer";
const repositoryId = "synthetic-repository";
const serviceId = "orders";
const environment = "uat";
const sourceId = "gateway-log";
const scopes = ["repository-read", "deployment-read", "contract-read", "source-read"] as const;
const importId = "550e8400-e29b-4d4a-a716-446655440000";
const recordId = "550e8400-e29b-4d4a-a716-446655440001";
const credential = Object.freeze({token: "host-authenticated"});
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const worker = {workerId: "environment-worker", instanceId: "signed-file-1", capabilities: ["jobs.execute"]};
const producer = {tenantId, principalId: "deployment-connector", producerId: "deploy",
  allowedEventTypes: ["deployment.changed"], allowedRepositories: [repositoryId],
  allowedServices: [serviceId], deploymentAuthorityGrants: [{repositoryId, serviceId, environment,
    adapterId: "deploy", sourceAuthorityIds: ["inventory"]}], capabilities: ["event.ingest"]};
let database: CatalogTestDatabase;
let root: string;
let privateKey: KeyObject;
let publicKeyPem: string;
let snapshot: ContractSnapshot;
let expectedPin: {tenantId: string; repositoryId: string; serviceId: string; environment: string;
  snapshotId: string; revision: string; configFingerprint: string; checkpointVersion: string};

const event = (eventId: string, payload: unknown) => ({event_version: "1.0.0", event_id: eventId,
  event_type: "deployment.changed", producer: {producer_id: "deploy", adapter_version: "1"},
  occurred_at: "2026-10-09T00:00:00.000Z", received_at: "2026-10-09T00:00:01.000Z",
  subjects: {repository_id: repositoryId, service_ids: [serviceId], environment},
  provider_evidence: {provider: "deploy", provider_reference: eventId}, payload});
const mappings = () => [{mappingId: "gateway-orders", ...expectedPin,
  publicOrigin: "https://api.example.test", publicPathTemplate: "/public/orders/{orderId}",
  applicationPathTemplate: "/api/orders/:orderId", method: "GET", routingEvidenceIds: ["route-config-7"]}];
const payload = () => ({importId, expectedPin: {...expectedPin},
  attestation: {revision: expectedPin.revision, sourceId, sourceVersion: "signed-artifact-7",
    windowStart: "2026-10-09T00:00:00Z", windowEnd: "2026-10-09T01:00:00Z"},
  records: [{recordId, raw: {url: "https://api.example.test/public/orders/123?token=CANARY_SECRET_123",
    method: "GET", statusCode: 200, revision: expectedPin.revision,
    headers: {authorization: "CANARY_SECRET_123"}, body: {email: "CANARY_SECRET_123@example.test"},
    traceId: "CANARY_SECRET_123"}}]});
const filePath = () => join(root, `${importId}.json`);
const writeSigned = async (value: unknown = payload(), signature?: string): Promise<void> => {
  const signed = signature ?? sign(null, Buffer.from(canonicalJsonStringify(value), "utf8"), privateKey).toString("base64");
  await writeFile(filePath(), JSON.stringify({payload: value, signature: signed}));
};
const importRequest = () => ({importId, expectedPin: {...expectedPin}});

beforeEach(async () => {
  database = await createCatalogTestDatabase();
  root = await mkdtemp(join(tmpdir(), "signed-observation-import-"));
  const keys = generateKeyPairSync("ed25519");
  privateKey = keys.privateKey;
  publicKeyPem = keys.publicKey.export({type: "spki", format: "pem"}).toString();
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
    repositories: [{repository_id: repositoryId, provider: "git", locator: "synthetic/repository",
      access_scope_id: scopes[0], services: [{service_id: serviceId, root: "services/orders",
        analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
        environments: [{name: environment, intended_branch: "main",
          deployment_authority: {adapter_id: "deploy", access_scope_id: scopes[1]}}]}]}],
    inference: {enabled: false}, logs: {enabled: true, adapter_id: sourceId,
      credential: {secret_ref: {scheme: "env", locator: "SYNTHETIC_LOG_TOKEN"}}}}};
  await orchestration.registerConfiguration(admin, configuration);
  await orchestration.activateInitialConfiguration(admin, {fingerprint: configuration.fingerprint});
  snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
  snapshot.service.repository_id = repositoryId;
  snapshot.source.repository_id = repositoryId;
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
     identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'partial',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
  [tenantId, snapshot.snapshot_id, repositoryId, serviceId, snapshot.source.immutable_revision,
    snapshot.ir_version, snapshot.identity_version, snapshot.config.config_fingerprint,
    snapshotIdentitySha256(snapshot), snapshotContentSha256(snapshot), [scopes[2]], JSON.stringify(snapshot)]);
  const environmentRepo = createEnvironmentRepository(database.pool, {schema: database.schema});
  await orchestration.ingestEvent(producer, event("signed-file-attempt", {change_kind: "attempt",
    deployment_id: "signed-file-attempt", environment, attempt_state: "succeeded",
    effective_order: "1", artifact_id: "artifact-a",
    revision: {state: "known", revision: snapshot.source.immutable_revision}}));
  await environmentRepo.recordAttempt(worker, {tenantId, producerId: "deploy", eventId: "signed-file-attempt"});
  await orchestration.ingestEvent(producer, event("signed-file-serving", {change_kind: "serving_observation",
    observation_id: "signed-file-serving", environment,
    source: {authority_id: "inventory", reference: "signed-file-serving", access_label: scopes[3]},
    completeness: "complete", effective_order: "1", serving_state: {status: "known",
      inventory: [{artifact_id: "artifact-a", revision: {state: "known",
        revision: snapshot.source.immutable_revision}}]}}));
  await environmentRepo.recordServingObservation(worker,
    {tenantId, producerId: "deploy", eventId: "signed-file-serving"});
  const selected = await createQueryReader(database.pool, {schema: database.schema}).readContract(
    {tenantId, principalId}, {version: "1", tenantId, repositoryId, serviceId,
      selector: {kind: "environment", environment}});
  expect(selected.status).toBe("resolved");
  if (selected.status !== "resolved") throw new Error("Expected resolved fixture");
  expectedPin = {tenantId, repositoryId, serviceId, environment,
    snapshotId: selected.pin.snapshotId, revision: selected.pin.revision,
    configFingerprint: selected.pin.configFingerprint, checkpointVersion: selected.pin.checkpointVersion!};
});
afterEach(async () => {await Promise.all([database.cleanup(), rm(root, {recursive: true, force: true})]);});

test("a signed file imports only sanitized metadata through the real store", async () => {
  await writeSigned();
  const readBatch = await createSignedObservationFileReader({root, publicKeyPem, sourceId, mappings: mappings()});
  const store = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async token => token === credential
      ? {tenantId, principalId, capabilities: ["observations.import"]} : undefined,
    readBatch});
  expect(await store.importBatch(credential, importRequest())).toMatchObject({outcome: "inserted", imported: 1});
  const schema = quoteCatalogTestSchema(database.schema);
  const records = await database.pool.query(`SELECT * FROM ${schema}.observation_records`);
  expect(records.rows[0]).toMatchObject({status: "confirmed", endpoint_id: "ep-get",
    mapping_id: "gateway-orders", method: "GET", status_code: 200});
  const imports = await database.pool.query(`SELECT row_to_json(t)::text AS value FROM ${schema}.observation_imports t`);
  expect(JSON.stringify([records.rows, imports.rows])).not.toMatch(/CANARY_SECRET_123|api\.example\.test|\/public\/|\/api\/orders/);
});

test("altered signatures reject before persistence", async () => {
  await writeSigned(payload(), Buffer.alloc(64).toString("base64"));
  const readBatch = await createSignedObservationFileReader({root, publicKeyPem, sourceId, mappings: mappings()});
  const store = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => ({tenantId, principalId, capabilities: ["observations.import"]}),
    readBatch});
  await expect(store.importBatch(credential, importRequest()))
    .rejects.toMatchObject({code: "INVALID_SOURCE_BATCH", message: "INVALID_SOURCE_BATCH"});
  const rows = await database.pool.query(`SELECT count(*)::int AS count FROM
    ${quoteCatalogTestSchema(database.schema)}.observation_records`);
  expect(rows.rows[0]?.count).toBe(0);
});

test("revocation before file read prevents fetch; revocation during read prevents insert", async () => {
  await writeSigned();
  const actual = await createSignedObservationFileReader({root, publicKeyPem, sourceId, mappings: mappings()});
  let reads = 0;
  const store = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => ({tenantId, principalId, capabilities: ["observations.import"]}),
    readBatch: async (identity, ref) => {reads += 1; return actual(identity, ref);}});
  const access = createAccessPolicyStore(database.pool, {schema: database.schema});
  await access.putGrant({tenantId}, {principalId, scopeId: scopes[3], active: false});
  await expect(store.importBatch(credential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(reads).toBe(0);
  await access.putGrant({tenantId}, {principalId, scopeId: scopes[3], active: true});
  const racing = createObservationStore(database.pool, {schema: database.schema,
    authorizeImporter: async () => ({tenantId, principalId, capabilities: ["observations.import"]}),
    readBatch: async (identity, ref) => {
      reads += 1;
      const result = await actual(identity, ref);
      await access.putGrant({tenantId}, {principalId, scopeId: scopes[3], active: false});
      return result;
    }});
  await expect(racing.importBatch(credential, importRequest()))
    .rejects.toMatchObject({code: "OBSERVATION_NOT_AUTHORIZED"});
  expect(reads).toBe(1);
  const rows = await database.pool.query(`SELECT count(*)::int AS count FROM
    ${quoteCatalogTestSchema(database.schema)}.observation_records`);
  expect(rows.rows[0]?.count).toBe(0);
});
