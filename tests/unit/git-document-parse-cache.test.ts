import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterEach, expect, test, vi} from "vitest";
import {createLocalGitAnalysisPorts} from "../../connectors/git-source/src/analysis-ports.js";
import {configuredAnalyzerProfiles} from "../../analyzers/host/src/index.js";
import type {ParsedDocumentCache} from "../../analyzers/nodejs/src/parsed-document-cache.js";

const observedCaches = vi.hoisted(() => ({values: [] as unknown[]}));
vi.mock("../../analyzers/host/src/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../analyzers/host/src/index.js")>();
  return {...actual, createConfiguredAnalyzer: (options: Parameters<typeof actual.createConfiguredAnalyzer>[0]) => {
    if (options.parsedDocumentCache) observedCaches.values.push(options.parsedDocumentCache);
    return actual.createConfiguredAnalyzer(options);
  }};
});

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});

test("Git host shares only scoped parse trees across sessions and clears them on dispose", async () => {
  observedCaches.values.length = 0;
  const repoPath = await mkdtemp(join(tmpdir(), "api-truth-document-cache-git-")); roots.push(repoPath);
  await execFile("git", ["init", "-q", "-b", "main"], {cwd: repoPath});
  const documentPath = "services/api/openapi.json";
  const saveCommit = async (paths: string[]) => {
    await mkdir(dirname(join(repoPath, documentPath)), {recursive: true});
    await writeFile(join(repoPath, documentPath), JSON.stringify({openapi: "3.0.3", info: {title: "Orders", version: "1"},
      paths: Object.fromEntries(paths.map(path => [path, {get: {responses: {"200": {description: "ok"}}}}]))}));
    await execFile("git", ["add", "-A"], {cwd: repoPath});
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {cwd: repoPath});
    return (await execFile("git", ["rev-parse", "HEAD"], {cwd: repoPath})).stdout.trim();
  };
  const first = await saveCommit(["/health"]);
  await writeFile(join(repoPath, "unrelated.txt"), "changed outside selected document");
  await execFile("git", ["add", "-A"], {cwd: repoPath});
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "unrelated"], {cwd: repoPath});
  const sameDocument = (await execFile("git", ["rev-parse", "HEAD"], {cwd: repoPath})).stdout.trim();
  const changedDocument = await saveCommit(["/health", "/orders"]);

  const profile = configuredAnalyzerProfiles.find(item => item.adapter_id === "openapi3-document")!;
  const repository = {repository_id: "docs", provider: "github" as const, locator: "acme/docs",
    access_scope_id: "docs-read", services: []};
  const service = {service_id: "api", root: "services/api", analyzer: {adapter_id: profile.adapter_id,
    adapter_version: profile.adapter_version, ir_version: profile.ir_version,
    resolution_inputs: [{kind: "type_manifest" as const, path: documentPath}]}, intended_branches: ["main"], environments: []};
  const ports = createLocalGitAnalysisPorts({repositories: [
    {tenantId: "tenant-a", repositoryId: "docs", repoPath}, {tenantId: "tenant-b", repositoryId: "docs", repoPath},
  ], limits: {maxFiles: 32, maxBytes: 1_000_000, timeoutMs: 30_000, maxOutputBytes: 1_000_000},
  parsedDocumentCache: {maxEntries: 16, maxBytes: 1_000_000}});
  const cache = () => observedCaches.values.at(-1) as ParsedDocumentCache;
  const analyze = async (tenantId: string, revision: string, configFingerprint: string) => {
    const resolved = await ports.resolver.resolve({tenantId, repository, service, immutableRevision: revision, configFingerprint});
    try { return await ports.analyzer.analyze(resolved.request); }
    finally { await ports.resolver.release!(resolved.request); }
  };
  try {
    const firstResult = await analyze("tenant-a", first, "config-a");
    expect(cache().stats).toMatchObject({misses: 1, hits: 0, entries: 1});
    const sameBytesResult = await analyze("tenant-a", sameDocument, "config-a");
    expect(cache().stats).toMatchObject({misses: 1, hits: 1, entries: 1});
    expect(firstResult.evidence.every(item => item.source_version === first)).toBe(true);
    expect(sameBytesResult.evidence.every(item => item.source_version === sameDocument)).toBe(true);
    expect(sameBytesResult.snapshot_id).not.toBe(firstResult.snapshot_id);

    await analyze("tenant-a", changedDocument, "config-a");
    expect(cache().stats).toMatchObject({misses: 2, hits: 1, entries: 2});
    await analyze("tenant-a", changedDocument, "config-b");
    expect(cache().stats).toMatchObject({misses: 3, hits: 1, entries: 3});
    await analyze("tenant-b", changedDocument, "config-a");
    expect(cache().stats).toMatchObject({misses: 4, hits: 1, entries: 4});
  } finally {
    await ports.dispose();
  }
  expect(cache().stats).toMatchObject({entries: 0, retainedBytes: 0});
});
