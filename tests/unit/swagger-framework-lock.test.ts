import { resolve } from "node:path";
import { expect, test } from "vitest";
import { resolveSwaggerFrameworkLock } from "../../analyzers/nodejs/src/framework-lock.js";

const root = resolve("/synthetic/service");
const packageJson = { dependencies: { "swagger-express-mw": "0.7.0" } };
const lock = () => ({ lockfileVersion: 3, packages: {
  "": { dependencies: packageJson.dependencies },
  "node_modules/swagger-express-mw": { version: "0.7.0", dependencies: { "swagger-node-runner": "^0.7.0" } },
  "node_modules/swagger-node-runner": { version: "0.7.0" },
} } as Record<string, any>);
const files = (value = lock(), manifest: unknown = packageJson) => new Map([
  [resolve(root, "package.json"), JSON.stringify(manifest)],
  [resolve(root, "package-lock.json"), JSON.stringify(value)],
]);

test.each([2, 3])("npm lock v%s records wrapper and runner at exact source pointers", version => {
  const value = lock(); value.lockfileVersion = version;
  const result = resolveSwaggerFrameworkLock(files(value), root);
  expect(result).toMatchObject({ kind: "locked", wrapper_version: "0.7.0", runner_version: "0.7.0", conformance_target: true });
  if (result.kind !== "locked") throw new Error("Expected locked versions");
  expect(result.evidence_locations).toContainEqual({path: "package.json", pointer: "/dependencies/swagger-express-mw"});
  expect(result.evidence_locations).toContainEqual({path: "package-lock.json", pointer: "/packages/node_modules~1swagger-node-runner/version"});
});

test("nearest nested runner wins over the hoisted version", () => {
  const value = lock();
  value.packages["node_modules/swagger-express-mw/node_modules/swagger-node-runner"] = {version: "0.7.1"};
  expect(resolveSwaggerFrameworkLock(files(value), root)).toMatchObject({kind: "locked", runner_version: "0.7.1", conformance_target: false});
});

test.each(["v1", "missing-wrapper", "missing-runner", "link", "alias", "stale-root", "range", "runner-range", "nested-link"])(
  "%s cannot qualify the bounded lock profile", failure => {
    const value = lock(); const manifest = structuredClone(packageJson);
    if (failure === "v1") value.lockfileVersion = 1;
    if (failure === "missing-wrapper") delete value.packages["node_modules/swagger-express-mw"];
    if (failure === "missing-runner") delete value.packages["node_modules/swagger-node-runner"];
    if (failure === "link") value.packages["node_modules/swagger-express-mw"].link = true;
    if (failure === "alias") value.packages["node_modules/swagger-express-mw"].name = "other-library";
    if (failure === "stale-root") value.packages[""].dependencies = {"swagger-express-mw": "0.6.0"};
    if (failure === "range") manifest.dependencies["swagger-express-mw"] = "^0.7.0";
    if (failure === "runner-range") value.packages["node_modules/swagger-express-mw"].dependencies["swagger-node-runner"] = "latest";
    if (failure === "nested-link") value.packages["node_modules/swagger-express-mw/node_modules/swagger-node-runner"] = {link: true};
    expect(resolveSwaggerFrameworkLock(files(value, manifest), root).kind).toBe("unresolved");
  });

test("multiple lock authorities and malformed/private input produce safe diagnostics", () => {
  for (const mode of ["multiple", "invalid", "oversized", "missing"]) {
    const input = files();
    if (mode === "multiple") input.set(resolve(root, "npm-shrinkwrap.json"), JSON.stringify(lock()));
    if (mode === "invalid") input.set(resolve(root, "package-lock.json"), '{"private-marker":');
    if (mode === "oversized") input.set(resolve(root, "package-lock.json"), "private-marker".repeat(100_000));
    if (mode === "missing") input.delete(resolve(root, "package-lock.json"));
    const result = resolveSwaggerFrameworkLock(input, root);
    expect(result.kind).toBe("unresolved");
    expect(JSON.stringify(result)).not.toContain("private-marker");
  }
});


test("npm shrinkwrap is accepted as the single selected lock authority", () => {
  const input = files();
  input.set(resolve(root, "npm-shrinkwrap.json"), input.get(resolve(root, "package-lock.json"))!);
  input.delete(resolve(root, "package-lock.json"));
  const result = resolveSwaggerFrameworkLock(input, root);
  expect(result.kind).toBe("locked");
  expect(result.evidence_locations).toContainEqual({path: "npm-shrinkwrap.json", pointer: "/packages/node_modules~1swagger-express-mw/version"});
});

test("duplicate keys and conflicting package-manager evidence cannot supply versions", () => {
  const input = files();
  input.set(resolve(root, "package-lock.json"), '{"lockfileVersion":3,"lockfileVersion":2,"packages":{}}');
  expect(resolveSwaggerFrameworkLock(input, root).kind).toBe("unresolved");
  const conflicting = files(); conflicting.set(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
  expect(resolveSwaggerFrameworkLock(conflicting, root).kind).toBe("unresolved");
});


test.each(["yarn.lock", "bun.lock", "bun.lockb"])("opaque %s is a competing lock authority", path => {
  const opaque = new Map([[resolve(root, path), "opaque-digest"]]);
  expect(resolveSwaggerFrameworkLock(files(), root, opaque).kind).toBe("unresolved");
});

test.each(["yarn@4.0.0", "pnpm@9.0.0", "npm@latest", "bun@1.0.0"])("manager marker %s cannot qualify npm lock evidence", packageManager => {
  expect(resolveSwaggerFrameworkLock(files(lock(), {...packageJson, packageManager}), root).kind).toBe("unresolved");
});

test("an exact npm manager marker is consistent with bounded lock declarations", () => {
  expect(resolveSwaggerFrameworkLock(files(lock(), {...packageJson, packageManager: "npm@10.0.0"}), root).kind).toBe("locked");
});
