import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parseAnalyzerResult } from "../../packages/ir/src/index.js";

const script = resolve("scripts/extract-routing-controllers.mjs");
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30000 });

test("local routing-controllers command emits D03 JSON without executing source", async () => {
  const root = await mkdtemp(join(tmpdir(), "routing-controllers-cli-"));
  try {
    const sentinel = join(root, "sentinel.txt");
    await writeFile(sentinel, "untouched");
    await writeFile(join(root, "controller.ts"), `
      import { writeFileSync } from "node:fs";
      import { JsonController, Get, Param, createExpressServer } from "routing-controllers";
      writeFileSync(${JSON.stringify(sentinel)}, "EXECUTED");
      @JsonController("/api") class Orders {
        @Get("/orders/:id") find(@Param("id") id: string): string { return id; }
      }
      createExpressServer({ controllers: [Orders] });
    `);
    const args = ["--source", root, "--service", "orders", "--revision", "a".repeat(40)];
    const output = run(args);
    expect(output.status).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.analyzer.analyzer_id).toBe("nodejs-routing-controllers");
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({ application_path: "/api/orders/:id", identity: { method: "GET" },
      responses: [{ status: { kind: "unknown" }, content: [{ media_type: "application/json" }] }] });
    expect(result.status).toBe("partial");
    expect(output.stderr).toContain("response_status_unknown");
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    const npmOutput = spawnSync("npm", ["run", "--silent", "extract:routing-controllers", "--", ...args],
      { encoding: "utf8", timeout: 30000, cwd: resolve(".") });
    expect(npmOutput.status).toBe(0);
    expect(parseAnalyzerResult(JSON.parse(npmOutput.stdout)).ok).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test("local routing-controllers command rejects bad arguments without leaking paths", () => {
  const source = resolve("fixtures/typescript/orders/baseline/src");
  const valid = ["--source", source, "--service", "orders", "--revision", "a".repeat(40)];
  for (const args of [[], [...valid, "--unknown", "private-secret"], [...valid, "--ir-version", "2.0.0"],
    [...valid.slice(0, -1), "mutable"], valid.slice(0, -2)]) {
    const output = run(args);
    expect(output.status).not.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain(source);
    expect(output.stderr).not.toContain("private-secret");
  }
}, 30000);

test("documented synthetic service command emits its registered routes", () => {
  const output = run(["--source", resolve("fixtures/nodejs/routing-controllers/orders/src"),
    "--service", "orders", "--revision", "a".repeat(40)]);
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map((endpoint: { application_path: string }) => endpoint.application_path)).toEqual([
    "/api/orders/:id", "/api/orders",
  ]);
  expect(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)).toContain("startup_entrypoint_unverified");
}, 30000);

test("local command accepts a contained declaration profile for wrapper imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "routing-controllers-profile-cli-"));
  try {
    await writeFile(join(root, "controller.ts"), `import { JsonController, Get } from "@example/route-kit";
      @JsonController("/items") class Items { @Get() list(): string { return "ok"; } }`);
    await writeFile(join(root, "api-truth.routing.json"), JSON.stringify({
      profile_version: "1.0.0", decorator_modules: ["@example/route-kit"],
      binding: "declarations_only", route_prefix: "/v1",
    }));
    const output = run(["--source", root, "--service", "items", "--revision", "a".repeat(40),
      "--profile", "api-truth.routing.json"]);
    expect(output.status).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.endpoints.map((endpoint: { application_path: string }) => endpoint.application_path)).toEqual(["/v1/items"]);
    expect(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code))
      .toContain("controller_registration_unverified");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test("local command selects a static controller glob and an asserted environment prefix", () => {
  const output = run(["--source", resolve("fixtures/nodejs/routing-controllers/glob/src"),
    "--service", "pets", "--revision", "a".repeat(40), "--profile", "api-truth.routing.json"]);
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map((endpoint: { application_path: string }) => endpoint.application_path))
    .toEqual(["/v1/pets/:id"]);
  expect(result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code))
    .toContain("controller_glob_source_projection_unverified");
}, 30000);

test("local command explicitly selects a contained production entrypoint",()=>{
 const args=["--source",resolve("fixtures/nodejs/routing-controllers/orders/src"),"--service","orders","--revision","a".repeat(40),"--entrypoint","app.ts"];
 const output=run(args);
 expect(output.status).toBe(0);
 const result=JSON.parse(output.stdout);
 expect(parseAnalyzerResult(result).ok).toBe(true);
 expect(result.endpoints).toHaveLength(2);
 expect(result.diagnostics.map((item:{code:string})=>item.code)).toContain("production_entrypoint_deployment_unverified");
 const invalid=run([...args.slice(0,-1),"../private-entrypoint.ts"]);
 expect(invalid.status).not.toBe(0);
 expect(invalid.stdout).toBe("");
 expect(invalid.stderr).not.toContain("private-entrypoint");
});
