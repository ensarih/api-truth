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
async function yamlService(text: string) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-nodejs-yaml-")); roots.push(root);
  await mkdir(join(root, "service", "api", "swagger"), { recursive: true });
  await writeFile(join(root, "service", "api", "swagger", "swagger.yaml"), text);
  return { root, adapter: createAnalyzer({ projectRoot: root }) };
}
function yamlRequest(): AnalyzerRequest {
  const input = request();
  input.resolution_inputs = [{ kind: "type_manifest", path: "service/api/swagger/swagger.yaml", digest: "host-supplied-digest" }];
  return input;
}
function request(): AnalyzerRequest {
  return {
    exchange_version: "1.0.0", ir_version: "1.1.0", request_id: "swagger-test", analyzer: ANALYZER,
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

test("selected Swagger 2 YAML yields declared routes while preserving basePath separately", async () => {
  const { adapter } = await yamlService(`swagger: '2.0'
info:
  title: Orders
  version: '1'
basePath: /api/v1
paths:
  /orders/{id}:
    parameters:
      - name: id
        in: path
        required: true
        type: string
    get:
      responses:
        '200':
          description: ok
`);
  const result = await adapter.analyze(yamlRequest());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints).toHaveLength(1);
  expect(result.endpoints[0]?.application_path).toBe("/orders/{id}");
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "exposure.base_path.declaration", value: "/api/v1" }));
  expect(result.diagnostics.map(item => item.code)).toContain("base_path_requires_middleware_profile");
});

test.each([
  ["duplicate key", "swagger: '2.0'\nswagger: '2.0'\n"],
  ["multiple documents", "swagger: '2.0'\n---\nswagger: '2.0'\n"],
  ["alias", "swagger: '2.0'\ninfo: &details {title: Orders, version: '1'}\ncopy: *details\npaths: {}\n"],
  ["custom tag", "swagger: '2.0'\ninfo: !custom {title: Orders, version: '1'}\npaths: {}\n"],
])("rejects unsafe YAML %s without emitting routes", async (_case, text) => {
  const { adapter } = await yamlService(text);
  const result = await adapter.analyze(yamlRequest());
  expect(result.status).toBe("failed");
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(parseAnalyzerResult(result).ok).toBe(true);
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

test("maps declared Swagger 2 API-key and basic security with document evidence", async () => {
  const secured = structuredClone(document) as any;
  secured.securityDefinitions = {
    apiToken: { type: "apiKey", name: "X-API-Token", in: "header" },
    basic: { type: "basic" },
  };
  secured.security = [{ apiToken: [], basic: [] }, { basic: [] }];
  const { adapter } = await service(secured);
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.security_schemes).toEqual({
    apiToken: { definition: { type: "apiKey", name: "X-API-Token", in: "header" },
      evidence_ids: [expect.any(String)] },
    basic: { definition: { type: "http", scheme: "basic" }, evidence_ids: [expect.any(String)] },
  });
  expect(result.endpoints[0]?.security).toMatchObject({ state: "declared", alternatives: [
    { requirements: [{ scheme: "apiToken", scopes: [] }, { scheme: "basic", scopes: [] }] },
    { requirements: [{ scheme: "basic", scopes: [] }] },
  ] });
  expect(result.evidence).toContainEqual(expect.objectContaining({ location: expect.objectContaining({
    pointer: "/securityDefinitions/apiToken",
  }) }));
  expect(result.diagnostics.map(item => item.code)).not.toContain("security_mapping_unresolved");
});

test("unsupported or missing Swagger security schemes keep operation security unknown", async () => {
  const secured = structuredClone(document) as any;
  secured.securityDefinitions = {
    token: { type: "apiKey", name: "key", in: "header" },
    oauth: { type: "oauth2", flow: "implicit", authorizationUrl: "https://example.test/auth", scopes: {} },
  };
  secured.security = [{ token: [], oauth: [] }, { missing: [] }];
  const { adapter } = await service(secured);
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints[0]?.security).toEqual({ state: "unknown", alternatives: [] });
  expect(result.diagnostics.map(item => item.code)).toContain("security_mapping_unresolved");
  expect(result.security_schemes?.token?.definition).toEqual({ type: "apiKey", name: "key", in: "header" });
  expect(result.security_schemes?.oauth).toBeUndefined();
});

test("operation-level anonymous security overrides inherited requirements", async () => {
  const secured = structuredClone(document) as any;
  secured.securityDefinitions = { token: { type: "apiKey", name: "key", in: "query" } };
  secured.security = [{ token: [] }];
  secured.paths["/orders/{id}"].get.security = [];
  const { adapter } = await service(secured);
  const result = await adapter.analyze(request());
  expect(result.endpoints[0]?.security).toMatchObject({ state: "anonymous", alternatives: [] });
  const securityEvidence = result.evidence.find(item => result.endpoints[0]?.security.evidence_ids?.includes(item.evidence_id));
  expect(securityEvidence?.location.pointer).toBe("/paths/~1orders~1{id}/get/security");
});


test("unsupported profile IR version fails before filesystem access", async () => {
  const adapter = createAnalyzer({ projectRoot: "/missing/profile-version-check" });
  await expect(adapter.analyze({ ...request(), ir_version: "1.0.0" }))
    .rejects.toThrow("Swagger profile requires IR 1.1.0");
});
