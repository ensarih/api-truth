import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test, vi} from "vitest";
import type {PoolClient} from "pg";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createLoadedDocumentVerificationAdmissionStore} from "../../packages/orchestration/src/loaded-document-verification-admission.js";
import {createLoadedDocumentVerificationLeaseStore} from "../../packages/orchestration/src/loaded-document-verification-leases.js";
import {createLoadedDocumentVerificationMaintenance} from "../../packages/orchestration/src/loaded-document-verification-maintenance.js";
import {createLoadedDocumentVerificationRunner} from "../../packages/orchestration/src/loaded-document-verification-runner.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";
import {createLoadedDocumentProofFixture, loadedDocumentServiceRoot} from "./support/loaded-document-proof-fixture.js";

const tenantId = "loaded-cancel-tenant", principalId = "worker", managerId = "manager";
const repositoryId = "repository", serviceId = "service", environment = "test";
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const config = (fingerprint: string, removed = false) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [{access_scope_id: "source", label: "source"}, {access_scope_id: "env", label: "env"}],
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/repository", access_scope_id: "source",
    services: [{service_id: removed ? "replacement" : serviceId, root: loadedDocumentServiceRoot,
      analyzer: {adapter_id: "openapi_document", adapter_version: "0.2.0"}, intended_branches: ["main"],
      environments: [{name: environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: "env"}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});
async function setup(maxQueuedPerTenant = 1, managerDecision?: (client: PoolClient,
  binding: {tenantId: string;principalId: string;repositoryId: string;serviceId: string}) => Promise<boolean>) {
  const db = await createCatalogTestDatabase();
  const repoPath = await mkdtemp(join(tmpdir(), "loaded-document-maintenance-"));
  const cleanup = async () => {try {await db.cleanup();} finally {await rm(repoPath, {recursive: true, force: true});}};
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const schema = quoteCatalogTestSchema(db.schema);
    const access = createAccessPolicyStore(db.pool, {schema: db.schema});
    for (const scopeId of ["source", "env"]) {
      await access.putScope({tenantId}, {scopeId, active: true});
      await access.putGrant({tenantId}, {principalId, scopeId, active: true});
    }
    const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
    await orchestration.registerConfiguration(admin, config("a"));
    await orchestration.activateInitialConfiguration(admin, {fingerprint: "a"});
    const fixture = await createLoadedDocumentProofFixture(db.pool, db.schema,
      {tenantId, repositoryId, serviceId, environment, immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`},
      repoPath, async () => true);
    const admission = createLoadedDocumentVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId, principalId,
      maxQueuedPerTenant, bindings: [{scope: fixture.scope, captureIdentityDigest: fixture.association.captureIdentityDigest,
        serviceRoot: loadedDocumentServiceRoot, ...fixture.loadBinding}], preflightAuthorize: async () => true,
      authorizeLoadedDocument: async () => true});
    const admitted = await admission.admit({captureIdentityDigest: fixture.association.captureIdentityDigest});
    await db.pool.query(`CREATE TABLE ${schema}.loaded_manager_grants (
      tenant_id text,principal_id text,repository_id text,service_id text,allowed boolean,
      PRIMARY KEY(tenant_id,principal_id,repository_id,service_id))`);
    await db.pool.query(`INSERT INTO ${schema}.loaded_manager_grants VALUES ($1,$2,$3,$4,true)`,
      [tenantId, managerId, repositoryId, serviceId]);
    const authorizeCancel = async (client: PoolClient, binding: {tenantId: string;principalId: string;repositoryId: string;serviceId: string}) => {
      const rows = await client.query(`SELECT allowed FROM loaded_manager_grants WHERE tenant_id=$1 AND principal_id=$2
        AND repository_id=$3 AND service_id=$4 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.repositoryId, binding.serviceId]);
      return rows.rows.length === 1 && rows.rows[0].allowed === true;
    };
    const maintenance = () => createLoadedDocumentVerificationMaintenance(db.pool, {schema: db.schema, tenantId,
      principalId: managerId, allowedRepositories: [repositoryId], allowedServices: [serviceId],
      batchSize: 1, preflightAuthorize: async () => true, authorizeCancel: managerDecision ?? authorizeCancel});
    const activate = async (fingerprint: string, removed = false) => {
      await orchestration.registerConfiguration(admin, config(fingerprint, removed));
      await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
        SET config_fingerprint=$2,checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId, fingerprint]);
    };
    return {db, schema, fixture, admission, admitted, maintenance, activate, cleanup};
  } catch (error) {await cleanup(); throw error;}
}

test("superseded live load lease cancels and releases active quota without changing historical evidence", async () => {
  const context = await setup();
  try {
    const leases = createLoadedDocumentVerificationLeaseStore(context.db.pool, {schema: context.db.schema,
      tenantId, principalId, workerId: "worker", instanceId: "instance", allowedRepositories: [repositoryId],
      allowedServices: [serviceId], preflightAuthorize: async () => true, authorizeLoadedDocument: async () => true});
    const claim = await leases.claimOne(); expect(claim.kind).toBe("leased");
    expect(await context.maintenance().cancelSuperseded()).toEqual({cancelledCount: 0, coverage: "partial", batchLimited: false});
    await context.activate("b");
    expect(await context.maintenance().cancelSuperseded()).toEqual({cancelledCount: 1, coverage: "partial", batchLimited: false});
    expect((await context.db.pool.query(`SELECT state,lease_token_hash,terminal_reason FROM
      ${context.schema}.orchestration_loaded_document_verification_job_state`)).rows)
      .toEqual([{state: "cancelled", lease_token_hash: null, terminal_reason: "LOADED_DOCUMENT_CONFIG_SUPERSEDED"}]);
    if (claim.kind === "leased") await expect(leases.heartbeat({jobId: claim.jobId, leaseToken: claim.leaseToken})).rejects.toBeDefined();
    await context.activate("a");
    const newIntent = await context.admission.admit({captureIdentityDigest: context.fixture.association.captureIdentityDigest});
    expect(newIntent.jobId).not.toBe(context.admitted.jobId);
    expect((await context.db.pool.query(`SELECT count(*)::int AS count FROM ${context.schema}.orchestration_observed_capture_verifications`)).rows)
      .toEqual([{count: 1}]);
    expect((await context.db.pool.query(`SELECT count(*)::int AS count FROM ${context.schema}.catalog_snapshots`)).rows)
      .toEqual([{count: 0}]);
  } finally {await context.cleanup();}
});

test("removed service needs its old manager grant and cancellation never exposes artifact references", async () => {
  const context = await setup();
  try {
    await context.activate("removed", true);
    await context.db.pool.query(`UPDATE ${context.schema}.loaded_manager_grants SET allowed=false`);
    expect((await context.maintenance().cancelSuperseded()).cancelledCount).toBe(0);
    await context.db.pool.query(`UPDATE ${context.schema}.loaded_manager_grants SET allowed=true`);
    const result = await context.maintenance().cancelSuperseded();
    expect(result).toEqual({cancelledCount: 1, coverage: "partial", batchLimited: false});
    expect(JSON.stringify(result)).not.toContain("capture:"); expect(JSON.stringify(result)).not.toContain("key:");
  } finally {await context.cleanup();}
});

test("supersession maintenance leaves a completed verification and its summary immutable", async () => {
  const context = await setup();
  try {
    await context.db.pool.query(`CREATE TABLE ${context.schema}.loaded_execute_grants (
      tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
      config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
      repository_id text NOT NULL,service_id text NOT NULL,environment text NOT NULL,service_root text NOT NULL,
      load_identity_digest text NOT NULL,allowed boolean NOT NULL)`);
    const job = await context.db.pool.query<{load_identity_digest: string; config_document_sha256: string}>(`SELECT
      load_identity_digest,config_document_sha256 FROM ${context.schema}.orchestration_loaded_document_verification_jobs
      WHERE tenant_id=$1 AND job_id=$2`, [tenantId, context.admitted.jobId]);
    await context.db.pool.query(`INSERT INTO ${context.schema}.loaded_execute_grants VALUES
      ($1,$2,'a',$3,1,$4,$5,$6,$7,$8,true)`, [tenantId, principalId, job.rows[0]!.config_document_sha256,
      repositoryId, serviceId, environment, loadedDocumentServiceRoot, job.rows[0]!.load_identity_digest]);
    const runner = createLoadedDocumentVerificationRunner(context.db.pool, {schema: context.db.schema, tenantId,
      principalId, workerId: "worker", instanceId: "instance", allowedRepositories: [repositoryId],
      allowedServices: [serviceId], heartbeatIntervalMs: 10_000,
      preflightAuthorize: async () => true,
      authorizeLoadedDocument: async (client, binding) => {
        const result = await client.query(`SELECT allowed FROM loaded_execute_grants WHERE tenant_id=$1 AND principal_id=$2
          AND config_fingerprint=$3 AND config_document_sha256=$4 AND config_checkpoint_version=$5 AND repository_id=$6
          AND service_id=$7 AND environment=$8 AND service_root=$9 AND load_identity_digest=$10 AND allowed FOR SHARE`,
        [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
          binding.checkpointVersion, binding.repositoryId, binding.serviceId, binding.environment, binding.serviceRoot,
          binding.loadIdentityDigest]);
        return result.rows.length === 1;
      }, verificationPortFactory: async () => context.fixture.loadedPort});
    expect(await runner.runOne()).toMatchObject({kind: "succeeded"});
    const resultsBefore = await context.db.pool.query(`SELECT * FROM
      ${context.schema}.orchestration_loaded_document_verification_results ORDER BY tenant_id,job_id`);
    const summariesBefore = await context.db.pool.query(`SELECT * FROM
      ${context.schema}.orchestration_observed_loaded_document_verifications ORDER BY tenant_id,load_identity_digest`);
    expect(resultsBefore.rows).toHaveLength(1);
    expect(summariesBefore.rows).toHaveLength(1);

    await context.activate("b");
    expect(await context.maintenance().cancelSuperseded())
      .toEqual({cancelledCount: 0, coverage: "partial", batchLimited: false});
    expect((await context.db.pool.query(`SELECT state FROM
      ${context.schema}.orchestration_loaded_document_verification_job_state`)).rows)
      .toEqual([{state: "succeeded"}]);
    expect((await context.db.pool.query(`SELECT * FROM
      ${context.schema}.orchestration_loaded_document_verification_results ORDER BY tenant_id,job_id`)).rows)
      .toEqual(resultsBefore.rows);
    expect((await context.db.pool.query(`SELECT * FROM
      ${context.schema}.orchestration_observed_loaded_document_verifications ORDER BY tenant_id,load_identity_digest`)).rows)
      .toEqual(summariesBefore.rows);
  } finally {await context.cleanup();}
});

test("switching away and back still cancels jobs from the earlier checkpoint epoch", async () => {
  const context = await setup(2);
  try {
    await context.activate("b");
    const later = await context.admission.admit({captureIdentityDigest: context.fixture.association.captureIdentityDigest});
    expect(later.jobId).not.toBe(context.admitted.jobId);
    await context.activate("a");
    const firstBatch = await context.maintenance().cancelSuperseded();
    expect(firstBatch).toEqual({cancelledCount: 1, coverage: "partial", batchLimited: true});
    const secondBatch = await context.maintenance().cancelSuperseded();
    expect(secondBatch).toEqual({cancelledCount: 1, coverage: "partial", batchLimited: false});
    const rows = await context.db.pool.query(`SELECT job_id,config_fingerprint,config_checkpoint_version::text,
      lifecycle.state AS lifecycle_state
      FROM ${context.schema}.orchestration_loaded_document_verification_jobs job JOIN
        ${context.schema}.orchestration_loaded_document_verification_job_state lifecycle USING(tenant_id,job_id)
      ORDER BY job_id`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every(row => row.lifecycle_state === "cancelled")).toBe(true);
    expect(rows.rows.map(row => row.config_checkpoint_version).sort()).toEqual(["1", "2"]);
  } finally {await context.cleanup();}
});

test("a denied first candidate consumes only one slot in the declared batch window", async () => {
  const authorizeCancel = vi.fn(async () => false);
  const context = await setup(2, authorizeCancel);
  try {
    await context.activate("b");
    await context.admission.admit({captureIdentityDigest: context.fixture.association.captureIdentityDigest});
    await context.activate("c");
    const result = await context.maintenance().cancelSuperseded();
    expect(result).toEqual({cancelledCount: 0, coverage: "partial", batchLimited: true});
    expect(authorizeCancel).toHaveBeenCalledTimes(1);
  } finally {await context.cleanup();}
});

test("a late verifier result cannot commit after maintenance cancels its superseded lease", async () => {
  const context = await setup();
  try {
    await context.db.pool.query(`CREATE TABLE ${context.schema}.loaded_execute_grants (
      tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
      config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
      repository_id text NOT NULL,service_id text NOT NULL,environment text NOT NULL,service_root text NOT NULL,
      load_identity_digest text NOT NULL,allowed boolean NOT NULL)`);
    const job = await context.db.pool.query<{load_identity_digest: string; config_document_sha256: string}>(`SELECT
      load_identity_digest,config_document_sha256 FROM ${context.schema}.orchestration_loaded_document_verification_jobs
      WHERE tenant_id=$1 AND job_id=$2`, [tenantId, context.admitted.jobId]);
    await context.db.pool.query(`INSERT INTO ${context.schema}.loaded_execute_grants VALUES
      ($1,$2,'a',$3,1,$4,$5,$6,$7,$8,true)`, [tenantId, principalId, job.rows[0]!.config_document_sha256,
      repositoryId, serviceId, environment, loadedDocumentServiceRoot, job.rows[0]!.load_identity_digest]);
    const runner = createLoadedDocumentVerificationRunner(context.db.pool, {schema: context.db.schema, tenantId,
      principalId, workerId: "worker", instanceId: "instance", allowedRepositories: [repositoryId],
      allowedServices: [serviceId], heartbeatIntervalMs: 10_000, verificationTimeoutMs: 10_000,
      preflightAuthorize: async () => true,
      authorizeLoadedDocument: async (client, binding) => {
        const result = await client.query(`SELECT allowed FROM loaded_execute_grants WHERE tenant_id=$1 AND principal_id=$2
          AND config_fingerprint=$3 AND config_document_sha256=$4 AND config_checkpoint_version=$5 AND repository_id=$6
          AND service_id=$7 AND environment=$8 AND service_root=$9 AND load_identity_digest=$10 AND allowed FOR SHARE`,
        [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
          binding.checkpointVersion, binding.repositoryId, binding.serviceId, binding.environment, binding.serviceRoot,
          binding.loadIdentityDigest]);
        return result.rows.length === 1;
      }, verificationPortFactory: async () => ({verify: async () => {
        notifyStarted(); await permissionToFinish; return context.fixture.loadedPort.verify();
      }})});
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => {notifyStarted = resolve;});
    let finish!: () => void;
    const permissionToFinish = new Promise<void>(resolve => {finish = resolve;});
    const running = runner.runOne();
    await started;
    expect(await context.maintenance().cancelSuperseded()).toMatchObject({cancelledCount: 0});
    await context.activate("b");
    expect(await context.maintenance().cancelSuperseded()).toMatchObject({cancelledCount: 1});
    finish();
    expect(await running).toMatchObject({kind: "deferred", reason: "lease_lost"});
    expect((await context.db.pool.query(`SELECT state FROM ${context.schema}.orchestration_loaded_document_verification_job_state`)).rows)
      .toEqual([{state: "cancelled"}]);
    expect((await context.db.pool.query(`SELECT count(*)::int AS count FROM
      ${context.schema}.orchestration_loaded_document_verification_results`)).rows).toEqual([{count: 0}]);
    expect((await context.db.pool.query(`SELECT count(*)::int AS count FROM
      ${context.schema}.orchestration_observed_loaded_document_verifications`)).rows).toEqual([{count: 0}]);
  } finally {await context.cleanup();}
});

test("manager preflight denial and hostile options perform no storage or manager lookup", async () => {
  const connect = vi.fn(), authorizeCancel = vi.fn(async () => true), getter = vi.fn(() => "tenant");
  const base = {schema: "schema", tenantId, principalId: managerId, allowedRepositories: [repositoryId],
    allowedServices: [serviceId], preflightAuthorize: async () => false, authorizeCancel};
  const pool = {connect} as unknown as import("pg").Pool;
  await expect(createLoadedDocumentVerificationMaintenance(pool, base).cancelSuperseded())
    .rejects.toMatchObject({code: "LOADED_DOCUMENT_MAINTENANCE_UNAUTHORIZED"});
  Object.defineProperty(base, "tenantId", {get: getter});
  expect(() => createLoadedDocumentVerificationMaintenance(pool, base)).toThrow("Invalid loaded-document maintenance configuration");
  expect(getter).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(authorizeCancel).not.toHaveBeenCalled();
});
