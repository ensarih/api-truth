import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {expect, test} from "vitest";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {canonicalOrchestrationHash} from "../../packages/orchestration/src/canonical.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore, type CaptureVerificationAdmissionOptions}
  from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "capture-admission-race";
const principalId = "capture-reviewer";
const sourceScopeId = "capture-source";
const environmentScopeId = "capture-environment";
const repositoryId = "capture-repository";
const serviceId = "capture-service";
const environmentName = "uat";
const scope = {tenantId, repositoryId, serviceId, immutableRevision: "a".repeat(40),
  sourceDigest: `sha256:${"b".repeat(64)}`, environment: environmentName};
const admin = {tenantId, principalId: "capture-admin", capabilities: ["configuration.admin"]};
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const config = (fingerprint: string, root = "services/capture-api") => ({fingerprint, document: {
  config_version: "1.0.0",
  access_scopes: [sourceScopeId, environmentScopeId].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "example/capture-api",
    access_scope_id: sourceScopeId, services: [{service_id: serviceId, root,
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: environmentName, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScopeId}}]}]}],
  inference: {enabled: false}, logs: {enabled: false},
}});

async function setup() {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  await applyOrchestrationMigrations(db.pool, {schema: db.schema});
  const access = createAccessPolicyStore(db.pool, {schema: db.schema});
  for (const scopeId of [sourceScopeId, environmentScopeId]) {
    await access.putScope({tenantId}, {scopeId, active: true});
    await access.putGrant({tenantId}, {principalId, scopeId, active: true});
  }
  const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
  const registered = await orchestration.registerConfiguration(admin, config("config-a"));
  await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
  await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_policy (
    tenant_id text NOT NULL, principal_id text NOT NULL, config_fingerprint text NOT NULL,
    config_document_sha256 text NOT NULL, config_checkpoint_version bigint NOT NULL,
    repository_id text NOT NULL, service_id text NOT NULL, environment text NOT NULL, service_root text NOT NULL,
    opt_in boolean NOT NULL, source_allowed boolean NOT NULL, environment_allowed boolean NOT NULL,
    capture_allowed boolean NOT NULL,
    PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version))`);
  await db.pool.query(`INSERT INTO ${schema}.trusted_capture_policy VALUES
    ($1,$2,'config-a',$3,1,$4,$5,$6,'services/capture-api',true,true,true,true)`,
  [tenantId, principalId, registered.documentSha256, repositoryId, serviceId, environmentName]);
  return {db, schema, orchestration};
}

async function insertCapture(db: CatalogTestDatabase, session: string): Promise<string> {
  const artifactRef = `capture:${session}`;
  const configuredKeyRef = "key:admission-race";
  const receiptDigest = hash(`receipt:${session}`);
  const signerSpkiDigest = hash("capture-admission-race-signer");
  const identity = canonicalOrchestrationHash({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest});
  const schema = quoteCatalogTestSchema(db.schema);
  await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, identity, repositoryId, serviceId, scope.immutableRevision, scope.sourceDigest, environmentName,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  return identity;
}

type HostBinding = Parameters<CaptureVerificationAdmissionOptions["authorizeCapture"]>[1];
const admissionOptions = (db: CatalogTestDatabase, overrides: Partial<CaptureVerificationAdmissionOptions> = {}) => ({
  schema: db.schema, tenantId, principalId, maxQueuedPerTenant: 10,
  preflightAuthorize: async () => true,
  authorizeCapture: async (client: PoolClient, binding: HostBinding): Promise<boolean> => {
    const policy = await client.query<{opt_in: boolean; source_allowed: boolean; environment_allowed: boolean;
      capture_allowed: boolean}>(`SELECT opt_in,source_allowed,environment_allowed,capture_allowed
      FROM trusted_capture_policy WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3
        AND config_document_sha256=$4 AND config_checkpoint_version=$5 AND repository_id=$6 AND service_id=$7
        AND environment=$8 AND service_root=$9 FOR SHARE`,
    [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
      binding.checkpointVersion, binding.repositoryId, binding.serviceId, binding.environment, binding.serviceRoot]);
    const row = policy.rows[0];
    return policy.rows.length === 1 && row!.opt_in && row!.source_allowed && row!.environment_allowed && row!.capture_allowed;
  },
  ...overrides,
});

const assertLockTimeout = async (db: CatalogTestDatabase, update: (client: PoolClient) => Promise<unknown>): Promise<void> => {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '250ms'");
    await expect(update(client)).rejects.toMatchObject({code: "55P03"});
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
};

test("admission holds DB-local capture permission through commit, then revocation takes effect", async () => {
  const {db, schema} = await setup();
  let releasePolicy!: () => void;
  let signalPolicyLocked!: () => void;
  const policyGate = new Promise<void>(resolve => { releasePolicy = resolve; });
  const policyLocked = new Promise<void>(resolve => { signalPolicyLocked = resolve; });
  let admission: ReturnType<ReturnType<typeof createCaptureVerificationAdmissionStore>["admit"]> | undefined;
  try {
    const identity = await insertCapture(db, "permission-lock");
    let firstAuthorize = true;
    const options = admissionOptions(db, {authorizeCapture: async (client: PoolClient, binding: HostBinding) => {
      const policy = await client.query<{capture_allowed: boolean}>(`SELECT capture_allowed FROM trusted_capture_policy
        WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND config_checkpoint_version=$4
        FOR SHARE`, [binding.tenantId, binding.principalId, binding.configFingerprint, binding.checkpointVersion]);
      if (firstAuthorize) {
        firstAuthorize = false;
        signalPolicyLocked();
        await policyGate;
      }
      return policy.rows[0]?.capture_allowed === true;
    }});
    const store = createCaptureVerificationAdmissionStore(db.pool, options);
    admission = store.admit({captureIdentityDigest: identity});
    await policyLocked;
    await assertLockTimeout(db, client => client.query(`UPDATE ${schema}.trusted_capture_policy
      SET capture_allowed=false WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principalId]));
    releasePolicy();
    await expect(admission).resolves.toMatchObject({outcome: "queued", captureIdentityDigest: identity,
      checkpointVersion: "1"});
    await db.pool.query(`UPDATE ${schema}.trusted_capture_policy SET capture_allowed=false
      WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principalId]);
    await expect(store.admit({captureIdentityDigest: identity}))
      .rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    expect((await db.pool.query<{count: string}>(`SELECT count(*)::text AS count FROM ${schema}.orchestration_capture_verification_jobs`))
      .rows).toEqual([{count: "1"}]);
  } finally {
    releasePolicy();
    await admission?.catch(() => undefined);
    await db.cleanup();
  }
});

test("active config epoch stays locked through admission and the job retains the admitted epoch", async () => {
  const {db, schema} = await setup();
  let releasePolicy!: () => void;
  let signalConfigShared!: () => void;
  const policyGate = new Promise<void>(resolve => { releasePolicy = resolve; });
  const configShared = new Promise<void>(resolve => { signalConfigShared = resolve; });
  let admission: ReturnType<ReturnType<typeof createCaptureVerificationAdmissionStore>["admit"]> | undefined;
  try {
    const identity = await insertCapture(db, "config-lock");
    let firstAuthorize = true;
    const store = createCaptureVerificationAdmissionStore(db.pool, admissionOptions(db, {
      authorizeCapture: async (client: PoolClient, binding: HostBinding) => {
        const active = await client.query<{checkpoint_version: string}>(`SELECT checkpoint_version::text
          FROM orchestration_active_configurations WHERE tenant_id=$1 FOR SHARE`, [binding.tenantId]);
        if (firstAuthorize) {
          firstAuthorize = false;
          signalConfigShared();
          await policyGate;
        }
        return active.rows[0]?.checkpoint_version === binding.checkpointVersion;
      },
    }));
    admission = store.admit({captureIdentityDigest: identity});
    await configShared;
    await assertLockTimeout(db, client => client.query(`UPDATE ${schema}.orchestration_active_configurations
      SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]));
    releasePolicy();
    const admitted = await admission;
    expect(admitted).toMatchObject({outcome: "queued", captureIdentityDigest: identity,
      configFingerprint: "config-a", checkpointVersion: "1"});
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    expect((await db.pool.query<{state: string; config_fingerprint: string; config_checkpoint_version: string}>(
      `SELECT state,config_fingerprint,config_checkpoint_version::text
       FROM ${schema}.orchestration_capture_verification_jobs`)).rows)
      .toEqual([{state: "queued", config_fingerprint: "config-a", config_checkpoint_version: "1"}]);
    expect((await db.pool.query<{checkpoint_version: string}>(
      `SELECT checkpoint_version::text FROM ${schema}.orchestration_active_configurations WHERE tenant_id=$1`,
    [tenantId])).rows).toEqual([{checkpoint_version: "2"}]);
  } finally {
    releasePolicy();
    await admission?.catch(() => undefined);
    await db.cleanup();
  }
});

test("admissions for identical external identifiers stay isolated by tenant", async () => {
  const first = await setup();
  const secondTenantId = "capture-admission-race-two";
  const secondPrincipalId = "capture-reviewer-two";
  const secondSchema = quoteCatalogTestSchema(first.db.schema);
  try {
    const access = createAccessPolicyStore(first.db.pool, {schema: first.db.schema});
    for (const scopeId of [sourceScopeId, environmentScopeId]) {
      await access.putScope({tenantId: secondTenantId}, {scopeId, active: true});
      await access.putGrant({tenantId: secondTenantId}, {principalId: secondPrincipalId, scopeId, active: true});
    }
    const orchestration = createOrchestrationRepository(first.db.pool, {schema: first.db.schema});
    const secondAdmin = {tenantId: secondTenantId, principalId: "capture-admin-two", capabilities: ["configuration.admin"]};
    const registered = await orchestration.registerConfiguration(secondAdmin, config("config-a"));
    await orchestration.activateInitialConfiguration(secondAdmin, {fingerprint: "config-a"});
    await first.db.pool.query(`INSERT INTO ${secondSchema}.trusted_capture_policy VALUES
      ($1,$2,'config-a',$3,1,$4,$5,$6,'services/capture-api',true,true,true,true)`,
    [secondTenantId, secondPrincipalId, registered.documentSha256, repositoryId, serviceId, environmentName]);

    const firstIdentity = await insertCapture(first.db, "same-receipt");
    const secondScope = {...scope, tenantId: secondTenantId};
    const artifactRef = "capture:same-receipt";
    const configuredKeyRef = "key:admission-race";
    const receiptDigest = hash("receipt:same-receipt");
    const signerSpkiDigest = hash("capture-admission-race-signer");
    const secondIdentity = canonicalOrchestrationHash({policyVersion: "runtime-capture-pin-1", scope: secondScope,
      artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest});
    await first.db.pool.query(`INSERT INTO ${secondSchema}.orchestration_observed_capture_associations
      (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
       policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
    [secondTenantId, secondIdentity, repositoryId, serviceId, scope.immutableRevision, scope.sourceDigest, environmentName,
      artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
    expect(secondIdentity).not.toBe(firstIdentity);

    const firstStore = createCaptureVerificationAdmissionStore(first.db.pool, admissionOptions(first.db));
    const secondStore = createCaptureVerificationAdmissionStore(first.db.pool, admissionOptions(first.db, {
      tenantId: secondTenantId, principalId: secondPrincipalId,
    }));
    const [firstResult, secondResult] = await Promise.all([
      firstStore.admit({captureIdentityDigest: firstIdentity}),
      secondStore.admit({captureIdentityDigest: secondIdentity}),
    ]);
    expect(firstResult).toMatchObject({outcome: "queued", captureIdentityDigest: firstIdentity});
    expect(secondResult).toMatchObject({outcome: "queued", captureIdentityDigest: secondIdentity});
    await expect(firstStore.admit({captureIdentityDigest: secondIdentity}))
      .rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    await expect(secondStore.admit({captureIdentityDigest: firstIdentity}))
      .rejects.toMatchObject({code: "CAPTURE_ADMISSION_DENIED"});
    expect((await first.db.pool.query<{tenant_id: string; count: string}>(`SELECT tenant_id,count(*)::text AS count
      FROM ${secondSchema}.orchestration_capture_verification_jobs GROUP BY tenant_id ORDER BY tenant_id`)).rows)
      .toEqual([{tenant_id: tenantId, count: "1"}, {tenant_id: secondTenantId, count: "1"}]);
  } finally { await first.db.cleanup(); }
});
