import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseAnalyzerResult, type AnalyzerRequest } from "../../packages/ir/src/index.js";
import { ANALYZER, createAnalyzer } from "../../analyzers/nodejs/src/middleware.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function service(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-swagger-middleware-")); roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, "service", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return { root, adapter: createAnalyzer({ projectRoot: root }) };
}
function request(): AnalyzerRequest {
  return {
    exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "middleware-test", analyzer: ANALYZER,
    source: { repository_id: "example-repo", service_id: "example", service_root: "service",
      immutable_revision: "a".repeat(40), source_digest: "pending", access_label: "test" },
    resolution_inputs: [
      { kind: "source_tree", path: "service", digest: "pending" },
      { kind: "type_manifest", path: "service/api/swagger/swagger.yaml", digest: "pending" },
    ],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 30, max_output_bytes: 1000000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
}
const document = `swagger: '2.0'
info: { title: Example, version: '1' }
basePath: /api/v1
paths:
  /orders/{id}:
    parameters:
      - { name: id, in: path, required: true, type: string }
    get:
      operationId: getOrder
      responses:
        '200': { description: ok }
`;
const entry = `const express = require("express");
const SwaggerExpress = require("swagger-express-mw");
const app = express();
SwaggerExpress.create({ appRoot: __dirname }, function (error, middleware) {
  if (error) throw error;
  middleware.register(app);
});`;

test("verified default-file registration composes basePath without claiming handler binding", async () => {
  const { adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": document });
  const first = await adapter.analyze(request());
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.endpoints).toMatchObject([{ application_path: "/api/v1/orders/{id}", identity: { method: "GET" } }]);
  expect(first.status).toBe("partial");
  expect(first.diagnostics.map(item => item.code)).toContain("handler_binding_unverified");
  expect(first.diagnostics.map(item => item.code)).not.toContain("base_path_requires_middleware_profile");
  expect(first.evidence).toContainEqual(expect.objectContaining({ source: { kind: "source_code", source_id: "example-repo" },
    location: expect.objectContaining({ path: "app.js" }) }));
  const bindingEvidence = first.evidence.find(item => item.source.kind === "source_code"
    && item.scope.endpoint_id === first.endpoints[0]?.endpoint_id);
  expect(first.dependencies).toContainEqual(expect.objectContaining({
    from_endpoint_id: first.endpoints[0]?.endpoint_id,
    to: { kind: "evidence", id: bindingEvidence?.evidence_id },
  }));
  expect(first.reproducibility_fingerprint).toBe(second.reproducibility_fingerprint);
});

test("missing or conditional registration does not turn document paths into mounted routes", async () => {
  for (const app of [entry.replace("middleware.register(app);", ""),
    entry.replace("middleware.register(app);", "if (process.env.ENABLED) middleware.register(app);"),
    entry.replace("middleware.register(app);", "const app = fake; middleware.register(app);"),
    entry.replace("middleware.register(app);", "middleware = fake; middleware.register(app);"),
    entry.replace("middleware.register(app);", "middleware.register = () => {}; middleware.register(app);"),
    entry.replace("middleware.register(app);", "return; middleware.register(app);"),
    entry.replace("middleware.register(app);", "if (process.env.DISABLED) return; middleware.register(app);"),
    entry.replace("function (error, middleware)", "function (middleware, middleware)")
      .replace("if (error) throw error;", "if (middleware) throw middleware;"),
    `${entry}\nSwaggerExpress.create({ appRoot: __dirname }, function (error, middleware) { middleware.register(app); });`]) {
    const { adapter } = await service({ "app.js": app, "api/swagger/swagger.yaml": document });
    const result = await adapter.analyze(request());
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.endpoints).toEqual([]);
    expect(result.diagnostics.map(item => item.code)).toContain("middleware_registration_unverified");
  }
});

test("wrong selected document and dynamic app root fail closed", async () => {
  const { adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": document,
    "api/swagger/other.yaml": document });
  const selected = request(); selected.resolution_inputs[1] = {
    kind: "type_manifest", path: "service/api/swagger/other.yaml", digest: "pending",
  };
  await expect(adapter.analyze(selected)).rejects.toThrow("Unsupported middleware resolution inputs");
  const root = await service({ "app.js": entry.replace("appRoot: __dirname", "appRoot: process.env.ROOT"),
    "api/swagger/swagger.yaml": document });
  const result = await root.adapter.analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("middleware_registration_unverified");
});

test("invalid basePath and changing source bytes cannot create stale full paths", async () => {
  const { root, adapter } = await service({ "app.js": entry,
    "api/swagger/swagger.yaml": document.replace("/api/v1", "api/v1") });
  const invalid = await adapter.analyze(request());
  expect(invalid.endpoints).toEqual([]);
  expect(invalid.diagnostics.map(item => item.code)).toContain("base_path_unresolved");
  await writeFile(join(root, "service", "api", "swagger", "swagger.yaml"), document);
  const valid = await adapter.analyze(request());
  expect(valid.endpoints[0]?.application_path).toBe("/api/v1/orders/{id}");
  expect(valid.reproducibility_fingerprint).not.toBe(invalid.reproducibility_fingerprint);
});

test("path traversal or repeated separators in basePath never produce a guessed route", async () => {
  for (const basePath of ["/api/../v1", "/api//v1", "/api/./v1"]) {
    const { adapter } = await service({ "app.js": entry,
      "api/swagger/swagger.yaml": document.replace("/api/v1", basePath) });
    const result = await adapter.analyze(request());
    expect(result.status).toBe("failed");
    expect(result.endpoints).toEqual([]);
    expect(result.diagnostics.map(item => item.code)).toContain("base_path_unresolved");
  }
});

test("operation paths are not silently rewritten while composing basePath", async () => {
  const { adapter } = await service({ "app.js": entry,
    "api/swagger/swagger.yaml": document.replace("/orders/{id}", "/orders//{id}") });
  const result = await adapter.analyze(request());
  expect(result.endpoints.map(item => item.application_path)).not.toContain("/api/v1/orders/{id}");
  expect(result.endpoints.map(item => item.application_path)).toEqual(["/api/v1/orders//{id}"]);
});

test("all affecting source files change the middleware result fingerprint", async () => {
  const { root, adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": document,
    "config/default.json": '{"mode":"example"}' });
  const first = await adapter.analyze(request());
  await writeFile(join(root, "service", "config", "default.json"), '{"mode":"changed"}');
  const second = await adapter.analyze(request());
  expect(second.endpoints[0]?.application_path).toBe(first.endpoints[0]?.application_path);
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
});

test("incremental requests use a full-service fallback", async () => {
  const { adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": document });
  const baseline = await adapter.analyze(request());
  const incremental = request(); incremental.extraction_mode = "incremental";
  const replay = await adapter.analyze(incremental);
  expect(replay.endpoints).toEqual(baseline.endpoints);
  expect(replay.status).toBe("partial");
  expect(replay.reproducibility_fingerprint).not.toBe(baseline.reproducibility_fingerprint);
});

test("source digest mismatches and symlinks cannot bypass the selected service boundary", async () => {
  const { root, adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": document });
  const mismatched = request(); mismatched.source.source_digest = `sha256:${"0".repeat(64)}`;
  await expect(adapter.analyze(mismatched)).rejects.toThrow("Source digest mismatch");
  await symlink("/etc/passwd", join(root, "service", "unrelated.json"));
  await expect(adapter.analyze(request())).rejects.toThrow("Source boundary or input limit rejected");
});

test("exact controller declarations retain separate source candidates without handler binding", async () => {
  const yaml = document.replace("    get:", "    x-swagger-router-controller: orders\n    get:");
  const { adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": yaml,
    "package.json": '{"type":"commonjs"}',
    "api/controllers/orders.js": "module.exports = { getOrder };\nfunction getOrder(req, res) { res.status(201).json({extra: true}); }" });
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.claims).toContainEqual(expect.objectContaining({predicate: "handler.candidate", verification: "inferred",
    value: expect.objectContaining({ controller: "orders", operationId: "getOrder", path: "api/controllers/orders.js" })}));
  const candidate = result.claims.find(item => item.predicate === "handler.candidate")!;
  const evidence = result.evidence.filter(item => candidate.evidence_ids.includes(item.evidence_id));
  expect(evidence.map(item => item.source.kind)).toEqual(expect.arrayContaining(["api_document", "source_code"]));
  expect(evidence).toContainEqual(expect.objectContaining({source: {kind: "source_code", source_id: "example-repo"},
    location: expect.objectContaining({path: "api/controllers/orders.js", line: 2}),
    scope: expect.objectContaining({endpoint_id: result.endpoints[0]!.endpoint_id}),
    limitations: expect.arrayContaining(["candidate only; runtime routing configuration and module initialization unverified"])}));
  expect(result.claims.some(item => item.predicate === "handler.binding")).toBe(false);
  expect(result.dependencies.some(item => item.evidence_ids.includes(evidence.find(item => item.source.kind === "source_code")!.evidence_id))).toBe(false);
  expect(result.endpoints[0]!.responses.map(item => item.status)).toEqual([{kind: "exact", code: 200}]);
  expect(result.diagnostics.map(item => item.code)).toContain("handler_candidate_unverified");
  expect(result.status).toBe("partial");
});

test("operation controller overrides path controller and source changes invalidate candidates", async () => {
  const yaml = document.replace("    get:", "    x-swagger-router-controller: fallback\n    get:\n      x-swagger-router-controller: orders");
  const { root, adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": yaml,
    "package.json": '{"type":"commonjs"}',
    "api/controllers/orders.js": "exports.getOrder = function () {};",
    "api/controllers/fallback.js": "exports.getOrder = function () {};" });
  const first = await adapter.analyze(request());
  expect(first.claims.filter(item => item.predicate === "handler.candidate")).toHaveLength(1);
  expect(first.claims.find(item => item.predicate === "handler.candidate")!.value).toMatchObject({controller: "orders"});
  await writeFile(join(root, "service/api/controllers/orders.js"), "exports.other = function () {};");
  const second = await adapter.analyze(request());
  expect(second.endpoints).toHaveLength(1);
  expect(second.claims.some(item => item.predicate === "handler.candidate")).toBe(false);
  expect(second.diagnostics.map(item => item.code)).toContain("handler_export_unresolved");
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
});

test("unresolved mappings and explicit pipes preserve document routes without candidate guesses", async () => {
  const cases = [
    {yaml: document, code: "handler_controller_unresolved"},
    {yaml: document.replace("    get:", "    x-swagger-router-controller: orders\n    get:").replace("      operationId: getOrder\n", ""), code: "handler_operation_id_unresolved"},
    {yaml: document.replace("    get:", "    x-swagger-router-controller: orders\n    x-swagger-pipe: custom\n    get:"), code: "handler_pipe_unverified"},
    {yaml: document.replace("    get:", "    x-swagger-router-controller: orders\n    get:\n      x-swagger-router-controller: null"), code: "handler_controller_unresolved"},
    {yaml: document.replace("    get:", "    x-swagger-router-controller: missing\n    get:"), code: "handler_source_unresolved"},
    {yaml: document.replace("    get:", "    x-swagger-router-controller: ../orders\n    get:"), code: "handler_mapping_unsupported"},
  ];
  for (const {yaml, code} of cases) {
    const { adapter } = await service({ "app.js": entry, "api/swagger/swagger.yaml": yaml,
      "api/controllers/orders.js": "exports.getOrder = function () {};" });
    const result = await adapter.analyze(request());
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.endpoints).toHaveLength(1);
    expect(result.claims.some(item => item.predicate === "handler.candidate")).toBe(false);
    expect(result.diagnostics.map(item => item.code)).toContain(code);
  }
});

const routingConfiguration = (directory: string) => JSON.stringify({swagger: {
  swaggerControllerPipe: "controllers", bagpipes: {
    router: {name: "swagger_router", mockMode: false, mockControllersDirs: [], controllersDirs: [directory]},
    controllers: ["express_compatibility", "router"],
  },
}});

test("configured controller candidates retain routing declaration provenance and invalidate on config changes", async () => {
  const yaml = document.replace("    get:", "    x-swagger-router-controller: orders\n    get:");
  const { root, adapter } = await service({"app.js": entry, "api/swagger/swagger.yaml": yaml,
    "package.json": '{"type":"commonjs"}', "config/default.json": routingConfiguration("custom/controllers"),
    "custom/controllers/orders.js": "exports.getOrder = function () {};",
    "alternate/controllers/orders.js": "exports.getOrder = function () {};"});
  const first = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  const declaration = first.claims.find(item => item.predicate === "routing.configuration.declaration")!;
  expect(declaration).toMatchObject({verification: "declared", value: expect.objectContaining({controller_dirs: ["custom/controllers"], pipeline: "controllers"})});
  const candidate = first.claims.find(item => item.predicate === "handler.candidate")!;
  expect(candidate.value).toMatchObject({path: "custom/controllers/orders.js", controller_directory: "custom/controllers"});
  const cfgEvidence = first.evidence.filter(item => candidate.evidence_ids.includes(item.evidence_id)
    && item.location.path === "config/default.json");
  expect(cfgEvidence).toContainEqual(expect.objectContaining({source: {kind: "configuration", source_id: "example-repo"},
    location: {path: "config/default.json", pointer: "/swagger/bagpipes/router/controllersDirs/0"}}));
  expect(first.diagnostics.map(item => item.code)).toContain("routing_runtime_overrides_unverified");
  expect(first.claims.some(item => item.predicate === "handler.binding")).toBe(false);
  await writeFile(join(root, "service/config/default.json"), routingConfiguration("alternate/controllers"));
  const second = await adapter.analyze(request());
  expect(second.claims.find(item => item.predicate === "handler.candidate")!.value).toMatchObject({path: "alternate/controllers/orders.js"});
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.endpoints[0]!.responses.map(item => item.status)).toEqual([{kind: "exact", code: 200}]);
});

test("opaque configuration affects provenance without exposing bytes or erasing document endpoints", async () => {
  const {root, adapter} = await service({"app.js": entry,
    "api/swagger/swagger.yaml": document.replace("    get:", "    x-swagger-router-controller: orders\n    get:"),
    "package.json": '{"type":"commonjs"}', "config/default.properties": "private-config-marker"});
  await writeFile(join(root, "service/config/default.properties"), Buffer.from([0xff, 0x00, 0x01]));
  const first = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.endpoints).toHaveLength(1);
  expect(first.diagnostics.map(item => item.code)).toContain("handler_configuration_unverified");
  expect(first.claims.some(item => item.predicate === "handler.candidate")).toBe(false);
  await writeFile(join(root, "service/config/default.properties"), "private-config-marker-changed");
  const second = await adapter.analyze(request());
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(JSON.stringify(second)).not.toContain("private-config-marker");
  const limited = request(); limited.limits.max_files = 3;
  await expect(adapter.analyze(limited)).rejects.toThrow("Source boundary or input limit rejected");
});

test("controller interface overrides cannot silently inherit a middleware-only candidate policy", async () => {
  const mapped = document.replace("    get:", "    x-swagger-router-controller: orders\n    get:");
  for (const yaml of [mapped.replace("paths:", "x-controller-interface: pipe\npaths:"),
    mapped.replace("    get:", "    x-controller-interface: auto-detect\n    get:"),
    mapped.replace("      operationId: getOrder", "      x-controller-interface: pipe\n      operationId: getOrder")]) {
    const {adapter} = await service({"app.js": entry, "api/swagger/swagger.yaml": yaml,
      "package.json": '{"type":"commonjs"}', "api/controllers/orders.js": "exports.getOrder = function () {};"});
    const result = await adapter.analyze(request());
    expect(result.endpoints).toHaveLength(1);
    expect(result.claims.some(item => item.predicate === "handler.candidate")).toBe(false);
    expect(result.diagnostics.map(item => item.code)).toContain("handler_interface_unverified");
  }
});
