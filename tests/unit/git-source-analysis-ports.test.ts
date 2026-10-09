import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createLocalGitAnalysisPorts } from "../../connectors/git-source/src/analysis-ports.js";
import type { AnalysisWorkerPorts } from "../../packages/orchestration/src/execution.js";
import type { AnalyzerSelection } from "../../packages/ir/src/index.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-git-ports-test-")); roots.push(root);
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  await execFile("git", ["add", "-A"], { cwd: root });
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  const revision = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { root, revision };
}

const selection = { adapter_id: "typescript-express", adapter_version: "0.6.0", ir_version: "1.0.0" as const };
const limits = { maxFiles: 100, maxBytes: 1_000_000, timeoutMs: 10_000, maxOutputBytes: 1_000_000 };
function input(revision: string, analyzer: AnalyzerSelection = selection) {
  return {
    tenantId: "tenant-a",
    repository: { repository_id: "repo-a", provider: "git", locator: "local", access_scope_id: "scope-a", services: [] },
    service: { service_id: "service-a", root: "services/api", analyzer, intended_branches: [], environments: [] },
    immutableRevision: revision,
    configFingerprint: `sha256:${"a".repeat(64)}`,
  } as Parameters<AnalysisWorkerPorts["resolver"]["resolve"]>[0] & { repoPath?: string };
}

test("resolves and analyzes a pinned local Git tree with the compiled Express profile", async () => {
  const repo = await repository({ "services/api/index.ts": "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.send('ok'));\n" });
  const mutableLimits = { ...limits };
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }], limits: mutableLimits });
  mutableLimits.maxFiles = 1;
  mutableLimits.timeoutMs = 1;
  try {
    const resolved = await ports.resolver.resolve(input(repo.revision));
    expect(resolved.changedPaths).toEqual([]);
    expect(resolved.changedPathsComplete).toBe(false);
    expect(resolved.request.extraction_mode).toBe("baseline");
    expect(resolved.request.limits).toEqual({ timeout_ms: limits.timeoutMs, max_files: limits.maxFiles,
      max_output_bytes: limits.maxOutputBytes });
    expect(resolved.request.source.source_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(resolved.request.resolution_inputs).toEqual([
      { kind: "source_tree", path: "services/api", digest: resolved.request.source.source_digest },
    ]);
    const result = await ports.analyzer.analyze(resolved.request);
    expect(result.request_id).toBe(resolved.request.request_id);
    expect(result.source.immutable_revision).toBe(repo.revision);
    expect(result.endpoints.some(endpoint => endpoint.application_path === "/health")).toBe(true);
    const repeated = await ports.resolver.resolve(input(repo.revision));
    expect(repeated.request.request_id).toBe(resolved.request.request_id);
    const repeatedResult = await ports.analyzer.analyze(repeated.request);
    expect(repeatedResult.result_id).toBe(result.result_id);
  } finally { await ports.dispose(); }
});

test("pins analyzer acceptance to the exact resolved request and disposes on mismatch", async () => {
  const repo = await repository({ "services/api/index.ts": "export const value = 1;\n" });
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }], limits });
  const resolved = await ports.resolver.resolve(input(repo.revision));
  const changed = structuredClone(resolved.request);
  changed.source = { ...changed.source, service_id: "other-service" };
  await expect(ports.analyzer.analyze(changed)).rejects.toThrow("Local Git analysis request rejected");
  await expect(ports.analyzer.analyze(resolved.request)).rejects.toThrow("Local Git analysis request rejected");
  await ports.dispose();
});

test("rejects a duplicate stable request while its source session is still active", async () => {
  const repo = await repository({ "services/api/index.ts": "export const value = 1;\n" });
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }], limits });
  try {
    const resolved = await ports.resolver.resolve(input(repo.revision));
    await expect(ports.resolver.resolve(input(repo.revision))).rejects.toThrow("Local Git analysis request rejected");
    await ports.analyzer.analyze(resolved.request);
  } finally { await ports.dispose(); }
});

test("dispose waits for an in-flight resolve and leaves reservation capacity settled", async () => {
  const repo = await repository({ "services/api/index.ts": "export const value = 1;\n" });
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }],
    limits: { ...limits, maxSessions: 1 } });
  const resolving = ports.resolver.resolve(input(repo.revision));
  const disposing = ports.dispose();
  await expect(resolving).rejects.toThrow("Local Git analysis request rejected");
  await expect(disposing).resolves.toBeUndefined();
  await expect(ports.resolver.resolve(input(repo.revision))).rejects.toThrow("Local Git analysis request rejected");
});

test("counts open sessions against the configured cap and releases capacity after each analysis", async () => {
  const repo = await repository({ "services/api/index.ts": "export const value = 1;\n" });
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }],
    limits: { ...limits, maxSessions: 1 } });
  try {
    const firstInput = input(repo.revision);
    const first = await ports.resolver.resolve(firstInput);
    const nextInput = { ...input(repo.revision), configFingerprint: `sha256:${"b".repeat(64)}` };
    await expect(ports.resolver.resolve(nextInput)).rejects.toThrow("Local Git analysis request rejected");
    await ports.analyzer.analyze(first.request);
    const next = await ports.resolver.resolve(nextInput);
    await expect(ports.analyzer.analyze(next.request)).resolves.toMatchObject({ source: { immutable_revision: repo.revision } });
  } finally { await ports.dispose(); }
});

test("pins a routing-controller manifest with the adapter's service-relative digest and forces full mode", async () => {
  const profile = JSON.stringify({ profile_version: "1.0.0", decorator_modules: ["@example/route-kit"],
    binding: "declarations_only", route_prefix: "/api" });
  const repo = await repository({
    "services/api/controller.ts": `import { JsonController, Get } from "@example/route-kit";\n@JsonController('/items') export class Items { @Get('/') all() { return []; } }\n`,
    "services/api/api-truth.routing.json": profile,
  });
  const routing = { adapter_id: "nodejs-routing-controllers", adapter_version: "0.9.0", ir_version: "1.0.0" as const,
    resolution_inputs: [{ kind: "type_manifest" as const, path: "services/api/api-truth.routing.json" }] };
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }], limits });
  try {
    const resolved = await ports.resolver.resolve({ ...input(repo.revision, routing), baseRevision: "b".repeat(40) });
    expect(resolved.request.extraction_mode).toBe("fallback_full_service");
    expect(resolved.request.resolution_inputs[1]).toEqual({ kind: "type_manifest", path: routing.resolution_inputs[0]!.path,
      digest: `sha256:${(await import("node:crypto")).createHash("sha256").update(`api-truth.routing.json\0${profile}`).digest("hex")}` });
    expect((await ports.analyzer.analyze(resolved.request)).source.immutable_revision).toBe(repo.revision);
  } finally { await ports.dispose(); }
});

test("normalizes Swagger middleware source and default-document digests from one pinned tree", async () => {
  const document = `swagger: '2.0'\ninfo: { title: Example, version: '1' }\nbasePath: /api/v1\npaths:\n  /orders:\n    get:\n      operationId: getOrders\n      responses:\n        '200': { description: ok }\n`;
  const entry = `const express = require("express");\nconst SwaggerExpress = require("swagger-express-mw");\nconst app = express();\nSwaggerExpress.create({ appRoot: __dirname }, function (error, middleware) { if (error) throw error; middleware.register(app); });\n`;
  const repo = await repository({ "services/api/app.js": entry, "services/api/api/swagger/swagger.yaml": document });
  const middleware = { adapter_id: "nodejs-swagger-express-mw", adapter_version: "0.33.0", ir_version: "1.1.0" as const,
    resolution_inputs: [{ kind: "type_manifest" as const, path: "services/api/api/swagger/swagger.yaml" }] };
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }], limits });
  try {
    const resolved = await ports.resolver.resolve(input(repo.revision, middleware));
    expect(resolved.request.resolution_inputs[1]?.digest).toBe(`sha256:${(await import("node:crypto")).createHash("sha256")
      .update(`services/api/api/swagger/swagger.yaml\0${document}`).digest("hex")}`);
    const result = await ports.analyzer.analyze(resolved.request);
    expect(result.endpoints.map(endpoint => endpoint.application_path)).toContain("/api/v1/orders");
  } finally { await ports.dispose(); }
});

test.each([
  {
    name: "standalone Swagger 2",
    selection: { adapter_id: "nodejs-swagger2-document", adapter_version: "0.15.0", ir_version: "1.1.0" as const,
      resolution_inputs: [{ kind: "type_manifest" as const, path: "services/api/contracts/swagger.yaml" }] },
    path: "services/api/contracts/swagger.yaml",
    document: `swagger: '2.0'\ninfo: { title: Example, version: '1' }\npaths:\n  /health:\n    get:\n      responses:\n        '200': { description: ok }\n`,
    endpoint: "/health",
  },
  {
    name: "standalone OpenAPI 3.0",
    selection: { adapter_id: "openapi3-document", adapter_version: "0.2.0", ir_version: "1.1.0" as const,
      resolution_inputs: [{ kind: "type_manifest" as const, path: "services/api/contracts/openapi.yaml" }] },
    path: "services/api/contracts/openapi.yaml",
    document: `openapi: 3.0.3\ninfo: { title: Example, version: '1' }\npaths:\n  /orders:\n    post:\n      responses:\n        '201': { description: created }\n`,
    endpoint: "/orders",
  },
])("normalizes $name as a selected document only", async ({ selection: selected, path, document, endpoint }) => {
  const repo = await repository({ [path]: document });
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }], limits });
  try {
    const resolved = await ports.resolver.resolve(input(repo.revision, selected));
    const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(`${path}\0${document}`).digest("hex")}`;
    expect(resolved.request.resolution_inputs).toEqual([{ kind: "type_manifest", path, digest }]);
    expect(resolved.request.source.source_digest).toBe(digest);
    expect(resolved.request.extraction_mode).toBe("baseline");
    const result = await ports.analyzer.analyze(resolved.request);
    expect(result.endpoints.map(item => item.application_path)).toContain(endpoint);
    expect(result.evidence.every(item => item.source.kind === "api_document")).toBe(true);
  } finally { await ports.dispose(); }
});

test("standalone document profiles require one contained manifest and explicit IR 1.1", async () => {
  const repo = await repository({ "services/api/docs/openapi.yaml": "openapi: 3.0.3\ninfo: { title: Example, version: '1' }\npaths: {}\n" });
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: repo.root }], limits });
  const base = { adapter_id: "openapi3-document", adapter_version: "0.2.0", ir_version: "1.1.0" as const };
  for (const invalid of [
    { ...base, resolution_inputs: [] },
    { ...base, resolution_inputs: [{ kind: "type_manifest" as const, path: "services/api/docs/openapi.yaml" },
      { kind: "type_manifest" as const, path: "services/api/docs/openapi.yaml" }] },
    { ...base, resolution_inputs: [{ kind: "type_manifest" as const, path: "outside/openapi.yaml" }] },
    { ...base, production_entrypoint: "services/api/index.ts",
      resolution_inputs: [{ kind: "type_manifest" as const, path: "services/api/docs/openapi.yaml" }] },
    { adapter_id: base.adapter_id, adapter_version: base.adapter_version,
      resolution_inputs: [{ kind: "type_manifest" as const, path: "services/api/docs/openapi.yaml" }] },
    { ...base, resolution_inputs: [{ kind: "runtime_observation", path: "services/api/runtime.json" }] },
  ] as unknown as AnalyzerSelection[]) {
    await expect(ports.resolver.resolve(input(repo.revision, invalid))).rejects.toThrow("Local Git analysis request rejected");
  }
  await ports.dispose();
});

test("rejects document-only and runtime-dependent profiles before resolving a repository", async () => {
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId: "tenant-a", repositoryId: "repo-a", repoPath: "/missing/repository" }], limits });
  await expect(ports.resolver.resolve(input("a".repeat(40), {
    adapter_id: "nodejs-swagger2-document", adapter_version: "0.2.0", ir_version: "1.1.0",
  }))).rejects.toThrow("Local Git analysis request rejected");
  await expect(ports.resolver.resolve(input("a".repeat(40), {
    adapter_id: "nodejs-swagger-express-mw", adapter_version: "0.33.0", ir_version: "1.1.0",
    resolution_inputs: [{ kind: "type_manifest", path: "services/api/api/swagger/swagger.yaml" }],
  }))).rejects.toThrow("Local Git analysis request rejected");
  await ports.dispose();
});
