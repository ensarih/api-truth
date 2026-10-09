import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { createLocalGitAnalysisPorts } from "../../connectors/git-source/src/analysis-ports.js";
import { contractSnapshotFromAnalyzerResult, createAccessPolicyStore } from "../../packages/catalog/src/index.js";
import type { InstallationConfig } from "../../packages/ir/src/index.js";
import { applyOrchestrationMigrations, createOrchestrationRepository, createOrchestrationWorker } from "../../packages/orchestration/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const execFile = promisify(execFileCallback);
const tenantId = "tenant-local-git-worker";
const admin = { tenantId, principalId: "admin", capabilities: ["configuration.admin"] };
const context = { tenantId, principalId: "connector", producerId: "github-adapter",
  allowedEventTypes: ["branch.updated", "repository.baseline_requested"], allowedRepositories: ["commerce"],
  allowedServices: ["orders"], deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
const workerIdentity = { workerId: "local-git-worker", instanceId: "one", capabilities: ["jobs.execute"] };
const fingerprint = "local-git-worker-config";
const configuration: { fingerprint: string; document: InstallationConfig } = { fingerprint, document: {
  config_version: "1.0.0", access_scopes: [{ access_scope_id: "engineering", label: "Engineering" }],
  repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce",
    access_scope_id: "engineering", services: [{ service_id: "orders", root: "services/api",
      analyzer: { adapter_id: "typescript-express", adapter_version: "0.5.1", ir_version: "1.0.0" },
      intended_branches: ["main"], environments: [] }] }],
  inference: { enabled: false }, logs: { enabled: false },
} };

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "api-truth-git-worker-"));
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: root });
  const commit = async (text: string) => {
    const source = join(root, "services/api/index.ts");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, text);
    await execFile("git", ["add", "-A"], { cwd: root });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source update"], { cwd: root });
    return (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  };
  const first = await commit(`import express from "express";\nconst app = express();\napp.get("/health", (_req, res) => res.send("ok"));\n`);
  const second = await commit(`import express from "express";\nconst app = express();\napp.get("/health", (_req, res) => res.send("ok"));\napp.post("/orders", (_req, res) => res.send("created"));\n`);
  return { root, first, second };
}

const baselineEvent = (revision: string) => ({
  event_version: "1.0.0", event_id: `baseline-${revision}`, event_type: "repository.baseline_requested",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `baseline-${revision}`,
    order: { kind: "sequence", value: "1" } },
  payload: { immutable_revision: revision, service_ids: ["orders"] },
});
const branchEvent = (sequence: string, prior: string | null, next: string) => ({
  event_version: "1.0.0", event_id: `branch-${sequence}`, event_type: "branch.updated",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `branch-${sequence}`,
    order: { kind: "sequence", value: sequence } },
  payload: { branch: "main", prior_revision: prior, new_revision: next, reference_state: "fast_forward" },
});

test("materializes real Git commits through D08 and persists baseline plus configured-branch update", async () => {
  const repo = await fixtureRepository();
  const database = await createCatalogTestDatabase();
  const ports = createLocalGitAnalysisPorts({ repositories: [{ tenantId, repositoryId: "commerce", repoPath: repo.root }],
    limits: { maxFiles: 100, maxBytes: 1_000_000, timeoutMs: 30_000, maxOutputBytes: 1_000_000 } });
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const worker = createOrchestrationWorker(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin, configuration);
    await repository.activateInitialConfiguration(admin, { fingerprint });
    const configuredRepository = configuration.document.repositories[0]!;
    const configuredService = configuredRepository.services[0]!;
    const permissionProbe = await ports.resolver.resolve({ tenantId, repository: configuredRepository,
      service: configuredService, immutableRevision: repo.first, configFingerprint: fingerprint });
    const permissionResult = await ports.analyzer.analyze(permissionProbe.request);
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of contractSnapshotFromAnalyzerResult(permissionResult, fingerprint).requiredScopeIds) {
      await access.putScope({ tenantId }, { scopeId, active: true });
    }

    await repository.ingestEvent(context, baselineEvent(repo.first));
    const [baseline] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(baseline?.kind).toBe("baseline_analysis");
    expect(await worker.runJob(workerIdentity, baseline!.lease, ports)).toMatchObject({ state: "succeeded" });

    await repository.ingestEvent(context, branchEvent("2", null, repo.first));
    const [branchBaseline] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(branchBaseline?.kind).toBe("branch_analysis");
    expect(await worker.runJob(workerIdentity, branchBaseline!.lease, ports)).toMatchObject({ state: "succeeded" });

    await repository.ingestEvent(context, branchEvent("3", repo.first, repo.second));
    const [branchUpdate] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(branchUpdate?.kind).toBe("branch_analysis");
    expect(await worker.runJob(workerIdentity, branchUpdate!.lease, ports)).toMatchObject({ state: "succeeded" });

    const schema = quoteCatalogTestSchema(database.schema);
    const snapshots = await database.pool.query<{ revision: string; digest: string; paths: string[] }>(
      `SELECT immutable_revision AS revision,document->'source'->>'source_digest' AS digest,
         ARRAY(SELECT endpoint->>'application_path' FROM jsonb_array_elements(document->'endpoints') endpoint
           ORDER BY endpoint->>'application_path') AS paths
       FROM ${schema}.catalog_snapshots WHERE tenant_id=$1 ORDER BY immutable_revision`, [tenantId]);
    expect(snapshots.rows).toHaveLength(2);
    const snapshotByRevision = new Map(snapshots.rows.map(row => [row.revision, row]));
    expect(snapshotByRevision.get(repo.first)).toMatchObject({ revision: repo.first, paths: ["/health"] });
    expect(snapshotByRevision.get(repo.second)).toMatchObject({ revision: repo.second, paths: ["/health", "/orders"] });
    expect(snapshots.rows.every(row => /^sha256:[a-f0-9]{64}$/.test(row.digest))).toBe(true);
    const pointer = await database.pool.query<{ snapshot_id: string; pointer_version: string; revision: string }>(
      `SELECT pointer.snapshot_id,pointer.pointer_version::text,snapshot.immutable_revision AS revision
       FROM ${schema}.catalog_branch_pointers pointer JOIN ${schema}.catalog_snapshots snapshot
         ON snapshot.tenant_id=pointer.tenant_id AND snapshot.snapshot_id=pointer.snapshot_id
       WHERE pointer.tenant_id=$1 AND pointer.repository_id='commerce' AND pointer.service_id='orders' AND pointer.branch='main'`,
      [tenantId]);
    expect(pointer.rows[0]).toMatchObject({ revision: repo.second, pointer_version: "2" });
    const associations = await database.pool.query<{ revision: string; association_kind: string }>(
      `SELECT immutable_revision AS revision,association_kind FROM ${schema}.orchestration_revision_snapshots
       WHERE tenant_id=$1 ORDER BY immutable_revision`, [tenantId]);
    expect(new Map(associations.rows.map(row => [row.revision, row.association_kind]))).toEqual(new Map([
      [repo.first, "analyzed"], [repo.second, "analyzed"],
    ]));
  } finally {
    await ports.dispose();
    await database.cleanup();
    await rm(repo.root, { recursive: true, force: true });
  }
});
