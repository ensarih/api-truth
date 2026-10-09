import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {afterEach, expect, test} from "vitest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true}))); });
const script = resolve("scripts/inventory-nodejs.mjs");
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], {encoding: "utf8", timeout: 30000});

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-nodejs-inventory-cli-")); roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, "service", path);
    await mkdir(join(target, ".."), {recursive: true});
    await writeFile(target, text);
  }
  return root;
}

test("local CLI inventories explicit production entrypoints without executing or disclosing source", async () => {
  const root = await tree({"main.ts": ""});
  const marker = join(root, "executed");
  await writeFile(join(root, "service/main.ts"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); import express from "express"; const app = express(); app.get("/private-path", handler);`);
  const output = run(["--project-root", root, "--service-root", "service", "--entrypoint", "main.ts"]);
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(result.classification).toBe("supported");
  expect(result.signals.map((signal: {family: string}) => signal.family)).toEqual(["express"]);
  expect(result).not.toHaveProperty("routes");
  expect(output.stdout).not.toContain("/private-path");
  expect(existsSync(marker)).toBe(false);
  expect(output.stderr).toBe("");
});

test("local CLI supports owner-selected document-only inventory and OpenAPI 3.0", async () => {
  const root = await tree({"api/openapi.json": JSON.stringify({openapi: "3.0.3", info: {title: "Example", version: "1"}, paths: {}})});
  const output = run(["--project-root", root, "--service-root", "service", "--document", "api/openapi.json"]);
  expect(output.status).toBe(0);
  const result = JSON.parse(output.stdout);
  expect(result.classification).toBe("supported");
  expect(result.signals).toMatchObject([{family: "openapi3", classification: "supported",
    evidence: [{path: "api/openapi.json", kind: "selected_api_document"}]}]);
});

test("CLI rejects missing, ambiguous, fixture and escaping selections without echoing paths", async () => {
  const root = await tree({"main.ts": `export {};`, "tests/app.test.ts": `export {};`});
  const cases = [
    [],
    ["--project-root", root, "--service-root", "service"],
    ["--project-root", root, "--service-root", "service", "--entrypoint", "main.ts", "--unknown", "secret-path"],
    ["--project-root", root, "--service-root", "service", "--entrypoint", "tests/app.test.ts"],
    ["--project-root", root, "--service-root", "../outside", "--entrypoint", "main.ts"],
  ];
  for (const args of cases) {
    const output = run(args);
    expect(output.status).not.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain(root);
    expect(output.stderr).not.toContain("secret-path");
  }
});
