import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {expect, test, vi} from "vitest";
import {createRuntimeCapturePinResolver, RuntimeCapturePinError} from "../../connectors/git-source/src/runtime-capture-pin.js";

const hash = (data: string | Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const spkiDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));
const scope = {tenantId: "tenant", repositoryId: "repository", serviceId: "service",
  immutableRevision: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}`, environment: "test"};
const receipt = (changes: Record<string, unknown> = {}) => ({version: "1.0.0", repository_id: scope.repositoryId,
  service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
  environment: scope.environment, session_id: "session-1", captured_at: "2026-10-08T16:00:00.000Z",
  node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
  runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: [], ...changes});
const signed = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64")});
};
const goodReceipt = signed(receipt());
const binding = {scope, artifactRef: "capture:receipt-1", configuredKeyRef: "key:approved-1",
  expectedReceiptDigest: hash(goodReceipt), expectedSignerSpkiDigest: spkiDigest, policyVersion: "runtime-capture-pin-1" as const};
function harness(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const authorize = vi.fn(async () => { events.push("authorize"); return true; });
  const readReceipt = vi.fn(async () => { events.push("receipt"); return goodReceipt; });
  const readKey = vi.fn(async () => { events.push("key"); return publicKey; });
  const resolver = createRuntimeCapturePinResolver({binding, authorize, readReceipt, readKey, ...overrides});
  return {resolver, authorize, readReceipt, readKey, events};
}

test("host-bound receipt and signer pin only provenance, after explicit authorization", async () => {
  const {resolver, readReceipt, readKey, events} = harness();
  const result = await resolver.resolve(scope);
  expect(events).toEqual(["authorize", "receipt", "key", "authorize"]);
  expect(readReceipt).toHaveBeenCalledWith(binding.artifactRef, expect.any(AbortSignal));
  expect(readKey).toHaveBeenCalledWith(binding.configuredKeyRef, expect.any(AbortSignal));
  expect(result).toMatchObject({kind: "pinned_envelope", receiptDigest: hash(goodReceipt),
    signerSpkiDigest: spkiDigest, artifactRef: binding.artifactRef,
    configuredKeyRef: binding.configuredKeyRef, scope, policyVersion: binding.policyVersion});
  expect(result.identityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("BEGIN PUBLIC KEY");
  expect(JSON.stringify(result)).not.toContain("payload");
  expect(JSON.stringify(result)).not.toContain("bindings");
});

test("scope and authorization are checked before protected reads", async () => {
  const h = harness();
  await expect(h.resolver.resolve({...scope, environment: "production"})).rejects.toMatchObject({code: "INVALID_CAPTURE_PIN_REQUEST"});
  expect(h.authorize).not.toHaveBeenCalled();
  expect(h.readReceipt).not.toHaveBeenCalled();
  const denied = harness({authorize: vi.fn(async () => false)});
  await expect(denied.resolver.resolve(scope)).rejects.toMatchObject({code: "CAPTURE_NOT_AUTHORIZED"});
  expect(denied.readReceipt).not.toHaveBeenCalled();
});

test.each(["artifactRef", "configuredKeyRef"])("committed path cannot be a protected %s", field => {
  expect(() => harness({binding: {...binding, [field]: "api-truth.runtime-binding.json"}}))
    .toThrowError(RuntimeCapturePinError);
  expect(() => harness({binding: {...binding, [field]: "source:api/controllers/key.pem"}}))
    .toThrowError(RuntimeCapturePinError);
});

test("signed substitution, attacker key, and tamper cannot satisfy fixed hashes", async () => {
  for (const replacement of [signed(receipt({session_id: "other"})), goodReceipt.replace("payload", "payloAd")]) {
    const h = harness({readReceipt: async () => replacement});
    await expect(h.resolver.resolve(scope))
      .rejects.toMatchObject({code: "CAPTURE_RECEIPT_UNVERIFIED"});
    expect(h.readKey).not.toHaveBeenCalled();
  }
  const attacker = generateKeyPairSync("ed25519").publicKey.export({type: "spki", format: "pem"}).toString();
  await expect(harness({readKey: async () => attacker}).resolver.resolve(scope))
    .rejects.toMatchObject({code: "CAPTURE_RECEIPT_UNVERIFIED"});
});

test("valid signature with wrong context and malformed shape remains unverified", async () => {
  for (const value of [receipt({environment: "production"}), receipt({node_version: "24"}),
    receipt({router_digest: `sha256:${"d".repeat(64)}`}), receipt({extra: "secret-canary"})]) {
    const replacement = signed(value);
    const h = harness({binding: {...binding, expectedReceiptDigest: hash(replacement)}, readReceipt: async () => replacement});
    await expect(h.resolver.resolve(scope)).rejects.toMatchObject({code: "CAPTURE_RECEIPT_UNVERIFIED"});
  }
});

test("oversize, duplicate JSON keys, malformed signature, and provider errors have fixed safe errors", async () => {
  for (const replacement of ["x".repeat(1_000_001), '{"payload":"a","payload":"b","signature":"c"}',
    JSON.stringify({payload: Buffer.from(JSON.stringify(receipt())).toString("base64"), signature: "not-base64"})]) {
    const h = harness({binding: {...binding, expectedReceiptDigest: hash(replacement)}, readReceipt: async () => replacement});
    await expect(h.resolver.resolve(scope)).rejects.toMatchObject({code: "CAPTURE_RECEIPT_UNVERIFIED"});
  }
  await expect(harness({readReceipt: async () => { throw Error("secret-canary"); }}).resolver.resolve(scope))
    .rejects.toMatchObject({code: "CAPTURE_SOURCE_UNAVAILABLE", message: "Capture source unavailable"});
});

test("accessors and throwing proxies cannot invoke trusted ports", async () => {
  const h = harness();
  const hostile = Object.defineProperty({...scope}, "environment", {get: () => { throw Error("secret-canary"); }});
  await expect(h.resolver.resolve(hostile)).rejects.toMatchObject({code: "INVALID_CAPTURE_PIN_REQUEST"});
  await expect(h.resolver.resolve(new Proxy(scope, {ownKeys: () => { throw Error("secret-canary"); }})))
    .rejects.toMatchObject({code: "INVALID_CAPTURE_PIN_REQUEST"});
  expect(h.authorize).not.toHaveBeenCalled();
  expect(h.readReceipt).not.toHaveBeenCalled();
  expect(() => harness({binding: Object.defineProperty({...binding}, "artifactRef", {get: () => { throw Error("secret-canary"); }})}))
    .toThrowError(RuntimeCapturePinError);
});

test("transparent proxies are rejected without invoking inspection traps", async () => {
  const h = harness();
  const trap = vi.fn(() => Reflect.ownKeys(scope));
  const proxy = new Proxy(scope, {ownKeys: trap});
  await expect(h.resolver.resolve(proxy)).rejects.toMatchObject({code: "INVALID_CAPTURE_PIN_REQUEST"});
  expect(trap).not.toHaveBeenCalled();
  expect(h.authorize).not.toHaveBeenCalled();
  const configured = new Proxy(binding, {ownKeys: trap});
  expect(() => harness({binding: configured})).toThrowError(RuntimeCapturePinError);
  expect(trap).not.toHaveBeenCalled();
});

test("authorization is rechecked after protected reads and revocation withholds the pin", async () => {
  let active = true;
  const authorize = vi.fn(async () => active);
  const h = harness({authorize, readReceipt: async () => { active = false; return goodReceipt; }});
  await expect(h.resolver.resolve(scope)).rejects.toMatchObject({code: "CAPTURE_NOT_AUTHORIZED"});
  expect(authorize).toHaveBeenCalledTimes(2);
});

test.each(["authorize", "readReceipt", "readKey", "secondAuthorize"])("total deadline bounds stalled %s", async phase => {
  let calls = 0;
  const never = (_scope: unknown, signal: AbortSignal) => new Promise<never>(() => {
    signal.addEventListener("abort", () => { /* the host port must cancel its own I/O */ }, {once: true});
  });
  const h = harness({timeoutMs: 20,
    ...(phase === "authorize" || phase === "secondAuthorize" ? {authorize: async (value: unknown, signal: AbortSignal) => {
      calls += 1;
      return phase === "secondAuthorize" && calls === 1 ? true : never(value, signal);
    }} : {}),
    ...(phase === "readReceipt" ? {readReceipt: (_ref: string, signal: AbortSignal) => never("", signal)} : {}),
    ...(phase === "readKey" ? {readKey: (_ref: string, signal: AbortSignal) => never("", signal)} : {})});
  const outcome = h.resolver.resolve(scope);
  await expect(outcome).rejects.toMatchObject({code: phase.includes("Authorize") || phase === "authorize"
    ? "CAPTURE_NOT_AUTHORIZED" : "CAPTURE_SOURCE_UNAVAILABLE"});
  await delay(1);
  expect(calls).toBeLessThanOrEqual(2);
});

test("invalid trusted deadline is rejected before any source call", () => {
  for (const timeoutMs of [0, 30_001, Number.POSITIVE_INFINITY, "20"]) {
    expect(() => harness({timeoutMs})).toThrowError(RuntimeCapturePinError);
  }
});
