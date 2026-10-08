import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {resolve} from "node:path";
import {expect, test} from "vitest";
import {verifyRuntimeBindings} from "../../analyzers/nodejs/src/runtime-binding.js";
import {digestServiceTree} from "../../analyzers/nodejs/src/source.js";
const root = resolve("/synthetic/service");
const handler = 'exports.getOrder = function() {};';
const files = new Map([[resolve(root, "api/controllers/orders.js"), handler]]);
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const source = {repository_id: "example", service_id: "orders", immutable_revision: "a".repeat(40), source_digest: digestServiceTree(files, root)};
const payload = () => ({version: "1.0.0", ...source, environment: "test", session_id: "session-1",
  captured_at: "2026-10-08T16:00:00.000Z", node_version: "22.19.0", runtime_fingerprint: `sha256:${"b".repeat(64)}`,
  router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
  bindings: [{method: "GET", application_path: "/api/v1/orders/{id}", controller: "orders", operation_id: "getOrder",
    handler_path: "api/controllers/orders.js", export_name: "getOrder", mock_mode: false,
    handler_digest: `sha256:${createHash("sha256").update(handler).digest("hex")}`}],
});
function envelope(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return JSON.stringify({payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64")});
}
const verify = (text = envelope(payload()), key = publicKey) => verifyRuntimeBindings({text, publicKey: key,
  path: "api-truth.runtime-binding.json", source, files, root});

test("trusted runtime receipts bind source revision and handler bytes", () => {
  const result = verify();
  expect(result).toMatchObject({kind: "verified", environment: "test", session_id: "session-1", bindings: payload().bindings});
});

test.each(["immutable_revision", "source_digest", "handler_digest", "mock_mode", "duplicate"])("mismatched runtime proof stays unresolved: %s", field => {
  const value = payload();
  if (field === "immutable_revision") value.immutable_revision = "c".repeat(40);
  if (field === "source_digest") value.source_digest = `sha256:${"c".repeat(64)}`;
  if (field === "handler_digest") value.bindings[0]!.handler_digest = `sha256:${"c".repeat(64)}`;
  if (field === "mock_mode") value.bindings[0]!.mock_mode = true;
  if (field === "duplicate") value.bindings.push({...value.bindings[0]!});
  expect(verify(envelope(value)).kind).toBe("unresolved");
});

test("tampered, unsigned and untrusted receipts cannot create authority", () => {
  const text = JSON.parse(envelope(payload())); text.signature = Buffer.alloc(64).toString("base64");
  expect(verify(JSON.stringify(text)).kind).toBe("unresolved");
  expect(verify(JSON.stringify(payload())).kind).toBe("unresolved");
  const other = generateKeyPairSync("ed25519").publicKey.export({type: "spki", format: "pem"}).toString();
  expect(verify(envelope(payload()), other).kind).toBe("unresolved");
});

test.each(["node_version", "router_digest", "handler_path", "extra", "timestamp"])("unsupported capture content cannot establish binding: %s", field => {
  const value = payload() as Record<string, any>;
  if (field === "node_version") value.node_version = "24.6.0";
  if (field === "router_digest") value.router_digest = `sha256:${"c".repeat(64)}`;
  if (field === "handler_path") value.bindings[0].handler_path = "../outside.js";
  if (field === "extra") value.private = "private-capture-marker";
  if (field === "timestamp") value.captured_at = "invalid";
  const result = verify(envelope(value));
  expect(result.kind).toBe("unresolved");
  expect(JSON.stringify(result)).not.toContain("private-capture-marker");
});


test("private keys and unsupported signing algorithms are rejected as trust anchors", () => {
  expect(verify(undefined, keys.privateKey.export({type: "pkcs8", format: "pem"}).toString()).kind).toBe("unresolved");
  const ec = generateKeyPairSync("ec", {namedCurve: "prime256v1"});
  expect(verify(undefined, ec.publicKey.export({type: "spki", format: "pem"}).toString()).kind).toBe("unresolved");
});
