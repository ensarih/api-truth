import {expect, test, vi} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";
import {createHash} from "node:crypto";

const tenantId = "capture-tenant", principalId = "capture-principal";
const sourceScope = "source-read", environmentScope = "environment-read";
const scope = {tenantId, repositoryId: "repository", serviceId: "service", environment: "uat",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`};
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const config = (fingerprint: string, root = "services/api") => ({fingerprint, document: {
  config_version: "1.0.0", access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: scope.repositoryId, provider: "github", locator: "sample/repository",
    access_scope_id: sourceScope, services: [{service_id: scope.serviceId, root,
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: scope.environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});

async function setup() {
  const db = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(db.pool, {schema: db.schema});
  const access = createAccessPolicyStore(db.pool, {schema: db.schema});
  for (const scopeId of [sourceScope, environmentScope]) {
    await access.putScope({tenantId}, {scopeId, active: true});
    await access.putGrant({tenantId}, {principalId, scopeId, active: true});
  }
  const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
  const registered = await orchestration.registerConfiguration(admin, config("config-a"));
  await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
  const schema = quoteCatalogTestSchema(db.schema);
  await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_policy (
    tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
    config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
    repository_id text NOT NULL,service_id text NOT NULL,environment text NOT NULL,service_root text NOT NULL,
    opt_in boolean NOT NULL,source_allowed boolean NOT NULL,environment_allowed boolean NOT NULL,capture_allowed boolean NOT NULL,
    PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version))`);
  await db.pool.query(`INSERT INTO ${schema}.trusted_capture_policy VALUES
    ($1,$2,'config-a',$3,1,$4,$5,$6,'services/api',true,true,true,true)`,
  [tenantId, principalId, registered.documentSha256, scope.repositoryId, scope.serviceId, scope.environment]);
  return {db, schema, access, orchestration, configDigest: registered.documentSha256};
}
async function capture(db: CatalogTestDatabase, session: string) {
  const artifactRef = `capture:${session}`, configuredKeyRef = "key:test";
  const receiptDigest = hash(`receipt:${session}`), signerSpkiDigest = hash("signer");
  const identityDigest = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest}));
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, identityDigest, scope.repositoryId, scope.serviceId, scope.immutableRevision, scope.sourceDigest,
    scope.environment, artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  return identityDigest;
}
const options = (db: CatalogTestDatabase, maxQueuedPerTenant = 1000) => ({schema: db.schema, tenantId, principalId,
  maxQueuedPerTenant,
  preflightAuthorize: async () => true,
  authorizeCapture: async (client: import("pg").PoolClient, binding: {
    tenantId: string; principalId: string; configFingerprint: string; configDocumentSha256: string;
    checkpointVersion: string; repositoryId: string; serviceId: string; environment: string; serviceRoot: string;
    captureIdentityDigest: string}) => {
    const row = await client.query<{opt_in: boolean; source_allowed: boolean; environment_allowed: boolean;
      capture_allowed: boolean}>(`SELECT opt_in,source_allowed,environment_allowed,capture_allowed FROM trusted_capture_policy
      WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND config_document_sha256=$4
        AND config_checkpoint_version=$5 AND repository_id=$6 AND service_id=$7 AND environment=$8 AND service_root=$9
      FOR SHARE`,
    [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
      binding.checkpointVersion, binding.repositoryId, binding.serviceId, binding.environment, binding.serviceRoot]);
    return row.rows.length === 1 && row.rows[0]!.opt_in && row.rows[0]!.source_allowed
      && row.rows[0]!.environment_allowed && row.rows[0]!.capture_allowed;
  }});

test("admission pins an historical capture to active config and replays without normal snapshot/pointer writes", async () => {
  const {db, schema} = await setup();
  try {
    const identity = await capture(db, "first");
    const store = createCaptureVerificationAdmissionStore(db.pool, options(db));
    const first = await store.admit({captureIdentityDigest: identity});
    const replay = await store.admit({captureIdentityDigest: identity});
    expect(first).toMatchObject({outcome: "queued", captureIdentityDigest: identity,
      verifierProfileVersion: "protected-handler-bytes-1", serviceRoot: "services/api",
      configFingerprint: "config-a", checkpointVersion: "1", jobId: expect.stringMatching(/^sha256:/)});
    expect(replay).toEqual({...first, outcome: "existing"});
    const rows = await db.pool.query<{state: string; config_document_sha256: string; capture_identity_digest: string}>(
      `SELECT state,config_document_sha256,capture_identity_digest FROM ${schema}.orchestration_capture_verification_jobs`);
    expect(rows.rows).toEqual([{state: "queued", config_document_sha256: first.configDocumentSha256,
      capture_identity_digest: identity}]);
    const pointers = await db.pool.query<{revisions: string; branches: string; snapshots: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots) AS revisions,
       (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS branches,
       (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots`);
    expect(pointers.rows).toEqual([{revisions: "0", branches: "0", snapshots: "0"}]);
    await expect(db.pool.query(`UPDATE ${schema}.orchestration_capture_verification_jobs SET service_root='other'`)).rejects.toThrow();
  } finally { await db.cleanup(); }
});

test("source/environment grants and independent capture policy deny before admission", async () => {
  const {db, schema, access} = await setup();
  try {
    const identity = await capture(db, "denied");
    const authorizeCapture = vi.fn(options(db).authorizeCapture);
    const store = createCaptureVerificationAdmissionStore(db.pool, {...options(db), authorizeCapture});
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: false});
    await expect(store.admit({captureIdentityDigest: identity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    expect(authorizeCapture).not.toHaveBeenCalled();
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: true});
    await access.putGrant({tenantId}, {principalId, scopeId: environmentScope, active: false});
    await expect(store.admit({captureIdentityDigest: identity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    expect(authorizeCapture).not.toHaveBeenCalled();
    await access.putGrant({tenantId}, {principalId, scopeId: environmentScope, active: true});
    await db.pool.query(`UPDATE ${schema}.trusted_capture_policy SET capture_allowed=false`);
    await expect(store.admit({captureIdentityDigest: identity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    expect(authorizeCapture).toHaveBeenCalledTimes(1);
    await db.pool.query(`UPDATE ${schema}.trusted_capture_policy SET capture_allowed=true,source_allowed=false`);
    await expect(store.admit({captureIdentityDigest: identity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    await db.pool.query(`UPDATE ${schema}.trusted_capture_policy SET source_allowed=true,environment_allowed=false`);
    await expect(store.admit({captureIdentityDigest: identity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    await db.pool.query(`UPDATE ${schema}.trusted_capture_policy SET environment_allowed=true,opt_in=false`);
    await expect(store.admit({captureIdentityDigest: identity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    await expect(store.admit({captureIdentityDigest: `sha256:${"f".repeat(64)}`}))
      .rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    const count = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count FROM ${schema}.orchestration_capture_verification_jobs`);
    expect(count.rows).toEqual([{count: "0"}]);
  } finally { await db.cleanup(); }
});

test("host preflight denies before pool access and corrupted active config never reaches capture policy", async () => {
  const {db, schema} = await setup();
  try {
    const identity = await capture(db, "config-corrupt");
    const connect = vi.spyOn(db.pool, "connect");
    try {
      const denied = createCaptureVerificationAdmissionStore(db.pool,
        {...options(db), preflightAuthorize: async () => false});
      await expect(denied.admit({captureIdentityDigest: identity}))
        .rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
    await db.pool.query(`ALTER TABLE ${schema}.orchestration_configurations
      DISABLE TRIGGER orchestration_configurations_immutable`);
    await db.pool.query(`UPDATE ${schema}.orchestration_configurations SET document_sha256=$1
      WHERE tenant_id=$2 AND config_fingerprint='config-a'`, [`sha256:${"f".repeat(64)}`, tenantId]);
    const authorizeCapture = vi.fn(options(db).authorizeCapture);
    const store = createCaptureVerificationAdmissionStore(db.pool, {...options(db), authorizeCapture});
    await expect(store.admit({captureIdentityDigest: identity}))
      .rejects.toMatchObject({code: "CAPTURE_ADMISSION_STORAGE_ERROR"});
    expect(authorizeCapture).not.toHaveBeenCalled();
  } finally { await db.cleanup(); }
});

test("active configuration switchback creates a distinct epoch-bound admission", async () => {
  const {db, schema, orchestration, configDigest} = await setup();
  try {
    const identity = await capture(db, "switchback");
    const store = createCaptureVerificationAdmissionStore(db.pool, options(db));
    const first = await store.admit({captureIdentityDigest: identity});
    await orchestration.registerConfiguration(admin, config("config-b"));
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET config_fingerprint='config-b',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await expect(store.admit({captureIdentityDigest: identity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET config_fingerprint='config-a',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await db.pool.query(`INSERT INTO ${schema}.trusted_capture_policy VALUES
      ($1,$2,'config-a',$3,3,$4,$5,$6,'services/api',true,true,true,true)`,
    [tenantId, principalId, configDigest, scope.repositoryId, scope.serviceId, scope.environment]);
    const second = await store.admit({captureIdentityDigest: identity});
    expect(second).toMatchObject({outcome: "queued", checkpointVersion: "3"});
    expect(second.jobId).not.toBe(first.jobId);
  } finally { await db.cleanup(); }
});

test("tenant quota serializes concurrent admission and hostile inputs never reach storage", async () => {
  const {db, schema} = await setup();
  try {
    const firstIdentity = await capture(db, "quota-a"), secondIdentity = await capture(db, "quota-b");
    const store = createCaptureVerificationAdmissionStore(db.pool, options(db, 1));
    const results = await Promise.all([store.admit({captureIdentityDigest: firstIdentity}),
      store.admit({captureIdentityDigest: firstIdentity})]);
    expect(results.map(result => result.outcome).sort()).toEqual(["existing", "queued"]);
    await expect(store.admit({captureIdentityDigest: secondIdentity})).rejects.toMatchObject({code: "CAPTURE_ADMISSION_QUOTA"});
    const hostile = new Proxy({captureIdentityDigest: firstIdentity},
      {getOwnPropertyDescriptor: () => { throw Error("private-canary"); }});
    await expect(store.admit(hostile)).rejects.toMatchObject({code: "INVALID_CAPTURE_ADMISSION_REQUEST"});
    const count = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count FROM ${schema}.orchestration_capture_verification_jobs`);
    expect(count.rows).toEqual([{count: "1"}]);
  } finally { await db.cleanup(); }
});

test("different capture identities race under one tenant quota without over-admission", async () => {
  const {db, schema} = await setup();
  try {
    const first = await capture(db, "race-first"), second = await capture(db, "race-second");
    const store = createCaptureVerificationAdmissionStore(db.pool, options(db, 1));
    const results = await Promise.allSettled([
      store.admit({captureIdentityDigest: first}), store.admit({captureIdentityDigest: second})]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({reason: {code: "CAPTURE_ADMISSION_QUOTA"}});
    const count = await db.pool.query<{count: string}>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_capture_verification_jobs`);
    expect(count.rows).toEqual([{count: "1"}]);
  } finally { await db.cleanup(); }
});
