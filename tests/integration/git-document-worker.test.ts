import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { createLocalGitAnalysisPorts } from "../../connectors/git-source/src/analysis-ports.js";
import { applyOrchestrationMigrations, createOrchestrationRepository, createOrchestrationWorker } from "../../packages/orchestration/src/index.js";
import type { InstallationConfig } from "../../packages/ir/src/index.js";
import { contractSnapshotFromAnalyzerResult, createAccessPolicyStore } from "../../packages/catalog/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const execFile = promisify(execFileCallback);
const tenantId = "tenant-git-document-worker";
const admin = { tenantId, principalId: "admin", capabilities: ["configuration.admin"] };
const context = { tenantId, principalId: "connector", producerId: "github-adapter",
  allowedEventTypes: ["branch.updated", "repository.baseline_requested"], allowedRepositories: ["docs"],
  allowedServices: ["api"], deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
const workerIdentity = { workerId: "git-document-worker", instanceId: "one", capabilities: ["jobs.execute"] };
const limits = { maxFiles: 100, maxBytes: 1_000_000, timeoutMs: 30_000, maxOutputBytes: 1_000_000 };

const baselineEvent = (revision: string) => ({
  event_version: "1.0.0", event_id: `document-baseline-${revision}`, event_type: "repository.baseline_requested",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "docs", service_ids: ["api"] },
  provider_evidence: { provider: "github", provider_reference: `baseline-${revision}`,
    order: { kind: "sequence", value: "1" } },
  payload: { immutable_revision: revision, service_ids: ["api"] },
});
const branchEvent = (sequence: string, prior: string | null, next: string) => ({
  event_version: "1.0.0", event_id: `document-branch-${sequence}`, event_type: "branch.updated",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "docs", service_ids: ["api"] },
  provider_evidence: { provider: "github", provider_reference: `branch-${sequence}`,
    order: { kind: "sequence", value: sequence } },
  payload: { branch: "main", prior_revision: prior, new_revision: next, reference_state: "fast_forward" },
});

const documents = [
  {
    name: "standalone Swagger 2",
    adapter_id: "nodejs-swagger2-document",
    adapter_version: "0.15.0",
    first: `swagger: '2.0'\ninfo: { title: Example, version: '1' }\npaths:\n  /health:\n    get:\n      responses:\n        '200': { description: ok }\n`,
    second: `swagger: '2.0'\ninfo: { title: Example, version: '1' }\npaths:\n  /health:\n    get:\n      responses:\n        '200': { description: ok }\n  /orders:\n    post:\n      responses:\n        '201': { description: created }\n`,
  },
  {
    name: "standalone OpenAPI 3.0",
    adapter_id: "openapi3-document",
    adapter_version: "0.2.0",
    first: `openapi: 3.0.3\ninfo: { title: Example, version: '1' }\npaths:\n  /health:\n    get:\n      responses:\n        '200': { description: ok }\n`,
    second: `openapi: 3.0.3\ninfo: { title: Example, version: '1' }\npaths:\n  /health:\n    get:\n      responses:\n        '200': { description: ok }\n  /orders:\n    post:\n      responses:\n        '201': { description: created }\n`,
  },
];

documents.push({...documents[1]!, name:"standalone OpenAPI 3.1", adapter_id:"openapi31-document", adapter_version:"0.1.0",
  first:documents[1]!.first.replace("openapi: 3.0.3", "openapi: 3.1.1"),
  second:documents[1]!.second.replace("openapi: 3.0.3", "openapi: 3.1.1")});

const failedDocumentCases = documents.flatMap(profile => [
  { profile, failureCase: "malformed" as const },
  { profile, failureCase: "deleted" as const },
]);

test.each(failedDocumentCases)("persists $profile.name baseline/update; $failureCase document cannot promote", async ({ profile, failureCase }) => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-git-document-worker-"));
  const database = await createCatalogTestDatabase();
  const documentPath = "services/api/contracts/api.yaml";
  const commitDocument = async (text: string | undefined): Promise<string> => {
    const absolute = join(root, documentPath);
    if (text === undefined) await rm(absolute, { force: true });
    else {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text);
    }
    await execFile("git", ["add", "-A"], { cwd: root });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "document update"], { cwd: root });
    return (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  };
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: root });
  const first = await commitDocument(profile.first);
  const second = await commitDocument(profile.second);
  const invalidRevision = await commitDocument(failureCase === "deleted" ? undefined : "swagger: '2.0'\nopenapi: [invalid\n");
  const fingerprint = `git-document-${profile.adapter_id}`;
  const manifest = { kind: "type_manifest" as const, path: documentPath };
  const configuration: { fingerprint: string; document: InstallationConfig } = { fingerprint, document: {
    config_version: "1.0.0", access_scopes: [{ access_scope_id: "docs-read", label: "Document readers" }],
    repositories: [{ repository_id: "docs", provider: "github", locator: "acme/docs", access_scope_id: "docs-read",
      services: [{ service_id: "api", root: "services/api", analyzer: {
        adapter_id: profile.adapter_id, adapter_version: profile.adapter_version, ir_version: "1.1.0",
        resolution_inputs: [manifest],
      }, intended_branches: ["main"], environments: [] }] }],
    inference: { enabled: false }, logs: { enabled: false },
  } };
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId, repositoryId: "docs", repoPath: root }], limits });
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const worker = createOrchestrationWorker(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin, configuration);
    await repository.activateInitialConfiguration(admin, { fingerprint });
    const configuredRepository = configuration.document.repositories[0]!;
    const configuredService = configuredRepository.services[0]!;
    const permissionProbe = await ports.resolver.resolve({ tenantId, repository: configuredRepository,
      service: configuredService, immutableRevision: first, configFingerprint: fingerprint });
    const permissionResult = await ports.analyzer.analyze(permissionProbe.request);
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of contractSnapshotFromAnalyzerResult(permissionResult, fingerprint).requiredScopeIds) {
      await access.putScope({ tenantId }, { scopeId, active: true });
    }

    await repository.ingestEvent(context, baselineEvent(first));
    const [baseline] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(baseline?.kind).toBe("baseline_analysis");
    expect(await worker.runJob(workerIdentity, baseline!.lease, ports)).toMatchObject({ state: "succeeded" });

    await repository.ingestEvent(context, branchEvent("2", null, first));
    const [branchBaseline] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(branchBaseline?.kind).toBe("branch_analysis");
    expect(await worker.runJob(workerIdentity, branchBaseline!.lease, ports)).toMatchObject({ state: "succeeded" });

    await repository.ingestEvent(context, branchEvent("3", first, second));
    const [branchUpdate] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(branchUpdate?.kind).toBe("branch_analysis");
    expect(await worker.runJob(workerIdentity, branchUpdate!.lease, ports)).toMatchObject({ state: "succeeded" });

    const schema = quoteCatalogTestSchema(database.schema);
    const pointerBeforeInvalid = await database.pool.query<{ snapshot_id: string; revision: string }>(
      `SELECT pointer.snapshot_id,snapshot.immutable_revision AS revision
       FROM ${schema}.catalog_branch_pointers pointer JOIN ${schema}.catalog_snapshots snapshot
         ON snapshot.tenant_id=pointer.tenant_id AND snapshot.snapshot_id=pointer.snapshot_id
       WHERE pointer.tenant_id=$1 AND pointer.repository_id='docs' AND pointer.service_id='api' AND pointer.branch='main'`,
      [tenantId]);
    expect(pointerBeforeInvalid.rows[0]?.revision).toBe(second);

    await repository.ingestEvent(context, branchEvent("4", second, invalidRevision));
    const [invalidClaim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(invalidClaim?.kind).toBe("branch_analysis");
    await expect(worker.runJob(workerIdentity, invalidClaim!.lease, ports)).rejects.toMatchObject({ code: "JOB_EXECUTION_FAILED" });
    const state = await database.pool.query<{ snapshot_id: string; revision: string; failed_associations: string }>(
      `SELECT pointer.snapshot_id,snapshot.immutable_revision AS revision,
         (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots
          WHERE tenant_id=$1 AND immutable_revision=$2) AS failed_associations
       FROM ${schema}.catalog_branch_pointers pointer JOIN ${schema}.catalog_snapshots snapshot
         ON snapshot.tenant_id=pointer.tenant_id AND snapshot.snapshot_id=pointer.snapshot_id
       WHERE pointer.tenant_id=$1 AND pointer.repository_id='docs' AND pointer.service_id='api' AND pointer.branch='main'`,
      [tenantId, invalidRevision]);
    expect(state.rows[0]).toEqual({ ...pointerBeforeInvalid.rows[0], revision: second, failed_associations: "0" });

    const snapshots = await database.pool.query<{ revision: string; paths: string[] }>(
      `SELECT immutable_revision AS revision,ARRAY(SELECT endpoint->>'application_path'
         FROM jsonb_array_elements(document->'endpoints') endpoint ORDER BY endpoint->>'application_path') AS paths
       FROM ${schema}.catalog_snapshots WHERE tenant_id=$1`, [tenantId]);
    const byRevision = new Map(snapshots.rows.map(row => [row.revision, row.paths]));
    expect(byRevision.get(first)).toEqual(["/health"]);
    expect(byRevision.get(second)).toEqual(["/health", "/orders"]);
    expect(byRevision.has(invalidRevision)).toBe(false);
  } finally {
    await ports.dispose();
    await database.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
