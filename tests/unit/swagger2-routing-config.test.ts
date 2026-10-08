import { resolve } from "node:path";
import { expect, test } from "vitest";
import { digestServiceTree } from "../../analyzers/nodejs/src/source.js";
import { resolveSwaggerRoutingConfiguration } from "../../analyzers/nodejs/src/routing-config.js";

const root = resolve("synthetic-service");
const configuration = (controllersDirs: unknown = ["custom/controllers"]) => ({ swagger: {
  swaggerControllerPipe: "controllers",
  bagpipes: { router: { name: "swagger_router", mockMode: false, mockControllersDirs: [], controllersDirs },
    controllers: ["swagger_params_parser", "express_compatibility", "router"] },
} });
const files = (value: unknown, filename = "default.json") =>
  new Map([[resolve(root, "config", filename), typeof value === "string" ? value : JSON.stringify(value)]]);

test("absent config and static config without bagpipes retain explicit default assumptions", () => {
  for (const tree of [new Map<string, string>(), files({app: {port: 3000}}), files({swagger: {bagpipes: null}})]) {
    expect(resolveSwaggerRoutingConfiguration(tree, root)).toMatchObject({ kind: "supported", origin: "default",
      controller_dirs: ["api/controllers"], pipeline: "swagger_controllers", router_fitting: "_router" });
  }
});

test("JSON and YAML routing declarations resolve a contained directory and exact pipeline evidence", () => {
  const yaml = `swagger:
  swaggerControllerPipe: controllers
  bagpipes:
    router:
      name: swagger_router
      mockMode: false
      mockControllersDirs: []
      controllersDirs: [custom/controllers]
    controllers: [swagger_params_parser, express_compatibility, router]
`;
  for (const tree of [files(configuration()), files(yaml, "default.yaml"), files(yaml, "default.yml")]) {
    const result = resolveSwaggerRoutingConfiguration(tree, root);
    expect(result).toMatchObject({kind: "supported", origin: "configured", controller_dirs: ["custom/controllers"],
      pipeline: "controllers", router_fitting: "router"});
    expect(result.evidence_locations).toEqual(expect.arrayContaining([
      expect.objectContaining({pointer: "/swagger/swaggerControllerPipe"}),
      expect.objectContaining({pointer: "/swagger/bagpipes/controllers/2"}),
      expect.objectContaining({pointer: "/swagger/bagpipes/router/name"}),
      expect.objectContaining({pointer: "/swagger/bagpipes/router/controllersDirs/0"}),
    ]));
  }
});

test("layered, dynamic, alternate-format, and opaque config never become an effective default", () => {
  for (const filename of ["production.yaml", "default.js", "default.json5", "custom-environment-variables.json"]) {
    const tree = files(configuration());
    tree.set(resolve(root, "config", filename), "private-config-marker");
    const result = resolveSwaggerRoutingConfiguration(tree, root);
    expect(result).toMatchObject({kind: "unresolved", code: "handler_configuration_unverified"});
    expect(JSON.stringify(result)).not.toContain("private-config-marker");
  }
  const opaque = new Map([[resolve(root, "config/default.properties"), `sha256:${"a".repeat(64)}`]]);
  expect(resolveSwaggerRoutingConfiguration(new Map(), root, opaque)).toMatchObject({kind: "unresolved"});
  const both = files(configuration()); both.set(resolve(root, "config/default.yaml"), "swagger: {}");
  expect(resolveSwaggerRoutingConfiguration(both, root)).toMatchObject({kind: "unresolved"});
});

test("malformed or hostile configuration remains safely unresolved", () => {
  const inputs = ["{", '{"swagger":{},"swagger":{}}', '{"__proto__":{"swagger":{}}}',
    "swagger:\n  bagpipes: &pipes {}\n  other: *pipes\n", "swagger: {}\n---\nswagger: {}\n"];
  for (const input of inputs) {
    const result = resolveSwaggerRoutingConfiguration(files(input, input.startsWith("{") ? "default.json" : "default.yaml"), root);
    expect(result).toMatchObject({kind: "unresolved"});
  }
  expect(resolveSwaggerRoutingConfiguration(files(" ".repeat(1_000_001) + "{}"), root))
    .toMatchObject({kind: "unresolved", reason: "configuration_limit_exceeded"});
});

test("directories preserve declared order but cannot escape the selected service", () => {
  expect(resolveSwaggerRoutingConfiguration(files(configuration(["first/controllers", "second/controllers"])), root))
    .toMatchObject({kind: "supported", controller_dirs: ["first/controllers", "second/controllers"]});
  for (const dirs of [[], "custom/controllers", ["../outside"], ["/tmp/controllers"], ["custom/../controllers"],
    ["custom//controllers"], ["custom/controllers", "custom/controllers"], Array(9).fill("controllers")])
    expect(resolveSwaggerRoutingConfiguration(files(configuration(dirs)), root).kind).toBe("unresolved");
});

test("mock routing, dependency factories, unknown fitting behavior, and non-middleware interfaces remain unresolved", () => {
  const variants = [
    {...configuration().swagger, mockMode: true},
    {...configuration().swagger, dependencies: {}},
    {...configuration().swagger, bagpipes: "DEFAULTS_TEST"},
    {...configuration().swagger, bagpipes: {router: {...configuration().swagger.bagpipes.router, mockMode: true}, controllers: ["router"]}},
    {...configuration().swagger, bagpipes: {router: {...configuration().swagger.bagpipes.router, controllersInterface: "pipe"}, controllers: ["router"]}},
    {...configuration().swagger, bagpipes: {router: {...configuration().swagger.bagpipes.router, name: "custom_router"}, controllers: ["router"]}},
    {...configuration().swagger, bagpipes: {...configuration().swagger.bagpipes, controllers: ["router", "express_compatibility"]}},
    {...configuration().swagger, bagpipes: {...configuration().swagger.bagpipes, controllers: ["router", "router"]}},
    {...configuration().swagger, bagpipes: {...configuration().swagger.bagpipes, controllers: ["unknown_fitting", "router"]}},
  ];
  for (const swagger of variants)
    expect(resolveSwaggerRoutingConfiguration(files({swagger}), root)).toMatchObject({kind: "unresolved"});
  const tree = files(configuration()); tree.set(resolve(root, "api/fittings/swagger_router.js"), "module.exports = custom;");
  expect(resolveSwaggerRoutingConfiguration(tree, root)).toMatchObject({kind: "unresolved", reason: "custom_fittings_unverified"});
});


test("source manifests are order-independent and separate file boundaries from embedded NUL text", () => {
  const first = new Map([[resolve(root, "a.js"), "one"], [resolve(root, "b.js"), "two"]]);
  const reverse = new Map([...first].reverse());
  expect(digestServiceTree(first, root)).toBe(digestServiceTree(reverse, root));
  const combined = new Map([[resolve(root, "a.js"), "one\0b.js\0two"]]);
  expect(digestServiceTree(first, root)).not.toBe(digestServiceTree(combined, root));
  const opaque = new Map([[resolve(root, "config/default.properties"), "a".repeat(64)]]);
  const changed = new Map([[resolve(root, "config/default.properties"), "b".repeat(64)]]);
  expect(digestServiceTree(first, root, opaque)).not.toBe(digestServiceTree(first, root, changed));
});

test("inline routers and named built-in fitting aliases retain their exact pipeline pointers", () => {
  const swagger = configuration().swagger;
  const inline = files({swagger: {...swagger, bagpipes: {
    parser: {name: "swagger_params_parser"},
    controllers: [{onError: "json_error_handler"}, "parser", {
      ...swagger.bagpipes.router, controllersInterface: "middleware",
    }],
  }}});
  const result = resolveSwaggerRoutingConfiguration(inline, root);
  expect(result).toMatchObject({kind: "supported", origin: "configured", router_fitting: "inline-2",
    controller_dirs: ["custom/controllers"]});
  expect(result.evidence_locations).toEqual(expect.arrayContaining([
    {path: "config/default.json", pointer: "/swagger/bagpipes/controllers/2/name"},
    {path: "config/default.json", pointer: "/swagger/bagpipes/controllers/2/controllersDirs/0"},
    {path: "config/default.json", pointer: "/swagger/bagpipes/controllers/2/controllersInterface"},
  ]));
});

test("explicit environment selects a static mockMode layer with exact evidence", () => {
  const tree = files({swagger: {mockMode: true}});
  tree.set(resolve(root, "config/production.json"), JSON.stringify({swagger: {mockMode: false}}));
  expect(resolveSwaggerRoutingConfiguration(tree, root, new Map(), undefined, {name: "production", location: {path: "package.json", pointer: "/scripts/start"}})).toMatchObject({
    kind: "supported", controller_dirs: ["api/controllers"], evidence_locations: expect.arrayContaining([
      {path: "config/production.json", pointer: "/swagger/mockMode"},
    ]),
  });
  expect(resolveSwaggerRoutingConfiguration(tree, root).kind).toBe("unresolved");
});

test.each(["json", "yaml", "yml"])("environment layer %s has bounded parsing and create-option precedence", extension => {
  const tree = files({swagger: {mockMode: false}});
  tree.set(resolve(root, `config/production.${extension}`), extension === "json"
    ? JSON.stringify({swagger: {mockMode: true}}) : "swagger:\n  mockMode: true\n");
  const selection = {name: "production", location: {path: "package.json", pointer: "/scripts/start"}};
  expect(resolveSwaggerRoutingConfiguration(tree, root, new Map(), undefined, selection).kind).toBe("unresolved");
  expect(resolveSwaggerRoutingConfiguration(tree, root, new Map(), {value: false, location: {path: "app.js", pointer: "span:0:10"}}, selection).kind)
    .toBe("supported");
});

test.each(["{", '{"swagger":{"mockMode":false,"mockMode":true}}',
  JSON.stringify({swagger: {mockMode: "private-marker"}}), JSON.stringify({swagger: {bagpipes: {}}})])(
  "unsupported environment layers stay unresolved without exposing content", content => {
    const tree = files({swagger: {mockMode: false}});
    tree.set(resolve(root, "config/production.json"), content);
    const result = resolveSwaggerRoutingConfiguration(tree, root, new Map(), undefined,
      {name: "production", location: {path: "package.json", pointer: "/scripts/start"}});
    expect(result.kind).toBe("unresolved");
    expect(JSON.stringify(result)).not.toContain("private-marker");
  });

test("duplicate, foreign and opaque environment files remain unresolved", () => {
  const selection = {name: "production", location: {path: "package.json", pointer: "/scripts/start"}};
  for (const extra of ["production.yaml", "staging.json", "production.js"]) {
    const tree = files({swagger: {mockMode: false}});
    tree.set(resolve(root, "config/production.json"), JSON.stringify({swagger: {mockMode: false}}));
    tree.set(resolve(root, `config/${extra}`), "swagger: {mockMode: false}");
    expect(resolveSwaggerRoutingConfiguration(tree, root, new Map(), undefined, selection).kind).toBe("unresolved");
  }
  const opaque = new Map([[resolve(root, "config/production.properties"), `sha256:${"a".repeat(64)}`]]);
  expect(resolveSwaggerRoutingConfiguration(files({swagger: {mockMode: false}}), root, opaque, undefined, selection).kind)
    .toBe("unresolved");
});
