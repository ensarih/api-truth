import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "vitest";
import type {PoolClient} from "pg";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createLoadedDocumentVerificationAdmissionStore} from "../../packages/orchestration/src/loaded-document-verification-admission.js";
import {createLoadedDocumentVerificationRunner, type LoadedDocumentVerificationRunnerOptions}
  from "../../packages/orchestration/src/loaded-document-verification-runner.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";
import {createLoadedDocumentProofFixture, loadedDocumentServiceRoot} from "./support/loaded-document-proof-fixture.js";

const tenantId = "loaded-runner-tenant", principalId = "loaded-runner-worker", repositoryId = "repository";
const serviceId = "orders", environment = "test", sourceScope = "source-read", envScope = "environment-read";
const admin = {tenantId, principalId: "configuration-admin", capabilities: ["configuration.admin"]};
const config = (fingerprint: string) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, envScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/repository", access_scope_id: sourceScope,
    services: [{service_id: serviceId, root: loadedDocumentServiceRoot,
      analyzer: {adapter_id: "openapi_document", adapter_version: "0.2.0"}, intended_branches: ["main"],
      environments: [{name: environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: envScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});

async function setup() {
  const db = await createCatalogTestDatabase();
  const repoPath = await mkdtemp(join(tmpdir(), "loaded-document-runner-"));
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const schema = quoteCatalogTestSchema(db.schema);
    const access = createAccessPolicyStore(db.pool, {schema: db.schema});
    for (const scopeId of [sourceScope, envScope]) {
      await access.putScope({tenantId}, {scopeId, active: true});
      await access.putGrant({tenantId}, {principalId, scopeId, active: true});
    }
    const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
    const registered = await orchestration.registerConfiguration(admin, config("config-a"));
    await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
    const fixture = await createLoadedDocumentProofFixture(db.pool, db.schema,
      {tenantId, repositoryId, serviceId, environment, immutableRevision: "a".repeat(40),
        sourceDigest: `sha256:${"b".repeat(64)}`}, repoPath, async () => true);
    await db.pool.query(`CREATE TABLE ${schema}.trusted_loaded_document_policy (
      tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
      config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
      repository_id text NOT NULL,service_id text NOT NULL,environment text NOT NULL,service_root text NOT NULL,
      capture_identity_digest text NOT NULL,artifact_ref text NOT NULL,configured_key_ref text NOT NULL,
      envelope_digest text NOT NULL,signer_spki_digest text NOT NULL,opt_in boolean NOT NULL,
      source_allowed boolean NOT NULL,environment_allowed boolean NOT NULL,artifact_allowed boolean NOT NULL,
      PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version,capture_identity_digest))`);
    await db.pool.query(`CREATE TABLE ${schema}.trusted_loaded_document_execute (
      tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
      config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
      repository_id text NOT NULL,service_id text NOT NULL,environment text NOT NULL,service_root text NOT NULL,
      load_identity_digest text NOT NULL,source_allowed boolean NOT NULL,environment_allowed boolean NOT NULL,
      artifact_allowed boolean NOT NULL,execute_allowed boolean NOT NULL,
      PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version,load_identity_digest))`);
    const binding = {scope: fixture.scope, captureIdentityDigest: fixture.association.captureIdentityDigest,
      serviceRoot: loadedDocumentServiceRoot, ...fixture.loadBinding};
    const policyValues = [tenantId, principalId, "config-a", registered.documentSha256, 1, repositoryId, serviceId,
      environment, loadedDocumentServiceRoot, fixture.association.captureIdentityDigest,
      fixture.loadBinding.loadArtifactRef, fixture.loadBinding.loadConfiguredKeyRef,
      fixture.loadBinding.loadEnvelopeDigest, fixture.loadBinding.loadSignerSpkiDigest];
    await db.pool.query(`INSERT INTO ${schema}.trusted_loaded_document_policy VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,true,true,true)`, policyValues);
    const admission = createLoadedDocumentVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId, principalId,
      bindings: [binding], preflightAuthorize: async () => true,
      authorizeLoadedDocument: async (client: PoolClient, auth) => {
        const row = await client.query(`SELECT 1 FROM trusted_loaded_document_policy WHERE tenant_id=$1 AND principal_id=$2
          AND config_fingerprint=$3 AND config_document_sha256=$4 AND config_checkpoint_version=$5 AND repository_id=$6
          AND service_id=$7 AND environment=$8 AND service_root=$9 AND capture_identity_digest=$10 AND artifact_ref=$11
          AND configured_key_ref=$12 AND envelope_digest=$13 AND signer_spki_digest=$14 AND opt_in
          AND source_allowed AND environment_allowed AND artifact_allowed FOR SHARE`,
        [auth.tenantId, auth.principalId, auth.configFingerprint, auth.configDocumentSha256, auth.checkpointVersion,
          auth.repositoryId, auth.serviceId, auth.environment, binding.serviceRoot, auth.captureIdentityDigest,
          auth.loadArtifactRef, auth.loadConfiguredKeyRef, auth.loadEnvelopeDigest, auth.loadSignerSpkiDigest]);
        return row.rows.length === 1;
      }});
    const admitted = await admission.admit({captureIdentityDigest: binding.captureIdentityDigest});
    await db.pool.query(`INSERT INTO ${schema}.trusted_loaded_document_execute VALUES
      ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,true,true,true,true)`, [tenantId, principalId, "config-a",
      registered.documentSha256, repositoryId, serviceId, environment, loadedDocumentServiceRoot, admitted.loadIdentityDigest]);
    return {db, schema, repoPath, fixture, binding, admission: admitted, cleanup: async () => {
      await db.cleanup(); await rm(repoPath, {recursive: true, force: true});
    }};
  } catch (error) {await db.cleanup(); await rm(repoPath, {recursive: true, force: true}); throw error;}
}

function runnerFor(context: Awaited<ReturnType<typeof setup>>,
  factory: LoadedDocumentVerificationRunnerOptions["verificationPortFactory"] = async () => ({verify: () => context.fixture.loadedPort.verify()}),
  verificationTimeoutMs = 10_000) {
  return createLoadedDocumentVerificationRunner(context.db.pool, {schema: context.db.schema, tenantId, principalId,
    workerId: "worker", instanceId: "instance", allowedRepositories: [repositoryId], allowedServices: [serviceId],
    heartbeatIntervalMs: 10_000, verificationTimeoutMs,
    preflightAuthorize: async () => true,
    authorizeLoadedDocument: async (client, binding) => {
      const result = await client.query(`SELECT 1 FROM trusted_loaded_document_execute WHERE tenant_id=$1 AND principal_id=$2
        AND config_fingerprint=$3 AND config_document_sha256=$4 AND config_checkpoint_version=$5 AND repository_id=$6
        AND service_id=$7 AND environment=$8 AND service_root=$9 AND load_identity_digest=$10 AND source_allowed
        AND environment_allowed AND artifact_allowed AND execute_allowed FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint, binding.configDocumentSha256,
        binding.checkpointVersion, binding.repositoryId, binding.serviceId, binding.environment, binding.serviceRoot,
        binding.loadIdentityDigest]);
      return result.rows.length === 1;
    }, verificationPortFactory: factory});
}

test("protected Git and signed-load fixture commits the safe summary and terminal state together", async () => {
  const context = await setup();
  try {
    const result = await runnerFor(context).runOne();
    expect(result).toMatchObject({kind: "succeeded", jobId: context.admission.jobId,
      captureIdentityDigest: context.binding.captureIdentityDigest,
      loadIdentityDigest: context.admission.loadIdentityDigest,
      receipt: {outcome: "inserted", verifierProfileVersion: "swagger-loaded-document-1", handlerCount: 1,
        matchCount: 1, unobservedDiagnosticCount: 0}});
    const state = await context.db.pool.query(`SELECT state,attempt_count,verification_result_digest,verification_attempt_no,
      verification_error_code,completed_at FROM ${context.schema}.orchestration_loaded_document_verification_job_state`);
    const stored = await context.db.pool.query(`SELECT * FROM ${context.schema}.orchestration_loaded_document_verification_results`);
    const summary = await context.db.pool.query(`SELECT * FROM ${context.schema}.orchestration_observed_loaded_document_verifications`);
    expect(state.rows).toMatchObject([{state: "succeeded", attempt_count: 1,
      verification_result_digest: result.kind === "succeeded" ? result.receipt.resultDigest : "",
      verification_attempt_no: 1, verification_error_code: null}]);
    expect(stored.rows).toHaveLength(1);
    expect(summary.rows).toMatchObject([{result_digest: result.kind === "succeeded" ? result.receipt.resultDigest : "",
      handler_count: 1, match_count: 1, unobserved_diagnostic_count: 0}]);
    const forbidden = await context.db.pool.query(`SELECT to_jsonb(result)::text AS result,
      to_jsonb(summary)::text AS summary FROM ${context.schema}.orchestration_loaded_document_verification_results result
      JOIN ${context.schema}.orchestration_observed_loaded_document_verifications summary USING(tenant_id,load_identity_digest)`);
    expect(forbidden.rows[0]!.result + forbidden.rows[0]!.summary).not.toContain("res.status");
    expect(forbidden.rows[0]!.result + forbidden.rows[0]!.summary).not.toContain("readOrder");
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM ${context.schema}.catalog_snapshots`))
      .toMatchObject({rows: [{count: 0}]});
    await expect(context.db.pool.query(`UPDATE ${context.schema}.orchestration_loaded_document_verification_results
      SET result_digest=$1`, [`sha256:${"e".repeat(64)}`])).rejects.toThrow();
    await expect(context.db.pool.query(`UPDATE ${context.schema}.orchestration_loaded_document_verification_job_state
      SET state='failed'`)).rejects.toThrow();
  } finally {await context.cleanup();}
});

test("deterministic unverified loads fail terminally without a summary or result", async () => {
  const context = await setup();
  try {
    const result = await runnerFor(context, async () => ({verify: async () => {throw Object.assign(new Error("private"),
      {code: "LOADED_DOCUMENT_UNVERIFIED"});}})).runOne();
    expect(result).toMatchObject({kind: "failed", reason: "unverified"});
    const rows = await context.db.pool.query(`SELECT state,attempt_count,verification_error_code,verification_result_digest
      FROM ${context.schema}.orchestration_loaded_document_verification_job_state`);
    expect(rows.rows).toEqual([{state: "failed", attempt_count: 1,
      verification_error_code: "LOADED_DOCUMENT_VERIFICATION_UNVERIFIED", verification_result_digest: null}]);
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM ${context.schema}.orchestration_loaded_document_verification_results`))
      .toMatchObject({rows: [{count: 0}]});
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM ${context.schema}.orchestration_observed_loaded_document_verifications`))
      .toMatchObject({rows: [{count: 0}]});
  } finally {await context.cleanup();}
});

test("verification deadline aborts the port and persists only a bounded transient retry", async () => {
  const context = await setup();
  try {
    let disposed = false;
    const result = await runnerFor(context, async (_binding, {signal}) => ({
      verify: () => new Promise((_resolve, reject) => {
        if (signal.aborted) reject(Error("private"));
        else signal.addEventListener("abort", () => reject(Error("private")), {once: true});
      }),
      dispose: async () => {disposed = true;},
    }), 100).runOne();
    expect(result).toMatchObject({kind: "deferred", reason: "transient"});
    expect(disposed).toBe(true);
    const state = await context.db.pool.query(`SELECT state,attempt_count,verification_error_code,verification_result_digest
      FROM ${context.schema}.orchestration_loaded_document_verification_job_state`);
    expect(state.rows).toEqual([{state: "retry_wait", attempt_count: 1,
      verification_error_code: "LOADED_DOCUMENT_VERIFICATION_TRANSIENT", verification_result_digest: null}]);
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM ${context.schema}.orchestration_loaded_document_verification_results`))
      .toMatchObject({rows: [{count: 0}]});
  } finally {await context.cleanup();}
});

test("third transient attempt becomes terminal and never creates a partial success result", async () => {
  const context = await setup();
  try {
    const runner = runnerFor(context, async () => ({verify: async () => {throw Error("private provider details");}}));
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runner.runOne();
      outcomes.push(result.kind);
      if (attempt < 3) {
        expect(await runner.runOne()).toMatchObject({kind: "no_work", coverage: "partial"});
        const backoff = await context.db.pool.query<{remaining_ms: number}>(`SELECT extract(epoch FROM
          available_at-clock_timestamp())*1000 AS remaining_ms FROM
          ${context.schema}.orchestration_loaded_document_verification_job_state WHERE state='retry_wait'`);
        const remainingMs = Number(backoff.rows[0]?.remaining_ms);
        expect(remainingMs).toBeGreaterThan(0);
        expect(remainingMs).toBeLessThanOrEqual(attempt === 1 ? 5_000 : 10_000);
        await context.db.pool.query(`UPDATE ${context.schema}.orchestration_loaded_document_verification_job_state
          SET available_at=clock_timestamp() WHERE state='retry_wait'`);
      }
    }
    expect(outcomes).toEqual(["deferred", "deferred", "failed"]);
    expect(await context.db.pool.query(`SELECT state,attempt_count,verification_error_code
      FROM ${context.schema}.orchestration_loaded_document_verification_job_state`)).toMatchObject({rows: [
      {state: "failed", attempt_count: 3, verification_error_code: "LOADED_DOCUMENT_VERIFICATION_TRANSIENT"},
    ]});
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM ${context.schema}.orchestration_loaded_document_verification_results`))
      .toMatchObject({rows: [{count: 0}]});
  } finally {await context.cleanup();}
});

test("deadline during port construction prevents verification from starting", async () => {
  const context = await setup();
  try {
    let started = false, disposed = false;
    const factory: LoadedDocumentVerificationRunnerOptions["verificationPortFactory"] = async (_binding, {signal}) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({verify: async () => {started = true; return {};},
          dispose: async () => {disposed = true;}}), {once: true});
      });
    const result = await runnerFor(context, factory, 100).runOne();
    expect(result).toMatchObject({kind: "deferred", reason: "transient"});
    expect(started).toBe(false);
    expect(disposed).toBe(true);
    expect(await context.db.pool.query(`SELECT state,verification_error_code FROM
      ${context.schema}.orchestration_loaded_document_verification_job_state`)).toMatchObject({rows: [
      {state: "retry_wait", verification_error_code: "LOADED_DOCUMENT_VERIFICATION_TRANSIENT"},
    ]});
  } finally {await context.cleanup();}
});

test("revoked execution permission during verification discards the verified result", async () => {
  const context = await setup();
  try {
    const factory: LoadedDocumentVerificationRunnerOptions["verificationPortFactory"] = async () => {
      await context.db.pool.query(`DELETE FROM ${context.schema}.trusted_loaded_document_execute`);
      return {verify: () => context.fixture.loadedPort.verify()};
    };
    const result = await runnerFor(context, factory).runOne();
    expect(result).toMatchObject({kind: "deferred", reason: "lease_lost"});
    expect((await context.db.pool.query(`SELECT state,verification_result_digest FROM
      ${context.schema}.orchestration_loaded_document_verification_job_state`)).rows).toEqual([
      {state: "leased", verification_result_digest: null},
    ]);
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM
      ${context.schema}.orchestration_observed_loaded_document_verifications`)).toMatchObject({rows: [{count: 0}]});
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM
      ${context.schema}.orchestration_loaded_document_verification_results`)).toMatchObject({rows: [{count: 0}]});
  } finally {await context.cleanup();}
});

test("final result-write failure rolls the safe summary back atomically", async () => {
  const context = await setup();
  try {
    await context.db.pool.query(`CREATE FUNCTION ${context.schema}.reject_loaded_result() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'private fixture failure'; END $$`);
    await context.db.pool.query(`CREATE TRIGGER reject_loaded_result BEFORE INSERT ON
      ${context.schema}.orchestration_loaded_document_verification_results FOR EACH ROW
      EXECUTE FUNCTION ${context.schema}.reject_loaded_result()`);
    const result = await runnerFor(context).runOne();
    expect(result).toMatchObject({kind: "deferred", reason: "transient"});
    expect(await context.db.pool.query(`SELECT state,verification_error_code,verification_result_digest
      FROM ${context.schema}.orchestration_loaded_document_verification_job_state`)).toMatchObject({rows: [
      {state: "retry_wait", verification_error_code: "LOADED_DOCUMENT_VERIFICATION_TRANSIENT",
        verification_result_digest: null},
    ]});
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM
      ${context.schema}.orchestration_observed_loaded_document_verifications`)).toMatchObject({rows: [{count: 0}]});
    expect(await context.db.pool.query(`SELECT count(*)::int AS count FROM
      ${context.schema}.orchestration_loaded_document_verification_results`)).toMatchObject({rows: [{count: 0}]});
  } finally {await context.cleanup();}
});

test("database rejects successful state without its exact completion result", async () => {
  const context = await setup();
  try {
    await expect(context.db.pool.query(`UPDATE ${context.schema}.orchestration_loaded_document_verification_job_state
      SET state='succeeded',attempt_count=1,verification_attempt_no=1,
        verification_result_digest=$1,completed_at=clock_timestamp()`, [`sha256:${"a".repeat(64)}`]))
      .rejects.toThrow("loaded document completion state mismatch");
    expect((await context.db.pool.query(`SELECT state,verification_result_digest FROM
      ${context.schema}.orchestration_loaded_document_verification_job_state`)).rows)
      .toEqual([{state: "queued", verification_result_digest: null}]);
  } finally {await context.cleanup();}
});

test("successful state and completion result cannot be changed or removed", async () => {
  const context = await setup();
  try {
    expect((await runnerFor(context).runOne()).kind).toBe("succeeded");
    await expect(context.db.pool.query(`UPDATE ${context.schema}.orchestration_loaded_document_verification_job_state
      SET row_version=row_version+1`)).rejects.toThrow("loaded document success is immutable");
    await expect(context.db.pool.query(`DELETE FROM ${context.schema}.orchestration_loaded_document_verification_job_state`))
      .rejects.toThrow("loaded document worker state is append only");
    await expect(context.db.pool.query(`UPDATE ${context.schema}.orchestration_loaded_document_verification_results
      SET completed_at=clock_timestamp()`)).rejects.toBeDefined();
    await expect(context.db.pool.query(`DELETE FROM ${context.schema}.orchestration_loaded_document_verification_results`))
      .rejects.toBeDefined();
    expect((await context.db.pool.query(`SELECT state FROM ${context.schema}.orchestration_loaded_document_verification_job_state`)).rows)
      .toEqual([{state: "succeeded"}]);
    expect((await context.db.pool.query(`SELECT count(*)::int AS count FROM
      ${context.schema}.orchestration_loaded_document_verification_results`)).rows).toEqual([{count: 1}]);
  } finally {await context.cleanup();}
});
