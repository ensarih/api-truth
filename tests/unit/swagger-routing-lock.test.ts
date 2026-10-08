import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { resolveSwaggerFrameworkLock } from "../../analyzers/nodejs/src/framework-lock.js";
const root = resolve("/synthetic/service");
const make = () => ({lockfileVersion: 3, packages: {
  "": {dependencies: {"swagger-express-mw": "0.7.0"}},
  "node_modules/swagger-express-mw": {version: "0.7.0", dependencies: {"swagger-node-runner": "^0.7.0"}},
  "node_modules/swagger-node-runner": {version: "0.7.0", dependencies: {bagpipes: "^0.1.0", config: "^1.16.0", sway: "^1.0.0"}},
  "node_modules/bagpipes": {version: "0.1.2"},
  "node_modules/config": {version: "1.31.0"},
  "node_modules/sway": {version: "1.0.0"},
}} as {lockfileVersion: number; packages: Record<string, any>});
function analyze(lock = make()) {
  return resolveSwaggerFrameworkLock(new Map([
    [resolve(root, "package.json"), JSON.stringify({dependencies: {"swagger-express-mw": "0.7.0"}})],
    [resolve(root, "package-lock.json"), JSON.stringify(lock)],
  ]), root);
}
test("records the three routing-affecting lock declarations with exact pointers", () => {
  const result = analyze();
  expect(result).toMatchObject({kind: "locked", routing_dependencies: {kind: "locked", conformance_target: true,
    versions: {bagpipes: "0.1.2", config: "1.31.0", sway: "1.0.0"}}});
  if (result.kind !== "locked") throw new Error("missing framework");
  expect(result.routing_dependencies.evidence_locations).toContainEqual({path: "package-lock.json",
    pointer: "/packages/node_modules~1swagger-node-runner/dependencies/config"});
  expect(result.routing_dependencies.evidence_locations).toContainEqual({path: "package-lock.json",
    pointer: "/packages/node_modules~1config/version"});
});
test.each(["missing", "link", "alias", "range", "opaque-range", "different-version"])("%s never matches the pinned routing target", mode => {
  const lock = make();
  if (mode === "missing") delete lock.packages["node_modules/config"];
  if (mode === "link") lock.packages["node_modules/swagger-node-runner/node_modules/config"] = {link: true};
  if (mode === "alias") lock.packages["node_modules/config"].name = "another-package";
  if (mode === "range") lock.packages["node_modules/config"].version = "^1.31.0";
  if (mode === "opaque-range") lock.packages["node_modules/swagger-node-runner"].dependencies.config = "latest";
  if (mode === "different-version") {
    lock.packages["node_modules/config"].version = "1.30.0";
    lock.packages["node_modules/swagger-node-runner"].dependencies.config = "1.30.0";
  }
  const result = analyze(lock);
  expect(result.kind).toBe("locked");
  if (result.kind !== "locked") throw new Error("missing framework");
  expect(result.routing_dependencies.conformance_target).not.toBe(true);
  expect(result.routing_dependencies.kind).toBe(mode === "different-version" ? "locked" : "unresolved");
});
test("a nested runner resolves dependencies through its wrapper before the root", () => {
  const lock = make();
  lock.packages["node_modules/swagger-express-mw/node_modules/swagger-node-runner"] = lock.packages["node_modules/swagger-node-runner"];
  lock.packages["node_modules/swagger-express-mw/node_modules/config"] = {version: "1.31.0"};
  lock.packages["node_modules/config"] = {version: "9.0.0"};
  const result = analyze(lock);
  expect(result).toMatchObject({routing_dependencies: {kind: "locked", conformance_target: true}});
  if (result.kind !== "locked") throw new Error("missing framework");
  expect(result.routing_dependencies.evidence_locations).toContainEqual({path: "package-lock.json",
    pointer: "/packages/node_modules~1swagger-express-mw~1node_modules~1config/version"});
});


test("the committed runtime harness matches the bounded routing target", () => {
  const lock = JSON.parse(readFileSync(new URL("../conformance/swagger-runtime/package-lock.json", import.meta.url), "utf8"));
  expect(analyze(lock)).toMatchObject({kind: "locked", conformance_target: true,
    routing_dependencies: {kind: "locked", conformance_target: true}});
  expect(JSON.stringify(analyze(lock))).not.toContain("https://");
  expect(JSON.stringify(analyze(lock))).not.toContain("sha512-");
});
