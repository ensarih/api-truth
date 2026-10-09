import {createHash} from "node:crypto";
import {expect, test, vi} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCaptureVerificationLeaseStore} from "../../packages/orchestration/src/capture-verification-leases.js";
import {createCaptureVerificationRunner} from "../../packages/orchestration/src/capture-verification-runner.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "runner-tenant", principalId = "runner-worker";
const sourceScope = "source-access", environmentScope = "environment-access";
const scope = {tenantId, repositoryId: "repository", serviceId: "service", environment: "uat",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const config = (fingerprint: string, accessIds: readonly [string, string] = [sourceScope, environmentScope]) =>
  ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: accessIds.map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: scope.repositoryId, provider: "github", locator: "sample/repository",
    access_scope_id: accessIds[0], services: [{service_id: scope.serviceId, root: "services/api",
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: scope.environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deployment", access_scope_id: accessIds[1]}}]}]}],
  inference: {enabled: false}, logs: {enabled: false}}});
const verified = (identity: string, receiptDigest: string, signerSpkiDigest: string) => ({
  kind: "verified_handler_bytes", scope, serviceRoot: "services/api", captureIdentityDigest: identity,
  receiptDigest, signerSpkiDigest, sourceDigest: scope.sourceDigest,
  handlers: [{method: "GET", applicationPath: "/orders/{id}", controller: "orders",
    operationId: "readOrder", handlerPath: "controllers/orders.js", handlerDigest: hash("handler"),
    exportName: "readOrder"}], limitations: ["Document operation correspondence and deployment are unverified"]});

async function setup(accessIds: readonly [string, string] = [sourceScope, environmentScope]) {
  const db = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(db.pool, {schema: db.schema});
  const schema = quoteCatalogTestSchema(db.schema);
  const access = createAccessPolicyStore(db.pool, {schema: db.schema});
  for (const scopeId of accessIds) {
    await access.putScope({tenantId}, {scopeId, active: true});
    await access.putGrant({tenantId}, {principalId, scopeId, active: true});
  }
  const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
  const registered = await orchestration.registerConfiguration(admin, config("config-a", accessIds));
  await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
  await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_execute (
    tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
    config_document_sha256 text NOT NULL,config_checkpoint_version bigint NOT NULL,
    allowed boolean NOT NULL,
    PRIMARY KEY(tenant_id,principal_id,config_fingerprint,config_checkpoint_version))`);
  await db.pool.query(`INSERT INTO ${schema}.trusted_capture_execute VALUES
    ($1,$2,'config-a',$3,1,true)`, [tenantId, principalId, registered.documentSha256]);
  const authorizeCapture = async (client: import("pg").PoolClient,
    binding: {tenantId: string; principalId: string; configFingerprint: string;
      configDocumentSha256: string; checkpointVersion: string}) => {
    const row = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_capture_execute
      WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3
        AND config_document_sha256=$4 AND config_checkpoint_version=$5 FOR SHARE`,
    [binding.tenantId, binding.principalId, binding.configFingerprint,
      binding.configDocumentSha256, binding.checkpointVersion]);
    return row.rows.length === 1 && row.rows[0]!.allowed;
  };
  return {db, schema, access, orchestration, authorizeCapture};
}
async function admit(db: CatalogTestDatabase, authorizeCapture: Awaited<ReturnType<typeof setup>>["authorizeCapture"],
  name = "one") {
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
    preflightAuthorize: async () => true, authorizeCapture});
  const admitted = await store.admit({captureIdentityDigest: identity});
  return {admitted, identity, receiptDigest, signerSpkiDigest};
}
function runner(db: CatalogTestDatabase, authorizeCapture: Awaited<ReturnType<typeof setup>>["authorizeCapture"],
  verify: (identity: string, receiptDigest: string, signerSpkiDigest: string) => Promise<unknown>,
  heartbeatIntervalMs?: number) {
  return createCaptureVerificationRunner(db.pool, {schema: db.schema, tenantId, principalId,
    workerId: "worker-a", instanceId: "instance-a", allowedRepositories: [scope.repositoryId],
    allowedServices: [scope.serviceId], preflightAuthorize: async () => true, authorizeCapture,
    verificationPortFactory: async binding => ({verify: () => verify(binding.captureIdentityDigest,
      binding.receiptDigest, binding.signerSpkiDigest)}),
    ...(heartbeatIntervalMs === undefined ? {} : {heartbeatIntervalMs})});
}
async function counts(db: CatalogTestDatabase, schema: string) {
  const rows = await db.pool.query<{verified: string; snapshots: string; pointers: string}>(
    `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_observed_capture_verifications) AS verified,
      (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
      (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS pointers`);
  return rows.rows[0];
}
function gate() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  return {waiting, started, release, entered};
}

test("claimed job verifies once and atomically links its exact 0007 result without catalog promotion", async () => {
  const {db, schema, authorizeCapture} = await setup();
  try {
    const pin = await admit(db, authorizeCapture);
    const call = vi.fn(async (identity: string, receipt: string, signer: string) => verified(identity, receipt, signer));
    const result = await runner(db, authorizeCapture, call).runOne();
    expect(result).toMatchObject({kind: "succeeded", jobId: pin.admitted.jobId,
      receipt: {outcome: "inserted", resultDigest: expect.stringMatching(/^sha256:/)}});
    expect(call).toHaveBeenCalledTimes(1);
    const state = await db.pool.query<{state: string; verification_capture_identity_digest: string;
      verification_profile_version: string; verification_result_digest: string; lease_token_hash: string | null}>(
      `SELECT state,verification_capture_identity_digest,verification_profile_version,
        verification_result_digest,lease_token_hash FROM ${schema}.orchestration_capture_verification_job_state`);
    expect(state.rows).toMatchObject([{state: "succeeded", verification_capture_identity_digest: pin.identity,
      verification_profile_version: "protected-handler-bytes-1",
      verification_result_digest: expect.stringMatching(/^sha256:/), lease_token_hash: null}]);
    expect(await counts(db, schema)).toEqual({verified: "1", snapshots: "0", pointers: "0"});
    expect(await runner(db, authorizeCapture, call).runOne()).toMatchObject({kind: "no_work"});
  } finally { await db.cleanup(); }
});

test("grant locks use PostgreSQL UTF-8 ordering for BMP and astral scope IDs", async () => {
  const {db, schema, authorizeCapture} = await setup(["😀", "\uE000"]);
  try {
    await admit(db, authorizeCapture);
    expect(await runner(db, authorizeCapture, async (identity, receipt, signer) =>
      verified(identity, receipt, signer)).runOne()).toMatchObject({kind: "succeeded"});
    expect(await counts(db, schema)).toEqual({verified: "1", snapshots: "0", pointers: "0"});
  } finally { await db.cleanup(); }
});

test("revocation and configuration change during protected verification suppress 0007 append", async () => {
  for (const change of ["grant", "configuration"] as const) {
    const {db, schema, access, orchestration, authorizeCapture} = await setup();
    const pause = gate();
    try {
      await admit(db, authorizeCapture);
      const running = runner(db, authorizeCapture, async (identity, receipt, signer) => {
        pause.entered(); await pause.waiting; return verified(identity, receipt, signer);
      }).runOne();
      await pause.started;
      if (change === "grant") await access.putGrant({tenantId}, {principalId, scopeId: sourceScope, active: false});
      else {
        await orchestration.registerConfiguration(admin, config("config-b"));
        await db.pool.query(`UPDATE ${schema}.orchestration_active_configurations
          SET config_fingerprint='config-b',checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`, [tenantId]);
      }
      pause.release();
      expect(await running).toMatchObject({kind: "deferred", reason: "lease_lost"});
      expect(await counts(db, schema)).toEqual({verified: "0", snapshots: "0", pointers: "0"});
    } finally { pause.release(); await db.cleanup(); }
  }
});

test("reclaimed lease token cannot append a late result", async () => {
  const {db, schema, authorizeCapture} = await setup();
  const pause = gate();
  try {
    const pin = await admit(db, authorizeCapture);
    const running = runner(db, authorizeCapture, async (identity, receipt, signer) => {
      pause.entered(); await pause.waiting; return verified(identity, receipt, signer);
    }).runOne();
    await pause.started;
    await db.pool.query(`UPDATE ${schema}.orchestration_capture_verification_job_state
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`, [pin.admitted.jobId]);
    const reclaim = createCaptureVerificationLeaseStore(db.pool, {schema: db.schema, tenantId, principalId,
      workerId: "worker-b", instanceId: "instance-b", allowedRepositories: [scope.repositoryId],
      allowedServices: [scope.serviceId], preflightAuthorize: async () => true, authorizeCapture});
    expect(await reclaim.claimOne()).toMatchObject({kind: "leased", attemptCount: 2});
    pause.release();
    expect(await running).toMatchObject({kind: "deferred", reason: "lease_lost"});
    expect(await counts(db, schema)).toEqual({verified: "0", snapshots: "0", pointers: "0"});
  } finally { pause.release(); await db.cleanup(); }
});

test("final CAS after 0007 insert rejects DB-expired lease and rolls back the verification", async () => {
  const {db, schema, authorizeCapture} = await setup();
  try {
    const pin = await admit(db, authorizeCapture);
    await db.pool.query(`CREATE FUNCTION ${schema}.expire_capture_lease() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        UPDATE orchestration_capture_verification_job_state
        SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=NEW.tenant_id AND job_id=${"'"}${pin.admitted.jobId}${"'"};
        RETURN NEW;
      END $$`);
    await db.pool.query(`CREATE TRIGGER expire_capture_lease BEFORE INSERT
      ON ${schema}.orchestration_observed_capture_verifications
      FOR EACH ROW EXECUTE FUNCTION ${schema}.expire_capture_lease()`);
    expect(await runner(db, authorizeCapture, async (identity, receipt, signer) =>
      verified(identity, receipt, signer)).runOne()).toMatchObject({kind: "deferred"});
    expect(await counts(db, schema)).toEqual({verified: "0", snapshots: "0", pointers: "0"});
  } finally { await db.cleanup(); }
});

test("default 10-second heartbeat renews while verification waits and terminal mismatch does not retry", async () => {
  const {db, schema, authorizeCapture} = await setup();
  const pause = gate();
  const realSetTimeout = globalThis.setTimeout;
  const ticks: Array<() => void> = [];
  const dummyHandles = new Set<ReturnType<typeof setTimeout>>();
  let timer: {mockRestore(): void} | undefined;
  let running: ReturnType<ReturnType<typeof runner>["runOne"]> | undefined;
  try {
    const pin = await admit(db, authorizeCapture);
    timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void,
      delay?: number, ...args: unknown[]) => {
      if (delay === 10_000) {
        const dummy = realSetTimeout(() => undefined, 60_000);
        dummyHandles.add(dummy);
        ticks.push(() => {
          clearTimeout(dummy);
          dummyHandles.delete(dummy);
          callback(...args);
        });
        return dummy;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    running = runner(db, authorizeCapture, async () => {
      pause.entered(); await pause.waiting;
      const error = new Error("private mismatch");
      Object.defineProperty(error, "code", {value: "PROTECTED_CAPTURE_UNVERIFIED"});
      throw error;
    }).runOne();
    await pause.started;
    expect(ticks.length).toBeGreaterThan(0);
    // The runner schedules after its claim and authorization reads, immediately before the port enters.
    ticks.pop()!();
    await vi.waitFor(async () => {
      const during = await db.pool.query<{row_version: string}>(
        `SELECT row_version::text FROM ${schema}.orchestration_capture_verification_job_state WHERE job_id=$1`,
      [pin.admitted.jobId]);
      expect(Number(during.rows[0]!.row_version)).toBeGreaterThan(2);
    });
    pause.release();
    expect(await running).toMatchObject({kind: "failed", reason: "unverified"});
    const state = await db.pool.query<{state: string; terminal_reason: string}>(
      `SELECT state,terminal_reason FROM ${schema}.orchestration_capture_verification_job_state WHERE job_id=$1`,
    [pin.admitted.jobId]);
    expect(state.rows).toEqual([{state: "failed", terminal_reason: "CAPTURE_VERIFICATION_UNVERIFIED"}]);
    expect(await counts(db, schema)).toEqual({verified: "0", snapshots: "0", pointers: "0"});
  } finally {
    pause.release();
    await running?.catch(() => undefined);
    timer?.mockRestore();
    for (const handle of dummyHandles) clearTimeout(handle);
    await db.cleanup();
  }
});

test("all falsy unknown verifier throws stay transient and never write 0007", async () => {
  for (const thrown of [undefined, null, false, 0]) {
    const {db, schema, authorizeCapture} = await setup();
    try {
      await admit(db, authorizeCapture);
      const outcome = await runner(db, authorizeCapture, async () => { throw thrown; }).runOne();
      expect(outcome).toMatchObject({kind: "deferred", reason: "transient"});
      const state = await db.pool.query<{state: string; attempt_count: number}>(
        `SELECT state,attempt_count FROM ${schema}.orchestration_capture_verification_job_state`);
      expect(state.rows).toEqual([{state: "leased", attempt_count: 1}]);
      expect(await counts(db, schema)).toEqual({verified: "0", snapshots: "0", pointers: "0"});
    } finally { await db.cleanup(); }
  }
});

test("hostile options are rejected before database access or verifier construction", async () => {
  const {db, authorizeCapture} = await setup();
  try {
    const connected = vi.spyOn(db.pool, "connect"), touched = vi.fn();
    try {
      const valid = {schema: db.schema, tenantId, principalId, workerId: "worker-a",
        instanceId: "instance-a", allowedRepositories: [scope.repositoryId],
        allowedServices: [scope.serviceId], preflightAuthorize: async () => true,
        authorizeCapture, verificationPortFactory: async () => ({verify: async () => touched()})};
      const accessor = Object.defineProperty({...valid}, "verificationPortFactory",
        {enumerable: true, get: () => { touched(); return valid.verificationPortFactory; }});
      expect(() => createCaptureVerificationRunner(db.pool, accessor as never))
        .toThrowError(expect.objectContaining({code: "INVALID_CAPTURE_RUNNER_CONFIGURATION"}));
      const proxy = new Proxy(valid, {getOwnPropertyDescriptor: () => { throw Error("private-canary"); }});
      expect(() => createCaptureVerificationRunner(db.pool, proxy))
        .toThrowError(expect.objectContaining({code: "INVALID_CAPTURE_RUNNER_CONFIGURATION"}));
      expect(touched).not.toHaveBeenCalled();
      expect(connected).not.toHaveBeenCalled();
    } finally { connected.mockRestore(); }
  } finally { await db.cleanup(); }
});

test("database faults before verification and during heartbeat remain fixed transient results", async () => {
  for (const faultAt of [2, 3]) {
    const {db, schema, authorizeCapture} = await setup();
    const pause = gate();
    try {
      await admit(db, authorizeCapture);
      const original = db.pool.connect.bind(db.pool);
      let calls = 0;
      const connect = vi.spyOn(db.pool, "connect").mockImplementation((async () => {
        calls += 1;
        if (calls === faultAt) throw Error("PRIVATE_DB_CANARY");
        return original();
      }) as never);
      let result: Awaited<ReturnType<ReturnType<typeof runner>["runOne"]>>;
      try {
        const running = runner(db, authorizeCapture, async (identity, receipt, signer) => {
          pause.entered(); await pause.waiting; return verified(identity, receipt, signer);
        }, 100).runOne();
        if (faultAt === 3) {
          await pause.started;
          await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
          pause.release();
        }
        result = await running;
      } finally { pause.release(); connect.mockRestore(); }
      expect(result).toMatchObject({kind: "deferred", reason: "transient"});
      expect(JSON.stringify(result)).not.toContain("PRIVATE_DB_CANARY");
      expect(await counts(db, schema)).toEqual({verified: "0", snapshots: "0", pointers: "0"});
    } finally { pause.release(); await db.cleanup(); }
  }
});

test("DB-local capture permission faults before and after verification suppress 0007 with fixed transient output", async () => {
  for (const faultAt of [2, 4]) {
    const {db, schema, authorizeCapture} = await setup();
    try {
      await admit(db, authorizeCapture);
      let calls = 0;
      const faultyAuthorize: typeof authorizeCapture = async (client, binding) => {
        calls += 1;
        if (calls === faultAt) throw Error("PRIVATE_AUTHORIZER_CANARY");
        return authorizeCapture(client, binding);
      };
      const output = await runner(db, faultyAuthorize, async (identity, receipt, signer) =>
        verified(identity, receipt, signer)).runOne();
      expect(calls).toBe(faultAt);
      expect(output).toMatchObject({kind: "deferred", reason: "transient"});
      expect(JSON.stringify(output)).not.toContain("PRIVATE_AUTHORIZER_CANARY");
      expect(await counts(db, schema)).toEqual({verified: "0", snapshots: "0", pointers: "0"});
    } finally { await db.cleanup(); }
  }
});
