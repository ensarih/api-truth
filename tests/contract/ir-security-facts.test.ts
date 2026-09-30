import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import { parseContractSnapshot } from "../../packages/ir/src/index.js";

const fixture = async () => JSON.parse(await readFile(
  new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as Record<string, any>;

const evidence = { evidence_id: "ev-auth", source: { kind: "source_code", source_id: "commerce" },
  source_version: "rev-b", location: { path: "src/auth.ts" }, method: "deterministic_analysis",
  scope: { service_id: "orders", snapshot_id: "snapshot-orders-rev-b" },
  limitations: [], access_label: "orders-read" };

test("explicit security scheme facts retain evidence and exact named requirements", async () => {
  const snapshot = await fixture();
  snapshot.evidence.push(evidence);
  snapshot.security_schemes = { apiToken: { definition: { type: "apiKey", name: "X-Api-Token", in: "header" },
    evidence_ids: ["ev-auth"] }, tenant: { definition: { type: "http", scheme: "bearer" },
    evidence_ids: ["ev-auth"] } };
  snapshot.endpoints[0].security.state = "declared";
  snapshot.endpoints[0].security.evidence_ids = ["ev-auth"];
  snapshot.endpoints[1].security.state = "declared";
  snapshot.endpoints[1].security.evidence_ids = ["ev-auth"];
  snapshot.endpoints[1].security.alternatives[0].requirements[1].scopes = [];
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
});

test("explicit anonymous access needs evidence and cannot coexist with security requirements", async () => {
  const snapshot = await fixture();
  snapshot.endpoints[0].security = { state: "anonymous", alternatives: [], evidence_ids: [] };
  const missing = parseContractSnapshot(snapshot);
  expect(missing.ok).toBe(false);
  snapshot.evidence.push({ ...evidence, scope: { ...evidence.scope, endpoint_id: "ep-get" } });
  snapshot.endpoints[0].security.evidence_ids = ["ev-auth"];
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
  snapshot.endpoints[0].security.alternatives = [{ requirements: [{ scheme: "apiToken", scopes: [] }] }];
  const conflicting = parseContractSnapshot(snapshot);
  expect(conflicting.ok).toBe(false);
});

test("declared security rejects absent scheme definitions and unrelated evidence", async () => {
  const snapshot = await fixture();
  snapshot.evidence.push({ ...evidence, scope: { ...evidence.scope, endpoint_id: "ep-create" } });
  snapshot.endpoints[0].security = { state: "declared", alternatives: snapshot.endpoints[0].security.alternatives,
    evidence_ids: ["ev-auth"] };
  const missing = parseContractSnapshot(snapshot);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.issues.map((issue) => issue.code))
    .toContain("semantic.dangling_reference");
  snapshot.security_schemes = { apiToken: { definition: { type: "apiKey", name: "X-Api-Token", in: "header" },
    evidence_ids: ["ev-auth"] } };
  const unrelated = parseContractSnapshot(snapshot);
  expect(unrelated.ok).toBe(false);
  if (!unrelated.ok) expect(unrelated.error.issues.map((issue) => issue.code))
    .toContain("semantic.scope_mismatch");
});

test("security evidence is validated even when the security state is unknown", async () => {
  const snapshot = await fixture();
  snapshot.endpoints[0].security.evidence_ids = ["missing-auth-evidence"];
  const result = parseContractSnapshot(snapshot);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.issues.map((issue) => issue.code))
    .toContain("semantic.dangling_reference");
});

test("apiKey and HTTP security schemes reject OAuth scopes and invalid bearer metadata", async () => {
  const snapshot = await fixture();
  snapshot.evidence.push(evidence);
  snapshot.security_schemes = { apiToken: { definition: { type: "apiKey", name: "X-Api-Token", in: "header" },
    evidence_ids: ["ev-auth"] } };
  snapshot.endpoints[0].security = { state: "declared", evidence_ids: ["ev-auth"],
    alternatives: [{ requirements: [{ scheme: "apiToken", scopes: ["read"] }] }] };
  const invalidScopes = parseContractSnapshot(snapshot);
  expect(invalidScopes.ok).toBe(false);
  if (!invalidScopes.ok) expect(invalidScopes.error.issues.map((issue) => issue.code))
    .toContain("semantic.invalid_security_scopes");

  snapshot.endpoints[0].security.alternatives[0].requirements[0].scopes = [];
  snapshot.security_schemes.apiToken.definition = { type: "http", scheme: "basic", bearerFormat: "JWT" };
  const invalidBearerFormat = parseContractSnapshot(snapshot);
  expect(invalidBearerFormat.ok).toBe(false);
  if (!invalidBearerFormat.ok) expect(invalidBearerFormat.error.issues.map((issue) => issue.code))
    .toContain("semantic.invalid_bearer_format");
});
