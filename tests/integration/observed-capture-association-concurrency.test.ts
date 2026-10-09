import {createHash, generateKeyPairSync, sign} from "node:crypto";
import type {PoolClient} from "pg";
import {expect, test} from "vitest";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createObservedCaptureAssociationStore} from "../../packages/orchestration/src/observed-captures.js";
import type {ObservedCaptureScope} from "../../packages/orchestration/src/observed-captures.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";

const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const baseScope: ObservedCaptureScope = {tenantId: "tenant-capture-a", repositoryId: "repository-capture", serviceId: "service-capture",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`, environment: "uat"};
const keys = generateKeyPairSync("ed25519");
const keyText = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const signerDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));

const signedReceipt = (sessionId: string): string => {
  const payload = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: baseScope.repositoryId,
    service_id: baseScope.serviceId, immutable_revision: baseScope.immutableRevision,
    source_digest: baseScope.sourceDigest, environment: baseScope.environment, session_id: sessionId,
    captured_at: "2026-10-08T16:00:00.000Z", node_version: "22.19.0",
    router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: []}));
  return JSON.stringify({payload: payload.toString("base64"),
    signature: sign(null, payload, keys.privateKey).toString("base64")});
};

const resolverFor = (text: string, scope = baseScope) => createRuntimeCapturePinResolver({
  binding: {scope, artifactRef: "capture:concurrency-receipt", configuredKeyRef: "key:concurrency-test",
    expectedReceiptDigest: hash(text), expectedSignerSpkiDigest: signerDigest, policyVersion: "runtime-capture-pin-1"},
  authorize: async () => true,
  readReceipt: async () => text,
  readKey: async () => keyText,
});

const storeFor = (db: Awaited<ReturnType<typeof createCatalogTestDatabase>>, text: string,
  scope = baseScope, transactionAuthorize: (client: PoolClient, selected: ObservedCaptureScope) => Promise<boolean>
    = async () => true) => createObservedCaptureAssociationStore(db.pool, {
  schema: db.schema,
  preflightAuthorize: async selected => selected.tenantId === scope.tenantId,
  transactionAuthorize,
  pinResolver: resolverFor(text, scope),
});

test("concurrent appends of one signed receipt produce one inserted and one existing row", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const text = signedReceipt("same-concurrent-receipt");
    const store = storeFor(db, text);
    const results = await Promise.all([store.append(baseScope), store.append(baseScope)]);
    expect(results.map(result => result.outcome).sort()).toEqual(["existing", "inserted"]);
    expect(results[0]!.captureIdentityDigest).toBe(results[1]!.captureIdentityDigest);
    const rows = await db.pool.query<{count: string; receipt_digest: string}>(
      `SELECT count(*)::text AS count,min(receipt_digest) AS receipt_digest
       FROM ${schema}.orchestration_observed_capture_associations WHERE tenant_id=$1`, [baseScope.tenantId]);
    expect(rows.rows).toEqual([{count: "1", receipt_digest: hash(text)}]);
  } finally { await db.cleanup(); }
});

test("separate authorized tenants retain isolated identities for the same signed receipt", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const tenantA = baseScope;
    const tenantB = {...baseScope, tenantId: "tenant-capture-b"};
    const text = signedReceipt("same-receipt-cross-tenant");
    const [a, b] = await Promise.all([
      storeFor(db, text, tenantA).append(tenantA),
      storeFor(db, text, tenantB).append(tenantB),
    ]);
    expect(a.outcome).toBe("inserted");
    expect(b.outcome).toBe("inserted");
    expect(a.captureIdentityDigest).not.toBe(b.captureIdentityDigest);
    const rows = await db.pool.query<{tenant_id: string; capture_identity_digest: string; receipt_digest: string}>(
      `SELECT tenant_id,capture_identity_digest,receipt_digest
       FROM ${schema}.orchestration_observed_capture_associations ORDER BY tenant_id`);
    expect(rows.rows).toEqual([
      {tenant_id: tenantA.tenantId, capture_identity_digest: a.captureIdentityDigest, receipt_digest: hash(text)},
      {tenant_id: tenantB.tenantId, capture_identity_digest: b.captureIdentityDigest, receipt_digest: hash(text)},
    ]);
  } finally { await db.cleanup(); }
});

test("DB-local grant lock serializes revocation with append; later append is denied", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  let releaseAuthorization!: () => void;
  let signalAuthorizationLocked!: () => void;
  const authorizationGate = new Promise<void>(resolve => { releaseAuthorization = resolve; });
  const authorizationLocked = new Promise<void>(resolve => { signalAuthorizationLocked = resolve; });
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_grants
      (tenant_id text PRIMARY KEY, allowed boolean NOT NULL)`);
    await db.pool.query(`INSERT INTO ${schema}.trusted_capture_grants VALUES ($1,true)`, [baseScope.tenantId]);
    let firstAuthorization = true;
    const transactionAuthorize = async (client: PoolClient,
      selected: ObservedCaptureScope): Promise<boolean> => {
      const grant = await client.query<{allowed: boolean}>(
        `SELECT allowed FROM trusted_capture_grants WHERE tenant_id=$1 FOR SHARE`, [selected.tenantId]);
      if (firstAuthorization) {
        firstAuthorization = false;
        signalAuthorizationLocked();
        await authorizationGate;
      }
      return grant.rows[0]?.allowed === true;
    };
    const store = storeFor(db, signedReceipt("grant-lock-receipt"), baseScope, transactionAuthorize);
    const append = store.append(baseScope);
    await authorizationLocked;

    const revoker = await db.pool.connect();
    let revokeFinished = false;
    let releaseGate = false;
    let committed = false;
    try {
      await revoker.query("BEGIN");
      await revoker.query("SET LOCAL lock_timeout = '5s'");
      const pid = (await revoker.query<{pid: number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const revoke = revoker.query(`UPDATE ${schema}.trusted_capture_grants SET allowed=false WHERE tenant_id=$1`,
        [baseScope.tenantId]).then(() => { revokeFinished = true; });

      let observedLockWait = false;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const activity = await db.pool.query<{wait_event_type: string | null}>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
        if (activity.rows[0]?.wait_event_type === "Lock") { observedLockWait = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true);
      expect(revokeFinished).toBe(false);
      releaseAuthorization();
      releaseGate = true;
      await expect(append).resolves.toMatchObject({outcome: "inserted"});
      await revoke;
      await revoker.query("COMMIT");
      committed = true;
    } finally {
      if (!releaseGate) releaseAuthorization();
      if (!committed) await revoker.query("ROLLBACK").catch(() => undefined);
      revoker.release();
    }

    await expect(store.append(baseScope)).rejects.toMatchObject({code: "CAPTURE_ASSOCIATION_UNAUTHORIZED"});
    const rows = await db.pool.query<{count: string}>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_observed_capture_associations`);
    expect(rows.rows).toEqual([{count: "1"}]);
  } finally {
    releaseAuthorization();
    await db.cleanup();
  }
});
