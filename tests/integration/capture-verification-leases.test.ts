import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {expect, test, vi} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrationManifest, applyOrchestrationMigrations,
  createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCaptureVerificationLeaseStore} from "../../packages/orchestration/src/capture-verification-leases.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "lease-tenant", principalId = "lease-worker";
const sourceScope = "source-access", environmentScope = "environment-access";
const scope = {tenantId, repositoryId: "repository", serviceId: "service", environment: "uat",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const config = (fingerprint: string) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: scope.repositoryId, provider: "github", locator: "sample/repository",
    access_scope_id: sourceScope, services: [{service_id: scope.serviceId, root: "services/api",
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: scope.environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});

async function setup() {
  const db = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(db.pool, {schema: db.schema});
  const schema = quoteCatalogTestSchema(db.schema);
  const access = createAccessPolicyStore(db.pool, {schema: db.schema});
  for (const scopeId of [sourceScope, environmentScope]) {
    await access.putScope({tenantId}, {scopeId, active: true});
    await access.putGrant({tenantId}, {principalId, scopeId, active: true});
  }
  const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
  const registered = await orchestration.registerConfiguration(admin, config("config-a"));
  await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
  await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_execute (
    tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
    config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
    source_allowed boolean NOT NULL,environment_allowed boolean NOT NULL,capture_allowed boolean NOT NULL,
    PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version))`);
  await db.pool.query(`INSERT INTO ${schema}.trusted_capture_execute VALUES
    ($1,$2,'config-a',$3,1,true,true,true)`, [tenantId, principalId, registered.documentSha256]);
  return {db, schema, access, orchestration, configDigest: registered.documentSha256};
}
async function admission(db: CatalogTestDatabase, name: string, maxQueuedPerTenant = 1000) {
  const artifactRef = `capture:${name}`, configuredKeyRef = "key:test";
  const receiptDigest = hash(`receipt:${name}`), signerSpkiDigest = hash("signer");
  const identity = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest}));
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, identity, scope.repositoryId, scope.serviceId, scope.immutableRevision, scope.sourceDigest,
    scope.environment, artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  const store = createCaptureVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId, principalId,
    maxQueuedPerTenant, preflightAuthorize: async () => true,
    authorizeCapture: async (client, binding) => {
      const row = await client.query<{source_allowed: boolean; environment_allowed: boolean; capture_allowed: boolean}>(
        `SELECT source_allowed,environment_allowed,capture_allowed FROM trusted_capture_execute
         WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3
           AND config_document_sha256=$4 AND config_checkpoint_version=$5 FOR SHARE`,
        [binding.tenantId, binding.principalId, binding.configFingerprint,
          binding.configDocumentSha256, binding.checkpointVersion]);
      return row.rows.length === 1 && row.rows[0]!.source_allowed && row.rows[0]!.environment_allowed
        && row.rows[0]!.capture_allowed;
    }});
  return store.admit({captureIdentityDigest: identity});
}
function leaseStore(db: CatalogTestDatabase, workerId: string, preflightAuthorize = async () => true) {
  return createCaptureVerificationLeaseStore(db.pool, {schema: db.schema, tenantId, principalId,
    workerId, instanceId: "instance-1", allowedRepositories: [scope.repositoryId], allowedServices: [scope.serviceId],
    preflightAuthorize,
    authorizeCapture: async (client, binding) => {
      const row = await client.query<{source_allowed: boolean; environment_allowed: boolean; capture_allowed: boolean}>(
        `SELECT source_allowed,environment_allowed,capture_allowed FROM trusted_capture_execute
         WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3
           AND config_document_sha256=$4 AND config_checkpoint_version=$5 FOR SHARE`,
        [binding.tenantId, binding.principalId, binding.configFingerprint,
          binding.configDocumentSha256, binding.checkpointVersion]);
      return row.rows.length === 1 && row.rows[0]!.source_allowed && row.rows[0]!.environment_allowed
        && row.rows[0]!.capture_allowed;
    }});
}

test("separate state backfills admissions, leases once, and heartbeats without D08 writes", async () => {
  const {db, schema} = await setup();
  try {
    const admitted = await admission(db, "one");
    const worker = leaseStore(db, "worker-a");
    const claimed = await worker.claimOne();
    expect(claimed).toMatchObject({kind: "leased", jobId: admitted.jobId,
      captureIdentityDigest: admitted.captureIdentityDigest, leaseToken: expect.stringMatching(/^[a-f0-9]{64}$/)});
    if (claimed.kind !== "leased") throw Error("expected lease");
    expect(await worker.claimOne()).toMatchObject({kind: "no_work", coverage: "partial"});
    const renewed = await worker.heartbeat({jobId: claimed.jobId, leaseToken: claimed.leaseToken});
    expect(renewed).toMatchObject({jobId: claimed.jobId, leaseToken: claimed.leaseToken});
    const row = await db.pool.query<{state: string; lease_token_hash: string; attempt_count: number}>(
      `SELECT state,lease_token_hash,attempt_count FROM ${schema}.orchestration_capture_verification_job_state`);
    expect(row.rows).toMatchObject([{state: "leased", lease_token_hash: expect.stringMatching(/^sha256:/), attempt_count: 1}]);
    expect(JSON.stringify(row.rows)).not.toContain(claimed.leaseToken);
    const ordinary = await db.pool.query<{snapshots: string; revisions: string; pointers: string; verified: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
       (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots) AS revisions,
       (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS pointers,
       (SELECT count(*)::text FROM ${schema}.orchestration_observed_capture_verifications) AS verified`);
    expect(ordinary.rows).toEqual([{snapshots: "0", revisions: "0", pointers: "0", verified: "0"}]);
  } finally { await db.cleanup(); }
});

test("two workers cannot claim the same capture and service capacity holds", async () => {
  const {db} = await setup();
  try {
    await admission(db, "race-a");
    await admission(db, "race-b");
    const first = leaseStore(db, "worker-a"), second = leaseStore(db, "worker-b");
    const claims = await Promise.all([first.claimOne(), second.claimOne()]);
    expect(claims.filter(claim => claim.kind === "leased")).toHaveLength(1);
    expect(claims.filter(claim => claim.kind === "no_work")).toHaveLength(1);
  } finally { await db.cleanup(); }
});

test("wrong worker/token fail; expired leases reclaim with a fresh token then exhaust", async () => {
  const {db, schema} = await setup();
  try {
    await admission(db, "expiry");
    const owner = leaseStore(db, "worker-a"), other = leaseStore(db, "worker-b");
    const first = await owner.claimOne();
    if (first.kind !== "leased") throw Error("expected lease");
    const ahead = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      await expect(owner.heartbeat({jobId: first.jobId, leaseToken: first.leaseToken}))
        .resolves.toMatchObject({jobId: first.jobId});
    } finally { ahead.mockRestore(); }
    await expect(other.heartbeat({jobId: first.jobId, leaseToken: first.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_CONFLICT"});
    await expect(owner.heartbeat({jobId: first.jobId, leaseToken: "f".repeat(64)}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_CONFLICT"});
    await db.pool.query(`UPDATE ${schema}.orchestration_capture_verification_job_state
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`, [first.jobId]);
    const behind = vi.spyOn(Date, "now").mockReturnValue(0);
    let second: Awaited<ReturnType<typeof other.claimOne>>;
    try { second = await other.claimOne(); } finally { behind.mockRestore(); }
    if (second.kind !== "leased") throw Error("expected reclaimed lease");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(owner.heartbeat({jobId: first.jobId, leaseToken: first.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_CONFLICT"});
    await db.pool.query(`UPDATE ${schema}.orchestration_capture_verification_job_state
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`, [first.jobId]);
    const third = await owner.claimOne();
    expect(third).toMatchObject({kind: "leased", attemptCount: 3});
    await db.pool.query(`UPDATE ${schema}.orchestration_capture_verification_job_state
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`, [first.jobId]);
    expect(await owner.claimOne()).toMatchObject({kind: "no_work", coverage: "partial"});
    const terminal = await db.pool.query<{state: string}>(
      `SELECT state FROM ${schema}.orchestration_capture_verification_job_state WHERE job_id=$1`, [first.jobId]);
    expect(terminal.rows).toEqual([{state: "failed"}]);
    await admission(db, "after-terminal", 1);
  } finally { await db.cleanup(); }
});

test("grant revocation and config switchback fence heartbeat and stale claims", async () => {
  const {db, schema, access, orchestration, configDigest} = await setup();
  try {
    const admitted = await admission(db, "fenced");
    const worker = leaseStore(db, "worker-a");
    const leased = await worker.claimOne();
    if (leased.kind !== "leased") throw Error("expected lease");
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: false});
    await expect(worker.heartbeat({jobId: leased.jobId, leaseToken: leased.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: true});
    await db.pool.query(`UPDATE ${schema}.trusted_capture_execute SET capture_allowed=false`);
    await expect(worker.heartbeat({jobId: leased.jobId, leaseToken: leased.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
    await db.pool.query(`UPDATE ${schema}.trusted_capture_execute SET capture_allowed=true`);
    await orchestration.registerConfiguration(admin, config("config-b"));
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET config_fingerprint='config-b',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await expect(worker.heartbeat({jobId: leased.jobId, leaseToken: leased.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET config_fingerprint='config-a',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await db.pool.query(`INSERT INTO ${schema}.trusted_capture_execute VALUES
      ($1,$2,'config-a',$3,3,true,true,true)`, [tenantId, principalId, configDigest]);
    await expect(worker.heartbeat({jobId: leased.jobId, leaseToken: leased.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
    expect(await worker.claimOne()).toMatchObject({kind: "no_work", coverage: "partial"});
    expect(admitted.checkpointVersion).toBe("1");
  } finally { await db.cleanup(); }
});

test("preflight capability denial and hostile lease input cause no database or callback work", async () => {
  const {db} = await setup();
  try {
    const connect = vi.spyOn(db.pool, "connect");
    try {
      const worker = leaseStore(db, "worker-a", async () => false);
      await expect(worker.claimOne()).rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
    const worker = leaseStore(db, "worker-a");
    const hostile = new Proxy({jobId: `sha256:${"f".repeat(64)}`, leaseToken: "a".repeat(64)},
      {getOwnPropertyDescriptor: () => { throw Error("private-canary"); }});
    await expect(worker.heartbeat(hostile)).rejects.toMatchObject({code: "INVALID_CAPTURE_LEASE_REQUEST"});
  } finally { await db.cleanup(); }
});

test("0009 backfills queued state for admission rows made before lifecycle migration", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    const versions = ["0001_orchestration_core", "0002_ordered_scheduling", "0003_durable_workers",
      "0004_atomic_execution", "0005_revision_target_uniqueness", "0006_observed_capture_associations",
      "0007_observed_capture_verifications", "0008_capture_verification_admissions"];
    const manifest = await Promise.all(versions.map(async version => ({version,
      sql: await readFile(new URL(`../../packages/orchestration/migrations/${version}.sql`, import.meta.url), "utf8")})));
    await applyOrchestrationMigrationManifest(db.pool, {schema: db.schema}, manifest);
    const receiptDigest = hash("pre-migration-receipt"), signerSpkiDigest = hash("signer");
    const captureIdentityDigest = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
      artifactRef: "capture:before", configuredKeyRef: "key:test", receiptDigest, signerSpkiDigest}));
    const jobId = hash("pre-migration-job"), configSha = hash("configuration");
    await db.pool.query(`INSERT INTO ${schema}.orchestration_configurations
      (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
      VALUES ($1,'config-a','1.0.0',$2,'{}'::jsonb,'admin')`, [tenantId, configSha]);
    await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_associations
      (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
       policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1','capture:before','key:test',$8,$9)`,
    [tenantId, captureIdentityDigest, scope.repositoryId, scope.serviceId, scope.immutableRevision,
      scope.sourceDigest, scope.environment, receiptDigest, signerSpkiDigest]);
    await db.pool.query(`INSERT INTO ${schema}.orchestration_capture_verification_jobs
      (tenant_id,job_id,capture_identity_digest,verifier_profile_version,repository_id,service_id,environment,
       service_root,config_fingerprint,config_document_sha256,config_checkpoint_version)
      VALUES ($1,$2,$3,'protected-handler-bytes-1',$4,$5,$6,'services/api','config-a',$7,1)`,
    [tenantId, jobId, captureIdentityDigest, scope.repositoryId, scope.serviceId, scope.environment, configSha]);
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const state = await db.pool.query<{state: string; attempt_count: number}>(
      `SELECT state,attempt_count FROM ${schema}.orchestration_capture_verification_job_state
       WHERE tenant_id=$1 AND job_id=$2`, [tenantId, jobId]);
    expect(state.rows).toEqual([{state: "queued", attempt_count: 0}]);
  } finally { await db.cleanup(); }
});
