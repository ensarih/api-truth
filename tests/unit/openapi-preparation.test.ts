import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { prepareOpenApiPublication } from "../../packages/openapi/src/index.js";

const fixture = async () => JSON.parse(await readFile(
  new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as any;

const selector = {
  kind: "revision" as const,
  repositoryId: "commerce", serviceId: "orders", snapshotId: "snapshot-orders-rev-b",
  revision: "rev-b", configFingerprint: "sha256:config-a",
};

const exportable = async () => {
  const snapshot = await fixture();
  snapshot.endpoints = [snapshot.endpoints[0]];
  snapshot.schemas = {};
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0].parameters = snapshot.endpoints[0].parameters.slice(0, 1);
  snapshot.endpoints[0].responses[0].content[0].schema = { type: "string" };
  snapshot.evidence = snapshot.evidence.filter((item: any) => item.scope.endpoint_id !== "ep-create");
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-proof",
    method: "deterministic_analysis", limitations: [],
    scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0].evidence_ids = ["ev-proof"];
  snapshot.endpoints[0].parameters[0].presence.evidence_ids = ["ev-proof"];
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-anonymous",
    method: "deterministic_analysis", limitations: [] });
  snapshot.endpoints[0].security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  return snapshot;
};

test("strict preparation produces canonical bytes, hash and immutable provenance", async () => {
  const snapshot = await exportable();
  const first = prepareOpenApiPublication({ snapshot, mode: "strict", selector });
  expect(first.publishable).toBe(true);
  expect(first.diagnostics).toEqual([]);
  expect(first.bytes).toBeInstanceOf(Uint8Array);
  expect(JSON.parse(new TextDecoder().decode(first.bytes))).toEqual(first.document);
  expect((first.document as any)["x-api-truth-provenance"]).toEqual({
    snapshotId: snapshot.snapshot_id,
    repositoryId: snapshot.service.repository_id,
    serviceId: snapshot.service.service_id,
    revision: snapshot.source.immutable_revision,
    sourceDigest: snapshot.source.source_digest,
    configVersion: snapshot.config.config_version,
    configFingerprint: snapshot.config.config_fingerprint,
  });
  expect(new TextDecoder().decode(first.bytes).startsWith('{"info":')).toBe(true);
  expect(first.contentSha256).toBe(`sha256:${createHash("sha256").update(first.bytes!).digest("hex")}`);
  expect(first.provenance).toMatchObject({ selector, snapshotId: snapshot.snapshot_id });
  expect(Object.isFrozen(first.provenance)).toBe(true);
  expect(Object.isFrozen(first.provenance.selector)).toBe(true);
  expect(prepareOpenApiPublication({ snapshot: structuredClone(snapshot), mode: "strict", selector }).bytes)
    .toEqual(first.bytes);
  const original = new Uint8Array(first.bytes!);
  first.bytes![0] = 0;
  expect(first.bytes).toEqual(original);
  expect(`sha256:${createHash("sha256").update(first.bytes!).digest("hex")}`).toBe(first.contentSha256);
});

test("draft is inspectable but never publishable; diagnostics block strict bytes", async () => {
  const snapshot = await fixture();
  const draft = prepareOpenApiPublication({ snapshot, mode: "draft", selector });
  expect(draft.publishable).toBe(false);
  expect(draft.document).toBeDefined();
  expect(draft.diagnostics.length).toBeGreaterThan(0);
  const strict = prepareOpenApiPublication({ snapshot, mode: "strict", selector });
  expect(strict.publishable).toBe(false);
  expect(strict.document).toBeUndefined();
  expect(strict.bytes).toBeUndefined();
  expect(strict.contentSha256).toBeUndefined();
});

test("selector must match exact snapshot identity and contain the required pin", async () => {
  const snapshot = await exportable();
  for (const field of ["repositoryId", "serviceId", "snapshotId", "revision", "configFingerprint"] as const) {
    expect(() => prepareOpenApiPublication({ snapshot, mode: "strict", selector: { ...selector, [field]: "other" } }))
      .toThrow("OpenAPI publication selector does not match snapshot");
  }
  expect(() => prepareOpenApiPublication({ snapshot, mode: "strict", selector: {
    ...selector, kind: "branch", branch: "main",
  } as any })).toThrow("Invalid OpenAPI publication selector");
  expect(() => prepareOpenApiPublication({ snapshot, mode: "strict", selector: {
    ...selector, kind: "environment", environment: "production", checkpointVersion: "1",
    resolvedSnapshotIds: [selector.snapshotId, "another"],
  } })).toThrow("Invalid OpenAPI publication selector");
  expect(() => prepareOpenApiPublication({ snapshot, mode: "strict", selector: {
    ...selector, kind: "environment", environment: "production", checkpointVersion: "1",
    resolvedSnapshotIds: ["another"],
  } })).toThrow("OpenAPI publication selector does not match snapshot");
});

test("branch and environment pins are preserved without resolving live state", async () => {
  const snapshot = await exportable();
  const branch = prepareOpenApiPublication({ snapshot, mode: "strict", selector: {
    ...selector, kind: "branch", branch: "main", pointerVersion: "7",
  } });
  const environment = prepareOpenApiPublication({ snapshot, mode: "strict", selector: {
    ...selector, kind: "environment", environment: "production", checkpointVersion: "12",
    resolvedSnapshotIds: [selector.snapshotId],
  } });
  expect(branch.publishable).toBe(true);
  expect(environment.publishable).toBe(true);
  expect(branch.contentSha256).toBe(environment.contentSha256);
  expect(branch.provenance.selector).toMatchObject({ pointerVersion: "7" });
  expect(environment.provenance.selector).toMatchObject({ checkpointVersion: "12" });
});

test("selector accessors cannot change a validated environment pin", async () => {
  const snapshot = await exportable();
  let reads = 0;
  const unstable = { ...selector, kind: "environment", environment: "production", checkpointVersion: "12",
    get resolvedSnapshotIds() {
      reads += 1;
      return reads < 3 ? [selector.snapshotId] : [selector.snapshotId, "another"];
    } };
  expect(() => prepareOpenApiPublication({ snapshot, mode: "strict", selector: unstable as any }))
    .toThrow("Invalid OpenAPI publication selector");
  expect(reads).toBe(0);
});
