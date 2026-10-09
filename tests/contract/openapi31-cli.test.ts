import {execFile} from "node:child_process";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {promisify} from "node:util";
import {expect, test} from "vitest";
import {parseAnalyzerResult} from "../../packages/ir/src/index.js";

const run = promisify(execFile);
test("OpenAPI 3.1 CLI uses its own exact profile and emits a valid bounded result", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-openapi31-cli-"));
  try {
    await mkdir(join(root, "service"));
    await writeFile(join(root, "service/openapi.json"), JSON.stringify({openapi: "3.1.0", info: {title: "Orders", version: "1"},
      paths: {"/orders": {get: {responses: {"200": {description: "ok", content: {"application/json": {
        schema: {type: ["object", "null"], properties: {kind: {const: "order"}}},
      }}}}}}}}));
    const {stdout} = await run(process.execPath, ["scripts/extract-openapi31.mjs", "--source", root, "--document", "service/openapi.json",
      "--service", "orders", "--revision", "a".repeat(40)], {cwd: resolve(".")});
    const result = JSON.parse(stdout);
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.analyzer).toEqual({analyzer_id: "openapi31-document", analyzer_version: "0.1.0"});
    expect(result.endpoints[0].application_path).toBe("/orders");
    expect(result.endpoints[0].responses[0].content[0].schema).toMatchObject({type: ["object", "null"], properties: {kind: {const: "order"}}});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("OpenAPI 3.1 CLI fails closed on a source boundary error without echoing arguments", async () => {
  try {
    await run(process.execPath, ["scripts/extract-openapi31.mjs", "--source", "/missing", "--document", "x", "--service", "orders", "--revision", "private-marker"]);
    expect.fail("must reject");
  } catch (error) {
    const failure = error as {stderr: string; stdout: string; code: number};
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).not.toContain("private-marker");
  }
});
