import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {expect, test, vi} from "vitest";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createObservedCaptureAssociationStore} from "../../packages/orchestration/src/observed-captures.js";
import {createObservedCaptureVerificationStore} from "../../packages/orchestration/src/observed-capture-verifications.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";

const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const scope = {tenantId: "tenant", repositoryId: "repository", serviceId: "service",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`, environment: "test"};
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const signerDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));
function fixture(session: string) {
  const bytes = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: scope.repositoryId,
    service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
    environment: scope.environment, session_id: session, captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: []}));
  const text = JSON.stringify({payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64")});
  const pinResolver = createRuntimeCapturePinResolver({binding: {scope, artifactRef: "capture:fixture",
    configuredKeyRef: "key:fixture", expectedReceiptDigest: hash(text), expectedSignerSpkiDigest: signerDigest,
    policyVersion: "runtime-capture-pin-1"}, authorize: async () => true,
    readReceipt: async () => text, readKey: async () => publicKey});
  return {text, pinResolver};
}
const verified = (captureIdentityDigest: string, receiptDigest: string) => ({kind: "verified_handler_bytes" as const,
  scope, serviceRoot: ".", captureIdentityDigest, receiptDigest, signerSpkiDigest: signerDigest,
  sourceDigest: scope.sourceDigest, handlers: [{method: "GET", applicationPath: "/orders/{id}", controller: "orders",
    operationId: "readOrder", handlerPath: "api/controllers/orders.js", handlerDigest: `sha256:${"d".repeat(64)}`,
    exportName: "readOrder"}], limitations: ["Document operation correspondence and deployment are unverified"] as const});
async function associate(db: Awaited<ReturnType<typeof createCatalogTestDatabase>>, session: string) {
  const {text, pinResolver} = fixture(session);
  const store = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
    preflightAuthorize: async () => true, transactionAuthorize: async () => true, pinResolver});
  const associated = await store.append(scope);
  return {captureIdentityDigest: associated.captureIdentityDigest, receiptDigest: hash(text)};
}

test("distinct capture IDs have separate immutable verified-byte summaries and exact replay", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const first = await associate(db, "first"), second = await associate(db, "second");
    const create = (item: typeof first) => createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => verified(item.captureIdentityDigest, item.receiptDigest)}});
    const a = await create(first).append({scope, captureIdentityDigest: first.captureIdentityDigest});
    const replay = await create(first).append({scope, captureIdentityDigest: first.captureIdentityDigest});
    const b = await create(second).append({scope, captureIdentityDigest: second.captureIdentityDigest});
    expect(a).toMatchObject({outcome: "inserted", verifierProfileVersion: "protected-handler-bytes-1",
      resultDigest: expect.stringMatching(/^sha256:/), handlerCount: 1});
    expect(replay).toEqual({...a, outcome: "existing"});
    expect(b).toMatchObject({outcome: "inserted"});
    expect(a.captureIdentityDigest).not.toBe(b.captureIdentityDigest);
    const rows = await db.pool.query<{result_digest: string; handler_count: number; document: unknown}>(
      `SELECT result_digest,handler_count,to_jsonb(row.*) AS document
       FROM ${schema}.orchestration_observed_capture_verifications row ORDER BY capture_identity_digest`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every(row => row.handler_count === 1)).toBe(true);
    const stored = JSON.stringify(rows.rows);
    expect(stored).not.toContain("api/controllers/orders.js");
    expect(stored).not.toContain("/orders/{id}");
    const pointers = await db.pool.query<{revisions: string; branches: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots) AS revisions,
       (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS branches`);
    expect(pointers.rows).toEqual([{revisions: "0", branches: "0"}]);
    await expect(db.pool.query(`UPDATE ${schema}.orchestration_observed_capture_verifications
      SET handler_count=2 WHERE tenant_id=$1`, [scope.tenantId])).rejects.toThrow();
    await expect(db.pool.query(`DELETE FROM ${schema}.orchestration_observed_capture_verifications`)).rejects.toThrow();
  } finally { await db.cleanup(); }
});

test("denied or missing parent cannot invoke verifier; revocation and mismatched output persist nothing", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const parent = await associate(db, "authorized");
    const verify = vi.fn(async () => verified(parent.captureIdentityDigest, parent.receiptDigest));
    const denied = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => false, transactionAuthorize: async () => true, verificationPort: {verify}});
    await expect(denied.append({scope, captureIdentityDigest: parent.captureIdentityDigest}))
      .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNAUTHORIZED"});
    const allowed = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true, verificationPort: {verify}});
    await expect(allowed.append({scope, captureIdentityDigest: `sha256:${"f".repeat(64)}`}))
      .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNAUTHORIZED"});
    await expect(allowed.append({scope: {...scope, tenantId: "other"}, captureIdentityDigest: parent.captureIdentityDigest}))
      .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNAUTHORIZED"});
    expect(verify).not.toHaveBeenCalled();
    await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_grants (tenant_id text PRIMARY KEY, allowed boolean NOT NULL)`);
    await db.pool.query(`INSERT INTO ${schema}.trusted_capture_grants VALUES ($1,true)`, [scope.tenantId]);
    const transactionAuthorize = async (client: import("pg").PoolClient) => {
      const row = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_capture_grants WHERE tenant_id=$1 FOR SHARE`, [scope.tenantId]);
      return row.rows[0]?.allowed === true;
    };
    const revoked = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize,
      verificationPort: {verify: async () => {
        await db.pool.query(`UPDATE ${schema}.trusted_capture_grants SET allowed=false WHERE tenant_id=$1`, [scope.tenantId]);
        return verified(parent.captureIdentityDigest, parent.receiptDigest);
      }}});
    await expect(revoked.append({scope, captureIdentityDigest: parent.captureIdentityDigest}))
      .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNAUTHORIZED"});
    const mismatched = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => verified(parent.captureIdentityDigest, `sha256:${"e".repeat(64)}`)}});
    await expect(mismatched.append({scope, captureIdentityDigest: parent.captureIdentityDigest}))
      .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNVERIFIED"});
    const count = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count FROM ${schema}.orchestration_observed_capture_verifications`);
    expect(count.rows).toEqual([{count: "0"}]);
  } finally { await db.cleanup(); }
});

test("changed verified result at same capture/profile conflicts; hostile request is inert", async () => {
  const db = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const parent = await associate(db, "collision");
    const input = {scope, captureIdentityDigest: parent.captureIdentityDigest};
    const original = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => verified(parent.captureIdentityDigest, parent.receiptDigest)}});
    await original.append(input);
    const changed = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => ({...verified(parent.captureIdentityDigest, parent.receiptDigest),
        handlers: [{...verified(parent.captureIdentityDigest, parent.receiptDigest).handlers[0]!,
          handlerDigest: `sha256:${"e".repeat(64)}`} ]})}});
    await expect(changed.append(input)).rejects.toMatchObject({code: "CAPTURE_VERIFICATION_CONFLICT"});
    const differentRoot = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => ({...verified(parent.captureIdentityDigest, parent.receiptDigest), serviceRoot: "service"})}});
    await expect(differentRoot.append(input)).rejects.toMatchObject({code: "CAPTURE_VERIFICATION_CONFLICT"});
    const hostileOutput = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => ({...verified(parent.captureIdentityDigest, parent.receiptDigest),
        handlers: [new Proxy(verified(parent.captureIdentityDigest, parent.receiptDigest).handlers[0]!, {
          getOwnPropertyDescriptor: () => { throw Error("private-result-canary"); }} )]})}});
    await expect(hostileOutput.append(input)).rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNVERIFIED"});
    const hostile = new Proxy(input, {getOwnPropertyDescriptor: () => { throw Error("private-canary"); }});
    await expect(original.append(hostile)).rejects.toMatchObject({code: "INVALID_CAPTURE_VERIFICATION_REQUEST"});
  } finally { await db.cleanup(); }
});

test("corrupted parent pin identity is refused before external verification", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const parent = await associate(db, "corrupt");
    await db.pool.query(`ALTER TABLE ${schema}.orchestration_observed_capture_associations DISABLE TRIGGER
      orchestration_observed_capture_associations_immutable`);
    await db.pool.query(`UPDATE ${schema}.orchestration_observed_capture_associations
      SET receipt_digest=$1 WHERE tenant_id=$2 AND capture_identity_digest=$3`,
    [`sha256:${"f".repeat(64)}`, scope.tenantId, parent.captureIdentityDigest]);
    const verify = vi.fn(async () => verified(parent.captureIdentityDigest, parent.receiptDigest));
    const store = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true, verificationPort: {verify}});
    await expect(store.append({scope, captureIdentityDigest: parent.captureIdentityDigest}))
      .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNAUTHORIZED"});
    expect(verify).not.toHaveBeenCalled();
  } finally { await db.cleanup(); }
});

test("oversized handler arrays are refused before bulk descriptor enumeration", async () => {
  const db = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const parent = await associate(db, "oversized");
    const handlers = new Array(1_000_000);
    const inspected = vi.fn();
    const original = Object.getOwnPropertyDescriptors;
    const spy = vi.spyOn(Object, "getOwnPropertyDescriptors").mockImplementation((value: unknown) => {
      if (value === handlers) inspected();
      return original(value);
    });
    try {
      const store = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
        preflightAuthorize: async () => true, transactionAuthorize: async () => true,
        verificationPort: {verify: async () => ({...verified(parent.captureIdentityDigest, parent.receiptDigest), handlers})}});
      await expect(store.append({scope, captureIdentityDigest: parent.captureIdentityDigest}))
        .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNVERIFIED"});
      expect(inspected).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  } finally { await db.cleanup(); }
});
