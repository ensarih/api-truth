import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {expect, test} from "vitest";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createObservedCaptureAssociationStore} from "../../packages/orchestration/src/observed-captures.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";

const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const scope = {tenantId: "tenant-a", repositoryId: "repository", serviceId: "service",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`, environment: "uat"};
const keys = generateKeyPairSync("ed25519");
const keyText = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const keyDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));
const receipt = (session: string) => {
  const bytes = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: scope.repositoryId,
    service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
    environment: scope.environment, session_id: session, captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: []}));
  return JSON.stringify({payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64")});
};
const pinResolver = (text: string, selected = scope) => createRuntimeCapturePinResolver({binding: {scope: selected, artifactRef: "capture:receipt-1",
  configuredKeyRef: "key:approved-1", expectedReceiptDigest: hash(text), expectedSignerSpkiDigest: keyDigest,
  policyVersion: "runtime-capture-pin-1"}, authorize: async () => true,
  readReceipt: async () => text, readKey: async () => keyText});

test("append-only capture identity retains two receipts at one revision without promoting pointers", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const grant = async () => true;
    const firstText = receipt("session-1"), secondText = receipt("session-2");
    const first = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: grant, transactionAuthorize: async () => true, pinResolver: pinResolver(firstText)});
    const second = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: grant, transactionAuthorize: async () => true, pinResolver: pinResolver(secondText)});
    const a = await first.append(scope), replay = await first.append(scope), b = await second.append(scope);
    expect(a).toMatchObject({outcome: "inserted", captureIdentityDigest: expect.stringMatching(/^sha256:/)});
    expect(replay).toEqual({...a, outcome: "existing"});
    expect(b).toMatchObject({outcome: "inserted"});
    expect(b.captureIdentityDigest).not.toBe(a.captureIdentityDigest);
    const rows = await db.pool.query<{capture_identity_digest: string; receipt_digest: string}>(
      `SELECT capture_identity_digest,receipt_digest FROM ${schema}.orchestration_observed_capture_associations
       WHERE tenant_id=$1 ORDER BY capture_identity_digest`, [scope.tenantId]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map(row => row.receipt_digest).sort()).toEqual([hash(firstText), hash(secondText)].sort());
    const tenantB = {...scope, tenantId: "tenant-b"};
    const isolated = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: grant, transactionAuthorize: async () => true, pinResolver: pinResolver(firstText, tenantB)});
    await isolated.append(tenantB);
    const otherRows = await db.pool.query<{tenant_id: string}>(
      `SELECT tenant_id FROM ${schema}.orchestration_observed_capture_associations WHERE tenant_id=$1`, [tenantB.tenantId]);
    expect(otherRows.rows).toEqual([{tenant_id: "tenant-b"}]);
    const pointers = await db.pool.query<{revisions: string; branches: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots) AS revisions,
       (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS branches`);
    expect(pointers.rows).toEqual([{revisions: "0", branches: "0"}]);
    await expect(db.pool.query(`UPDATE ${schema}.orchestration_observed_capture_associations
      SET environment='production' WHERE capture_identity_digest=$1`, [a.captureIdentityDigest])).rejects.toThrow();
    await expect(db.pool.query(`DELETE FROM ${schema}.orchestration_observed_capture_associations`)).rejects.toThrow();
  } finally { await db.cleanup(); }
});

test("stored identity collision cannot silently alias different receipt fields", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const resolver = pinResolver(receipt("collision"));
    const pin = await resolver.resolve(scope);
    await db.pool.query(`INSERT INTO ${schema}.orchestration_observed_capture_associations
      (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
       policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [scope.tenantId, pin.identityDigest,
      scope.repositoryId, scope.serviceId, scope.immutableRevision, scope.sourceDigest, scope.environment,
      pin.policyVersion, pin.artifactRef, pin.configuredKeyRef, `sha256:${"f".repeat(64)}`, pin.signerSpkiDigest]);
    const store = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true, pinResolver: resolver});
    await expect(store.append(scope)).rejects.toMatchObject({code: "CAPTURE_ASSOCIATION_CONFLICT"});
  } finally { await db.cleanup(); }
});

test("hostile request and host options never invoke callbacks or leak values", async () => {
  const db = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    let calls = 0;
    const options = {schema: db.schema, preflightAuthorize: async () => { calls += 1; return true; },
      transactionAuthorize: async () => true, pinResolver: pinResolver(receipt("safe"))};
    const store = createObservedCaptureAssociationStore(db.pool, options);
    const proxy = new Proxy(scope, {ownKeys: () => { throw Error("secret-canary"); }});
    await expect(store.append(proxy)).rejects.toMatchObject({code: "INVALID_CAPTURE_ASSOCIATION_REQUEST"});
    expect(calls).toBe(0);
    expect(() => createObservedCaptureAssociationStore(db.pool,
      new Proxy(options, {getOwnPropertyDescriptor: () => { throw Error("secret-canary"); }})))
      .toThrowError("Invalid capture association request");
    expect(() => createObservedCaptureAssociationStore(db.pool,
      Object.defineProperty({...options}, "schema", {get: () => { throw Error("secret-canary"); }})))
      .toThrowError("Invalid capture association request");
    expect(calls).toBe(0);
  } finally { await db.cleanup(); }
});

test("writer denial, in-flight revocation, tenant mismatch and pin substitution store nothing", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_grants (tenant_id text PRIMARY KEY, allowed boolean NOT NULL)`);
    await db.pool.query(`INSERT INTO ${schema}.trusted_capture_grants VALUES ($1,true)`, [scope.tenantId]);
    const transactionAuthorize = async (client: import("pg").PoolClient, selected: typeof scope) => {
      const rows = await client.query<{allowed: boolean}>(
        `SELECT allowed FROM trusted_capture_grants WHERE tenant_id=$1 FOR SHARE`, [selected.tenantId]);
      return rows.rows[0]?.allowed === true;
    };
    const denied = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => false, transactionAuthorize, pinResolver: pinResolver(receipt("one"))});
    await expect(denied.append(scope)).rejects.toMatchObject({code: "CAPTURE_ASSOCIATION_UNAUTHORIZED"});
    const text = receipt("two");
    const resolver = pinResolver(text);
    const revoked = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize,
      pinResolver: {resolve: async (selected) => {
        const pin = await resolver.resolve(selected);
        await db.pool.query(`UPDATE ${schema}.trusted_capture_grants SET allowed=false WHERE tenant_id=$1`, [scope.tenantId]);
        return pin;
      }}});
    await expect(revoked.append(scope)).rejects.toMatchObject({code: "CAPTURE_ASSOCIATION_UNAUTHORIZED"});
    const wrongTenant = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async selected => selected.tenantId === scope.tenantId,
      transactionAuthorize, pinResolver: resolver});
    await expect(wrongTenant.append({...scope, tenantId: "tenant-b"}))
      .rejects.toMatchObject({code: "CAPTURE_ASSOCIATION_UNAUTHORIZED"});
    const forged = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      pinResolver: {resolve: async selected => ({...await resolver.resolve(selected), receiptDigest: `sha256:${"f".repeat(64)}`})}});
    await expect(forged.append(scope)).rejects.toMatchObject({code: "CAPTURE_ASSOCIATION_UNVERIFIED"});
    const rows = await db.pool.query<{count: string}>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_observed_capture_associations`);
    expect(rows.rows).toEqual([{count: "0"}]);
  } finally { await db.cleanup(); }
});
