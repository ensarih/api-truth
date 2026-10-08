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

const localModules = (controller: string, modules: Record<string, string>) => new Map([
  [resolve(root, "package.json"), '{"type":"commonjs"}'],
  [resolve(root, "api/controllers/orders.js"), controller],
  ...Object.entries(modules).map(([path, source]) => [resolve(root, path), source] as [string, string]),
]);
const withLocal = 'const helper = require("./helper"); exports.getOrder = function(req, res) { helper.read(req, res); };';
test("contained literal CommonJS imports carry initialization source evidence", () => {
  const files = localModules(withLocal, {
    "api/controllers/helper.js": 'const leaf = require("../helpers/leaf.cjs"); exports.read = function() { leaf.read(); };',
    "api/helpers/leaf.cjs": 'exports.read = function() {};',
  });
  const result = createHandlerCandidateResolver(files, root)("orders", "getOrder");
  expect(result).toMatchObject({kind: "candidate", initialization_sources: [
    {path: "api/controllers/helper.js", package_scope: "package.json"}, {path: "api/helpers/leaf.cjs"},
  ]});
});
test.each(["throw", "cycle", "missing", "esm", "shadow", "alternative", "external", "dynamic", "escape"])(
  "local initialization %s cannot qualify a candidate", mode => {
    let controller = withLocal;
    const modules: Record<string, string> = {"api/controllers/helper.js": 'exports.read = function() {};'};
    if (mode === "throw") modules["api/controllers/helper.js"] = 'throw new Error("private-import-marker"); exports.read = function() {};';
    if (mode === "cycle") modules["api/controllers/helper.js"] = 'const root = require("./orders"); exports.read = function() {};';
    if (mode === "missing") delete modules["api/controllers/helper.js"];
    if (mode === "esm") modules["api/controllers/package.json"] = '{"type":"module"}';
    if (mode === "shadow") controller = 'const require = () => {}; ' + controller;
    if (mode === "alternative") modules["api/controllers/helper.json"] = '{}';
    if (mode === "external") controller = controller.replace('./helper', 'external-library');
    if (mode === "dynamic") controller = controller.replace('"./helper"', 'lookup()');
    if (mode === "escape") controller = controller.replace('./helper', '../../../outside');
    const result = createHandlerCandidateResolver(localModules(controller, modules), root)("orders", "getOrder");
    expect(result.kind).toBe("unresolved");
    expect(JSON.stringify(result)).not.toContain("private-import-marker");
  });
test("local imports respect shared depth and byte limits", () => {
  const modules: Record<string, string> = {};
  for (let i = 0; i < 12; i++) modules[`api/controllers/leaf${i}.js`] =
    `const next = require("./leaf${i + 1}"); exports.read = function() {};`;
  expect(createHandlerCandidateResolver(localModules(withLocal.replace('./helper', './leaf0'), modules), root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_source_limit_exceeded"});
  const large = {"api/controllers/helper.js": `/*${"x".repeat(999_950)}*/ exports.read = function() {};`};
  expect(createHandlerCandidateResolver(localModules(withLocal, large), root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_source_limit_exceeded"});
});

test("repeated local imports produce one deterministic initialization source", () => {
  const source = 'const first = require("./helper"); const second = require("./helper"); exports.getOrder = function() {};';
  const lookup = createHandlerCandidateResolver(localModules(source, {"api/controllers/helper.js": 'exports.read = function() {};'}), root);
  const first = lookup("orders", "getOrder");
  expect(first).toMatchObject({kind: "candidate", initialization_sources: [{path: "api/controllers/helper.js", package_scope: "package.json"}]});
  expect(lookup("orders", "getOrder")).toEqual(first);
});
test("a child module's nearest package scope controls eligibility", () => {
  const files = localModules(withLocal.replace('./helper', '../helpers/helper'), {
    "api/helpers/helper.js": 'exports.read = function() {};', "api/helpers/package.json": '{"type":"module"}',
  });
  expect(createHandlerCandidateResolver(files, root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_module_format_unverified"});
});
test("the local initialization graph enforces its shared module count", () => {
  const modules: Record<string, string> = {};
  const imports: string[] = [];
  for (let i = 0; i < 32; i++) {
    modules[`api/controllers/helper${i}.js`] = 'exports.read = function() {};';
    imports.push(`const value${i} = require("./helper${i}");`);
  }
  const source = imports.join('\n') + ' exports.getOrder = function() {};';
  expect(createHandlerCandidateResolver(localModules(source, modules), root)("orders", "getOrder"))
    .toMatchObject({kind: "unresolved", code: "handler_source_limit_exceeded"});
});
