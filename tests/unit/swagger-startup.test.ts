import { resolve } from "node:path";
import { expect, test } from "vitest";
import { resolveSwaggerStartup } from "../../analyzers/nodejs/src/startup.js";
const root = resolve("/synthetic/service");
const binding = {path: "app.js", line: 4, span: "span:10:100"};
const files = (source = 'const app = {};', manifest: unknown = {type: "commonjs", scripts: {start: "node app.js"}, engines: {node: "22.19.0"}}) =>
  new Map([[resolve(root, "package.json"), JSON.stringify(manifest)], [resolve(root, "app.js"), source]]);

test("one exact npm start declaration links the registration entrypoint and runtime pin", () => {
  expect(resolveSwaggerStartup(files(), root, binding)).toMatchObject({kind: "declared", entrypoint: "app.js",
    node_version: "22.19.0", environment_inputs: [], evidence_locations: [
      {path: "package.json", pointer: "/scripts/start"}, {path: "package.json", pointer: "/type"},
      {path: "package.json", pointer: "/engines/node"},
    ]});
});

test.each(["node other.js", "node --require hook.js app.js", "PRIVATE=secret node app.js", "npm run serve", "node app.js && echo private"])(
  "opaque start command %s is not a startup proof", start => {
    const result = resolveSwaggerStartup(files("", {type: "commonjs", scripts: {start}, engines: {node: "22.19.0"}}), root, binding);
    expect(result.kind).toBe("unresolved");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("echo private");
  });

test.each(["^22.19.0", "24.6.0", undefined])("Node pin %s cannot qualify this conformance target", node => {
  expect(resolveSwaggerStartup(files("", {type: "commonjs", scripts: {start: "node app.js"}, engines: {node}}), root, binding).kind)
    .toBe("unresolved");
});

test.each([
  ['process.env.PRIVATE_BUSINESS_SETTING = "private-value";', "write", "unknown"],
  ['process.env.swagger_mockMode = "private-value";', "write", "swagger_mockMode"],
  ['const value = process.env.NODE_CONFIG;', "read", "NODE_CONFIG"],
  ['delete process.env.NODE_CONFIG_DIR;', "write", "NODE_CONFIG_DIR"],
  ['process.env[dynamicName] = "private-value";', "opaque", "unknown"],
  ['const env = process.env;', "opaque", "unknown"],
  ['Object.assign(process.env, {swagger_mockMode: "private-value"});', "opaque", "unknown"],
])("configuration-affecting environment input gets safe evidence: %s", (source, operation, variable) => {
  const result = resolveSwaggerStartup(files(source), root, binding);
  expect(result.environment_inputs).toContainEqual(expect.objectContaining({operation, variable,
    location: expect.objectContaining({path: "app.js", line: 1})}));
  expect(JSON.stringify(result)).not.toContain("private-value");
});

test("all contained JS sources participate without exposing unrelated variable names", () => {
  const input = files('const value = process.env.PRIVATE_BUSINESS_SETTING;');
  input.set(resolve(root, "bootstrap/config.js"), 'process.env.swagger_custom_private = "private-value";');
  const result = resolveSwaggerStartup(input, root, binding);
  expect(result.environment_inputs).toHaveLength(2);
  expect(result.environment_inputs).toContainEqual(expect.objectContaining({variable: "unknown", operation: "read"}));
  expect(result.environment_inputs).toContainEqual(expect.objectContaining({variable: "swagger_*", operation: "write"}));
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BUSINESS_SETTING");
  expect(JSON.stringify(result)).not.toContain("swagger_custom_private");
});

test("missing binding, invalid manifest and malformed sources stay unresolved", () => {
  expect(resolveSwaggerStartup(files(), root, undefined).kind).toBe("unresolved");
  const bad = files(); bad.set(resolve(root, "package.json"), '{"private-marker":');
  expect(resolveSwaggerStartup(bad, root, binding).kind).toBe("unresolved");
  const malformed = files('process.env.NODE_CONFIG = "unfinished');
  expect(resolveSwaggerStartup(malformed, root, binding).environment_inputs).toContainEqual(
    expect.objectContaining({variable: "unknown", operation: "opaque"}));
});


test.each(["prestart", "poststart"])("npm %s hooks prevent a bounded startup declaration", hook => {
  const scripts = {start: "node app.js", [hook]: "node opaque-bootstrap.js"};
  expect(resolveSwaggerStartup(files("", {type: "commonjs", scripts, engines: {node: "22.19.0"}}), root, binding).kind).toBe("unresolved");
});

test("malformed and oversized startup input cannot appear resolved", () => {
  const duplicate = files(); duplicate.set(resolve(root, "package.json"), '{"scripts":{"start":"node app.js","start":"node other.js"}}');
  expect(resolveSwaggerStartup(duplicate, root, binding).kind).toBe("unresolved");
  const large = files("x".repeat(1_000_001));
  expect(resolveSwaggerStartup(large, root, binding).environment_inputs).toContainEqual(expect.objectContaining({operation: "opaque"}));
});

test("the environment inventory honors the shared time budget", () => {
  expect(() => resolveSwaggerStartup(files(), root, binding, () => {throw new Error("Analysis time limit exceeded");}))
    .toThrow("Analysis time limit exceeded");
});


test.each(['const alias = process;', 'const {env} = process;', 'import runtime from "node:process";', 'const runtime = require("process");'])(
  "process aliases and module imports leave an opaque environment gap: %s", source => {
    expect(resolveSwaggerStartup(files(source), root, binding).environment_inputs).toContainEqual(
      expect.objectContaining({variable: "unknown", operation: "opaque"}));
  });

test("a cumulative AST node limit leaves an opaque gap", () => {
  const input = files("const x = 0;\n".repeat(40_000));
  expect(resolveSwaggerStartup(input, root, binding).environment_inputs).toContainEqual(
    expect.objectContaining({variable: "unknown", operation: "opaque"}));
});

test.each(["development", "test", "production", "staging", "uat"])("explicit npm environment %s is a bounded launch declaration", environment => {
  const result = resolveSwaggerStartup(files("", {type: "commonjs", scripts: {start: `NODE_ENV=${environment} node app.js`},
    engines: {node: "22.19.0"}}), root, binding);
  expect(result).toMatchObject({kind: "declared", environment_name: environment, entrypoint: "app.js"});
  expect(result.evidence_locations).toContainEqual({path: "package.json", pointer: "/scripts/start"});
});

test.each(["NODE_ENV=private-marker node app.js", "NODE_ENV=production node app.js\n", "NODE_ENV=production PRIVATE=secret node app.js",
  "cross-env NODE_ENV=production node app.js", "NODE_ENV='production' node app.js"])("unsupported environment launch syntax stays unresolved", start => {
  const result = resolveSwaggerStartup(files("", {type: "commonjs", scripts: {start}, engines: {node: "22.19.0"}}), root, binding);
  expect(result.kind).toBe("unresolved");
  expect(JSON.stringify(result)).not.toContain("private-marker");
  expect(JSON.stringify(result)).not.toContain("secret");
});
