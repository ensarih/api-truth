import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createHandlerCandidateResolver } from "../../analyzers/nodejs/src/handler-candidates.js";

const root = resolve("synthetic-service");
const resolver = (source: string, filename = "orders.js") => createHandlerCandidateResolver(
  new Map([[resolve(root, "api/controllers", filename), source],
    [resolve(root, "package.json"), '{"type":"commonjs"}']]), root);

test("exact default-directory CommonJS exports identify source candidates", () => {
  const sources = [
    "module.exports = { getOrder }; function getOrder(req, res) { res.json({id: 1}); }",
    "module.exports = { getOrder: read }; function read(req, res) {}",
    "module.exports = { getOrder(req, res) {} };",
    "module.exports = { getOrder: (req, res) => {} };",
    "exports.getOrder = function (req, res) {};",
    "exports.getOrder = getOrder; function getOrder(req, res) {};",
    "module.exports.getOrder = function (req, res) {};",
    "const read = (req, res) => {}; exports.getOrder = read;",
  ];
  for (const source of sources) {
    const candidate = resolver(source)("orders", "getOrder");
    expect(candidate).toMatchObject({ kind: "candidate", path: "api/controllers/orders.js", line: 1,
      export_name: "getOrder" });
    expect(candidate.kind === "candidate" && candidate.span).toMatch(/^span:\d+:\d+$/);
  }
});

test("mutated, conditional, aliased, duplicate, and dynamic exports never become candidates", () => {
  const sources = [
    "if (enabled) exports.getOrder = function () {};",
    "module.exports = { ...other, getOrder() {} };",
    "module.exports = { getOrder() {}, getOrder() {} };",
    "exports.getOrder = function () {}; exports.getOrder = function () {};",
    "module.exports = { getOrder() {} }; exports.getOrder = function () {};",
    "const out = exports; out.getOrder = function () {};",
    "const module = fake; module.exports = { getOrder() {} };",
    "exports = {}; exports.getOrder = function () {};",
    "Object.assign(exports, { getOrder() {} });",
    "exports.getOrder = function () {}; delete exports.getOrder;",
    "exports.getOrder = function () {}; Object.defineProperty(exports, 'getOrder', {value: fake});",
    "module.exports = { getOrder: read }; function read() {} read = fake;",
    "module.exports = { getOrder: read }; function read() {} let read = fake;",
    "let read = function () {}; exports.getOrder = read;",
    "import { read } from './other.js'; exports.getOrder = read;",
    "export function getOrder() {};",
    "exports[getName()] = function () {};",
    "module.exports = { get getOrder() { return fake; } };",
    "module.exports = { getOrder: missing };",
    "module.exports = { getOrder() {} ",
  ];
  for (const source of sources) expect(resolver(source)("orders", "getOrder").kind).toBe("unresolved");
});

test("ES module package scopes cannot make CommonJS source look loadable", () => {
  const files = new Map([
    [resolve(root, "api/controllers/orders.js"), "exports.getOrder = function () {};"],
    [resolve(root, "package.json"), '{"type":"module"}'],
  ]);
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder").kind).toBe("unresolved");
  files.set(resolve(root, "api/controllers/package.json"), '{"type":"commonjs"}');
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder").kind).toBe("candidate");
  files.set(resolve(root, "api/controllers/package.json"), '{"type":"commonjs","type":"module"}');
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder").kind).toBe("unresolved");
});

test("missing contained package scopes cannot rely on an unscanned ancestor", () => {
  const files = new Map([[resolve(root, "api/controllers/orders.js"), "exports.getOrder = function () {};"]]);
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_module_format_unverified"});
  files.set(resolve(root, "api/controllers/orders.cjs"), "exports.getOrder = function () {};");
  expect(createHandlerCandidateResolver(files, root)("orders.cjs", "getOrder").kind).toBe("candidate");
});

test("controller lookup is contained and never guesses a compiled or alternate module", () => {
  const lookup = resolver("exports.getOrder = function () {};");
  for (const name of ["../orders", "/orders", "orders/../orders", "Orders", "orders.ts", "__proto__", "constructor"])
    expect(lookup(name, "getOrder").kind).toBe("unresolved");
  expect(lookup("orders", "missing")).toMatchObject({kind: "unresolved", code: "handler_export_unresolved"});
  expect(resolver("exports.getOrder = function () {};", "orders.ts")("orders", "getOrder").kind).toBe("unresolved");
  expect(resolver("exports.getOrder = function () {};", "orders.cjs")("orders", "getOrder").kind).toBe("unresolved");
  expect(resolver("exports.getOrder = function () {};", "orders.cjs")("orders.cjs", "getOrder").kind).toBe("candidate");
});

test("source parsing rejects excessive bytes and preserves no source text in diagnostics", () => {
  const privateSource = "private-source-marker";
  const candidate = resolver(`/*${privateSource}${"x".repeat(1_000_001)}*/ exports.getOrder = function () {};`)("orders", "getOrder");
  expect(candidate).toMatchObject({kind: "unresolved", code: "handler_source_limit_exceeded"});
  expect(JSON.stringify(candidate)).not.toContain(privateSource);
  const files = new Map([
    [resolve(root, "api/controllers/orders.js"), "exports.getOrder = function () {};"],
    [resolve(root, "package.json"), JSON.stringify({type: "commonjs", description: privateSource + "x".repeat(1_000_001)})],
  ]);
  const scope = createHandlerCandidateResolver(files, root)("orders", "getOrder");
  expect(scope).toMatchObject({kind: "unresolved", code: "handler_source_limit_exceeded"});
  expect(JSON.stringify(scope)).not.toContain(privateSource);
});

test("uninterpreted runtime configuration cannot choose a default-directory candidate", () => {
  const files = new Map([
    [resolve(root, "api/controllers/orders.js"), "exports.getOrder = function () {};"],
    [resolve(root, "config/default.yaml"), "swagger:\n  bagpipes:\n    _router:\n      controllersDirs: [ custom/controllers ]\n"],
  ]);
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_configuration_unverified"});
});

function configuredFiles(dirs: string[]) {
  return new Map([
    [resolve(root, "package.json"), '{"type":"commonjs"}'],
    [resolve(root, "config/default.json"), JSON.stringify({swagger: {
      swaggerControllerPipe: "controllers", bagpipes: {
        router: {name: "swagger_router", mockControllersDirs: [], controllersDirs: dirs}, controllers: ["router"],
      },
    }})],
  ]);
}

test("configured directories select only the exact source declared by the selected pipeline", () => {
  const files = configuredFiles(["custom/controllers"]);
  files.set(resolve(root, "custom/controllers/orders.js"), "exports.getOrder = function () {};");
  files.set(resolve(root, "api/controllers/orders.js"), "exports.getOrder = function () {};");
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder"))
    .toMatchObject({kind: "candidate", path: "custom/controllers/orders.js", controller_directory: "custom/controllers"});
});

test("multiple possible modules cannot assume the first require call succeeds", () => {
  const files = configuredFiles(["first/controllers", "second/controllers"]);
  files.set(resolve(root, "first/controllers/orders.js"), "throw new Error('private-init-marker'); exports.getOrder = function () {};");
  files.set(resolve(root, "second/controllers/orders.js"), "exports.getOrder = function () {};");
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_source_ambiguous"});
  files.delete(resolve(root, "first/controllers/orders.js"));
  files.set(resolve(root, "first/controllers/orders.json"), "{}");
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_module_resolution_unverified"});
});

test.each([
  'throw new Error("private-init-marker");',
  'initialize();',
  'const dependency = require("./dependency");',
  'const value = unknown.property;',
  'const value = new Service();',
  'if (flag) initialize();',
  'while (flag) {}',
  'class Helper { static value = initialize(); }',
  'const value = { [initialize()]: 1 };',
  'const value = { ...unknown };',
  'const value = 1; const value = 2;',
])("opaque initialization withholds a handler candidate: %s", prefix => {
  const result = resolver(`${prefix}\nexports.getOrder = function() {};`)("orders", "getOrder");
  expect(result).toMatchObject({kind: "unresolved", code: "handler_initialization_unverified"});
  expect(JSON.stringify(result)).not.toContain("private-init-marker");
});

test("function bodies are deferred and literal declarations stay eligible", () => {
  expect(resolver('"use strict"; const label = "example"; const options = {enabled: true, values: [1, null]};\nexports.getOrder = function() { throw new Error("deferred"); };')("orders", "getOrder").kind).toBe("candidate");
});

test("const handlers cannot be exported before their initialization", () => {
  expect(resolver('exports.getOrder = read; const read = () => {};')("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_initialization_unverified"});
});
