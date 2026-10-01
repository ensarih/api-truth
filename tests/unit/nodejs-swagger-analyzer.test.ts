import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/nodejs/src/index.js";
import { parseAnalyzerResult, type AnalyzerRequest } from "../../packages/ir/src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function service(document: unknown) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-nodejs-analyzer-")); roots.push(root);
  await mkdir(join(root, "service", "api", "swagger"), { recursive: true });
  await writeFile(join(root, "service", "api", "swagger", "swagger.json"), JSON.stringify(document));
  return { root, adapter: createAnalyzer({ projectRoot: root }) };
}
function request(): AnalyzerRequest {
  return {
    exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "swagger-test", analyzer: ANALYZER,
    source: { repository_id: "orders-repo", service_id: "orders", service_root: "service", immutable_revision: "a".repeat(40), source_digest: "host-supplied-digest", access_label: "test" },
    resolution_inputs: [{ kind: "type_manifest", path: "service/api/swagger/swagger.json", digest: "host-supplied-digest" }],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 1, max_output_bytes: 1000000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
}
const document = {
  swagger: "2.0", info: { title: "Orders", version: "1" },
  paths: { "/orders/{id}": { parameters: [{ name: "id", in: "path", required: true, type: "string" }],
    get: { operationId: "getOrder", produces: ["application/json"], responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Order" } } } },
  } },
  definitions: { Order: { type: "object", properties: { id: { type: "string" } } } },
};

test("selected Swagger 2 document yields a separate D03-valid declared route", async () => {
  const { adapter } = await service(document);
  const first = await adapter.analyze(request());
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.analyzer).toEqual(ANALYZER);
  expect(first.endpoints).toHaveLength(1);
  expect(first.endpoints[0]).toMatchObject({ application_path: "/orders/{id}", identity: { method: "GET" },
    parameters: [{ name: "id", in: "path", presence: { state: "required" } }],
    responses: [{ status: { kind: "exact", code: 200 }, content: [{ media_type: "application/json" }] }],
    security: { state: "unknown" },
  });
  expect(first.evidence.find(item => item.location.pointer === "/paths/~1orders~1{id}/get")).toMatchObject({ method: "type_declaration" });
  expect(first.claims).toContainEqual(expect.objectContaining({ predicate: "route.declaration", verification: "declared" }));
  expect(first.diagnostics.map(item => item.code)).toContain("middleware_binding_unverified");
  expect(first.diagnostics.map(item => item.code)).not.toContain("json_duplicate_keys_unverified");
  expect(first.dependencies).toContainEqual(expect.objectContaining({ from_endpoint_id: first.endpoints[0]?.endpoint_id,
    to: { kind: "schema", id: expect.stringMatching(/^schema-/) } }));
  expect(first.reproducibility_fingerprint).toBe(second.reproducibility_fingerprint);
  expect(first.endpoints).toEqual(second.endpoints);
});

test("duplicate document keys fail analysis before any operation is emitted", async () => {
  const { root, adapter } = await service(document);
  await writeFile(join(root, "service", "api", "swagger", "swagger.json"),
    '{"swagger":"2.0","info":{"title":"Orders","version":"1"},"paths":{},"paths":{"/hidden":{"get":{"responses":{"200":{"description":"ok"}}}}}}');
  const result = await adapter.analyze(request());
  expect(result.status).toBe("failed");
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("duplicate_json_key");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("unsupported document facts remain visible and prevent complete coverage", async () => {
  const withUnknown = structuredClone(document) as any;
  withUnknown.paths["/orders/{id}"].get["x-custom-routing"] = true;
  const { adapter } = await service(withUnknown);
  const result = await adapter.analyze(request());
  expect(result.status).toBe("partial");
  expect(result.coverage.status).toBe("incomplete");
  expect(result.diagnostics.map(item => item.code)).toContain("unsupported_field");
  expect(result.endpoints).toHaveLength(1);
});

test("selected malformed document fails safely, and source digest mismatch is rejected", async () => {
  const { adapter } = await service({ swagger: "3.0", paths: {} });
  const failed = await adapter.analyze(request());
  expect(failed.status).toBe("failed");
  expect(failed.endpoints).toEqual([]);
  expect(parseAnalyzerResult(failed).ok).toBe(true);
  const req = request(); req.source.source_digest = `sha256:${"0".repeat(64)}`;
  await expect(adapter.analyze(req)).rejects.toThrow("Source digest mismatch");
});

test("local unsupported routes do not suppress a valid operation or create duplicate route identities", async () => {
  const withConflict = structuredClone(document) as any;
  withConflict.paths["/orders/{key}"] = structuredClone(withConflict.paths["/orders/{id}"]);
  withConflict.paths["relative"] = { get: { responses: { "200": { description: "ok" } } } };
  const { adapter } = await service(withConflict);
  const result = await adapter.analyze(request());
  expect(result.status).toBe("partial");
  expect(result.endpoints).toHaveLength(1);
  expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["unsupported_construct", "conflicting_route_declarations"]));
  expect(parseAnalyzerResult(result).ok).toBe(true);
});
