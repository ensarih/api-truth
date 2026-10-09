import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {expect, test} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCaptureVerificationLeaseStore, type CaptureVerificationLeaseOptions}
  from "../../packages/orchestration/src/capture-verification-leases.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "lease-race-tenant", principalId = "lease-race-worker";
const sourceScope = "lease-race-source", environmentScope = "lease-race-environment";
const repositoryId = "lease-race-repository", serviceId = "lease-race-service", environment = "uat";
const scope = {tenantId, repositoryId, serviceId, environment, immutableRevision: "a".repeat(40),
  sourceDigest: `sha256:${"b".repeat(64)}`};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const config = (fingerprint: string) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/lease-race",
    access_scope_id: sourceScope, services: [{service_id: serviceId, root: "services/api",
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: environment, intended_branch: "main",
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
  const admin = {tenantId, principalId: "lease-race-admin", capabilities: ["configuration.admin"]};
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

async function admit(db: CatalogTestDatabase, name: string) {
  const artifactRef = `capture:${name}`, configuredKeyRef = "key:lease-race";
  const receiptDigest = hash(`receipt:${name}`), signerSpkiDigest = hash("lease-race-signer");
  const captureIdentityDigest = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest}));
  const schema = quoteCatalogTestSchema(db.schema);
  await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, captureIdentityDigest, repositoryId, serviceId, scope.immutableRevision, scope.sourceDigest,
    environment, artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  const admission = createCaptureVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId, principalId,
    preflightAuthorize: async () => true,
    authorizeCapture: async (client, binding) => {
      const result = await client.query<{source_allowed: boolean; environment_allowed: boolean; capture_allowed: boolean}>(
        `SELECT source_allowed,environment_allowed,capture_allowed FROM trusted_capture_execute
         WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND config_document_sha256=$4
           AND config_checkpoint_version=$5 FOR SHARE`,
        [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
          binding.checkpointVersion]);
      return result.rows.length === 1 && result.rows[0]!.source_allowed
        && result.rows[0]!.environment_allowed && result.rows[0]!.capture_allowed;
    }});
  return admission.admit({captureIdentityDigest});
}

type Authorizer = CaptureVerificationLeaseOptions["authorizeCapture"];
function leaseStore(db: CatalogTestDatabase, workerId: string, authorizeCapture?: Authorizer) {
  const authorize: Authorizer = authorizeCapture ?? (async (client, binding) => {
    const result = await client.query<{source_allowed: boolean; environment_allowed: boolean; capture_allowed: boolean}>(
      `SELECT source_allowed,environment_allowed,capture_allowed FROM trusted_capture_execute
       WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND config_document_sha256=$4
         AND config_checkpoint_version=$5 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
        binding.checkpointVersion]);
    return result.rows.length === 1 && result.rows[0]!.source_allowed
      && result.rows[0]!.environment_allowed && result.rows[0]!.capture_allowed;
  });
  return createCaptureVerificationLeaseStore(db.pool, {schema: db.schema, tenantId, principalId, workerId,
    instanceId: "lease-race-instance", allowedRepositories: [repositoryId], allowedServices: [serviceId],
    preflightAuthorize: async () => true, authorizeCapture: authorize});
}

async function expectLockWait(client: PoolClient, run: () => Promise<unknown>) {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout='250ms'");
  await expect(run()).rejects.toMatchObject({code: "55P03"});
  await client.query("ROLLBACK");
}

test("heartbeat holds permission and active-config locks through commit", async () => {
  const {db, schema, access} = await setup();
  let releaseAuthorization!: () => void;
  let signalAuthorization!: () => void;
  const authorizationGate = new Promise<void>(resolve => { releaseAuthorization = resolve; });
  const authorizationStarted = new Promise<void>(resolve => { signalAuthorization = resolve; });
  let heartbeat: ReturnType<ReturnType<typeof leaseStore>["heartbeat"]> | undefined;
  try {
    const admitted = await admit(db, "lock-window");
    const claimant = leaseStore(db, "claim-worker");
    const lease = await claimant.claimOne();
    if (lease.kind !== "leased" || lease.jobId !== admitted.jobId) throw Error("expected admitted job lease");
    let pauseFirstAuthorization = true;
    const worker = leaseStore(db, "claim-worker", async (client, binding) => {
      const policy = await client.query<{capture_allowed: boolean}>(`SELECT capture_allowed FROM trusted_capture_execute
        WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND config_checkpoint_version=$4 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint, binding.checkpointVersion]);
      if (pauseFirstAuthorization) {
        pauseFirstAuthorization = false;
        signalAuthorization();
        await authorizationGate;
      }
      return policy.rows.length === 1 && policy.rows[0]!.capture_allowed;
    });
    heartbeat = worker.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken});
    await authorizationStarted;

    const contender = await db.pool.connect();
    try {
      await expectLockWait(contender, () => contender.query(`UPDATE ${schema}.principal_scope_grants
        SET active=false WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=$3`,
      [tenantId, principalId, sourceScope]));
    } finally { contender.release(); }
    const configContender = await db.pool.connect();
    try {
      await expectLockWait(configContender, () => configContender.query(`UPDATE ${schema}.orchestration_active_configurations
        SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]));
    } finally { configContender.release(); }

    releaseAuthorization();
    await expect(heartbeat).resolves.toMatchObject({kind: "leased", jobId: lease.jobId,
      leaseToken: lease.leaseToken, checkpointVersion: "1"});
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: false});
    await expect(worker.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: true});
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await expect(worker.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken}))
      .rejects.toMatchObject({code: "CAPTURE_LEASE_UNAUTHORIZED"});
  } finally {
    releaseAuthorization();
    await heartbeat?.catch(() => undefined);
    await db.cleanup();
  }
});

test("heartbeat that crosses lease expiry during host authorization cannot renew", async () => {
  const {db, schema} = await setup();
  let releaseAuthorization!: () => void;
  let signalAuthorization!: () => void;
  const authorizationGate = new Promise<void>(resolve => { releaseAuthorization = resolve; });
  const authorizationStarted = new Promise<void>(resolve => { signalAuthorization = resolve; });
  let heartbeat: ReturnType<ReturnType<typeof leaseStore>["heartbeat"]> | undefined;
  try {
    const admitted = await admit(db, "expiry-window");
    const claimant = leaseStore(db, "claim-worker");
    const lease = await claimant.claimOne();
    if (lease.kind !== "leased" || lease.jobId !== admitted.jobId) throw Error("expected admitted job lease");
    let pauseFirstAuthorization = true;
    const worker = leaseStore(db, "claim-worker", async (client, binding) => {
      const policy = await client.query<{capture_allowed: boolean}>(`SELECT capture_allowed FROM trusted_capture_execute
        WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND config_checkpoint_version=$4 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint, binding.checkpointVersion]);
      if (pauseFirstAuthorization) {
        pauseFirstAuthorization = false;
        signalAuthorization();
        await authorizationGate;
      }
      return policy.rows.length === 1 && policy.rows[0]!.capture_allowed;
    });
    heartbeat = worker.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken});
    await authorizationStarted;
    // Move the database lease deadline past now while heartbeat is suspended before its row lock.
    await db.pool.query(`UPDATE ${schema}.orchestration_capture_verification_job_state
      SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE tenant_id=$1 AND job_id=$2`,
    [tenantId, lease.jobId]);
    releaseAuthorization();
    await expect(heartbeat).rejects.toMatchObject({code: "CAPTURE_LEASE_CONFLICT"});
    const state = await db.pool.query<{lease_expired: boolean}>(`SELECT lease_expires_at<=clock_timestamp() AS lease_expired
      FROM ${schema}.orchestration_capture_verification_job_state WHERE tenant_id=$1 AND job_id=$2`,
    [tenantId, lease.jobId]);
    expect(state.rows).toEqual([{lease_expired: true}]);
  } finally {
    releaseAuthorization();
    await heartbeat?.catch(() => undefined);
    await db.cleanup();
  }
});
