import {createHash} from "node:crypto";
import {expect, test, vi} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCaptureVerificationLeaseStore} from "../../packages/orchestration/src/capture-verification-leases.js";
import {createCaptureVerificationRunner} from "../../packages/orchestration/src/capture-verification-runner.js";
import {createCaptureVerificationMaintenance} from "../../packages/orchestration/src/capture-verification-maintenance.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "cancel-tenant", principalId = "cancel-worker", managerId = "cancel-manager";
const sourceScope = "source-access", environmentScope = "environment-access";
const repositoryId = "repository", serviceId = "service", environment = "uat";
const scope = {tenantId, repositoryId, serviceId, environment,
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const config = (fingerprint: string, removed = false) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/repository",
    access_scope_id: sourceScope, services: [{service_id: removed ? "replacement" : serviceId,
      root: "services/api", analyzer: {adapter_id: "typescript", adapter_version: "1"},
      intended_branches: ["main"], environments: [{name: environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});
const verified = (identity: string, receiptDigest: string, signerSpkiDigest: string) => ({
  kind: "verified_handler_bytes", scope, serviceRoot: "services/api", captureIdentityDigest: identity,
  receiptDigest, signerSpkiDigest, sourceDigest: scope.sourceDigest,
  handlers: [{method: "GET", applicationPath: "/orders/{id}", controller: "orders",
    operationId: "readOrder", handlerPath: "controllers/orders.js", handlerDigest: hash("handler"),
    exportName: "readOrder"}], limitations: ["Document operation correspondence and deployment are unverified"]});

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
  await db.pool.query(`CREATE TABLE ${schema}.trusted_cancel_manager (
    tenant_id text NOT NULL,principal_id text NOT NULL,repository_id text NOT NULL,
    service_id text NOT NULL,allowed boolean NOT NULL,
    PRIMARY KEY(tenant_id,principal_id,repository_id,service_id))`);
  await db.pool.query(`INSERT INTO ${schema}.trusted_cancel_manager VALUES
    ($1,$2,$3,$4,true)`, [tenantId, managerId, repositoryId, serviceId]);
  const authorizeCancel = async (client: import("pg").PoolClient,
    binding: {tenantId: string; principalId: string; repositoryId: string; serviceId: string}) => {
    const rows = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_cancel_manager
      WHERE tenant_id=$1 AND principal_id=$2 AND repository_id=$3 AND service_id=$4 FOR SHARE`,
    [binding.tenantId, binding.principalId, binding.repositoryId, binding.serviceId]);
    return rows.rows.length === 1 && rows.rows[0]!.allowed;
  };
  return {db, schema, access, orchestration, registered, authorizeCancel};
}
async function admit(db: CatalogTestDatabase, name: string, quota = 1000) {
  const artifactRef = `capture:${name}`, configuredKeyRef = "key:test";
  const receiptDigest = hash(`receipt:${name}`), signerSpkiDigest = hash("signer");
  const identity = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest}));
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, identity, repositoryId, serviceId, scope.immutableRevision, scope.sourceDigest,
    environment, artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  const store = createCaptureVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId,
    principalId, maxQueuedPerTenant: quota, preflightAuthorize: async () => true,
    authorizeCapture: async () => true});
  const receipt = await store.admit({captureIdentityDigest: identity});
  return {receipt, identity, receiptDigest, signerSpkiDigest};
}
async function activate(db: CatalogTestDatabase,
  orchestration: Awaited<ReturnType<typeof setup>>["orchestration"], fingerprint: string,
  removed = false) {
  await orchestration.registerConfiguration(admin, config(fingerprint, removed));
  await db.pool.query(`UPDATE ${quoteCatalogTestSchema(db.schema)}.orchestration_active_configurations
    SET config_fingerprint=$2,checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`,
  [tenantId, fingerprint]);
}
function maintenance(db: CatalogTestDatabase, authorizeCancel: Awaited<ReturnType<typeof setup>>["authorizeCancel"],
  batchSize = 100, preflightAuthorize = async () => true) {
  return createCaptureVerificationMaintenance(db.pool, {schema: db.schema, tenantId, principalId: managerId,
    allowedRepositories: [repositoryId], allowedServices: [serviceId], batchSize,
    preflightAuthorize, authorizeCancel});
}
function lease(db: CatalogTestDatabase) {
  return createCaptureVerificationLeaseStore(db.pool, {schema: db.schema, tenantId, principalId,
    workerId: "worker-a", instanceId: "instance-a", allowedRepositories: [repositoryId],
    allowedServices: [serviceId], preflightAuthorize: async () => true,
    authorizeCapture: async () => true});
}
async function states(db: CatalogTestDatabase, schema: string) {
  const rows = await db.pool.query<{job_id: string; state: string; lease_token_hash: string | null;
    terminal_reason: string | null; verification_result_digest: string | null}>(
    `SELECT job_id,state,lease_token_hash,terminal_reason,verification_result_digest
      FROM ${schema}.orchestration_capture_verification_job_state ORDER BY job_id`);
  return rows.rows;
}

test("old queued and live leases cancel in a bounded batch, releasing quota without catalog writes", async () => {
  const {db, schema, orchestration, authorizeCancel} = await setup();
  try {
    await admit(db, "one", 2);
    await admit(db, "two", 2);
    const oldLease = await lease(db).claimOne();
    if (oldLease.kind !== "leased") throw Error("expected live old lease");
    await activate(db, orchestration, "config-b");
    const result = await maintenance(db, authorizeCancel).cancelSuperseded();
    expect(result).toEqual({cancelledCount: 2, coverage: "partial", batchLimited: false});
    expect(JSON.stringify(result)).not.toContain(oldLease.jobId);
    expect(await states(db, schema)).toEqual(expect.arrayContaining([
      expect.objectContaining({state: "cancelled", lease_token_hash: null,
        terminal_reason: "CAPTURE_CONFIG_SUPERSEDED", verification_result_digest: null}),
      expect.objectContaining({state: "cancelled", lease_token_hash: null,
        terminal_reason: "CAPTURE_CONFIG_SUPERSEDED", verification_result_digest: null}),
    ]));
    await expect(lease(db).heartbeat({jobId: oldLease.jobId, leaseToken: oldLease.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
    const current = await admit(db, "current", 2);
    expect((await states(db, schema)).find(row => row.job_id === current.receipt.jobId))
      .toMatchObject({state: "queued", terminal_reason: null});
    expect(await maintenance(db, authorizeCancel).cancelSuperseded())
      .toMatchObject({cancelledCount: 0});
    const ordinary = await db.pool.query<{verified: string; snapshots: string; pointers: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_observed_capture_verifications) AS verified,
        (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
        (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS pointers`);
    expect(ordinary.rows).toEqual([{verified: "0", snapshots: "0", pointers: "0"}]);
  } finally { await db.cleanup(); }
});

test("removed service is still cancellable only with its old independent manager grant", async () => {
  const {db, schema, orchestration, authorizeCancel} = await setup();
  try {
    await admit(db, "removed");
    await activate(db, orchestration, "config-removed", true);
    await db.pool.query(`UPDATE ${schema}.trusted_cancel_manager SET allowed=false`);
    expect(await maintenance(db, authorizeCancel).cancelSuperseded())
      .toMatchObject({cancelledCount: 0, coverage: "partial"});
    expect((await states(db, schema))[0]).toMatchObject({state: "queued"});
    await db.pool.query(`UPDATE ${schema}.trusted_cancel_manager SET allowed=true`);
    expect(await maintenance(db, authorizeCancel).cancelSuperseded())
      .toMatchObject({cancelledCount: 1});
    expect((await states(db, schema))[0]).toMatchObject({state: "cancelled"});
  } finally { await db.cleanup(); }
});

test("batch output is count-only and switchback never revives canceled old jobs", async () => {
  const {db, schema, orchestration, authorizeCancel} = await setup();
  try {
    await admit(db, "batch-one");
    await admit(db, "batch-two");
    await activate(db, orchestration, "config-b");
    expect(await maintenance(db, authorizeCancel, 1).cancelSuperseded())
      .toEqual({cancelledCount: 1, coverage: "partial", batchLimited: true});
    expect(await maintenance(db, authorizeCancel, 1).cancelSuperseded())
      .toEqual({cancelledCount: 1, coverage: "partial", batchLimited: false});
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET config_fingerprint='config-a',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    expect(await maintenance(db, authorizeCancel).cancelSuperseded())
      .toMatchObject({cancelledCount: 0});
    expect((await states(db, schema)).every(row => row.state === "cancelled")).toBe(true);
    const revivedEpoch = await admit(db, "switchback-current");
    expect((await states(db, schema)).find(row => row.job_id === revivedEpoch.receipt.jobId))
      .toMatchObject({state: "queued"});
  } finally { await db.cleanup(); }
});

test("preflight denial and hostile configuration cause no database or manager callback work", async () => {
  const {db, authorizeCancel} = await setup();
  try {
    const connect = vi.spyOn(db.pool, "connect"), called = vi.fn();
    try {
      const denied = maintenance(db, async () => { called(); return true; }, 100, async () => false);
      await expect(denied.cancelSuperseded()).rejects.toMatchObject({code: "CAPTURE_MAINTENANCE_UNAUTHORIZED"});
      const valid = {schema: db.schema, tenantId, principalId: managerId,
        allowedRepositories: [repositoryId], allowedServices: [serviceId], batchSize: 1,
        preflightAuthorize: async () => true, authorizeCancel};
      const getter = Object.defineProperty({...valid}, "authorizeCancel",
        {enumerable: true, get: () => { called(); return authorizeCancel; }});
      expect(() => createCaptureVerificationMaintenance(db.pool, getter as never))
        .toThrowError(expect.objectContaining({code: "INVALID_CAPTURE_MAINTENANCE_CONFIGURATION"}));
      const proxy = new Proxy(valid, {getOwnPropertyDescriptor: () => { throw Error("private-canary"); }});
      expect(() => createCaptureVerificationMaintenance(db.pool, proxy))
        .toThrowError(expect.objectContaining({code: "INVALID_CAPTURE_MAINTENANCE_CONFIGURATION"}));
      expect(connect).not.toHaveBeenCalled();
      expect(called).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  } finally { await db.cleanup(); }
});

test("corrupted active configuration fails closed and leaves superseded job untouched", async () => {
  const {db, schema, orchestration, authorizeCancel} = await setup();
  try {
    await admit(db, "corrupt");
    await activate(db, orchestration, "config-b");
    await db.pool.query(`ALTER TABLE ${schema}.orchestration_configurations
      DISABLE TRIGGER orchestration_configurations_immutable`);
    await db.pool.query(`UPDATE ${schema}.orchestration_configurations
      SET document='{}'::jsonb WHERE tenant_id=$1 AND config_fingerprint='config-b'`, [tenantId]);
    await expect(maintenance(db, authorizeCancel).cancelSuperseded())
      .rejects.toMatchObject({code: "CAPTURE_MAINTENANCE_STORAGE_ERROR"});
    expect((await states(db, schema))[0]).toMatchObject({state: "queued", terminal_reason: null});
  } finally { await db.cleanup(); }
});

test("late running verifier cannot append 0007 after maintenance cancels its old lease", async () => {
  const {db, schema, orchestration, authorizeCancel} = await setup();
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let running: ReturnType<ReturnType<typeof createCaptureVerificationRunner>["runOne"]> | undefined;
  try {
    await admit(db, "late");
    const runner = createCaptureVerificationRunner(db.pool, {schema: db.schema, tenantId, principalId,
      workerId: "worker-a", instanceId: "instance-a", allowedRepositories: [repositoryId],
      allowedServices: [serviceId], preflightAuthorize: async () => true,
      authorizeCapture: async () => true,
      verificationPortFactory: async binding => ({verify: async () => {
        enter(); await waiting;
        return verified(binding.captureIdentityDigest, binding.receiptDigest, binding.signerSpkiDigest);
      }})});
    running = runner.runOne();
    await started;
    await activate(db, orchestration, "config-b");
    expect(await maintenance(db, authorizeCancel).cancelSuperseded())
      .toMatchObject({cancelledCount: 1});
    release();
    expect(await running).toMatchObject({kind: "deferred", reason: "lease_lost"});
    const result = await db.pool.query<{count: string}>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_observed_capture_verifications`);
    expect(result.rows).toEqual([{count: "0"}]);
  } finally { release(); await running?.catch(() => undefined); await db.cleanup(); }
});
