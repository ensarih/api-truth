import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {expect, test} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCaptureVerificationMaintenance} from "../../packages/orchestration/src/capture-verification-maintenance.js";
import type {CaptureVerificationMaintenanceOptions} from "../../packages/orchestration/src/capture-verification-maintenance.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "maintenance-race-tenant", workerId = "maintenance-race-worker", managerId = "maintenance-race-manager";
const sourceScope = "maintenance-race-source", environmentScope = "maintenance-race-environment";
const repositoryId = "maintenance-race-repository", serviceId = "removed-service", replacementServiceId = "replacement-service";
const environment = "uat";
const scope = {tenantId, repositoryId, serviceId, environment, immutableRevision: "a".repeat(40),
  sourceDigest: `sha256:${"b".repeat(64)}`};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const config = (fingerprint: string, service = serviceId) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/maintenance-race",
    access_scope_id: sourceScope, services: [{service_id: service, root: "services/api",
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});
function gate() {
  let release!: () => void, enter!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  return {waiting, started, release, enter};
}

async function setup() {
  const db = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(db.pool, {schema: db.schema});
  const schema = quoteCatalogTestSchema(db.schema);
  const access = createAccessPolicyStore(db.pool, {schema: db.schema});
  for (const scopeId of [sourceScope, environmentScope]) {
    await access.putScope({tenantId}, {scopeId, active: true});
    await access.putGrant({tenantId}, {principalId: workerId, scopeId, active: true});
  }
  const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
  const admin = {tenantId, principalId: "maintenance-race-admin", capabilities: ["configuration.admin"]};
  await orchestration.registerConfiguration(admin, config("config-a"));
  await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
  await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_manager_scope (
    tenant_id text NOT NULL,principal_id text NOT NULL,repository_id text NOT NULL,service_id text NOT NULL,
    allowed boolean NOT NULL,PRIMARY KEY(tenant_id,principal_id,repository_id,service_id))`);
  await db.pool.query(`INSERT INTO ${schema}.trusted_capture_manager_scope VALUES($1,$2,$3,$4,true)`,
    [tenantId, managerId, repositoryId, serviceId]);
  const authorizeCancel: CaptureVerificationMaintenanceOptions["authorizeCancel"] = async (client, binding) => {
    const rows = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_capture_manager_scope
      WHERE tenant_id=$1 AND principal_id=$2 AND repository_id=$3 AND service_id=$4 FOR SHARE`,
    [binding.tenantId, binding.principalId, binding.repositoryId, binding.serviceId]);
    return rows.rows.length === 1 && rows.rows[0]!.allowed;
  };
  return {db, schema, access, orchestration, authorizeCancel};
}

async function admit(db: CatalogTestDatabase, name: string) {
  const artifactRef = `capture:${name}`, configuredKeyRef = "key:maintenance-race";
  const receiptDigest = hash(`receipt:${name}`), signerSpkiDigest = hash("maintenance-race-signer");
  const identity = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest}));
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, identity, repositoryId, serviceId, scope.immutableRevision, scope.sourceDigest,
    environment, artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  const store = createCaptureVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId, principalId: workerId,
    preflightAuthorize: async () => true, authorizeCapture: async () => true});
  return store.admit({captureIdentityDigest: identity});
}

async function expectLockTimeout(client: PoolClient, update: () => Promise<unknown>) {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='250ms'");
  await expect(update()).rejects.toMatchObject({code: "55P03"});
  await client.query("ROLLBACK");
}

test("maintenance locks independent manager scope and active epoch through cancellation commit", async () => {
  const {db, schema, access, orchestration, authorizeCancel} = await setup();
  const held = gate();
  let cancellation: ReturnType<ReturnType<typeof createCaptureVerificationMaintenance>["cancelSuperseded"]> | undefined;
  try {
    const oldJobs = [await admit(db, "old-one"), await admit(db, "old-two")];
    const admin = {tenantId, principalId: "maintenance-race-admin", capabilities: ["configuration.admin"]};
    await orchestration.registerConfiguration(admin, config("config-b", replacementServiceId));
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET config_fingerprint='config-b',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    // Ordinary service-reader authority is revoked and the service is absent from active config.
    await access.putGrant({tenantId}, {principalId: workerId, scopeId: sourceScope, active: false});

    let pauseFirst = true;
    const store = createCaptureVerificationMaintenance(db.pool, {schema: db.schema, tenantId, principalId: managerId,
      allowedRepositories: [repositoryId], allowedServices: [serviceId], batchSize: 1,
      preflightAuthorize: async context => context.capability === "capture.verify.manage",
      authorizeCancel: async (client, binding) => {
        const result = await authorizeCancel(client, binding);
        if (pauseFirst) {
          pauseFirst = false;
          held.enter();
          await held.waiting;
        }
        return result;
      }});
    cancellation = store.cancelSuperseded();
    await held.started;

    const managerUpdate = await db.pool.connect();
    try {
      await expectLockTimeout(managerUpdate, () => managerUpdate.query(`UPDATE ${schema}.trusted_capture_manager_scope
        SET allowed=false WHERE tenant_id=$1 AND principal_id=$2 AND repository_id=$3 AND service_id=$4`,
      [tenantId, managerId, repositoryId, serviceId]));
    } finally { await managerUpdate.query("ROLLBACK").catch(() => undefined); managerUpdate.release(); }

    const configUpdate = await db.pool.connect();
    try {
      await expectLockTimeout(configUpdate, () => configUpdate.query(`UPDATE ${schema}.orchestration_active_configurations
        SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]));
    } finally { await configUpdate.query("ROLLBACK").catch(() => undefined); configUpdate.release(); }

    held.release();
    await expect(cancellation).resolves.toEqual({cancelledCount: 1, coverage: "partial", batchLimited: true});
    const states = await db.pool.query<{job_id: string; state: string; lease_worker_id: string | null;
      lease_instance_id: string | null; lease_token_hash: string | null; lease_expires_at: Date | null;
      terminal_reason: string | null}>(`SELECT job_id,state,lease_worker_id,lease_instance_id,lease_token_hash,
        lease_expires_at,terminal_reason FROM ${schema}.orchestration_capture_verification_job_state
        WHERE tenant_id=$1 ORDER BY job_id`, [tenantId]);
    expect(states.rows).toHaveLength(2);
    expect(states.rows.filter(row => row.state === "cancelled")).toHaveLength(1);
    expect(states.rows.find(row => row.state === "cancelled")).toMatchObject({lease_worker_id: null,
      lease_instance_id: null, lease_token_hash: null, lease_expires_at: null,
      terminal_reason: "CAPTURE_CONFIG_SUPERSEDED"});
    expect(states.rows.find(row => row.state === "queued")).toMatchObject({terminal_reason: null});
    expect(JSON.stringify(await cancellation)).not.toContain(oldJobs[0]!.jobId);
    expect(JSON.stringify(await cancellation)).not.toContain(oldJobs[1]!.jobId);

    // Both rows became writable after commit; only the manager grant now controls further cleanup.
    await db.pool.query(`UPDATE ${schema}.trusted_capture_manager_scope SET allowed=false
      WHERE tenant_id=$1 AND principal_id=$2 AND repository_id=$3 AND service_id=$4`,
    [tenantId, managerId, repositoryId, serviceId]);
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await expect(store.cancelSuperseded()).resolves.toMatchObject({cancelledCount: 0});
    const remaining = await db.pool.query<{state: string}>(`SELECT state
      FROM ${schema}.orchestration_capture_verification_job_state WHERE tenant_id=$1 AND state='queued'`, [tenantId]);
    expect(remaining.rows).toEqual([{state: "queued"}]);
  } finally {
    held.release();
    await cancellation?.catch(() => undefined);
    await db.cleanup();
  }
});
