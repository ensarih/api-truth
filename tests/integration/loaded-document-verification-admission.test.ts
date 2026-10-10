import {createHash} from "node:crypto";
import {expect, test, vi} from "vitest";
import type {PoolClient} from "pg";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrationManifest, applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createLoadedDocumentVerificationAdmissionStore} from "../../packages/orchestration/src/loaded-document-verification-admission.js";
import {createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {readFile} from "node:fs/promises";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "loaded-admission-tenant", principalId = "loaded-admission-principal";
const repositoryId = "repository", serviceId = "service", environment = "uat", serviceRoot = "services/api";
const sourceScope = "source-read", environmentScope = "environment-read";
const scope = {tenantId, repositoryId, serviceId, environment, immutableRevision: "a".repeat(40),
  sourceDigest: `sha256:${"b".repeat(64)}`};
const load = {artifactRef: "capture:loaded-envelope", configuredKeyRef: "key:loaded-signer",
  envelopeDigest: `sha256:${"c".repeat(64)}`, signerSpkiDigest: `sha256:${"d".repeat(64)}`};
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const admin = {tenantId, principalId: "configuration-admin", capabilities: ["configuration.admin"]};
const config = (fingerprint: string) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/repository",
    access_scope_id: sourceScope, services: [{service_id: serviceId, root: serviceRoot,
      analyzer: {adapter_id: "openapi_document", adapter_version: "0.2.0"}, intended_branches: ["main"],
      environments: [{name: environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});

async function setup() {
  const db = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const admissionSql = await readFile(new URL("../../packages/orchestration/migrations/0014_loaded_document_verification_jobs.sql", import.meta.url), "utf8");
    await applyOrchestrationMigrationManifest(db.pool, {schema: db.schema}, [
      {version: "0014_loaded_document_verification_jobs", sql: admissionSql},
    ]);
    const schema = quoteCatalogTestSchema(db.schema);
    const access = createAccessPolicyStore(db.pool, {schema: db.schema});
    for (const scopeId of [sourceScope, environmentScope]) {
      await access.putScope({tenantId}, {scopeId, active: true});
      await access.putGrant({tenantId}, {principalId, scopeId, active: true});
    }
    const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
    const registered = await orchestration.registerConfiguration(admin, config("config-a"));
    await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
    await db.pool.query(`CREATE TABLE ${schema}.trusted_loaded_document_policy (
    tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
    config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
    repository_id text NOT NULL,service_id text NOT NULL,environment text NOT NULL,service_root text NOT NULL,
    capture_identity_digest text NOT NULL,artifact_ref text NOT NULL,configured_key_ref text NOT NULL,
    envelope_digest text NOT NULL,signer_spki_digest text NOT NULL,opt_in boolean NOT NULL,
    source_allowed boolean NOT NULL,environment_allowed boolean NOT NULL,artifact_allowed boolean NOT NULL,
    PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version,capture_identity_digest))`);
    return {db, schema, access, orchestration, configDocumentSha256: registered.documentSha256};
  } catch (error) {await db.cleanup(); throw error;}
}
async function capture(db: CatalogTestDatabase, id: string) {
  const association = {artifactRef: `capture:${id}`, configuredKeyRef: "key:capture-signer",
    receiptDigest: hash(`receipt:${id}`), signerSpkiDigest: hash("capture signer")};
  const captureIdentityDigest = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef: association.artifactRef, configuredKeyRef: association.configuredKeyRef,
    receiptDigest: association.receiptDigest, signerSpkiDigest: association.signerSpkiDigest}));
  const schema = quoteCatalogTestSchema(db.schema);
  await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, captureIdentityDigest, repositoryId, serviceId, scope.immutableRevision, scope.sourceDigest,
    environment, association.artifactRef, association.configuredKeyRef, association.receiptDigest, association.signerSpkiDigest]);
  await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_verifications
    (tenant_id,capture_identity_digest,verifier_profile_version,service_root,source_digest,receipt_digest,
     signer_spki_digest,result_digest,handler_count)
    VALUES($1,$2,'protected-handler-bytes-1',$3,$4,$5,$6,$7,1)`,
  [tenantId, captureIdentityDigest, serviceRoot, scope.sourceDigest, association.receiptDigest,
    association.signerSpkiDigest, hash(`handler result:${id}`)]);
  return {captureIdentityDigest, association};
}
const options = (db: CatalogTestDatabase, identities: readonly {captureIdentityDigest: string}[], maxQueuedPerTenant = 1000) => ({
  schema: db.schema, tenantId, principalId, maxQueuedPerTenant,
  bindings: identities.map(({captureIdentityDigest}) => ({scope, captureIdentityDigest, serviceRoot,
    loadArtifactRef: load.artifactRef, loadConfiguredKeyRef: load.configuredKeyRef,
    loadEnvelopeDigest: load.envelopeDigest, loadSignerSpkiDigest: load.signerSpkiDigest})),
  preflightAuthorize: async () => true,
  authorizeLoadedDocument: async (client: PoolClient, binding: {
    tenantId: string; principalId: string; configFingerprint: string; configDocumentSha256: string;
    checkpointVersion: string; repositoryId: string; serviceId: string; environment: string; serviceRoot: string;
    captureIdentityDigest: string; loadArtifactRef: string; loadConfiguredKeyRef: string;
    loadEnvelopeDigest: string; loadSignerSpkiDigest: string}) => {
    const result = await client.query<{opt_in: boolean; source_allowed: boolean; environment_allowed: boolean; artifact_allowed: boolean}>(
      `SELECT opt_in,source_allowed,environment_allowed,artifact_allowed FROM trusted_loaded_document_policy
       WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND config_document_sha256=$4
        AND config_checkpoint_version=$5 AND repository_id=$6 AND service_id=$7 AND environment=$8 AND service_root=$9
        AND capture_identity_digest=$10 AND artifact_ref=$11 AND configured_key_ref=$12 AND envelope_digest=$13
        AND signer_spki_digest=$14 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
        binding.checkpointVersion, binding.repositoryId, binding.serviceId, binding.environment, binding.serviceRoot,
        binding.captureIdentityDigest, binding.loadArtifactRef, binding.loadConfiguredKeyRef,
        binding.loadEnvelopeDigest, binding.loadSignerSpkiDigest]);
    const row = result.rows[0];
    return result.rows.length === 1 && row?.opt_in === true && row.source_allowed === true
      && row.environment_allowed === true && row.artifact_allowed === true;
  },
});
async function approvePolicy(db: CatalogTestDatabase, identities: readonly {captureIdentityDigest: string}[], checkpoint = 1) {
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.trusted_loaded_document_policy VALUES
    ($1,$2,'config-a',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,true,true,true)`,
  [tenantId, principalId, (await db.pool.query<{document_sha256: string}>(`SELECT document_sha256 FROM
    ${quoteCatalogTestSchema(db.schema)}.orchestration_configurations WHERE tenant_id=$1 AND config_fingerprint='config-a'`,
  [tenantId])).rows[0]!.document_sha256, checkpoint, repositoryId, serviceId, environment, serviceRoot,
  identities[0]!.captureIdentityDigest, load.artifactRef, load.configuredKeyRef, load.envelopeDigest, load.signerSpkiDigest]);
}

test("loaded-document admission queues exact host-bound identity and replays without result/catalog writes", async () => {
  const {db, schema} = await setup();
  try {
    const parent = await capture(db, "one");
    await approvePolicy(db, [parent]);
    const store = createLoadedDocumentVerificationAdmissionStore(db.pool, options(db, [parent]));
    const [first, simultaneous] = await Promise.all([
      store.admit({captureIdentityDigest: parent.captureIdentityDigest}),
      store.admit({captureIdentityDigest: parent.captureIdentityDigest}),
    ]);
    const replay = await store.admit({captureIdentityDigest: parent.captureIdentityDigest});
    expect(first).toMatchObject({captureIdentityDigest: parent.captureIdentityDigest,
      verifierProfileVersion: "swagger-loaded-document-1", serviceRoot, configFingerprint: "config-a",
      checkpointVersion: "1", loadIdentityDigest: expect.stringMatching(/^sha256:/), jobId: expect.stringMatching(/^sha256:/)});
    expect([first.outcome, simultaneous.outcome].sort()).toEqual(["existing", "queued"]);
    expect(replay).toMatchObject({...first, outcome: "existing"});
    expect(first.loadIdentityDigest).toBe(hash(canonicalJsonStringify({profileVersion: "swagger-loaded-document-1", scope,
      captureIdentityDigest: parent.captureIdentityDigest, loadArtifactRef: load.artifactRef,
      loadConfiguredKeyRef: load.configuredKeyRef, loadEnvelopeDigest: load.envelopeDigest,
      loadSignerSpkiDigest: load.signerSpkiDigest})));
    expect(await db.pool.query(`SELECT * FROM ${schema}.orchestration_loaded_document_verification_jobs`)).toMatchObject({rows: [
      {state: "queued", load_identity_digest: first.loadIdentityDigest,
        capture_identity_digest: parent.captureIdentityDigest, load_artifact_ref: load.artifactRef,
        config_document_sha256: first.configDocumentSha256},
    ]});
    const counts = await db.pool.query<{loaded: string; catalog: string; pointers: string}>(`SELECT
      (SELECT count(*)::text FROM ${schema}.orchestration_observed_loaded_document_verifications) AS loaded,
      (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS catalog,
      (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS pointers`);
    expect(counts.rows).toEqual([{loaded: "0", catalog: "0", pointers: "0"}]);
    await expect(db.pool.query(`UPDATE ${schema}.orchestration_loaded_document_verification_jobs SET service_root='elsewhere'`))
      .rejects.toThrow();
    await expect(db.pool.query(`DELETE FROM ${schema}.orchestration_loaded_document_verification_jobs`)).rejects.toThrow();
  } finally {await db.cleanup();}
});

test("denial and malformed caller inputs do not reach the database", async () => {
  const {db} = await setup();
  try {
    const parent = await capture(db, "denied");
    await approvePolicy(db, [parent]);
    const query = vi.spyOn(db.pool, "query");
    const connect = vi.spyOn(db.pool, "connect");
    const denied = createLoadedDocumentVerificationAdmissionStore(db.pool, {...options(db, [parent]),
      preflightAuthorize: async () => false});
    await expect(denied.admit({captureIdentityDigest: parent.captureIdentityDigest})).rejects.toMatchObject({
      code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    const malformed = createLoadedDocumentVerificationAdmissionStore(db.pool, options(db, [parent]));
    await expect(malformed.admit({captureIdentityDigest: parent.captureIdentityDigest, loadArtifactRef: "caller:choice"} as never))
      .rejects.toMatchObject({code: "INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST"});
    await expect(malformed.admit({captureIdentityDigest: `sha256:${"f".repeat(64)}`}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    const wrongTenantPreflight = vi.fn(async () => true);
    expect(() => createLoadedDocumentVerificationAdmissionStore(db.pool, {...options(db, [parent]), tenantId: "another-tenant",
      preflightAuthorize: wrongTenantPreflight})).toThrow();
    expect(wrongTenantPreflight).not.toHaveBeenCalled();
    let configGetterCalled = false;
    const accessorOptions = Object.defineProperty({...options(db, [parent])}, "authorizeLoadedDocument", {
      get() {configGetterCalled = true; throw Error("private host policy canary");}, enumerable: true,
    });
    expect(() => createLoadedDocumentVerificationAdmissionStore(db.pool, accessorOptions as never))
      .toThrow(expect.objectContaining({code: "INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST"}));
    expect(configGetterCalled).toBe(false);
    let proxyTrapCalled = false;
    const proxyOptions = new Proxy(options(db, [parent]), {ownKeys() {proxyTrapCalled = true; throw Error("proxy canary");}});
    expect(() => createLoadedDocumentVerificationAdmissionStore(db.pool, proxyOptions as never))
      .toThrow(expect.objectContaining({code: "INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST"}));
    expect(proxyTrapCalled).toBe(false);
    let requestGetterCalled = false;
    const accessorRequest = Object.defineProperty({}, "captureIdentityDigest", {
      get() {requestGetterCalled = true; throw Error("private caller canary");}, enumerable: true,
    });
    await expect(malformed.admit(accessorRequest as never)).rejects.toMatchObject({
      code: "INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST"});
    expect(requestGetterCalled).toBe(false);
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    query.mockRestore(); connect.mockRestore();
  } finally {await db.cleanup();}
});

test("missing handler verification, revoked grants, and absent configured opt-in fail closed", async () => {
  const {db, schema, access} = await setup();
  try {
    const parent = await capture(db, "parents");
    await approvePolicy(db, [parent]);
    const auth = vi.fn(options(db, [parent]).authorizeLoadedDocument);
    const store = createLoadedDocumentVerificationAdmissionStore(db.pool, {...options(db, [parent]), authorizeLoadedDocument: auth});
    const missingAssociationId = hash("bound but absent capture association");
    const missingAssociationAuth = vi.fn(options(db, [parent]).authorizeLoadedDocument);
    const missingAssociation = createLoadedDocumentVerificationAdmissionStore(db.pool, {
      ...options(db, [parent, {captureIdentityDigest: missingAssociationId}]), authorizeLoadedDocument: missingAssociationAuth,
    });
    await expect(missingAssociation.admit({captureIdentityDigest: missingAssociationId})).rejects.toMatchObject({
      code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    expect(missingAssociationAuth).not.toHaveBeenCalled();
    await db.pool.query(`DROP TRIGGER orchestration_observed_capture_verifications_immutable
      ON ${schema}.orchestration_observed_capture_verifications`);
    await db.pool.query(`DELETE FROM ${schema}.orchestration_observed_capture_verifications WHERE tenant_id=$1`, [tenantId]);
    await expect(store.admit({captureIdentityDigest: parent.captureIdentityDigest})).rejects.toMatchObject({
      code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    expect(auth).not.toHaveBeenCalled();
    await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_verifications
      (tenant_id,capture_identity_digest,verifier_profile_version,service_root,source_digest,receipt_digest,
       signer_spki_digest,result_digest,handler_count)
      SELECT tenant_id,capture_identity_digest,'protected-handler-bytes-1',$2,source_digest,receipt_digest,
       signer_spki_digest,$3,1 FROM ${schema}.orchestration_observed_capture_associations WHERE tenant_id=$1`,
    [tenantId, serviceRoot, hash("replacement handler result")]);
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: false});
    await expect(store.admit({captureIdentityDigest: parent.captureIdentityDigest})).rejects.toMatchObject({
      code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    expect(auth).not.toHaveBeenCalled();
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: true});
    const wrongLoadOptions = options(db, [parent]);
    wrongLoadOptions.bindings = wrongLoadOptions.bindings.map(binding => ({...binding, loadArtifactRef: "capture:unapproved"}));
    const wrongLoadAuth = vi.fn(wrongLoadOptions.authorizeLoadedDocument);
    const wrongLoad = createLoadedDocumentVerificationAdmissionStore(db.pool,
      {...wrongLoadOptions, authorizeLoadedDocument: wrongLoadAuth});
    await expect(wrongLoad.admit({captureIdentityDigest: parent.captureIdentityDigest})).rejects.toMatchObject({
      code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    expect(wrongLoadAuth).toHaveBeenCalledTimes(1);
    await db.pool.query(`UPDATE ${schema}.trusted_loaded_document_policy SET artifact_allowed=false`);
    await expect(store.admit({captureIdentityDigest: parent.captureIdentityDigest})).rejects.toMatchObject({
      code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    expect(auth).toHaveBeenCalledTimes(1);
  } finally {await db.cleanup();}
});

test("active configuration epoch changes invalidate opt-in and make switchback admission identity distinct", async () => {
  const {db, schema, orchestration, configDocumentSha256} = await setup();
  try {
    const parent = await capture(db, "epoch");
    await approvePolicy(db, [parent]);
    const store = createLoadedDocumentVerificationAdmissionStore(db.pool, options(db, [parent]));
    const first = await store.admit({captureIdentityDigest: parent.captureIdentityDigest});
    await orchestration.registerConfiguration(admin, config("config-b"));
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations SET config_fingerprint='config-b',
      checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await expect(store.admit({captureIdentityDigest: parent.captureIdentityDigest})).rejects.toMatchObject({
      code: "LOADED_DOCUMENT_ADMISSION_DENIED"});
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations SET config_fingerprint='config-a',
      checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await approvePolicy(db, [parent], 3);
    const later = await store.admit({captureIdentityDigest: parent.captureIdentityDigest});
    expect(later).toMatchObject({outcome: "queued", checkpointVersion: "3", configDocumentSha256});
    expect(later.jobId).not.toBe(first.jobId);
    expect(later.loadIdentityDigest).toBe(first.loadIdentityDigest);
  } finally {await db.cleanup();}
});

test("tenant quota is serialized and exact replay remains free", async () => {
  const {db, schema} = await setup();
  try {
    const one = await capture(db, "quota-one"), two = await capture(db, "quota-two");
    await approvePolicy(db, [one]); await approvePolicy(db, [two]);
    const store = createLoadedDocumentVerificationAdmissionStore(db.pool, options(db, [one, two], 1));
    const concurrent = await Promise.allSettled([one, two].map(parent => store.admit({captureIdentityDigest: parent.captureIdentityDigest})));
    const first = concurrent.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.admit>>> =>
      result.status === "fulfilled");
    const rejected = concurrent.find(result => result.status === "rejected");
    expect(first).toBeDefined();
    expect(rejected).toBeDefined();
    expect(rejected).toMatchObject({status: "rejected", reason: {code: "LOADED_DOCUMENT_ADMISSION_QUOTA"}});
    if (!first) throw new Error("Expected one admitted load");
    const admitted = [one, two].find(parent => parent.captureIdentityDigest === first.value.captureIdentityDigest)!;
    expect((await store.admit({captureIdentityDigest: admitted.captureIdentityDigest})).outcome).toBe("existing");
    const rows = await db.pool.query(`SELECT * FROM ${schema}.orchestration_loaded_document_verification_jobs`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({job_id: first.value.jobId, state: "queued"});
  } finally {await db.cleanup();}
});
