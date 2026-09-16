import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parseAnalyzerResult } from "../../packages/ir/src/index.js";

const script = resolve("scripts/extract.mjs");
const baseline = resolve("fixtures/typescript/orders/baseline/src");
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30000 });
const documentedArguments = ["--source", "fixtures/typescript/orders/baseline/src", "--service", "orders", "--revision", "a".repeat(40)];

test("CLI emits valid JSON for relative and absolute roots without stdout diagnostics", () => {
  for (const source of ["fixtures/typescript/orders/baseline/src", baseline]) {
    const output = run(["--source", source, "--service", "orders", "--revision", "a".repeat(40)]);
    expect(output.status).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.endpoints).toHaveLength(3);
    expect(result.source.source_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(output.stderr).toContain("computed_route_path_unresolved");
  }
});

test("CLI rejects mutable revisions, unsupported IR, missing and unknown arguments without leaking source", () => {
  const valid = ["--source", baseline, "--service", "orders", "--revision", "a".repeat(40)];
  for (const args of [[], [...valid, "--ir-version", "2.0.0"], [...valid, "--unknown", "private-secret"], valid.slice(0, -2), [...valid.slice(0, -1), "rev-a"]]) {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("private-secret");
    expect(result.stderr).not.toContain(baseline);
  }
});

test("CLI never executes source side effects or reads fixture expectations", async () => {
  const root = await mkdtemp(join(tmpdir(), "extractor-cli-"));
  try {
    const sentinel = join(root, "sentinel.txt");
    await writeFile(sentinel, "untouched");
    await writeFile(join(root, "expected.json"), "not-json and not an oracle");
    await writeFile(join(root, "app.ts"), `import express from "express"; import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(sentinel)},"EXECUTED"); const app=express(); app.get("/independent",(req,res)=>res.status(200).type("application/json").json({works:true}));`);
    const output = run(["--source", root, "--service", "different-service", "--revision", "b".repeat(40)]);
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout).endpoints[0].application_path).toBe("/independent");
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("documented npm command emits only a D03-valid AnalyzerResult on stdout", () => {
  const output = spawnSync("npm", ["run", "--silent", "extract", "--", ...documentedArguments], { encoding: "utf8", timeout: 30000, cwd: resolve(".") });
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(output.stderr).toContain("computed_route_path_unresolved");
});
