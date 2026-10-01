import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseAnalyzerResult } from "../../packages/ir/src/index.js";

const script = resolve("scripts/extract-swagger2.mjs");
const source = resolve("fixtures/nodejs/swagger2/orders");
const args = ["--source", source, "--document", "api/swagger/swagger.json", "--service", "orders", "--revision", "a".repeat(40)];
const run = (values: string[]) => spawnSync(process.execPath, [script, ...values], { encoding: "utf8", timeout: 30000 });

test("local Swagger 2 command emits one valid declared route with a visible coverage gap", () => {
  const output = run(args);
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.analyzer.analyzer_id).toBe("nodejs-swagger2-document");
  expect(result.endpoints).toHaveLength(1);
  expect(result.endpoints[0]).toMatchObject({ application_path: "/orders/{id}", identity: { method: "GET" } });
  expect(result.status).toBe("partial");
  expect(output.stderr).toContain("middleware_binding_unverified");
  expect(output.stdout.trim()).not.toContain("Swagger 2 extraction failed");
}, 30000);

test("local Swagger 2 command accepts YAML and keeps basePath out of route identity", () => {
  const output = run(args.map(value => value === "api/swagger/swagger.json" ? "api/swagger/swagger.yaml" : value));
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map((endpoint: { application_path: string }) => endpoint.application_path)).toEqual(["/orders/{id}"]);
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "exposure.base_path.declaration", value: "/gateway/v1" }));
  expect(output.stderr).toContain("base_path_requires_middleware_profile");
}, 30000);

test("local Swagger 2 command rejects bad or escaping input without echoing private paths", () => {
  for (const invalid of [[], [...args, "--unknown", "private-secret"], [...args.slice(0, -1), "main"],
    args.map((value, index) => index === 3 ? "../outside.json" : value)]) {
    const output = run(invalid);
    expect(output.status).not.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain(source);
    expect(output.stderr).not.toContain("private-secret");
  }
}, 30000);
