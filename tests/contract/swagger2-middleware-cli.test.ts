import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseAnalyzerResult } from "../../packages/ir/src/index.js";

const script = resolve("scripts/extract-swagger2-middleware.mjs");
const source = resolve("fixtures/nodejs/swagger2/middleware/src");
const args = ["--source", source, "--service", "orders", "--revision", "a".repeat(40)];
const run = (values: string[]) => spawnSync(process.execPath, [script, ...values], { encoding: "utf8", timeout: 30000 });

test("local middleware command emits one bound, still incomplete route", () => {
  const output = run(args);
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.analyzer.analyzer_id).toBe("nodejs-swagger-express-mw");
  expect(result.endpoints.map((item: { application_path: string }) => item.application_path))
    .toEqual(["/api/v1/orders/{id}"]);
  expect(result.status).toBe("partial");
  expect(output.stderr).toContain("handler_binding_unverified");
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "handler.candidate", verification: "inferred",
    value: expect.objectContaining({path: "api/controllers/orders.js", export_name: "getOrder"}) }));
  expect(output.stderr).toContain("handler_candidate_unverified");
}, 30000);

test("local middleware command rejects invalid input without echoing paths", () => {
  for (const invalid of [[], [...args, "--unknown", "private-secret"], [...args.slice(0, -1), "main"]]) {
    const output = run(invalid);
    expect(output.status).not.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain(source);
    expect(output.stderr).not.toContain("private-secret");
  }
}, 30000);

test("local middleware command resolves a declared custom pipeline with separate config evidence", () => {
  const output = run(["--source", resolve("fixtures/nodejs/swagger2/configured-middleware/src"),
    "--service", "orders", "--revision", "a".repeat(40)]);
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map((item: {application_path: string}) => item.application_path))
    .toEqual(["/api/v1/orders/{id}"]);
  const candidate = result.claims.find((item: {predicate: string}) => item.predicate === "handler.candidate");
  expect(candidate).toMatchObject({verification: "inferred", value: {path: "handlers/orders.js",
    controller_directory: "handlers", export_name: "getOrder"}});
  expect(result.evidence.filter((item: {evidence_id: string}) => candidate.evidence_ids.includes(item.evidence_id)))
    .toContainEqual(expect.objectContaining({source: {kind: "configuration", source_id: expect.any(String)},
      location: {path: "config/default.yaml", pointer: "/swagger/bagpipes/router/controllersDirs/0"}}));
  expect(output.stderr).toContain("routing_runtime_overrides_unverified");
  expect(result.claims.some((item: {predicate: string}) => item.predicate === "handler.binding")).toBe(false);
}, 30000);
