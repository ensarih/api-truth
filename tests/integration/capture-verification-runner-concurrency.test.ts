import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {expect, test} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCaptureVerificationRunner} from "../../packages/orchestration/src/capture-verification-runner.js";
import type {CaptureVerificationLeaseOptions} from "../../packages/orchestration/src/capture-verification-leases.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "runner-finalize-race", principalId = "runner-finalize-worker";
const sourceScope = "runner-finalize-source", environmentScope = "runner-finalize-environment";
const repositoryId = "runner-finalize-repository", serviceId = "runner-finalize-service", environment = "uat";
const scope = {tenantId, repositoryId, serviceId, environment,
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const config = (fingerprint: string) => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: [sourceScope, environmentScope].map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/finalize-race",
    access_scope_id: sourceScope, services: [{service_id: serviceId, root: "services/api",
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: environmentScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});
const gate = () => {
  let release!: () => void, enter!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  return {waiting, started, release, enter};
};
const resultFor = (identity: string, receiptDigest: string, signerSpkiDigest: string) => ({
  kind: "verified_handler_bytes", scope, serviceRoot: "services/api", captureIdentityDigest: identity,
  receiptDigest, signerSpkiDigest, sourceDigest: scope.sourceDigest,
  handlers: [{method: "GET", applicationPath: "/orders/{id}", controller: "orders",
    operationId: "readOrder", handlerPath: "controllers/orders.js", handlerDigest: hash("handler"),
    exportName: "readOrder"}],
  limitations: ["Document operation correspondence and deployment are unverified"],
});

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
  const admin = {tenantId, principalId: "runner-finalize-admin", capabilities: ["configuration.admin"]};
  const registered = await orchestration.registerConfiguration(admin, config("config-a"));
  await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
  const trustedPolicyTable = `CREATE TABLE ${schema}.trusted_capture_execute (
    tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
    config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,allowed boolean NOT NULL,
    PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version))`;
  await db.pool.query(trustedPolicyTable);
  await db.pool.query(`INSERT INTO ${schema}.trusted_capture_execute VALUES
    ($1,$2,'config-a',$3,1,true)`, [tenantId, principalId, registered.documentSha256]);
  return {db, schema, access};
}

async function admit(db: CatalogTestDatabase, name: string) {
  const artifactRef = `capture:${name}`, configuredKeyRef = "key:runner-finalize";
  const receiptDigest = hash(`receipt:${name}`), signerSpkiDigest = hash("runner-finalize-signer");
  const identity = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest}));
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [tenantId, identity, repositoryId, serviceId, scope.immutableRevision, scope.sourceDigest,
    environment, artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  const store = createCaptureVerificationAdmissionStore(db.pool, {schema: db.schema, tenantId, principalId,
    preflightAuthorize: async () => true,
    authorizeCapture: async (client: PoolClient, binding) => {
      const row = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_capture_execute
        WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3
          AND config_document_sha256=$4 AND config_checkpoint_version=$5 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint,
        binding.configDocumentSha256, binding.checkpointVersion]);
      return row.rows.length === 1 && row.rows[0]!.allowed;
    }});
  const admitted = await store.admit({captureIdentityDigest: identity});
  return {admitted, identity, receiptDigest, signerSpkiDigest};
}

test("final authorization locks grant, host policy, and config until 0007 plus success commit together", async () => {
  const {db, schema} = await setup();
  const finalAuthorization = gate();
  let verificationComplete = false;
  let run: Promise<unknown> | undefined;
  try {
    const pin = await admit(db, "lock-race");
    const authorizeCapture: CaptureVerificationLeaseOptions["authorizeCapture"] = async (client, binding) => {
      const row = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_capture_execute
        WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3
          AND config_document_sha256=$4 AND config_checkpoint_version=$5 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint,
        binding.configDocumentSha256, binding.checkpointVersion]);
      // Runner binding includes jobId at final verification authorization; lease-heartbeat binding does not.
      if (verificationComplete && Object.hasOwn(binding, "jobId")) {
        finalAuthorization.enter();
        await finalAuthorization.waiting;
      }
      return row.rows.length === 1 && row.rows[0]!.allowed;
    };
    const runner = createCaptureVerificationRunner(db.pool, {schema: db.schema, tenantId, principalId,
      workerId: "worker-a", instanceId: "instance-a", allowedRepositories: [repositoryId],
      allowedServices: [serviceId], preflightAuthorize: async () => true, authorizeCapture,
      verificationPortFactory: async binding => ({verify: async () => {
        verificationComplete = true;
        return resultFor(binding.captureIdentityDigest, binding.receiptDigest, binding.signerSpkiDigest);
      }})});
    run = runner.runOne();
    await finalAuthorization.started;

    const grantUpdate = await db.pool.connect();
    try {
      await grantUpdate.query("BEGIN");
      await grantUpdate.query("SET LOCAL lock_timeout='250ms'");
      await expect(grantUpdate.query(`UPDATE ${schema}.principal_scope_grants SET active=false
        WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=$3`,
      [tenantId, principalId, sourceScope])).rejects.toMatchObject({code: "55P03"});
    } finally {
      await grantUpdate.query("ROLLBACK").catch(() => undefined);
      grantUpdate.release();
    }
    const configUpdate = await db.pool.connect();
    try {
      await configUpdate.query("BEGIN");
      await configUpdate.query("SET LOCAL lock_timeout='250ms'");
      await expect(configUpdate.query(`UPDATE ${schema}.orchestration_active_configurations
        SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]))
        .rejects.toMatchObject({code: "55P03"});
    } finally {
      await configUpdate.query("ROLLBACK").catch(() => undefined);
      configUpdate.release();
    }

    finalAuthorization.release();
    const result = await run;
    expect(result).toMatchObject({kind: "succeeded", jobId: pin.admitted.jobId,
      receipt: {captureIdentityDigest: pin.identity, outcome: "inserted"}});
    const stored = await db.pool.query<{result_digest: string; capture_identity_digest: string}>(
      `SELECT result_digest,capture_identity_digest FROM ${schema}.orchestration_observed_capture_verifications
       WHERE tenant_id=$1`, [tenantId]);
    const state = await db.pool.query<{state: string; verification_result_digest: string;
      verification_capture_identity_digest: string}>(`SELECT state,verification_result_digest,
        verification_capture_identity_digest FROM ${schema}.orchestration_capture_verification_job_state
        WHERE tenant_id=$1 AND job_id=$2`, [tenantId, pin.admitted.jobId]);
    expect(stored.rows).toHaveLength(1);
    expect(state.rows).toEqual([{state: "succeeded", verification_result_digest: stored.rows[0]!.result_digest,
      verification_capture_identity_digest: stored.rows[0]!.capture_identity_digest}]);
    expect(state.rows[0]!.verification_capture_identity_digest).toBe(pin.identity);

    await db.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
      WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=$3`, [tenantId, principalId, sourceScope]);
    await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
      SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
  } finally {
    finalAuthorization.release();
    await run?.catch(() => undefined);
    await db.cleanup();
  }
});

test("lifecycle cannot be rebound to another valid verification owned by a different job", async () => {
  const {db, schema} = await setup();
  try {
    const first = await admit(db, "owner-first");
    const second = await admit(db, "owner-second");
    const authorizeCapture: CaptureVerificationLeaseOptions["authorizeCapture"] = async (client, binding) => {
      const row = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_capture_execute
        WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3
          AND config_document_sha256=$4 AND config_checkpoint_version=$5 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint,
        binding.configDocumentSha256, binding.checkpointVersion]);
      return row.rows.length === 1 && row.rows[0]!.allowed;
    };
    const runner = createCaptureVerificationRunner(db.pool, {schema: db.schema, tenantId, principalId,
      workerId: "worker-a", instanceId: "instance-a", allowedRepositories: [repositoryId],
      allowedServices: [serviceId], preflightAuthorize: async () => true, authorizeCapture,
      verificationPortFactory: async binding => ({verify: async () => resultFor(
        binding.captureIdentityDigest, binding.receiptDigest, binding.signerSpkiDigest)})});
    const firstResult = await runner.runOne();
    const secondResult = await runner.runOne();
    expect(firstResult).toMatchObject({kind: "succeeded", jobId: first.admitted.jobId,
      receipt: {captureIdentityDigest: first.identity, outcome: "inserted"}});
    expect(secondResult).toMatchObject({kind: "succeeded", jobId: second.admitted.jobId,
      receipt: {captureIdentityDigest: second.identity, outcome: "inserted"}});

    const otherVerification = await db.pool.query<{verifier_profile_version: string; result_digest: string}>(
      `SELECT verifier_profile_version,result_digest FROM ${schema}.orchestration_observed_capture_verifications
       WHERE tenant_id=$1 AND capture_identity_digest=$2`, [tenantId, second.identity]);
    expect(otherVerification.rows).toHaveLength(1);
    await expect(db.pool.query(`UPDATE ${schema}.orchestration_capture_verification_job_state
      SET verification_capture_identity_digest=$3,verification_profile_version=$4,verification_result_digest=$5
      WHERE tenant_id=$1 AND job_id=$2`, [tenantId, first.admitted.jobId, second.identity,
      otherVerification.rows[0]!.verifier_profile_version, otherVerification.rows[0]!.result_digest]))
      .rejects.toMatchObject({code: "23503"});

    const linked = await db.pool.query<{job_id: string; capture_identity_digest: string; state: string;
      verification_capture_identity_digest: string; verification_profile_version: string;
      verification_result_digest: string}>(`SELECT job.job_id,job.capture_identity_digest,state.state,
        state.verification_capture_identity_digest,state.verification_profile_version,state.verification_result_digest
        FROM ${schema}.orchestration_capture_verification_jobs job
        JOIN ${schema}.orchestration_capture_verification_job_state state USING (tenant_id,job_id)
        WHERE job.tenant_id=$1 ORDER BY job.job_id`, [tenantId]);
    expect(linked.rows).toHaveLength(2);
    expect(linked.rows.find(row => row.job_id === first.admitted.jobId)).toMatchObject({
      capture_identity_digest: first.identity, state: "succeeded",
      verification_capture_identity_digest: first.identity,
      verification_profile_version: "protected-handler-bytes-1",
      verification_result_digest: firstResult.kind === "succeeded" ? firstResult.receipt.resultDigest : "",
    });
    const ordinary = await db.pool.query<{snapshots: string; revision_links: string; pointers: string}>(`SELECT
      (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
      (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots) AS revision_links,
      (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS pointers`);
    expect(ordinary.rows).toEqual([{snapshots: "0", revision_links: "0", pointers: "0"}]);
  } finally { await db.cleanup(); }
});
