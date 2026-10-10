import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import type {PoolClient} from "pg";
import {expect, test, vi} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrationManifest} from "../../packages/orchestration/src/migrations.js";
import {createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createLoadedDocumentVerificationAdmissionStore} from "../../packages/orchestration/src/loaded-document-verification-admission.js";
import {createLoadedDocumentVerificationLeaseStore} from "../../packages/orchestration/src/loaded-document-verification-leases.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "loaded-lease-tenant", principalId = "loaded-lease-worker";
const sourceScope = "source-read", environmentScope = "environment-read";
const repositoryId = "repository", environment = "uat";
const serviceIds = ["service", "service-two", "service-three"] as const;
const serviceRoot = (serviceId: string) => serviceId === "service" ? "services/api" : `services/${serviceId}`;
const revision = "a".repeat(40), sourceDigest = `sha256:${"b".repeat(64)}`;
const load = {artifactRef: "capture:loaded-envelope", configuredKeyRef: "key:loaded-signer",
  envelopeDigest: `sha256:${"c".repeat(64)}`, signerSpkiDigest: `sha256:${"d".repeat(64)}`};
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const admin = {tenantId, principalId: "configuration-admin", capabilities: ["configuration.admin"]};
const scope = (serviceId: string, env = environment) => ({tenantId, repositoryId, serviceId, environment: env,
  immutableRevision: revision, sourceDigest});
const config = (fingerprint: string) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/repository",
    access_scope_id: sourceScope, services: serviceIds.map(service_id => ({service_id, root: serviceRoot(service_id),
      analyzer: {adapter_id: "openapi_document", adapter_version: "0.2.0"}, intended_branches: ["main"],
      environments: [environment, "production"].map(name => ({name, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScope}}))}))}],
  inference: {enabled: false}, logs: {enabled: false}}});

const BASE_MIGRATIONS = ["0001_orchestration_core", "0002_ordered_scheduling", "0003_durable_workers",
  "0004_atomic_execution", "0005_revision_target_uniqueness", "0006_observed_capture_associations",
  "0007_observed_capture_verifications", "0008_capture_verification_admissions", "0009_capture_verification_leases",
  "0010_capture_verification_results", "0011_capture_verification_cancellation", "0012_revision_resolution_inputs",
  "0013_loaded_document_verifications", "0014_loaded_document_verification_jobs"];
async function applyBase(db: CatalogTestDatabase) {
  const manifest = await Promise.all(BASE_MIGRATIONS.map(async version => ({version,
    sql: await readFile(new URL(`../../packages/orchestration/migrations/${version}.sql`, import.meta.url), "utf8")})));
  await applyOrchestrationMigrationManifest(db.pool, {schema: db.schema}, manifest);
}
async function applyLeaseMigration(db: CatalogTestDatabase) {
  const sql = await readFile(new URL("../../packages/orchestration/migrations/0015_loaded_document_verification_leases.sql", import.meta.url), "utf8");
  await applyOrchestrationMigrationManifest(db.pool, {schema: db.schema}, [{version: "0015_loaded_document_verification_leases", sql}]);
}
async function setup(applyLeases = true) {
  const db = await createCatalogTestDatabase();
  try {
    await applyBase(db);
    const schema = quoteCatalogTestSchema(db.schema);
    const access = createAccessPolicyStore(db.pool, {schema: db.schema});
    for (const scopeId of [sourceScope, environmentScope]) {
      await access.putScope({tenantId}, {scopeId, active: true});
      await access.putGrant({tenantId}, {principalId, scopeId, active: true});
    }
    const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
    const registered = await orchestration.registerConfiguration(admin, config("config-a"));
    await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
    if (applyLeases) await applyLeaseMigration(db);
    await db.pool.query(`CREATE TABLE ${schema}.trusted_loaded_document_execute (
      tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
      config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
      repository_id text NOT NULL,service_id text NOT NULL,environment text NOT NULL,service_root text NOT NULL,
      load_identity_digest text NOT NULL,source_allowed boolean NOT NULL,environment_allowed boolean NOT NULL,
      artifact_allowed boolean NOT NULL,execute_allowed boolean NOT NULL,
      PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version,load_identity_digest))`);
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

async function admit(db: CatalogTestDatabase, serviceId: string, name: string, env = environment, legacy = false) {
  const serviceScope = scope(serviceId, env), root = serviceRoot(serviceId), schema = quoteCatalogTestSchema(db.schema);
  const association = {artifactRef: `capture:${name}`, configuredKeyRef: "key:capture-signer",
    receiptDigest: hash(`receipt:${name}`), signerSpkiDigest: hash("capture signer")};
  const captureIdentityDigest = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope: serviceScope,
    artifactRef: association.artifactRef, configuredKeyRef: association.configuredKeyRef,
    receiptDigest: association.receiptDigest, signerSpkiDigest: association.signerSpkiDigest}));
  await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, captureIdentityDigest, repositoryId, serviceId, revision, sourceDigest, env,
    association.artifactRef, association.configuredKeyRef, association.receiptDigest, association.signerSpkiDigest]);
  await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_verifications
    (tenant_id,capture_identity_digest,verifier_profile_version,service_root,source_digest,receipt_digest,
     signer_spki_digest,result_digest,handler_count)
    VALUES($1,$2,'protected-handler-bytes-1',$3,$4,$5,$6,$7,1)`,
  [tenantId, captureIdentityDigest, root, sourceDigest, association.receiptDigest,
    association.signerSpkiDigest, hash(`handler result:${name}`)]);
  const binding = {scope: serviceScope, captureIdentityDigest, serviceRoot: root,
    loadArtifactRef: load.artifactRef, loadConfiguredKeyRef: load.configuredKeyRef,
    loadEnvelopeDigest: load.envelopeDigest, loadSignerSpkiDigest: load.signerSpkiDigest};
  const admission = createLoadedDocumentVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId, principalId,
    bindings: [binding], preflightAuthorize: async () => true,
    authorizeLoadedDocument: async (client: PoolClient, auth: {configFingerprint: string; configDocumentSha256: string;
      checkpointVersion: string; loadIdentityDigest: string; captureIdentityDigest: string}) => {
      const row = await client.query(`SELECT 1 FROM trusted_loaded_document_policy WHERE tenant_id=$1 AND principal_id=$2
        AND config_fingerprint=$3 AND config_document_sha256=$4 AND config_checkpoint_version=$5
        AND capture_identity_digest=$6 AND artifact_ref=$7 AND configured_key_ref=$8 AND envelope_digest=$9
        AND signer_spki_digest=$10 AND opt_in AND source_allowed AND environment_allowed AND artifact_allowed FOR SHARE`,
      [tenantId, principalId, auth.configFingerprint, auth.configDocumentSha256, auth.checkpointVersion,
        captureIdentityDigest, load.artifactRef, load.configuredKeyRef, load.envelopeDigest, load.signerSpkiDigest]);
      return row.rows.length === 1;
    }});
  // Policy is inserted after the active configuration was created; every lease check re-locks this row.
  const configRow = await db.pool.query<{document_sha256: string}>(`SELECT document_sha256 FROM ${schema}.orchestration_configurations
    WHERE tenant_id=$1 AND config_fingerprint='config-a'`, [tenantId]);
  await db.pool.query(`INSERT INTO ${schema}.trusted_loaded_document_policy
    (tenant_id,principal_id,config_fingerprint,config_document_sha256,config_checkpoint_version,
     repository_id,service_id,environment,service_root,capture_identity_digest,artifact_ref,configured_key_ref,
     envelope_digest,signer_spki_digest,opt_in,source_allowed,environment_allowed,artifact_allowed)
    VALUES($1,$2,'config-a',$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,true,true,true)`,
  [tenantId, principalId, configRow.rows[0]!.document_sha256, repositoryId, serviceId, env,
    serviceRoot(serviceId),
    captureIdentityDigest, load.artifactRef, load.configuredKeyRef, load.envelopeDigest, load.signerSpkiDigest]);
  let receipt;
  if (legacy) {
    const configRow = await db.pool.query<{document_sha256: string; checkpoint_version: string}>(`SELECT c.document_sha256,
      a.checkpoint_version::text FROM ${schema}.orchestration_configurations c
      JOIN ${schema}.orchestration_active_configurations a USING(tenant_id,config_fingerprint)
      WHERE c.tenant_id=$1 AND c.config_fingerprint='config-a'`, [tenantId]);
    const configDocumentSha256 = configRow.rows[0]!.document_sha256;
    const checkpointVersion = configRow.rows[0]!.checkpoint_version;
    const loadIdentityDigest = hash(canonicalJsonStringify({profileVersion: "swagger-loaded-document-1",
      scope: serviceScope, captureIdentityDigest, loadArtifactRef: load.artifactRef,
      loadConfiguredKeyRef: load.configuredKeyRef, loadEnvelopeDigest: load.envelopeDigest,
      loadSignerSpkiDigest: load.signerSpkiDigest}));
    const jobId = hash(canonicalJsonStringify({kind: "loaded_document_verification_admission", tenantId,
      loadIdentityDigest, verifierProfileVersion: "swagger-loaded-document-1", serviceRoot: root,
      configFingerprint: "config-a", configDocumentSha256, checkpointVersion}));
    await db.pool.query(`INSERT INTO ${schema}.orchestration_loaded_document_verification_jobs
      (tenant_id,job_id,load_identity_digest,capture_identity_digest,parent_verifier_profile_version,
       verifier_profile_version,repository_id,service_id,environment,immutable_revision,source_digest,service_root,
       load_artifact_ref,load_configured_key_ref,load_envelope_digest,load_signer_spki_digest,config_fingerprint,
       config_document_sha256,config_checkpoint_version,state)
      VALUES($1,$2,$3,$4,'protected-handler-bytes-1','swagger-loaded-document-1',$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,'config-a',$15,$16,'queued')`, [tenantId,jobId,loadIdentityDigest,captureIdentityDigest,
      repositoryId,serviceId,env,revision,sourceDigest,root,load.artifactRef,load.configuredKeyRef,
      load.envelopeDigest,load.signerSpkiDigest,configDocumentSha256,checkpointVersion]);
    receipt = {jobId, loadIdentityDigest, captureIdentityDigest};
  } else {
    receipt = await admission.admit({captureIdentityDigest});
  }
  return {receipt, binding, association};
}
function leaseStore(db: CatalogTestDatabase, workerId: string, allowed: readonly string[] = [...serviceIds],
  preflightAuthorize = async () => true) {
  return createLoadedDocumentVerificationLeaseStore(db.pool, {schema: db.schema, tenantId, principalId,
    workerId, instanceId: "instance-1", allowedRepositories: [repositoryId], allowedServices: allowed,
    preflightAuthorize,
    authorizeLoadedDocument: async (client, binding) => {
      const result = await client.query(`SELECT 1 FROM trusted_loaded_document_execute WHERE tenant_id=$1 AND principal_id=$2
        AND config_fingerprint=$3 AND config_document_sha256=$4 AND config_checkpoint_version=$5
        AND repository_id=$6 AND service_id=$7 AND environment=$8 AND service_root=$9 AND load_identity_digest=$10
        AND source_allowed AND environment_allowed AND artifact_allowed AND execute_allowed FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
        binding.checkpointVersion, binding.repositoryId, binding.serviceId, binding.environment,
        binding.serviceRoot, binding.loadIdentityDigest]);
      return result.rows.length === 1;
    }});
}
async function installExecutePolicy(db: CatalogTestDatabase, admission: Awaited<ReturnType<typeof admit>>, serviceId: string) {
  const auth = leaseStore(db, "policy-reader");
  const binding = admission.binding;
  // Read the active epoch and policy identity from the actual admission result, then bind host opt-in.
  const row = await db.pool.query<{config_fingerprint: string; document_sha256: string; checkpoint_version: string}>(`SELECT
    a.config_fingerprint,a.config_document_sha256 AS document_sha256,a.config_checkpoint_version::text AS checkpoint_version
    FROM ${quoteCatalogTestSchema(db.schema)}.orchestration_loaded_document_verification_jobs a
    WHERE a.tenant_id=$1 AND a.job_id=$2`, [tenantId, admission.receipt.jobId]);
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.trusted_loaded_document_execute VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,true,true,true)`,
  [tenantId, principalId, row.rows[0]!.config_fingerprint, row.rows[0]!.document_sha256,
    row.rows[0]!.checkpoint_version, repositoryId, serviceId, binding.scope.environment, serviceRoot(serviceId),
    admission.receipt.loadIdentityDigest]);
  return auth;
}

test("0015 backfills admission-only jobs, leases once, logs only token hashes and heartbeats", async () => {
  const {db, schema} = await setup(false);
  try {
    const admitted = await admit(db, "service", "one", environment, true);
    const preMigration = await db.pool.query(`SELECT count(*)::text AS count FROM ${schema}.orchestration_loaded_document_verification_job_state`)
      .catch(() => undefined);
    expect(preMigration).toBeUndefined();
    await applyLeaseMigration(db);
    const worker = leaseStore(db, "worker-a");
    await installExecutePolicy(db, admitted, "service");
    const claimed = await worker.claimOne();
    expect(claimed).toMatchObject({kind: "leased", jobId: admitted.receipt.jobId,
      loadIdentityDigest: admitted.receipt.loadIdentityDigest, captureIdentityDigest: admitted.receipt.captureIdentityDigest,
      leaseToken: expect.stringMatching(/^[a-f0-9]{64}$/), attemptCount: 1});
    if (claimed.kind !== "leased") throw Error("expected lease");
    expect(Object.isFrozen(claimed.binding)).toBe(true);
    expect(claimed.binding).toMatchObject({tenantId, principalId, workerId: "worker-a",
      jobId: claimed.jobId, loadIdentityDigest: claimed.loadIdentityDigest,
      captureIdentityDigest: claimed.captureIdentityDigest, environment, repositoryId,
      serviceId: "service", immutableRevision: revision, sourceDigest,
      loadArtifactRef: load.artifactRef, loadEnvelopeDigest: load.envelopeDigest});
    expect(await worker.claimOne()).toMatchObject({kind: "no_work", coverage: "partial"});
    const renewed = await worker.heartbeat({jobId: claimed.jobId, leaseToken: claimed.leaseToken});
    expect(renewed).toMatchObject({jobId: claimed.jobId, leaseToken: claimed.leaseToken, attemptCount: 1});
    const expiry = await db.pool.query<{remaining: number}>(`SELECT extract(epoch FROM lease_expires_at-clock_timestamp()) AS remaining
      FROM ${schema}.orchestration_loaded_document_verification_job_state WHERE tenant_id=$1 AND job_id=$2`,
    [tenantId, claimed.jobId]);
    expect(Number(expiry.rows[0]?.remaining)).toBeGreaterThan(115);
    expect(Number(expiry.rows[0]?.remaining)).toBeLessThanOrEqual(120);
    const states = await db.pool.query<{state: string; attempt_count: number; lease_token_hash: string}>(`SELECT state,attempt_count,lease_token_hash
      FROM ${schema}.orchestration_loaded_document_verification_job_state WHERE tenant_id=$1`, [tenantId]);
    expect(states.rows).toMatchObject([{state: "leased", attempt_count: 1, lease_token_hash: expect.stringMatching(/^sha256:/)}]);
    expect(JSON.stringify(states.rows)).not.toContain(claimed.leaseToken);
    const attempts = await db.pool.query<{attempt_no: number}>(`SELECT attempt_no
      FROM ${schema}.orchestration_loaded_document_verification_lease_attempts WHERE tenant_id=$1`, [tenantId]);
    expect(attempts.rows).toEqual([{attempt_no: 1}]);
    expect(JSON.stringify(attempts.rows)).not.toContain(claimed.leaseToken);
    const sideEffects = await db.pool.query<{summaries: string; snapshots: string; pointers: string}>(`SELECT
      (SELECT count(*)::text FROM ${schema}.orchestration_observed_loaded_document_verifications) AS summaries,
      (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
      (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS pointers`);
    expect(sideEffects.rows).toEqual([{summaries: "0", snapshots: "0", pointers: "0"}]);
  } finally {await db.cleanup();}
});

test("lease capacity is independent across environments for one service", async () => {
  const {db, schema} = await setup();
  try {
    const first = await admit(db, "service", "first"), sameService = await admit(db, "service", "same-service"),
      otherEnvironment = await admit(db, "service", "other-environment", "production");
    for (const row of [first, sameService, otherEnvironment]) {
      const serviceId = row.binding.scope.serviceId;
      await installExecutePolicy(db, row, serviceId);
    }
    const worker = leaseStore(db, "worker-a");
    const firstClaim = await worker.claimOne();
    expect(firstClaim.kind).toBe("leased");
    const secondClaim = await leaseStore(db, "worker-b").claimOne();
    expect(secondClaim.kind).toBe("leased");
    const state = await db.pool.query<{service_id: string; environment: string; state: string}>(`SELECT job.service_id,job.environment,state.state
      FROM ${schema}.orchestration_loaded_document_verification_job_state state
      JOIN ${schema}.orchestration_loaded_document_verification_jobs job USING(tenant_id,job_id)
      WHERE state.state='leased' ORDER BY job.service_id`);
    expect(state.rows).toHaveLength(2);
    expect(state.rows.filter(row => row.service_id === "service")).toHaveLength(2);
    expect(state.rows.map(row => row.environment).sort()).toEqual(["production", "uat"]);
  } finally {await db.cleanup();}
});

test("tenant capacity limits active leases to two across services", async () => {
  const {db, schema} = await setup();
  try {
    const rows = await Promise.all(serviceIds.map((serviceId, index) => admit(db, serviceId, `tenant-${index}`)));
    for (const row of rows) await installExecutePolicy(db, row, row.binding.scope.serviceId);
    const claims = await Promise.all(rows.map((_, index) => leaseStore(db, `tenant-worker-${index}`).claimOne()));
    expect(claims.filter(item => item.kind === "leased")).toHaveLength(2);
    expect(claims.filter(item => item.kind === "no_work")).toHaveLength(1);
    const state = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count
      FROM ${schema}.orchestration_loaded_document_verification_job_state WHERE state='leased'`);
    expect(state.rows[0]?.count).toBe("2");
  } finally {await db.cleanup();}
});

test("wrong token/worker and expired reclaimed tokens fail; attempts exhaust with a fixed terminal code", async () => {
  const {db, schema} = await setup();
  try {
    const admitted = await admit(db, "service", "expiry");
    const owner = leaseStore(db, "worker-a"); await installExecutePolicy(db, admitted, "service");
    const first = await owner.claimOne(); if (first.kind !== "leased") throw Error("expected initial lease");
    await expect(leaseStore(db, "worker-b").heartbeat({jobId: first.jobId, leaseToken: first.leaseToken}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_LEASE_CONFLICT"});
    await expect(owner.heartbeat({jobId: first.jobId, leaseToken: "f".repeat(64)}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_LEASE_CONFLICT"});
    for (const attempt of [2, 3]) {
      await db.pool.query(`UPDATE ${schema}.orchestration_loaded_document_verification_job_state
        SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2`, [tenantId, first.jobId]);
      const reclaimed = await owner.claimOne();
      expect(reclaimed).toMatchObject({kind: "leased", attemptCount: attempt});
      if (reclaimed.kind !== "leased") throw Error("expected reclaimed lease");
      expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
      await expect(owner.heartbeat({jobId: first.jobId, leaseToken: first.leaseToken}))
        .rejects.toMatchObject({code: "LOADED_DOCUMENT_LEASE_CONFLICT"});
    }
    await db.pool.query(`UPDATE ${schema}.orchestration_loaded_document_verification_job_state
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2`, [tenantId, first.jobId]);
    expect(await owner.claimOne()).toMatchObject({kind: "no_work", coverage: "partial"});
    const terminal = await db.pool.query<{state: string; safe_error_code: string | null}>(`SELECT state,safe_error_code
      FROM ${schema}.orchestration_loaded_document_verification_job_state WHERE tenant_id=$1 AND job_id=$2`,
    [tenantId, first.jobId]);
    expect(terminal.rows).toEqual([{state: "failed", safe_error_code: "LOADED_DOCUMENT_LEASE_EXHAUSTED"}]);
    const attempts = await db.pool.query<{attempt_no: number}>(`SELECT attempt_no FROM
      ${schema}.orchestration_loaded_document_verification_lease_attempts WHERE tenant_id=$1 ORDER BY attempt_no`, [tenantId]);
    expect(attempts.rows).toEqual([{attempt_no: 1}, {attempt_no: 2}, {attempt_no: 3}]);
  } finally {await db.cleanup();}
});

test("current config, reader grants and independent artifact authorization fence claim and heartbeat", async () => {
  const {db, schema, access, orchestration} = await setup();
  try {
    const admitted = await admit(db, "service", "fenced");
    await installExecutePolicy(db, admitted, "service");
    const worker = leaseStore(db, "worker-a");
    const lease = await worker.claimOne(); if (lease.kind !== "leased") throw Error("expected lease");
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: false});
    await expect(worker.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_LEASE_UNAUTHORIZED"});
    await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: true});
    await db.pool.query(`UPDATE ${schema}.trusted_loaded_document_execute SET artifact_allowed=false`);
    await expect(worker.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_LEASE_UNAUTHORIZED"});
    await db.pool.query(`UPDATE ${schema}.trusted_loaded_document_execute SET artifact_allowed=true`);
    await orchestration.registerConfiguration(admin, config("config-b"));
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET config_fingerprint='config-b',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
    await expect(worker.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_LEASE_UNAUTHORIZED"});
    expect(await worker.claimOne()).toMatchObject({kind: "no_work", coverage: "partial"});
  } finally {await db.cleanup();}
});

test("preflight denial and bad lease arguments avoid storage; lease attempt history is immutable", async () => {
  const {db, schema} = await setup();
  try {
    const admitted = await admit(db, "service", "hostile");
    await installExecutePolicy(db, admitted, "service");
    const connect = vi.spyOn(db.pool, "connect");
    const denied = leaseStore(db, "worker-denied", undefined, async () => false);
    await expect(denied.claimOne()).rejects.toMatchObject({code: "LOADED_DOCUMENT_LEASE_UNAUTHORIZED"});
    expect(connect).not.toHaveBeenCalled(); connect.mockRestore();
    const restricted = leaseStore(db, "worker-restricted", ["not-configured"]);
    expect(await restricted.claimOne()).toMatchObject({kind: "no_work", coverage: "partial"});
    const worker = leaseStore(db, "worker-a");
    const hostile = new Proxy({jobId: admitted.receipt.jobId, leaseToken: "a".repeat(64)}, {
      getOwnPropertyDescriptor: () => {throw Error("private proxy canary");},
    });
    await expect(worker.heartbeat(hostile)).rejects.toMatchObject({code: "INVALID_LOADED_DOCUMENT_LEASE_REQUEST"});
    const lease = await worker.claimOne(); if (lease.kind !== "leased") throw Error("expected lease");
    await expect(db.pool.query(`UPDATE ${schema}.orchestration_loaded_document_verification_lease_attempts
      SET attempt_no=2 WHERE tenant_id=$1`, [tenantId])).rejects.toThrow();
    expect(JSON.stringify(await db.pool.query(`SELECT * FROM ${schema}.orchestration_loaded_document_verification_lease_attempts`)))
      .not.toContain(lease.leaseToken);
  } finally {await db.cleanup();}
});
