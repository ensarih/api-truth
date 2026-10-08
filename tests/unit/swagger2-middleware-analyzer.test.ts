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
    exchange_version: "1.0.0", ir_version: "1.1.0", request_id: "middleware-test", analyzer: ANALYZER,
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


test("unsupported profile IR version fails before filesystem access", async () => {
  const adapter = createAnalyzer({ projectRoot: "/missing/profile-version-check" });
  await expect(adapter.analyze({ ...request(), ir_version: "1.0.0" }))
    .rejects.toThrow("Swagger profile requires IR 1.1.0");
});

test("locked framework declarations join candidates without establishing runtime binding", async () => {
  const manifest = {type: "commonjs", dependencies: {"swagger-express-mw": "0.7.0"}};
  const lock = {lockfileVersion: 3, packages: {"": {dependencies: manifest.dependencies},
    "node_modules/swagger-express-mw": {version: "0.7.0", dependencies: {"swagger-node-runner": "^0.7.0"}},
    "node_modules/swagger-node-runner": {version: "0.7.0"}}};
  const {root, adapter} = await service({"app.js": entry,
    "api/swagger/swagger.yaml": document.replace("    get:\n", "    x-swagger-router-controller: orders\n    get:\n"),
    "package.json": JSON.stringify(manifest), "package-lock.json": JSON.stringify(lock),
    "api/controllers/orders.js": "exports.getOrder = function(req, res) { res.status(201).json({value: true}); };"});
  const first = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.claims).toContainEqual(expect.objectContaining({predicate: "framework.lock.declaration", verification: "declared",
    value: expect.objectContaining({wrapper_version: "0.7.0", runner_version: "0.7.0", conformance_target: true})}));
  const candidate = first.claims.find(item => item.predicate === "handler.candidate")!;
  expect(candidate.verification).toBe("inferred");
  expect(first.evidence.filter(item => candidate.evidence_ids.includes(item.evidence_id))).toContainEqual(
    expect.objectContaining({location: {path: "package-lock.json", pointer: "/packages/node_modules~1swagger-node-runner/version"},
      scope: expect.objectContaining({endpoint_id: first.endpoints[0]!.endpoint_id}), limitations: expect.arrayContaining([
        "lockfile declaration only; installed modules, runtime resolution and framework behavior unverified"])}));
  expect(first.claims.some(item => item.predicate === "handler.binding")).toBe(false);
  expect(first.endpoints[0]!.responses.map(item => item.status)).toEqual([{kind: "exact", code: 200}]);
  expect(first.diagnostics.map(item => item.code)).toContain("framework_runtime_unverified");
  expect(first.diagnostics.map(item => item.code)).toContain("framework_routing_dependencies_unverified");
  lock.packages["node_modules/swagger-node-runner"].version = "0.7.1";
  await writeFile(join(root, "service/package-lock.json"), JSON.stringify(lock));
  const second = await adapter.analyze(request());
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.diagnostics.map(item => item.code)).toContain("framework_version_unsupported");
  expect(second.claims.find(item => item.predicate === "handler.candidate")?.verification).toBe("inferred");
  expect(second.status).toBe("partial");
  await writeFile(join(root, "service/yarn.lock"), "private-lock-marker");
  const competing = await adapter.analyze(request());
  expect(competing.reproducibility_fingerprint).not.toBe(second.reproducibility_fingerprint);
  expect(competing.claims.some(item => item.predicate === "framework.lock.declaration")).toBe(false);
  expect(competing.diagnostics.map(item => item.code)).toContain("framework_version_unverified");
  expect(JSON.stringify(competing)).not.toContain("private-lock-marker");
});

test("bounded npm start declarations remain limited and source environment writes suppress candidates", async () => {
  const {root, adapter} = await service({"app.js": entry,
    "api/swagger/swagger.yaml": document.replace("    get:\n", "    x-swagger-router-controller: orders\n    get:\n"),
    "package.json": JSON.stringify({type: "commonjs", scripts: {start: "node app.js"}, engines: {node: "22.19.0"}}),
    "api/controllers/orders.js": "exports.getOrder = function() {};"});
  const first = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.claims).toContainEqual(expect.objectContaining({predicate: "startup.entrypoint.declaration", verification: "declared",
    value: {entrypoint: "app.js", node_version: "22.19.0", policy: "npm-start-declaration-1"}}));
  expect(first.claims.some(item => item.predicate === "handler.candidate")).toBe(true);
  const candidate = first.claims.find(item => item.predicate === "handler.candidate")!;
  expect(first.evidence.filter(item => candidate.evidence_ids.includes(item.evidence_id))).toContainEqual(
    expect.objectContaining({location: {path: "package.json", pointer: "/scripts/start"}, limitations: expect.any(Array)}));
  await writeFile(join(root, "service/app.js"), 'process.env.swagger_mockMode = "private-runtime-value";\n' + entry);
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(second).ok).toBe(true);
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.claims.some(item => item.predicate === "handler.candidate")).toBe(false);
  expect(second.claims.some(item => item.predicate === "handler.binding")).toBe(false);
  expect(second.claims).toContainEqual(expect.objectContaining({predicate: "environment.access.declaration",
    value: expect.arrayContaining([expect.objectContaining({variable: "swagger_mockMode", operation: "write"})])}));
  const startupClaim = second.claims.find(item => item.predicate === "startup.entrypoint.declaration")!;
  expect(startupClaim.evidence_ids.map(id => second.evidence.find(item => item.evidence_id === id)?.location.path))
    .toEqual(["package.json", "package.json", "package.json"]);
  expect(second.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["handler_environment_unverified", "startup_environment_unverified"]));
  expect(second.endpoints).toHaveLength(1);
  const environmentIds = new Set(second.evidence.filter(item => item.limitations.includes(
    "syntactic startup/environment declaration only; reachability, effective values and production invocation unverified"))
    .map(item => item.evidence_id));
  expect(second.dependencies.some(item => item.evidence_ids.some(id => environmentIds.has(id)))).toBe(false);
  expect(JSON.stringify(second)).not.toContain("private-runtime-value");
  expect(second.status).toBe("partial");
});

test("routing dependency declarations preserve scoped evidence and invalidate without promoting handlers", async () => {
  const manifest = {type: "commonjs", dependencies: {"swagger-express-mw": "0.7.0"}};
  const lock = {lockfileVersion: 3, packages: {
    "": {dependencies: manifest.dependencies},
    "node_modules/swagger-express-mw": {version: "0.7.0", dependencies: {"swagger-node-runner": "^0.7.0"}},
    "node_modules/swagger-node-runner": {version: "0.7.0", dependencies: {bagpipes: "^0.1.0", config: "^1.16.0", sway: "^1.0.0"}},
    "node_modules/bagpipes": {version: "0.1.2"}, "node_modules/config": {version: "1.31.0"}, "node_modules/sway": {version: "1.0.0"},
  }};
  const {root, adapter} = await service({"app.js": entry,
    "api/swagger/swagger.yaml": document.replace("    get:\n", "    x-swagger-router-controller: orders\n    get:\n"),
    "package.json": JSON.stringify(manifest), "package-lock.json": JSON.stringify(lock),
    "api/controllers/orders.js": "exports.getOrder = function(req, res) { res.status(201).json({value: true}); };"});
  const first = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.claims).toContainEqual(expect.objectContaining({predicate: "framework.routing_dependencies.declaration", verification: "declared",
    value: {versions: {bagpipes: "0.1.2", config: "1.31.0", sway: "1.0.0"}, conformance_target: true,
      policy: "npm-routing-dependencies-declaration-1"}}));
  const candidate = first.claims.find(item => item.predicate === "handler.candidate")!;
  expect(candidate.verification).toBe("inferred");
  expect(first.evidence.filter(item => candidate.evidence_ids.includes(item.evidence_id))).toContainEqual(expect.objectContaining({
    location: {path: "package-lock.json", pointer: "/packages/node_modules~1config/version"},
    scope: expect.objectContaining({endpoint_id: first.endpoints[0]!.endpoint_id})}));
  expect(first.claims.some(item => item.predicate === "handler.binding")).toBe(false);
  expect(first.endpoints[0]!.responses.map(item => item.status)).toEqual([{kind: "exact", code: 200}]);
  lock.packages["node_modules/config"].version = "1.30.0";
  await writeFile(join(root, "service/package-lock.json"), JSON.stringify(lock));
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(second).ok).toBe(true);
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.claims.some(item => item.predicate === "framework.routing_dependencies.declaration")).toBe(false);
  expect(second.diagnostics.map(item => item.code)).toContain("framework_routing_dependencies_unverified");
  expect(second.claims.find(item => item.predicate === "handler.candidate")?.verification).toBe("inferred");
  expect(second.status).toBe("partial");
});

test("opaque controller initialization preserves the route and invalidates the prior candidate", async () => {
  const {root, adapter} = await service({"app.js": entry, "package.json": '{"type":"commonjs"}',
    "api/swagger/swagger.yaml": document.replace("    get:\n", "    x-swagger-router-controller: orders\n    get:\n"),
    "api/controllers/orders.js": "exports.getOrder = function(req, res) {};"});
  const first = await adapter.analyze(request());
  expect(first.claims.some(item => item.predicate === "handler.candidate")).toBe(true);
  await writeFile(join(root, "service/api/controllers/orders.js"),
    'throw new Error("private-init-marker"); exports.getOrder = function(req, res) {};');
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(second).ok).toBe(true);
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.endpoints.map(item => item.application_path)).toEqual(["/api/v1/orders/{id}"]);
  expect(second.claims.some(item => ["handler.candidate", "handler.binding"].includes(item.predicate))).toBe(false);
  expect(second.diagnostics.map(item => item.code)).toContain("handler_initialization_unverified");
  expect(second.status).toBe("partial");
  expect(JSON.stringify(second)).not.toContain("private-init-marker");
});

test("local initialization imports carry limited evidence and helper edits invalidate candidates", async () => {
  const {root, adapter} = await service({"app.js": entry, "package.json": '{"type":"commonjs"}',
    "api/swagger/swagger.yaml": document.replace("    get:\n", "    x-swagger-router-controller: orders\n    get:\n"),
    "api/controllers/orders.js": 'const helper = require("./helper"); exports.getOrder = function(req, res) { helper.read(req, res); };',
    "api/controllers/helper.js": 'exports.read = function(req, res) { res.status(201).json({value: true}); };'});
  const first = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  const candidate = first.claims.find(item => item.predicate === "handler.candidate")!;
  expect(candidate.verification).toBe("inferred");
  const helperEvidence = first.evidence.find(item => item.location.path === "api/controllers/helper.js"
    && item.scope.endpoint_id === first.endpoints[0]!.endpoint_id)!;
  expect(candidate.evidence_ids).toContain(helperEvidence.evidence_id);
  expect(helperEvidence.limitations).toContain("bounded local initialization syntax only; module execution and runtime binding unverified");
  expect(first.dependencies.some(item => item.evidence_ids.includes(helperEvidence.evidence_id))).toBe(false);
  expect(first.claims.some(item => item.predicate === "handler.binding")).toBe(false);
  expect(first.endpoints[0]!.responses.map(item => item.status)).toEqual([{kind: "exact", code: 200}]);
  expect((await adapter.analyze(request())).reproducibility_fingerprint).toBe(first.reproducibility_fingerprint);
  await writeFile(join(root, "service/api/controllers/helper.js"), 'throw new Error("private-import-marker"); exports.read = function() {};');
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(second).ok).toBe(true);
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.endpoints.map(item => item.application_path)).toEqual(["/api/v1/orders/{id}"]);
  expect(second.claims.some(item => item.predicate === "handler.candidate")).toBe(false);
  expect(second.diagnostics.map(item => item.code)).toContain("handler_initialization_unverified");
  expect(JSON.stringify(second)).not.toContain("private-import-marker");
});

test("middleware uses the shared composed-schema conversion and dependency traversal", async () => {
  const spec = document.replace("'200': { description: ok }", "'200': { description: ok, schema: { allOf: [{ $ref: '#/definitions/Base' }, { type: object, additionalProperties: { $ref: '#/definitions/Value' } }] } }")
    + "\nproduces: [application/json]\ndefinitions:\n  Base: { type: object, properties: { id: { type: string } } }\n  Value: { type: string }\n";
  const {adapter} = await service({"app.js": entry, "api/swagger/swagger.yaml": spec});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  const schema = result.endpoints[0]!.responses[0]!.content[0]!.schema;
  expect(schema.allOf).toHaveLength(2);
  expect(schema.allOf![1]!.additionalProperties).toMatchObject({$ref: expect.stringMatching(/^#\/schemas\//)});
  expect(result.dependencies.filter(item => item.to.kind === "schema")).toHaveLength(2);
  expect(result.diagnostics.map(item => item.code)).not.toContain("schema_keyword_unsupported");
  expect(result.claims.some(item => item.predicate === "handler.binding")).toBe(false);
});

test("middleware preserves declared bounds and diagnoses malformed required lists", async () => {
  const spec = document.replace("'200': { description: ok }", "'200': { description: ok, schema: { $ref: '#/definitions/Order' } }")
    + "\nproduces: [application/json]\ndefinitions:\n  Order:\n    type: object\n    required: [id, id]\n    properties:\n      id: { type: string, minLength: 1, maxLength: 40 }\n      count: { type: integer, minimum: 0, maximum: 100 }\n";
  const {adapter} = await service({"app.js": entry, "api/swagger/swagger.yaml": spec});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints).toHaveLength(1);
  const schema = Object.values(result.schemas)[0]!.schema;
  expect(schema.required).toBeUndefined();
  expect(schema.properties?.id).toEqual({type: "string", minLength: 1, maxLength: 40});
  expect(schema.properties?.count).toEqual({type: "integer", minimum: 0, maximum: 100});
  expect(result.diagnostics.map(item => item.code)).toContain("schema_required_unsupported");
  expect(result.claims.some(item => item.predicate === "handler.binding")).toBe(false);
});


test("middleware shares pattern and enum validation for YAML declarations", async () => {
  const spec = document.replace("'200': { description: ok }", "'200': { description: ok, schema: { $ref: '#/definitions/Order' } }")
    + "\nproduces: [application/json]\ndefinitions:\n  Order:\n    type: object\n    properties:\n      id: { type: string, pattern: '^[a-z]+$', enum: [a, b] }\n      invalid: { enum: [a, a], pattern: '[' }\n";
  const {adapter} = await service({"app.js": entry, "api/swagger/swagger.yaml": spec});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints).toHaveLength(1);
  expect(Object.values(result.schemas)[0]!.schema.properties).toEqual({
    id: {type: "string", pattern: "^[a-z]+$", enum: ["a", "b"]}, invalid: {},
  });
  expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["schema_enum_duplicate", "schema_pattern_unsupported"]));
  expect(result.claims.some(item => item.predicate === "handler.binding")).toBe(false);
});
