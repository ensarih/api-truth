import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { createLocalGitAnalysisPorts } from "../../connectors/git-source/src/analysis-ports.js";
import { applyOrchestrationMigrations, createOrchestrationRepository,
  createOrchestrationWorker } from "../../packages/orchestration/src/index.js";
import type { AnalysisWorkerPorts } from "../../packages/orchestration/src/execution.js";
import type { AnalyzerRequest, InstallationConfig } from "../../packages/ir/src/index.js";
import { createAccessPolicyStore, contractSnapshotFromAnalyzerResult } from "../../packages/catalog/src/index.js";
import { canonicalOrchestrationHash } from "../../packages/orchestration/src/canonical.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const execFile = promisify(execFileCallback);
const tenantId = "tenant-document-input-reuse";
const admin = { tenantId, principalId: "admin", capabilities: ["configuration.admin"] };
const context = { tenantId, principalId: "connector", producerId: "github-adapter",
  allowedEventTypes: ["branch.updated"], allowedRepositories: ["docs"], allowedServices: ["api"],
  deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
const workerIdentity = { workerId: "document-input-reuse", instanceId: "one", capabilities: ["jobs.execute"] };
const limits = { maxFiles: 100, maxBytes: 1_000_000, timeoutMs: 30_000, maxOutputBytes: 1_000_000, maxSessions: 1 };
const documentPath = "services/api/contracts/api.yaml";
const profiles = [
  { label: "Swagger 2", adapter_id: "nodejs-swagger2-document", adapter_version: "0.15.0",
    document: (path: string) => `swagger: '2.0'\ninfo: { title: Example, version: '1' }\npaths:\n  ${path}:\n    get:\n      responses:\n        '200': { description: ok }\n` },
  { label: "OpenAPI 3.0", adapter_id: "openapi3-document", adapter_version: "0.2.0",
    document: (path: string) => `openapi: 3.0.3\ninfo: { title: Example, version: '1' }\npaths:\n  ${path}:\n    get:\n      responses:\n        '200': { description: ok }\n` },
  { label: "OpenAPI 3.1", adapter_id: "openapi31-document", adapter_version: "0.1.0",
    document: (path: string) => `openapi: 3.1.1\ninfo: { title: Example, version: '1' }\npaths:\n  ${path}:\n    get:\n      responses:\n        '200': { description: ok }\n` },
] as const;

const branchEvent = (sequence: string, prior: string | null, next: string) => ({
  event_version: "1.0.0", event_id: `doc-reuse-${sequence}`, event_type: "branch.updated",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "docs", service_ids: ["api"] },
  provider_evidence: { provider: "github", provider_reference: `delivery-${sequence}`,
    order: { kind: "sequence", value: sequence } },
  payload: { branch: "main", prior_revision: prior, new_revision: next, reference_state: "fast_forward" },
});

const createFixture = async (profile: typeof profiles[number]) => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-document-input-reuse-"));
  const database = await createCatalogTestDatabase();
  const writeCommit = async (text: string, note: string): Promise<string> => {
    const absolute = join(root, documentPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    await writeFile(join(root, "README.txt"), note);
    await execFile("git", ["add", "-A"], { cwd: root });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-qm", note], { cwd: root });
    return (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  };
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: root });
  const firstRevision = await writeCommit(profile.document("/health"), "first source");
  const unchangedDocumentRevision = await writeCommit(profile.document("/health"), "unrelated source edit");
  const fingerprint = `document-reuse-${profile.adapter_id}`;
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
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
  const worker = createOrchestrationWorker(database.pool, { schema: database.schema });
  await repository.registerConfiguration(admin, configuration);
  await repository.activateInitialConfiguration(admin, { fingerprint });
  const configuredRepository = configuration.document.repositories[0]!;
  const configuredService = configuredRepository.services[0]!;
  const permissionProbe = await ports.resolver.resolve({ tenantId, repository: configuredRepository,
    service: configuredService, immutableRevision: firstRevision, configFingerprint: fingerprint });
  const permissionResult = await ports.analyzer.analyze(permissionProbe.request);
  const access = createAccessPolicyStore(database.pool, { schema: database.schema });
  for (const scopeId of contractSnapshotFromAnalyzerResult(permissionResult, fingerprint).requiredScopeIds) {
    await access.putScope({ tenantId }, { scopeId, active: true });
  }
  return { root, database, repository, worker, ports, fingerprint, firstRevision,
    unchangedDocumentRevision, permissionResult, writeCommit, configuredRepository, configuredService };
};

test.each(profiles)("rechecks unchanged selected bytes for $label and preserves incomplete coverage", async profile => {
  const fixture = await createFixture(profile);
  try {
    let analyzerCalls = 0;
    let releaseCalls = 0;
    let lastResolution: Awaited<ReturnType<typeof fixture.ports.resolver.resolve>> | undefined;
    const ports: AnalysisWorkerPorts = { ...fixture.ports,
      resolver: { ...fixture.ports.resolver,
        resolve: async input => {
          lastResolution = await fixture.ports.resolver.resolve(input);
          return lastResolution;
        },
        release: async request => {
          releaseCalls += 1;
          return fixture.ports.resolver.release(request);
        } },
      analyzer: { analyze: async request => {
        analyzerCalls += 1;
        return fixture.ports.analyzer.analyze(request);
      } },
    };
    await fixture.repository.ingestEvent(context,
      branchEvent("1", null, fixture.firstRevision));
    const [first] = await fixture.worker.claimJobs(workerIdentity, { limit: 1 });
    expect(await fixture.worker.runJob(workerIdentity, first!.lease, ports)).toMatchObject({ state: "succeeded" });
    expect(analyzerCalls).toBe(1);
    const releasesBeforeNoop = releaseCalls;

    await fixture.repository.ingestEvent(context,
      branchEvent("2", fixture.firstRevision, fixture.unchangedDocumentRevision));
    const [second] = await fixture.worker.claimJobs(workerIdentity, { limit: 1 });
    expect(await fixture.worker.runJob(workerIdentity, second!.lease, ports)).toMatchObject({ state: "succeeded" });
    expect(lastResolution?.changedPaths).toEqual([]);
    expect(lastResolution?.changedPathsComplete).toBe(true);
    const schema = quoteCatalogTestSchema(fixture.database.schema);
    const baseEvidence = await fixture.database.pool.query<{ resolution_inputs_fingerprint: string | null;
      coverage_status: string }>(
      `SELECT association.resolution_inputs_fingerprint,(
         SELECT snapshot.document->'coverage'->>'status' FROM ${schema}.catalog_snapshots snapshot
         WHERE snapshot.tenant_id=association.tenant_id AND snapshot.snapshot_id=association.snapshot_id) AS coverage_status
       FROM ${schema}.orchestration_revision_snapshots association
       WHERE association.tenant_id=$1 AND association.immutable_revision=$2`, [tenantId, fixture.firstRevision]);
    expect(baseEvidence.rows[0]?.resolution_inputs_fingerprint).toBe(canonicalOrchestrationHash({
      version: "orchestration-resolution-inputs-1", resolutionInputs: lastResolution!.request.resolution_inputs,
    }));
    expect(baseEvidence.rows[0]?.coverage_status).toBe("incomplete");
    expect(analyzerCalls).toBe(2);
    expect(releaseCalls).toBeGreaterThan(releasesBeforeNoop);

    // Prove the one-session limit has no leftover materialization after analysis cleanup.
    const capacityProbe = await fixture.ports.resolver.resolve({ tenantId, repository: fixture.configuredRepository,
      service: fixture.configuredService, immutableRevision: fixture.unchangedDocumentRevision,
      baseRevision: fixture.firstRevision, configFingerprint: fixture.fingerprint });
    await fixture.ports.resolver.release(capacityProbe.request);

    const stored = await fixture.database.pool.query<{ kind: string; snapshot_id: string;
      revision: string; snapshot_revision: string }>(
      `SELECT association.association_kind AS kind,association.snapshot_id,
         association.immutable_revision AS revision,snapshot.immutable_revision AS snapshot_revision
       FROM ${schema}.orchestration_revision_snapshots association
       JOIN ${schema}.catalog_snapshots snapshot ON snapshot.tenant_id=association.tenant_id
         AND snapshot.snapshot_id=association.snapshot_id
       WHERE association.tenant_id=$1`, [tenantId]);
    const byRevision = new Map(stored.rows.map(row => [row.revision, row]));
    expect(stored.rows).toHaveLength(2);
    expect(byRevision.get(fixture.firstRevision)).toMatchObject({ kind: "analyzed", snapshot_id: expect.any(String),
      snapshot_revision: fixture.firstRevision });
    expect(byRevision.get(fixture.unchangedDocumentRevision)).toMatchObject({ kind: "analyzed",
      snapshot_id: expect.any(String), snapshot_revision: fixture.unchangedDocumentRevision });
    const counts = await fixture.database.pool.query<{ associations: string; snapshots: string;
      selected_revision: string | null }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
         (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
         (SELECT last_successful_selected_revision FROM ${schema}.orchestration_branch_checkpoints
          WHERE tenant_id=$1 AND repository_id='docs' AND service_id='api' AND branch='main') AS selected_revision`,
      [tenantId]);
    expect(counts.rows).toEqual([{ associations: "2", snapshots: "2", selected_revision: fixture.unchangedDocumentRevision }]);
  } finally {
    await fixture.ports.dispose();
    await fixture.database.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test.each([
  "selected document changed",
  "base coverage partial",
  "legacy fingerprint unknown",
  "resolver proof incomplete",
] as const)("does a full analysis when document no-op proof is unsafe: %s", async condition => {
  const profile = profiles[2]!;
  const fixture = await createFixture(profile);
  try {
    let analyzerCalls = 0;
    let resolverProofIncomplete = false;
    const wrappedPorts: AnalysisWorkerPorts = { ...fixture.ports,
      resolver: { ...fixture.ports.resolver, resolve: async input => {
        const result = await fixture.ports.resolver.resolve(input);
        return resolverProofIncomplete
          ? { ...result, changedPaths: [], changedPathsComplete: false,
            request: { ...result.request, changed_paths: [] } }
          : result;
      } },
      analyzer: { analyze: async request => {
        analyzerCalls += 1;
        return fixture.ports.analyzer.analyze(request);
      } },
    };
    await fixture.repository.ingestEvent(context, branchEvent("1", null, fixture.firstRevision));
    const [first] = await fixture.worker.claimJobs(workerIdentity, { limit: 1 });
    await expect(fixture.worker.runJob(workerIdentity, first!.lease, wrappedPorts))
      .resolves.toMatchObject({ state: "succeeded" });
    expect(analyzerCalls).toBe(1);

    if (condition === "legacy fingerprint unknown") {
      const schema = quoteCatalogTestSchema(fixture.database.schema);
      await fixture.database.pool.query(`ALTER TABLE ${schema}.orchestration_revision_snapshots
        DISABLE TRIGGER orchestration_revision_snapshots_immutable`);
      await fixture.database.pool.query(`UPDATE ${schema}.orchestration_revision_snapshots
        SET resolution_inputs_fingerprint=NULL WHERE tenant_id=$1 AND immutable_revision=$2`,
        [tenantId, fixture.firstRevision]);
      await fixture.database.pool.query(`ALTER TABLE ${schema}.orchestration_revision_snapshots
        ENABLE TRIGGER orchestration_revision_snapshots_immutable`);
    }
    const nextRevision = condition === "selected document changed"
      ? await fixture.writeCommit(profile.document("/orders"), "selected document edit")
      : fixture.unchangedDocumentRevision;
    resolverProofIncomplete = condition === "resolver proof incomplete";
    await fixture.repository.ingestEvent(context,
      branchEvent("2", fixture.firstRevision, nextRevision));
    const [second] = await fixture.worker.claimJobs(workerIdentity, { limit: 1 });
    await expect(fixture.worker.runJob(workerIdentity, second!.lease, wrappedPorts))
      .resolves.toMatchObject({ state: "succeeded" });
    expect(analyzerCalls).toBe(2);

    const schema = quoteCatalogTestSchema(fixture.database.schema);
    const associations = await fixture.database.pool.query<{ immutable_revision: string; association_kind: string }>(
      `SELECT immutable_revision,association_kind FROM ${schema}.orchestration_revision_snapshots
       WHERE tenant_id=$1 ORDER BY immutable_revision`, [tenantId]);
    const byRevision = new Map(associations.rows.map(row => [row.immutable_revision, row.association_kind]));
    expect(associations.rows).toHaveLength(2);
    expect(byRevision.get(fixture.firstRevision)).toBe("analyzed");
    expect(byRevision.get(nextRevision)).toBe("analyzed");
  } finally {
    await fixture.ports.dispose();
    await fixture.database.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a superseded analysis cannot publish after its source session is released", async () => {
  const profile = profiles[2]!;
  const fixture = await createFixture(profile);
  try {
    const newestRevision = await fixture.writeCommit(profile.document("/health"), "newest unrelated edit");
    let supersedeOnRelease = false;
    const wrappedPorts: AnalysisWorkerPorts = { ...fixture.ports,
      resolver: { ...fixture.ports.resolver, release: async request => {
        await fixture.ports.resolver.release(request);
        if (!supersedeOnRelease || (request as AnalyzerRequest).source.immutable_revision
          !== fixture.unchangedDocumentRevision) return;
        supersedeOnRelease = false;
        await fixture.repository.ingestEvent(context,
          branchEvent("3", fixture.unchangedDocumentRevision, newestRevision));
      } },
    };
    await fixture.repository.ingestEvent(context, branchEvent("1", null, fixture.firstRevision));
    const [first] = await fixture.worker.claimJobs(workerIdentity, { limit: 1 });
    await expect(fixture.worker.runJob(workerIdentity, first!.lease, wrappedPorts))
      .resolves.toMatchObject({ state: "succeeded" });
    await fixture.repository.ingestEvent(context,
      branchEvent("2", fixture.firstRevision, fixture.unchangedDocumentRevision));
    const [second] = await fixture.worker.claimJobs(workerIdentity, { limit: 1 });
    supersedeOnRelease = true;
    await expect(fixture.worker.runJob(workerIdentity, second!.lease, wrappedPorts)).rejects.toMatchObject({
      code: "JOB_SUPERSEDED",
    });
    const schema = quoteCatalogTestSchema(fixture.database.schema);
    const state = await fixture.database.pool.query<{ associations: string; snapshots: string;
      selected_revision: string; desired_revision: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
         (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
         checkpoint.last_successful_selected_revision AS selected_revision,
         checkpoint.desired_revision
       FROM ${schema}.orchestration_branch_checkpoints checkpoint
       WHERE checkpoint.tenant_id=$1 AND checkpoint.repository_id='docs' AND checkpoint.service_id='api'
         AND checkpoint.branch='main'`, [tenantId]);
    expect(state.rows).toEqual([{ associations: "1", snapshots: "1",
      selected_revision: fixture.firstRevision, desired_revision: newestRevision }]);
  } finally {
    await fixture.ports.dispose();
    await fixture.database.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed source-session release prevents analysis association and branch promotion", async () => {
  const fixture = await createFixture(profiles[2]!);
  try {
    const ports: AnalysisWorkerPorts = { ...fixture.ports,
      resolver: { ...fixture.ports.resolver, release: async request => {
        await fixture.ports.resolver.release(request);
        throw new Error("source release failed");
      } },
    };
    await fixture.repository.ingestEvent(context, branchEvent("1", null, fixture.firstRevision));
    const [claim] = await fixture.worker.claimJobs(workerIdentity, { limit: 1 });
    await expect(fixture.worker.runJob(workerIdentity, claim!.lease, ports))
      .rejects.toMatchObject({ code: "JOB_EXECUTION_FAILED" });
    const schema = quoteCatalogTestSchema(fixture.database.schema);
    const state = await fixture.database.pool.query<{ associations: string; snapshots: string; pointers: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
         (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
         (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1) AS pointers`, [tenantId]);
    expect(state.rows).toEqual([{ associations: "0", snapshots: "0", pointers: "0" }]);
  } finally {
    await fixture.ports.dispose();
    await fixture.database.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
