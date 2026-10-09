import {createHash} from "node:crypto";
import {expect, test, vi} from "vitest";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createObservedCaptureVerificationStore} from "../../packages/orchestration/src/observed-capture-verifications.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const scope = {tenantId: "tenant", repositoryId: "repository", serviceId: "service",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`, environment: "uat"};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const signerSpkiDigest = hash("trusted signer");
async function parent(db: CatalogTestDatabase, name: string) {
  const receiptDigest = hash(`signed receipt:${name}`), artifactRef = `capture:${name}`;
  const configuredKeyRef = "key:trusted";
  const captureIdentityDigest = hash(canonicalJsonStringify({policyVersion: "runtime-capture-pin-1", scope,
    artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest}));
  await db.pool.query(`INSERT INTO ${quoteCatalogTestSchema(db.schema)}.orchestration_observed_capture_associations
    (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
     policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'runtime-capture-pin-1',$8,$9,$10,$11)`,
  [scope.tenantId, captureIdentityDigest, scope.repositoryId, scope.serviceId, scope.immutableRevision,
    scope.sourceDigest, scope.environment, artifactRef, configuredKeyRef, receiptDigest, signerSpkiDigest]);
  return {captureIdentityDigest, receiptDigest};
}
const verified = (captureIdentityDigest: string, receiptDigest: string) => ({kind: "verified_handler_bytes" as const,
  scope, serviceRoot: "services/api", captureIdentityDigest, receiptDigest, signerSpkiDigest,
  sourceDigest: scope.sourceDigest, handlers: [{method: "GET", applicationPath: "/orders/{id}", controller: "orders",
    operationId: "readOrder", handlerPath: "controllers/orders.js", handlerDigest: hash("handler"),
    exportName: "readOrder"}], limitations: ["Document operation correspondence and deployment are unverified"] as const});
async function setup() {
  const db = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(db.pool, {schema: db.schema});
  const schema = quoteCatalogTestSchema(db.schema);
  await db.pool.query(`CREATE TABLE ${schema}.trusted_finalize_markers (
    marker_id text PRIMARY KEY, outcome text NOT NULL, result_digest text NOT NULL)`);
  return {db, schema};
}
const baseOptions = (db: CatalogTestDatabase, captureIdentityDigest: string, receiptDigest: string) => ({
  schema: db.schema, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
  verificationPort: {verify: async () => verified(captureIdentityDigest, receiptDigest)}});

test("successful finalizer sees the inserted 0007 row and commits its marker atomically", async () => {
  const {db, schema} = await setup();
  try {
    const pin = await parent(db, "success");
    const finalizer = vi.fn(async (client: import("pg").PoolClient, receivedScope: typeof scope,
      receipt: {outcome: string; captureIdentityDigest: string; resultDigest: string; handlerCount: number}) => {
      expect(Object.isFrozen(receivedScope)).toBe(true);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(receivedScope).toEqual(scope);
      expect(receipt).toMatchObject({outcome: "inserted", captureIdentityDigest: pin.captureIdentityDigest,
        handlerCount: 1, resultDigest: expect.stringMatching(/^sha256:/)});
      const visible = await client.query(`SELECT 1 FROM orchestration_observed_capture_verifications
        WHERE tenant_id=$1 AND capture_identity_digest=$2 AND result_digest=$3`,
      [scope.tenantId, pin.captureIdentityDigest, receipt.resultDigest]);
      expect(visible.rowCount).toBe(1);
      await client.query(`INSERT INTO trusted_finalize_markers VALUES ($1,$2,$3)`,
        [pin.captureIdentityDigest, receipt.outcome, receipt.resultDigest]);
      return true;
    });
    const store = createObservedCaptureVerificationStore(db.pool, {...baseOptions(db, pin.captureIdentityDigest, pin.receiptDigest),
      transactionFinalize: finalizer});
    const receipt = await store.append({scope, captureIdentityDigest: pin.captureIdentityDigest});
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(receipt.outcome).toBe("inserted");
    const rows = await db.pool.query<{outcome: string; result_digest: string}>(
      `SELECT outcome,result_digest FROM ${schema}.trusted_finalize_markers`);
    expect(rows.rows).toEqual([{outcome: "inserted", result_digest: receipt.resultDigest}]);
  } finally { await db.cleanup(); }
});

test("false and throwing finalizers roll back both new verification and trusted writes", async () => {
  const {db, schema} = await setup();
  try {
    const rejected = await parent(db, "false"), thrown = await parent(db, "throw");
    const make = (pin: typeof rejected, action: "false" | "throw") => createObservedCaptureVerificationStore(db.pool,
      {...baseOptions(db, pin.captureIdentityDigest, pin.receiptDigest),
        transactionFinalize: async (client: import("pg").PoolClient, _selected: typeof scope,
          receipt: {outcome: string; resultDigest: string}) => {
          await client.query(`INSERT INTO trusted_finalize_markers VALUES ($1,$2,$3)`,
            [pin.captureIdentityDigest, receipt.outcome, receipt.resultDigest]);
          if (action === "throw") throw Error("PRIVATE_FINALIZER_CANARY");
          return false;
        }});
    await expect(make(rejected, "false").append({scope, captureIdentityDigest: rejected.captureIdentityDigest}))
      .rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNAUTHORIZED"});
    const error = await make(thrown, "throw").append({scope,
      captureIdentityDigest: thrown.captureIdentityDigest}).catch((value: unknown) => value);
    expect(error).toMatchObject({code: "CAPTURE_VERIFICATION_STORAGE_ERROR"});
    expect(JSON.stringify(error)).not.toContain("PRIVATE_FINALIZER_CANARY");
    const counts = await db.pool.query<{verified: string; markers: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_observed_capture_verifications) AS verified,
       (SELECT count(*)::text FROM ${schema}.trusted_finalize_markers) AS markers`);
    expect(counts.rows).toEqual([{verified: "0", markers: "0"}]);
  } finally { await db.cleanup(); }
});

test("exact replay invokes finalizer with existing outcome and a failed replay leaves prior row", async () => {
  const {db, schema} = await setup();
  try {
    const pin = await parent(db, "replay");
    const request = {scope, captureIdentityDigest: pin.captureIdentityDigest};
    await createObservedCaptureVerificationStore(db.pool, baseOptions(db, pin.captureIdentityDigest, pin.receiptDigest))
      .append(request);
    const store = createObservedCaptureVerificationStore(db.pool, {...baseOptions(db, pin.captureIdentityDigest, pin.receiptDigest),
      transactionFinalize: async (client, _scope, receipt) => {
        expect(receipt.outcome).toBe("existing");
        await client.query(`INSERT INTO trusted_finalize_markers VALUES ($1,$2,$3)`,
          [pin.captureIdentityDigest, receipt.outcome, receipt.resultDigest]);
        return true;
      }});
    expect(await store.append(request)).toMatchObject({outcome: "existing"});
    const failedReplay = createObservedCaptureVerificationStore(db.pool, {...baseOptions(db, pin.captureIdentityDigest, pin.receiptDigest),
      transactionFinalize: async (client, _scope, receipt) => {
        await client.query(`UPDATE trusted_finalize_markers SET outcome='private-transient' WHERE marker_id=$1`,
          [pin.captureIdentityDigest]);
        expect(receipt.outcome).toBe("existing");
        return false;
      }});
    await expect(failedReplay.append(request)).rejects.toMatchObject({code: "CAPTURE_VERIFICATION_UNAUTHORIZED"});
    const rows = await db.pool.query<{verified: string; outcome: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_observed_capture_verifications) AS verified,
       (SELECT outcome FROM ${schema}.trusted_finalize_markers WHERE marker_id=$1) AS outcome`,
    [pin.captureIdentityDigest]);
    expect(rows.rows).toEqual([{verified: "1", outcome: "existing"}]);
  } finally { await db.cleanup(); }
});

test("accessor or proxy finalizer configuration is rejected before pool access", async () => {
  const {db} = await setup();
  try {
    const pin = await parent(db, "hostile");
    const touched = vi.fn();
    const accessor = Object.defineProperty({...baseOptions(db, pin.captureIdentityDigest, pin.receiptDigest)},
      "transactionFinalize", {enumerable: true, get: () => { touched(); return async () => true; }});
    const connect = vi.spyOn(db.pool, "connect");
    try {
      expect(() => createObservedCaptureVerificationStore(db.pool, accessor as never))
        .toThrowError(expect.objectContaining({code: "INVALID_CAPTURE_VERIFICATION_REQUEST"}));
      const proxy = new Proxy({...baseOptions(db, pin.captureIdentityDigest, pin.receiptDigest),
        transactionFinalize: async () => true}, {getOwnPropertyDescriptor: () => { throw Error("PRIVATE_PROXY_CANARY"); }});
      expect(() => createObservedCaptureVerificationStore(db.pool, proxy))
        .toThrowError(expect.objectContaining({code: "INVALID_CAPTURE_VERIFICATION_REQUEST"}));
      expect(touched).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  } finally { await db.cleanup(); }
});
