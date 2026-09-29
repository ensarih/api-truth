import { resolve } from "node:path";
import type { Pool } from "pg";

import { expect, test } from "vitest";

import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import type { AnalyzerRequest } from "../../packages/ir/src/index.js";
import { createAccessPolicyStore, contractSnapshotFromAnalyzerResult } from "../../packages/catalog/src/index.js";
import { applyOrchestrationMigrations, createOrchestrationRepository, createOrchestrationWorker,
  createReconciliationScheduler } from "../../packages/orchestration/src/index.js";
import type { ScheduledReconciliationRequest } from "../../packages/orchestration/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const tenantId = "tenant-execution";
const configuration = { fingerprint: "exec-config", document: {
  config_version: "1.0.0", access_scopes: [{ access_scope_id: "engineering", label: "Engineering" }],
  repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce", access_scope_id: "engineering",
    services: [{ service_id: "orders", root: ".", analyzer: { adapter_id: ANALYZER.analyzer_id,
      adapter_version: ANALYZER.analyzer_version }, intended_branches: ["main"], environments: [] }] }],
  inference: { enabled: false }, logs: { enabled: false },
} };
const admin = { tenantId, principalId: "admin", capabilities: ["configuration.admin"] };
const context = { tenantId, principalId: "connector", producerId: "github-adapter",
  allowedEventTypes: ["branch.updated", "pull_request.updated", "reconciliation.requested", "repository.baseline_requested"], allowedRepositories: ["commerce"],
  allowedServices: ["orders"], deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
const workerIdentity = { workerId: "execution-worker", instanceId: "one", capabilities: ["jobs.execute"] };
const requestFor = (revision: string): AnalyzerRequest => ({
  exchange_version: "1.0.0", ir_version: "1.0.0", request_id: `execution-${revision}`,
  analyzer: ANALYZER,
  source: { repository_id: "commerce", service_id: "orders", service_root: ".", immutable_revision: revision,
    source_digest: "pending", access_label: "engineering" },
  resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
  prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
  limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
  execution_policy: { network_access: false, side_effects: "none" },
});
const baselineEvent = (revision: string) => ({
  event_version: "1.0.0", event_id: `baseline-${revision}`, event_type: "repository.baseline_requested",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `delivery-${revision}`,
    order: { kind: "sequence", value: "1" } },
  payload: { immutable_revision: revision, service_ids: ["orders"] },
});
const branchEvent = (id: string, sequence: string, revision: string) => ({
  event_version: "1.0.0", event_id: id, event_type: "branch.updated",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `delivery-${sequence}`,
    order: { kind: "sequence", value: sequence } },
  payload: { branch: "main", prior_revision: null, new_revision: revision, reference_state: "fast_forward" },
});
const pullRequestEvent = (baseRevision: string, headRevision: string) => ({
  event_version: "1.0.0", event_id: `pr-${headRevision}`, event_type: "pull_request.updated",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `pr-delivery-${headRevision}`,
    order: { kind: "sequence", value: "3" } },
  payload: { pull_request_id: "42", state: "open", base_branch: "main", base_revision: baseRevision,
    head_branch: "feature/orders", head_revision: headRevision },
});
const reconciliationEvent = (id: string) => ({
  event_version: "1.0.0", event_id: id, event_type: "reconciliation.requested",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `delivery-${id}`,
    order: { kind: "sequence", value: "1" } },
  payload: { scope: { service_ids: ["orders"], environments: [] }, provider_snapshot_reference: id },
});

const preparedAnalysis = async (revision: string, fixture = "baseline") => {
  const raw = requestFor(revision);
  const result = await createAnalyzer({ projectRoot: resolve(`fixtures/typescript/orders/${fixture}/src`) }).analyze(raw);
  const request = { ...raw, source: { ...raw.source, source_digest: result.source.source_digest },
    resolution_inputs: [{ kind: "source_tree" as const, path: ".", digest: result.source.source_digest }] };
  return { result, request };
};

const activate = async (database: Awaited<ReturnType<typeof createCatalogTestDatabase>>, result: Awaited<
  ReturnType<typeof preparedAnalysis>>["result"]) => {
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
  await repository.registerConfiguration(admin, configuration);
  await repository.activateInitialConfiguration(admin, { fingerprint: configuration.fingerprint });
  const converted = contractSnapshotFromAnalyzerResult(result, configuration.fingerprint);
  const access = createAccessPolicyStore(database.pool, { schema: database.schema });
  for (const scopeId of converted.requiredScopeIds) await access.putScope({ tenantId }, { scopeId, active: true });
  return { repository, worker: createOrchestrationWorker(database.pool, { schema: database.schema }) };
};

test("runJob rejects missing worker capability before database or port access", async () => {
  let databaseCalls = 0;
  let portReads = 0;
  const worker = createOrchestrationWorker({ connect: async () => {
    databaseCalls += 1;
    throw new Error("database should not be reached");
  } } as unknown as Pool, { schema: "unused_schema" });
  const ports = new Proxy({}, { get: () => { portReads += 1; throw new Error("port should not be read"); } });
  await expect(worker.runJob({ ...workerIdentity, capabilities: [] }, undefined, ports as never))
    .rejects.toMatchObject({ code: "WORKER_UNAUTHORIZED" });
  expect({ databaseCalls, portReads }).toEqual({ databaseCalls: 0, portReads: 0 });
});

test("a resolver redirection or analyzer source mismatch fails safely without writing results", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "8".repeat(40);
    const { result, request } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, baselineEvent(revision));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    let analyzerCalls = 0;
    await expect(worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request: { ...request, source: {
        ...request.source, service_id: "other-service" } }, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => { analyzerCalls += 1; return result; } },
    })).rejects.toMatchObject({ code: "JOB_EXECUTION_FAILED" });
    expect(analyzerCalls).toBe(0);
    const wrongDigest = `sha256:${"0".repeat(64)}`;
    await expect(worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request: { ...request, source: {
        ...request.source, source_digest: wrongDigest },
        resolution_inputs: [{ kind: "source_tree", path: ".", digest: wrongDigest }] },
      changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result },
    })).rejects.toMatchObject({ code: "JOB_EXECUTION_FAILED" });
    const schema = quoteCatalogTestSchema(database.schema);
    const counts = await database.pool.query<{ snapshots: string; associations: string; results: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
              (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
              (SELECT count(*)::text FROM ${schema}.orchestration_job_results WHERE tenant_id=$1) AS results`, [tenantId],
    );
    expect(counts.rows[0]).toEqual({ snapshots: "0", associations: "0", results: "0" });
  } finally { await database.cleanup(); }
});

test("a failed analyzer result is reported through failJob for retry and terminal failure", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "6".repeat(40);
    const { result, request } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    result.status = "failed";
    expect(result.coverage.diagnostic_ids.length).toBeGreaterThan(0);
    await repository.ingestEvent(context, baselineEvent(revision));
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`UPDATE ${schema}.orchestration_jobs SET max_attempts=2
      WHERE tenant_id=$1 AND target_revision=$2`, [tenantId, revision]);
    const ports = { resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result } };
    const [first] = await worker.claimJobs(workerIdentity, { limit: 1 });
    let failure: unknown;
    try { await worker.runJob(workerIdentity, first!.lease, ports); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "JOB_EXECUTION_FAILED" });
    expect(await worker.failJob(workerIdentity, first!.lease, failure)).toMatchObject({
      state: "retry_wait", safeErrorCode: "JOB_EXECUTION_FAILED" });
    await database.pool.query(`UPDATE ${schema}.orchestration_jobs SET available_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND job_id=$2`, [tenantId, first!.jobId]);
    const [second] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(second?.jobId).toBe(first?.jobId);
    let secondFailure: unknown;
    try { await worker.runJob(workerIdentity, second!.lease, ports); }
    catch (error) { secondFailure = error; }
    expect(secondFailure).toMatchObject({ code: "JOB_EXECUTION_FAILED" });
    expect(await worker.failJob(workerIdentity, second!.lease, secondFailure)).toMatchObject({
      state: "failed", safeErrorCode: "JOB_EXECUTION_FAILED" });
    const stored = await database.pool.query<{ state: string; result_count: string; snapshot_count: string }>(
      `SELECT job.state,
         (SELECT count(*)::text FROM ${schema}.orchestration_job_results WHERE tenant_id=$1) AS result_count,
         (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshot_count
       FROM ${schema}.orchestration_jobs job WHERE job.tenant_id=$1 AND job.job_id=$2`, [tenantId, first!.jobId],
    );
    expect(stored.rows[0]).toEqual({ state: "failed", result_count: "0", snapshot_count: "0" });
    const later = { ...baselineEvent(revision), event_id: "baseline-after-failure",
      provider_evidence: { provider: "github", provider_reference: "retry-authority",
        order: { kind: "sequence" as const, value: "2" } } };
    expect(await repository.ingestEvent(context, later)).toMatchObject({
      outcome: "accepted", disposition: "scheduled" });
    const [third] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(third?.jobId).not.toBe(first?.jobId);
    const recovered = await preparedAnalysis(revision);
    expect(await worker.runJob(workerIdentity, third!.lease, {
      resolver: { resolve: async () => ({ request: recovered.request,
        changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => recovered.result },
    })).toMatchObject({ state: "succeeded" });
    const checkpoint = await database.pool.query<{ attempt_generation: string; last_terminal_outcome: string }>(
      `SELECT attempt_generation::text,last_terminal_outcome FROM ${schema}.orchestration_analysis_checkpoints
       WHERE tenant_id=$1 AND immutable_revision=$2`, [tenantId, revision],
    );
    expect(checkpoint.rows[0]).toEqual({ attempt_generation: "2", last_terminal_outcome: "succeeded" });
  } finally { await database.cleanup(); }
});

test("a leased baseline analyzes and commits one immutable association without a branch pointer", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const worker = createOrchestrationWorker(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin, configuration);
    await repository.activateInitialConfiguration(admin, { fingerprint: configuration.fingerprint });
    const revision = "a".repeat(40);
    const analyzer = createAnalyzer({ projectRoot: resolve("fixtures/typescript/orders/baseline/src") });
    const raw = requestFor(revision);
    const result = await analyzer.analyze(raw);
    const converted = contractSnapshotFromAnalyzerResult(result, configuration.fingerprint);
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of converted.requiredScopeIds) await access.putScope({ tenantId }, { scopeId, active: true });
    const request = { ...raw, source: { ...raw.source, source_digest: result.source.source_digest },
      resolution_inputs: [{ kind: "source_tree" as const, path: ".", digest: result.source.source_digest }] };
    await repository.ingestEvent(context, baselineEvent(revision));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(claim?.kind).toBe("baseline_analysis");
    const outcome = await worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result },
    });
    expect(outcome).toMatchObject({ state: "succeeded" });
    const schema = quoteCatalogTestSchema(database.schema);
    const stored = await database.pool.query<{ state: string; snapshot_id: string }>(
      `SELECT job.state,association.snapshot_id FROM ${schema}.orchestration_jobs job
       JOIN ${schema}.orchestration_revision_snapshots association ON association.tenant_id=job.tenant_id
         AND association.producing_job_id=job.job_id WHERE job.tenant_id=$1 AND job.job_id=$2`,
      [tenantId, claim!.jobId],
    );
    expect(stored.rows[0]).toEqual({ state: "succeeded", snapshot_id: result.snapshot_id });
    const pointers = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1`, [tenantId],
    );
    expect(pointers.rows[0]?.count).toBe("0");
    await expect(worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => { throw new Error("replay reached resolver"); } },
      analyzer: { analyze: async () => { throw new Error("replay reached analyzer"); } },
    })).rejects.toMatchObject({ code: "JOB_LEASE_CONFLICT" });
    const results = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_job_results WHERE tenant_id=$1 AND job_id=$2`,
      [tenantId, claim!.jobId],
    );
    expect(results.rows[0]?.count).toBe("1");
  } finally { await database.cleanup(); }
});

test("a later authorized request for an already associated immutable baseline reports no_work", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "4".repeat(40);
    const { result, request } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, baselineEvent(revision));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    await worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result },
    });
    const replay = { ...baselineEvent(revision), event_id: "baseline-later",
      provider_evidence: { provider: "github", provider_reference: "later-delivery",
        order: { kind: "sequence" as const, value: "2" } } };
    expect(await repository.ingestEvent(context, replay)).toMatchObject({
      outcome: "accepted", disposition: "no_work" });
    const schema = quoteCatalogTestSchema(database.schema);
    const state = await database.pool.query<{ generation: string; jobs: string; associations: string }>(
      `SELECT checkpoint.attempt_generation::text AS generation,
         (SELECT count(*)::text FROM ${schema}.orchestration_jobs WHERE tenant_id=$1 AND kind='baseline_analysis') AS jobs,
         (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations
       FROM ${schema}.orchestration_analysis_checkpoints checkpoint WHERE checkpoint.tenant_id=$1`, [tenantId],
    );
    expect(state.rows[0]).toEqual({ generation: "1", jobs: "1", associations: "1" });
    expect(await worker.claimJobs(workerIdentity, { limit: 1 })).toEqual([]);
  } finally { await database.cleanup(); }
});

test("a different digest for the same immutable target conflicts and rolls back every completion write", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "3".repeat(40);
    const baseline = await preparedAnalysis(revision);
    const changed = await preparedAnalysis(revision, "changed");
    expect(changed.result.source.source_digest).not.toBe(baseline.result.source.source_digest);
    const { repository, worker } = await activate(database, baseline.result);
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of contractSnapshotFromAnalyzerResult(changed.result, configuration.fingerprint).requiredScopeIds) {
      await access.putScope({ tenantId }, { scopeId, active: true });
    }
    await repository.ingestEvent(context, baselineEvent(revision));
    const [first] = await worker.claimJobs(workerIdentity, { limit: 1 });
    await worker.runJob(workerIdentity, first!.lease, {
      resolver: { resolve: async () => ({ request: baseline.request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => baseline.result },
    });
    await repository.ingestEvent(context, branchEvent("same-target-other-content", "2", revision));
    const [second] = await worker.claimJobs(workerIdentity, { limit: 1 });
    await expect(worker.runJob(workerIdentity, second!.lease, {
      resolver: { resolve: async () => ({ request: changed.request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => changed.result },
    })).rejects.toMatchObject({ code: "REVISION_ASSOCIATION_CONFLICT" });
    const schema = quoteCatalogTestSchema(database.schema);
    const stored = await database.pool.query<{ associations: string; snapshots: string; results: string;
      branch_state: string; branch_pointer_count: string; success_outbox_count: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
         (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
         (SELECT count(*)::text FROM ${schema}.orchestration_job_results WHERE tenant_id=$1) AS results,
         (SELECT state FROM ${schema}.orchestration_jobs WHERE tenant_id=$1 AND job_id=$2) AS branch_state,
         (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1) AS branch_pointer_count,
         (SELECT count(*)::text FROM ${schema}.orchestration_outbox WHERE tenant_id=$1 AND job_id=$2
            AND payload->>'state'='succeeded') AS success_outbox_count`, [tenantId, second!.jobId],
    );
    expect(stored.rows[0]).toEqual({ associations: "1", snapshots: "1", results: "1",
      branch_state: "leased", branch_pointer_count: "0", success_outbox_count: "0" });
  } finally { await database.cleanup(); }
});

for (const scenario of ["same", "different"] as const) {
  test(`concurrent baseline and branch completions with ${scenario} digest serialize to one immutable association`, async () => {
    const database = await createCatalogTestDatabase();
    try {
      const revision = scenario === "same" ? "0".repeat(40) : "5".repeat(40);
      const baseline = await preparedAnalysis(revision);
      const branch = scenario === "same" ? baseline : await preparedAnalysis(revision, "changed");
      const { repository, worker } = await activate(database, baseline.result);
      const access = createAccessPolicyStore(database.pool, { schema: database.schema });
      for (const scopeId of contractSnapshotFromAnalyzerResult(branch.result, configuration.fingerprint).requiredScopeIds) {
        await access.putScope({ tenantId }, { scopeId, active: true });
      }
      await worker.putConcurrencyPolicy(admin, { globalLimit: 16, repositoryLimit: 4, serviceLimit: 2 });
      await repository.ingestEvent(context, baselineEvent(revision));
      await repository.ingestEvent(context, branchEvent(`concurrent-${scenario}`, "2", revision));
      const claims = await worker.claimJobs(workerIdentity, { limit: 2 });
      expect(claims).toHaveLength(2);
      const outcomes = await Promise.allSettled(claims.map((claim) => {
        const prepared = claim.kind === "baseline_analysis" ? baseline : branch;
        return worker.runJob(workerIdentity, claim.lease, {
          resolver: { resolve: async () => ({ request: prepared.request,
            changedPaths: [], changedPathsComplete: false }) },
          analyzer: { analyze: async () => prepared.result },
        });
      }));
      const successful = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(successful).toHaveLength(scenario === "same" ? 2 : 1);
      expect(failures).toHaveLength(scenario === "same" ? 0 : 1);
      if (scenario === "different") expect(failures[0]?.reason).toMatchObject({
        code: "REVISION_ASSOCIATION_CONFLICT" });
      const schema = quoteCatalogTestSchema(database.schema);
      const stored = await database.pool.query<{ associations: string; snapshots: string; results: string;
        success_outboxes: string }>(
        `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
           (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
           (SELECT count(*)::text FROM ${schema}.orchestration_job_results WHERE tenant_id=$1) AS results,
           (SELECT count(*)::text FROM ${schema}.orchestration_outbox WHERE tenant_id=$1
              AND payload->>'state'='succeeded') AS success_outboxes`, [tenantId],
      );
      expect(stored.rows[0]).toEqual({ associations: "1", snapshots: "1",
        results: scenario === "same" ? "2" : "1",
        success_outboxes: scenario === "same" ? "2" : "1" });
    } finally { await database.cleanup(); }
  });
}

test("a later same-revision confirmation is promoted with its newer checkpoint evidence", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "9".repeat(40);
    const { result, request } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, branchEvent("branch-confirmation-one", "1", revision));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    await repository.ingestEvent(context, branchEvent("branch-confirmation-two", "2", revision));
    expect(await worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result },
    })).toMatchObject({ state: "succeeded" });
    const schema = quoteCatalogTestSchema(database.schema);
    const pointer = await database.pool.query<{ order_value: string; provider_reference: string }>(
      `SELECT order_value,provider_reference FROM ${schema}.catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id='commerce' AND service_id='orders' AND branch='main'`, [tenantId],
    );
    expect(pointer.rows[0]).toEqual({ order_value: "2", provider_reference: "delivery-2" });
  } finally { await database.cleanup(); }
});

test("a branch update promotes once and a content-identical new revision reuses without analyzer or ingest", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const worker = createOrchestrationWorker(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin, configuration);
    await repository.activateInitialConfiguration(admin, { fingerprint: configuration.fingerprint });
    const source = createAnalyzer({ projectRoot: resolve("fixtures/typescript/orders/baseline/src") });
    const firstRevision = "b".repeat(40);
    const secondRevision = "c".repeat(40);
    const firstResult = await source.analyze(requestFor(firstRevision));
    firstResult.status = "success";
    firstResult.coverage = { status: "complete", analyzed_roots: ["."], diagnostic_ids: [] };
    const converted = contractSnapshotFromAnalyzerResult(firstResult, configuration.fingerprint);
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of converted.requiredScopeIds) await access.putScope({ tenantId }, { scopeId, active: true });
    const selectedBases: Array<string | undefined> = [];
    const resolver = { resolve: async ({ immutableRevision, baseRevision }: {
      immutableRevision: string; baseRevision?: string;
    }) => {
      selectedBases.push(baseRevision);
      const raw = requestFor(immutableRevision);
      return { request: { ...raw, source: { ...raw.source, source_digest: firstResult.source.source_digest },
        resolution_inputs: [{ kind: "source_tree" as const, path: ".", digest: firstResult.source.source_digest }] },
      changedPaths: [], changedPathsComplete: true };
    } };
    await repository.ingestEvent(context, branchEvent("branch-first", "1", firstRevision));
    const [first] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(first?.kind).toBe("branch_analysis");
    expect(await worker.runJob(workerIdentity, first!.lease, { resolver,
      analyzer: { analyze: async () => firstResult } })).toMatchObject({ state: "succeeded" });
    await repository.ingestEvent(context, branchEvent("branch-second", "2", secondRevision));
    const [second] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(second?.jobId).not.toBe(first?.jobId);
    let analyzerCalls = 0;
    expect(await worker.runJob(workerIdentity, second!.lease, { resolver,
      analyzer: { analyze: async () => { analyzerCalls += 1; return firstResult; } } }))
      .toMatchObject({ state: "succeeded" });
    expect(analyzerCalls).toBe(0);
    expect(selectedBases).toEqual([undefined, firstRevision]);
    const schema = quoteCatalogTestSchema(database.schema);
    const pointer = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id='commerce' AND service_id='orders' AND branch='main'`, [tenantId],
    );
    expect(pointer.rows[0]).toEqual({ snapshot_id: firstResult.snapshot_id, pointer_version: "2" });
    const associations = await database.pool.query<{ immutable_revision: string; snapshot_id: string; association_kind: string }>(
      `SELECT immutable_revision,snapshot_id,association_kind FROM ${schema}.orchestration_revision_snapshots
       WHERE tenant_id=$1 ORDER BY immutable_revision`, [tenantId],
    );
    expect(associations.rows).toEqual([
      { immutable_revision: firstRevision, snapshot_id: firstResult.snapshot_id, association_kind: "analyzed" },
      { immutable_revision: secondRevision, snapshot_id: firstResult.snapshot_id, association_kind: "reused" },
    ]);
    const snapshots = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.catalog_snapshots WHERE tenant_id=$1`, [tenantId],
    );
    expect(snapshots.rows[0]?.count).toBe("1");
    const reuseResult = await database.pool.query<{ base_selected_revision: string; base_snapshot_id: string }>(
      `SELECT base_selected_revision,base_snapshot_id FROM ${schema}.orchestration_job_results
       WHERE tenant_id=$1 AND job_id=$2`, [tenantId, second!.jobId],
    );
    expect(reuseResult.rows[0]).toEqual({ base_selected_revision: firstRevision,
      base_snapshot_id: firstResult.snapshot_id });
  } finally { await database.cleanup(); }
});

test("a newer desired branch revision supersedes an analyzer already in flight without partial promotion", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const oldRevision = "d".repeat(40);
    const newerRevision = "e".repeat(40);
    const { result, request } = await preparedAnalysis(oldRevision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, branchEvent("branch-old", "1", oldRevision));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(claim?.kind).toBe("branch_analysis");
    let startAnalyzer!: () => void;
    const analyzerStarted = new Promise<void>((resolveStarted) => { startAnalyzer = resolveStarted; });
    let releaseAnalyzer!: () => void;
    const analyzerReleased = new Promise<void>((resolveReleased) => { releaseAnalyzer = resolveReleased; });
    const running = worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => { startAnalyzer(); await analyzerReleased; return result; } },
    });
    await analyzerStarted;
    await repository.ingestEvent(context, branchEvent("branch-new", "2", newerRevision));
    releaseAnalyzer();
    await expect(running).rejects.toMatchObject({ code: "JOB_SUPERSEDED" });
    const schema = quoteCatalogTestSchema(database.schema);
    const state = await database.pool.query<{ state: string; cancellation_requested: boolean }>(
      `SELECT state,cancellation_requested FROM ${schema}.orchestration_jobs WHERE tenant_id=$1 AND job_id=$2`,
      [tenantId, claim!.jobId],
    );
    expect(state.rows[0]).toMatchObject({ cancellation_requested: true });
    const counts = await database.pool.query<{ snapshots: string; associations: string; pointers: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
              (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
              (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1) AS pointers`, [tenantId],
    );
    expect(counts.rows[0]).toEqual({ snapshots: "0", associations: "0", pointers: "0" });
  } finally { await database.cleanup(); }
});

test("configuration advancement during analyzer work prevents the old branch job from promoting", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "7".repeat(40);
    const { result, request } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    const nextDocument = structuredClone(configuration.document);
    nextDocument.repositories[0]!.services[0]!.intended_branches = [];
    await repository.registerConfiguration(admin, { fingerprint: "exec-config-next", document: nextDocument });
    await repository.ingestEvent(context, branchEvent("branch-before-config", "1", revision));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    let entered!: () => void;
    const analyzerEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolveResume) => { resume = resolveResume; });
    const running = worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => { entered(); await resumed; return result; } },
    });
    await analyzerEntered;
    await repository.activateConfigurationByCas(admin, { fingerprint: "exec-config-next",
      expectedCheckpointVersion: "1", providerEvidence: {
        provider: "control-plane", provider_reference: "approval-next" } });
    resume();
    await expect(running).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    const schema = quoteCatalogTestSchema(database.schema);
    const counts = await database.pool.query<{ snapshots: string; pointers: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
              (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1) AS pointers`, [tenantId],
    );
    expect(counts.rows[0]).toEqual({ snapshots: "0", pointers: "0" });
  } finally { await database.cleanup(); }
});

test("a deferred catalog promotion failure rolls back D06 and D08 completion together", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "f".repeat(40);
    const { result, request } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, branchEvent("branch-rollback", "1", revision));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`CREATE FUNCTION ${schema}.reject_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced promotion rollback'; END $$`);
    await database.pool.query(`CREATE CONSTRAINT TRIGGER reject_promotion AFTER INSERT OR UPDATE
      ON ${schema}.catalog_branch_pointers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION ${schema}.reject_promotion()`);
    await expect(worker.runJob(workerIdentity, claim!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result },
    })).rejects.toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
    const counts = await database.pool.query<{ snapshots: string; associations: string; results: string;
      pointers: string; succeeded: string; leased: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.catalog_snapshots WHERE tenant_id=$1) AS snapshots,
              (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1) AS associations,
              (SELECT count(*)::text FROM ${schema}.orchestration_job_results WHERE tenant_id=$1) AS results,
              (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1) AS pointers,
              (SELECT count(*)::text FROM ${schema}.orchestration_jobs WHERE tenant_id=$1 AND state='succeeded') AS succeeded,
              (SELECT count(*)::text FROM ${schema}.orchestration_jobs WHERE tenant_id=$1 AND state='leased') AS leased`,
      [tenantId],
    );
    expect(counts.rows[0]).toEqual({ snapshots: "0", associations: "0", results: "0",
      pointers: "0", succeeded: "0", leased: "1" });
  } finally { await database.cleanup(); }
});

test("a changed D06 base pointer version during resolver work cannot commit a stale D07 plan", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const firstRevision = "1".repeat(40);
    const secondRevision = "2".repeat(40);
    const { result: firstResult, request: firstRequest } = await preparedAnalysis(firstRevision);
    firstResult.status = "success";
    firstResult.coverage = { status: "complete", analyzed_roots: ["."], diagnostic_ids: [] };
    const { repository, worker } = await activate(database, firstResult);
    await repository.ingestEvent(context, branchEvent("base-original", "1", firstRevision));
    const [first] = await worker.claimJobs(workerIdentity, { limit: 1 });
    await worker.runJob(workerIdentity, first!.lease, {
      resolver: { resolve: async () => ({ request: firstRequest, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => firstResult },
    });
    await repository.ingestEvent(context, branchEvent("base-target", "2", secondRevision));
    const [second] = await worker.claimJobs(workerIdentity, { limit: 1 });
    let resume!: () => void;
    const resumed = new Promise<void>((resolveResume) => { resume = resolveResume; });
    let resolverEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { resolverEntered = resolveEntered; });
    const targetRequest = { ...firstRequest, request_id: `execution-${secondRevision}`,
      source: { ...firstRequest.source, immutable_revision: secondRevision } };
    const running = worker.runJob(workerIdentity, second!.lease, {
      resolver: { resolve: async ({ baseRevision }) => {
        expect(baseRevision).toBe(firstRevision);
        resolverEntered();
        await resumed;
        return { request: targetRequest, changedPaths: [], changedPathsComplete: true };
      } },
      analyzer: { analyze: async () => { throw new Error("reuse must skip analyzer"); } },
    });
    await entered;
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`UPDATE ${schema}.catalog_branch_pointers SET pointer_version=pointer_version+1
      WHERE tenant_id=$1 AND repository_id='commerce' AND service_id='orders' AND branch='main'`, [tenantId]);
    resume();
    await expect(running).rejects.toMatchObject({ code: "PROMOTION_INELIGIBLE" });
    const unchanged = await database.pool.query<{ state: string; count: string }>(
      `SELECT job.state,(SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots
         WHERE tenant_id=$1 AND immutable_revision=$3) AS count
       FROM ${schema}.orchestration_jobs job WHERE job.tenant_id=$1 AND job.job_id=$2`,
      [tenantId, second!.jobId, secondRevision],
    );
    expect(unchanged.rows[0]).toEqual({ state: "leased", count: "0" });
  } finally { await database.cleanup(); }
});

test("a PR preview uses its declared base revision and never changes the branch pointer", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const baseRevision = "a".repeat(40);
    const branchRevision = "c".repeat(40);
    const headRevision = "b".repeat(40);
    const base = await preparedAnalysis(baseRevision);
    const branch = await preparedAnalysis(branchRevision, "changed");
    base.result.status = "success";
    base.result.coverage = { status: "complete", analyzed_roots: ["."], diagnostic_ids: [] };
    const { repository, worker } = await activate(database, base.result);
    const run = async (request: AnalyzerRequest, result: typeof base.result) => {
      const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
      expect(claim).toBeDefined();
      await worker.runJob(workerIdentity, claim!.lease, {
        resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
        analyzer: { analyze: async () => result },
      });
      return claim!;
    };
    await repository.ingestEvent(context, baselineEvent(baseRevision));
    await run(base.request, base.result);
    await repository.ingestEvent(context, branchEvent("branch-newer", "2", branchRevision));
    await run(branch.request, branch.result);

    const schema = quoteCatalogTestSchema(database.schema);
    const before = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id='commerce' AND service_id='orders' AND branch='main'`, [tenantId],
    );
    expect(before.rows[0]?.snapshot_id).toBe(branch.result.snapshot_id);

    await repository.ingestEvent(context, pullRequestEvent(baseRevision, headRevision));
    const [preview] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(preview?.kind).toBe("pr_preview_analysis");
    const headRequest = { ...base.request, request_id: `execution-${headRevision}`,
      source: { ...base.request.source, immutable_revision: headRevision } };
    let analyzerCalls = 0;
    expect(await worker.runJob(workerIdentity, preview!.lease, {
      resolver: { resolve: async ({ baseRevision: selectedBase }) => {
        expect(selectedBase).toBe(baseRevision);
        return { request: headRequest, changedPaths: [], changedPathsComplete: true };
      } },
      analyzer: { analyze: async () => { analyzerCalls += 1; return base.result; } },
    })).toMatchObject({ state: "succeeded" });
    expect(analyzerCalls).toBe(0);
    const after = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id='commerce' AND service_id='orders' AND branch='main'`, [tenantId],
    );
    expect(after.rows).toEqual(before.rows);
    const result = await database.pool.query<{ scope_kind: string; base_selected_revision: string;
      base_snapshot_id: string }>(
      `SELECT scope_kind,base_selected_revision,base_snapshot_id FROM ${schema}.orchestration_job_results
       WHERE tenant_id=$1 AND job_id=$2`, [tenantId, preview!.jobId],
    );
    expect(result.rows).toEqual([{ scope_kind: "pr_preview", base_selected_revision: baseRevision,
      base_snapshot_id: base.result.snapshot_id }]);

    const nextHead = "d".repeat(40);
    await repository.ingestEvent(context, { ...pullRequestEvent(baseRevision, nextHead),
      payload: { ...pullRequestEvent(baseRevision, nextHead).payload, state: "updated" },
      provider_evidence: { provider: "github", provider_reference: "pr-delivery-update",
        order: { kind: "sequence", value: "4" } } });
    const [pending] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(pending?.kind).toBe("pr_preview_analysis");
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    let entered!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const running = worker.runJob(workerIdentity, pending!.lease, {
      resolver: { resolve: async () => {
        entered();
        await hold;
        return { request: { ...headRequest, request_id: `execution-${nextHead}`,
          source: { ...headRequest.source, immutable_revision: nextHead } },
        changedPaths: [], changedPathsComplete: true };
      } },
      analyzer: { analyze: async () => base.result },
    });
    await started;
    await repository.ingestEvent(context, { ...pullRequestEvent(baseRevision, nextHead),
      event_id: "pr-closed", payload: { ...pullRequestEvent(baseRevision, nextHead).payload, state: "closed" },
      provider_evidence: { provider: "github", provider_reference: "pr-delivery-close",
        order: { kind: "sequence", value: "5" } } });
    release();
    await expect(running).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    const stale = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_job_results
       WHERE tenant_id=$1 AND job_id=$2`, [tenantId, pending!.jobId],
    );
    expect(stale.rows[0]?.count).toBe("0");
  } finally { await database.cleanup(); }
});

test("exact branch reconciliation repairs a missed revision and records absence without deleting the pointer", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "e".repeat(40);
    const { result, request } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, reconciliationEvent("scan-present"));
    const [first] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(first?.kind).toBe("branch_reconciliation");
    let observedBranch = "";
    expect(await worker.runJob(workerIdentity, first!.lease, {
      exactBranchReconciler: { observe: async ({ branch, providerSnapshotReference }: {
        branch: string; providerSnapshotReference?: string;
      }) => {
        observedBranch = branch;
        expect(providerSnapshotReference).toBe("scan-present");
        return { repositoryId: "commerce", branch, state: "present", immutableRevision: revision,
          providerEvidence: { provider: "github", provider_reference: "provider-present",
            order: { kind: "sequence", value: "5" } } };
      } },
    } as never)).toMatchObject({ state: "succeeded" });
    expect(observedBranch).toBe("main");
    const [repair] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(repair?.kind).toBe("branch_analysis");
    expect(await worker.runJob(workerIdentity, repair!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result },
    })).toMatchObject({ state: "succeeded" });

    const schema = quoteCatalogTestSchema(database.schema);
    const pointer = await database.pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1 AND branch='main'`, [tenantId],
    );
    expect(pointer.rows[0]?.snapshot_id).toBe(result.snapshot_id);
    await repository.ingestEvent(context, reconciliationEvent("scan-stale-provider"));
    const [stale] = await worker.claimJobs(workerIdentity, { limit: 1 });
    await expect(worker.runJob(workerIdentity, stale!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => ({
        repositoryId: "commerce", branch, state: "present", immutableRevision: revision,
        providerEvidence: { provider: "github", provider_reference: "provider-stale",
          order: { kind: "sequence", value: "4" } },
      }) },
    } as never)).rejects.toMatchObject({ code: "RECONCILIATION_FAILED" });
    await database.pool.query(`UPDATE ${schema}.orchestration_jobs SET max_attempts=1
      WHERE tenant_id=$1 AND job_id=$2`, [tenantId, stale!.jobId]);
    await worker.failJob(workerIdentity, stale!.lease, { code: "RECONCILIATION_FAILED" });
    await repository.ingestEvent(context, reconciliationEvent("scan-unchanged"));
    const [unchanged] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(unchanged?.kind).toBe("branch_reconciliation");
    expect(await worker.runJob(workerIdentity, unchanged!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => ({
        repositoryId: "commerce", branch, state: "present", immutableRevision: revision,
        providerEvidence: { provider: "github", provider_reference: "provider-unchanged",
          order: { kind: "sequence", value: "6" } },
      }) },
    } as never)).toMatchObject({ state: "succeeded" });
    const [noJob] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(noJob).toBeUndefined();
    const noWork = await database.pool.query<{ last_outcome: string }>(
      `SELECT last_outcome FROM ${schema}.orchestration_reconciliation_checkpoints
       WHERE tenant_id=$1 AND branch='main'`, [tenantId],
    );
    expect(noWork.rows[0]?.last_outcome).toBe("no_work");
    await repository.ingestEvent(context, reconciliationEvent("scan-absent"));
    const [second] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(second?.kind).toBe("branch_reconciliation");
    expect(await worker.runJob(workerIdentity, second!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => ({
        repositoryId: "commerce", branch, state: "absent",
        providerEvidence: { provider: "github", provider_reference: "provider-absent",
          order: { kind: "sequence", value: "7" } },
      }) },
    } as never)).toMatchObject({ state: "succeeded" });
    const state = await database.pool.query<{ desired_state: string; desired_revision: string | null;
      last_outcome: string; last_completed_reference: string }>(
      `SELECT branch.desired_state,branch.desired_revision,reconcile.last_outcome,reconcile.last_completed_reference
       FROM ${schema}.orchestration_branch_checkpoints branch
       JOIN ${schema}.orchestration_reconciliation_checkpoints reconcile
         USING (tenant_id,repository_id,service_id,branch)
       WHERE branch.tenant_id=$1 AND branch.branch='main'`, [tenantId],
    );
    expect(state.rows).toEqual([{ desired_state: "absent", desired_revision: null,
      last_outcome: "absent", last_completed_reference: "scan-absent" }]);
    const after = await database.pool.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1 AND branch='main'`, [tenantId],
    );
    expect(after.rows).toEqual(pointer.rows);
  } finally { await database.cleanup(); }
});

test("exact branch reconciliation rejects wrong scope and noncanonical provider sequence", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "f".repeat(40);
    const { result } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, reconciliationEvent("scan-invalid"));
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(claim?.kind).toBe("branch_reconciliation");
    const observation = { repositoryId: "commerce", branch: "main", state: "present",
      immutableRevision: revision, providerEvidence: { provider: "github", provider_reference: "observed",
        order: { kind: "sequence", value: "8" } } };
    await expect(worker.runJob(workerIdentity, claim!.lease, {
      exactBranchReconciler: { observe: async () => ({ ...observation, branch: "other" }) },
    } as never)).rejects.toMatchObject({ code: "RECONCILIATION_FAILED", retryable: true });
    await expect(worker.runJob(workerIdentity, claim!.lease, {
      exactBranchReconciler: { observe: async () => ({ ...observation,
        providerEvidence: { ...observation.providerEvidence,
          order: { kind: "sequence", value: "08" } } }) },
    } as never)).rejects.toMatchObject({ code: "RECONCILIATION_FAILED", retryable: true });
    const schema = quoteCatalogTestSchema(database.schema);
    const unchanged = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_branch_checkpoints
       WHERE tenant_id=$1`, [tenantId],
    );
    expect(unchanged.rows[0]?.count).toBe("0");
  } finally { await database.cleanup(); }
});

test("an older branch reconciliation cannot apply after a newer request supersedes its generation", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "f".repeat(40);
    const { result } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, reconciliationEvent("scan-old"));
    const [old] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(old?.kind).toBe("branch_reconciliation");
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    let entered!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const running = worker.runJob(workerIdentity, old!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => {
        entered();
        await hold;
        return { repositoryId: "commerce", branch, state: "present", immutableRevision: revision,
          providerEvidence: { provider: "github", provider_reference: "old-observation",
            order: { kind: "sequence", value: "2" } } };
      } },
    } as never);
    await started;
    await repository.ingestEvent(context, reconciliationEvent("scan-new"));
    release();
    await expect(running).rejects.toMatchObject({ code: "JOB_SUPERSEDED" });
    const schema = quoteCatalogTestSchema(database.schema);
    const state = await database.pool.query<{ desired: string; requested_provider_snapshot_reference: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_branch_checkpoints WHERE tenant_id=$1) AS desired,
              requested_provider_snapshot_reference
       FROM ${schema}.orchestration_reconciliation_checkpoints WHERE tenant_id=$1`, [tenantId],
    );
    expect(state.rows).toEqual([{ desired: "0", requested_provider_snapshot_reference: "scan-new" }]);
  } finally { await database.cleanup(); }
});

test("exact PR reconciliation keeps a closed PR closed until a newer observation proves reopening", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const baseRevision = "a".repeat(40);
    const headRevision = "b".repeat(40);
    const { result, request } = await preparedAnalysis(baseRevision);
    result.status = "success";
    result.coverage = { status: "complete", analyzed_roots: ["."], diagnostic_ids: [] };
    const { repository, worker } = await activate(database, result);
    const direct = (id: string, order: { kind: "sequence" | "cursor"; value: string }) => ({
      ...pullRequestEvent(baseRevision, headRevision), event_id: id,
      provider_evidence: { provider: "github", provider_reference: id, order },
    });
    await repository.ingestEvent(context, direct("pr-opaque-first", { kind: "cursor", value: "cursor-1" }));
    const [first] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(first?.kind).toBe("pr_reconciliation");
    const observation = (state: "open" | "closed", order: { kind: "sequence" | "cursor"; value: string }) => ({
      repositoryId: "commerce", serviceId: "orders", pullRequestId: "42", state,
      baseBranch: "main", baseRevision, headBranch: "feature/orders", headRevision,
      providerEvidence: { provider: "github", provider_reference: `observed-${state}-${order.value}`, order },
    });
    await expect(worker.runJob(workerIdentity, first!.lease, {
      exactPullRequestReconciler: { observe: async () => ({
        ...observation("closed", { kind: "sequence", value: "10" }), pullRequestId: "other",
      }) },
    } as never)).rejects.toMatchObject({ code: "RECONCILIATION_FAILED", retryable: true });
    expect(await worker.runJob(workerIdentity, first!.lease, {
      exactPullRequestReconciler: { observe: async ({ pullRequestId, configuredBaseBranch }: {
        pullRequestId: string; configuredBaseBranch: string;
      }) => {
        expect({ pullRequestId, configuredBaseBranch }).toEqual({ pullRequestId: "42", configuredBaseBranch: "main" });
        return observation("closed", { kind: "sequence", value: "10" });
      } },
    } as never)).toMatchObject({ state: "succeeded" });
    const schema = quoteCatalogTestSchema(database.schema);
    const closed = await database.pool.query<{ state: string; current_job_id: string | null }>(
      `SELECT state,current_job_id FROM ${schema}.orchestration_pr_checkpoints
       WHERE tenant_id=$1 AND pull_request_id='42'`, [tenantId],
    );
    expect(closed.rows).toEqual([{ state: "closed", current_job_id: null }]);

    await repository.ingestEvent(context, direct("pr-stale-open", { kind: "sequence", value: "9" }));
    await repository.ingestEvent(context, direct("pr-opaque-open", { kind: "cursor", value: "cursor-2" }));
    const [second] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(second?.kind).toBe("pr_reconciliation");
    await expect(worker.runJob(workerIdentity, second!.lease, {
      exactPullRequestReconciler: { observe: async () => observation("open", { kind: "cursor", value: "cursor-3" }) },
    } as never)).rejects.toMatchObject({ code: "RECONCILIATION_FAILED", retryable: true });
    const stillClosed = await database.pool.query<{ state: string }>(
      `SELECT state FROM ${schema}.orchestration_pr_checkpoints WHERE tenant_id=$1 AND pull_request_id='42'`, [tenantId],
    );
    expect(stillClosed.rows[0]?.state).toBe("closed");
    expect(await worker.runJob(workerIdentity, second!.lease, {
      exactPullRequestReconciler: { observe: async () => observation("open", { kind: "sequence", value: "11" }) },
    } as never)).toMatchObject({ state: "succeeded" });
    const reopened = await database.pool.query<{ state: string; kind: string }>(
      `SELECT checkpoint.state,job.kind FROM ${schema}.orchestration_pr_checkpoints checkpoint
       JOIN ${schema}.orchestration_jobs job ON job.tenant_id=checkpoint.tenant_id
         AND job.job_id=checkpoint.current_job_id
       WHERE checkpoint.tenant_id=$1 AND checkpoint.pull_request_id='42'`, [tenantId],
    );
    expect(reopened.rows).toEqual([{ state: "open", kind: "pr_preview_analysis" }]);
    const [baseline] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(baseline?.kind).toBe("baseline_analysis");
    expect(await worker.runJob(workerIdentity, baseline!.lease, {
      resolver: { resolve: async () => ({ request, changedPaths: [], changedPathsComplete: false }) },
      analyzer: { analyze: async () => result },
    })).toMatchObject({ state: "succeeded" });
    const [preview] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(preview?.kind).toBe("pr_preview_analysis");
    expect(await worker.runJob(workerIdentity, preview!.lease, {
      resolver: { resolve: async ({ baseRevision: selectedBase }) => {
        expect(selectedBase).toBe(baseRevision);
        return { request: { ...request, request_id: `execution-${headRevision}`,
          source: { ...request.source, immutable_revision: headRevision } },
        changedPaths: [], changedPathsComplete: true };
      } },
      analyzer: { analyze: async () => { throw new Error("reuse should skip analyzer"); } },
    })).toMatchObject({ state: "succeeded" });
    const isolated = await database.pool.query<{ scope_kind: string; base_selected_revision: string;
      pointers: string }>(
      `SELECT scope_kind,base_selected_revision,
         (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1) AS pointers
       FROM ${schema}.orchestration_job_results WHERE tenant_id=$1 AND job_id=$2`,
      [tenantId, preview!.jobId],
    );
    expect(isolated.rows).toEqual([{ scope_kind: "pr_preview", base_selected_revision: baseRevision, pointers: "0" }]);
  } finally { await database.cleanup(); }
});

test("CAS configuration activation runs its eventless exact-branch reconciliation", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const { result } = await preparedAnalysis("a".repeat(40));
    const { repository, worker } = await activate(database, result);
    await repository.registerConfiguration(admin, { fingerprint: "exec-config-b", document: configuration.document });
    await repository.activateConfigurationByCas(admin, { fingerprint: "exec-config-b",
      expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "approval-1" } });
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(claim?.kind).toBe("branch_reconciliation");
    expect(await worker.runJob(workerIdentity, claim!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => ({
        repositoryId: "commerce", branch, state: "absent",
        providerEvidence: { provider: "github", provider_reference: "confirmed-absent",
          order: { kind: "sequence", value: "1" } },
      }) },
    } as never)).toMatchObject({ state: "succeeded" });
    const schema = quoteCatalogTestSchema(database.schema);
    const state = await database.pool.query<{ config_fingerprint: string; last_outcome: string }>(
      `SELECT job.config_fingerprint,checkpoint.last_outcome
       FROM ${schema}.orchestration_jobs job
       JOIN ${schema}.orchestration_reconciliation_checkpoints checkpoint
         ON checkpoint.tenant_id=job.tenant_id AND checkpoint.current_job_id=job.job_id
       WHERE job.tenant_id=$1 AND job.job_id=$2`, [tenantId, claim!.jobId],
    );
    expect(state.rows).toEqual([{ config_fingerprint: "exec-config-b", last_outcome: "absent" }]);
  } finally { await database.cleanup(); }
});

test("an older exact-PR observation cannot replace a newer reconciliation generation", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const baseRevision = "a".repeat(40);
    const headRevision = "b".repeat(40);
    const { result } = await preparedAnalysis(baseRevision);
    const { repository, worker } = await activate(database, result);
    const opaque = (id: string) => ({ ...pullRequestEvent(baseRevision, headRevision), event_id: id,
      provider_evidence: { provider: "github", provider_reference: id,
        order: { kind: "cursor", value: id } } });
    await repository.ingestEvent(context, opaque("pr-opaque-old"));
    const [old] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(old?.kind).toBe("pr_reconciliation");
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    let entered!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const running = worker.runJob(workerIdentity, old!.lease, {
      exactPullRequestReconciler: { observe: async () => {
        entered();
        await hold;
        return { repositoryId: "commerce", serviceId: "orders", pullRequestId: "42", state: "open",
          baseBranch: "main", baseRevision, headBranch: "feature/orders", headRevision,
          providerEvidence: { provider: "github", provider_reference: "old-provider-result",
            order: { kind: "sequence", value: "1" } } };
      } },
    } as never);
    await started;
    await repository.ingestEvent(context, opaque("pr-opaque-new"));
    release();
    await expect(running).rejects.toMatchObject({ code: "JOB_SUPERSEDED" });
    const schema = quoteCatalogTestSchema(database.schema);
    const state = await database.pool.query<{ state: string; base_revision: string | null;
      generation: string }>(
      `SELECT state,base_revision,reconciliation_generation::text AS generation
       FROM ${schema}.orchestration_pr_checkpoints WHERE tenant_id=$1 AND pull_request_id='42'`, [tenantId],
    );
    expect(state.rows).toEqual([{ state: "pending", base_revision: null, generation: "2" }]);
  } finally { await database.cleanup(); }
});

test("scheduler retries one durable reconciliation event with a stable identity", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const { result } = await preparedAnalysis("a".repeat(40));
    const { repository, worker } = await activate(database, result);
    const scheduler = createReconciliationScheduler(repository);
    const request: ScheduledReconciliationRequest = { idempotencyKey: "provider-snapshot-42", occurredAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:01.000Z", repositoryId: "commerce",
      serviceIds: ["orders"], environments: [], providerSnapshotReference: "snapshot-42",
      providerEvidence: { provider: "github", provider_reference: "snapshot-42",
        order: { kind: "sequence", value: "1" } } };
    expect(await scheduler.request(context, request)).toMatchObject({ outcome: "accepted" });
    expect(await scheduler.request(context, { ...request, receivedAt: "2026-01-01T00:00:02.000Z" }))
      .toMatchObject({ outcome: "duplicate" });
    await expect(scheduler.request(context, { ...request, providerSnapshotReference: "changed-snapshot" }))
      .rejects.toMatchObject({ code: "EVENT_ID_CONFLICT" });
    const schema = quoteCatalogTestSchema(database.schema);
    const counts = await database.pool.query<{ events: string; jobs: string }>(
      `SELECT (SELECT count(*)::text FROM ${schema}.orchestration_events
         WHERE tenant_id=$1 AND event_type='reconciliation.requested') AS events,
       (SELECT count(*)::text FROM ${schema}.orchestration_jobs
         WHERE tenant_id=$1 AND kind='branch_reconciliation') AS jobs`, [tenantId],
    );
    expect(counts.rows[0]).toEqual({ events: "1", jobs: "1" });
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(claim?.kind).toBe("branch_reconciliation");
    expect(await worker.runJob(workerIdentity, claim!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => ({
        repositoryId: "commerce", branch, state: "absent",
        providerEvidence: { provider: "github", provider_reference: "snapshot-42",
          order: { kind: "sequence", value: "1" } },
      }) },
    } as never)).toMatchObject({ state: "succeeded" });
  } finally { await database.cleanup(); }
});

test("configuration event activates its candidate and runs exact-branch reconciliation", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const { result } = await preparedAnalysis("a".repeat(40));
    const { repository, worker } = await activate(database, result);
    await repository.registerConfiguration(admin, { fingerprint: "exec-config-event", document: configuration.document });
    const event = { event_version: "1.0.0", event_id: "configuration-switch", event_type: "configuration.changed",
      producer: { producer_id: "github-adapter", adapter_version: "1" },
      occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
      subjects: { service_ids: ["orders"] },
      provider_evidence: { provider: "github", provider_reference: "config-switch",
        order: { kind: "sequence", value: "1" } },
      payload: { config_version: "1.0.0", config_fingerprint: "exec-config-event",
        affected_service_ids: ["orders"], affected_scope: "installation" } };
    await repository.ingestEvent({ ...context,
      allowedEventTypes: [...context.allowedEventTypes, "configuration.changed"].sort(),
      capabilities: ["configuration.admin", "event.ingest"] }, event);
    const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(claim?.kind).toBe("branch_reconciliation");
    expect(await worker.runJob(workerIdentity, claim!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => ({
        repositoryId: "commerce", branch, state: "absent",
        providerEvidence: { provider: "github", provider_reference: "confirmed-after-config",
          order: { kind: "sequence", value: "2" } },
      }) },
    } as never)).toMatchObject({ state: "succeeded" });
    const schema = quoteCatalogTestSchema(database.schema);
    const state = await database.pool.query<{ fingerprint: string; outcome: string }>(
      `SELECT active.config_fingerprint AS fingerprint,checkpoint.last_outcome AS outcome
       FROM ${schema}.orchestration_active_configurations active
       JOIN ${schema}.orchestration_reconciliation_checkpoints checkpoint USING (tenant_id)
       WHERE active.tenant_id=$1`, [tenantId],
    );
    expect(state.rows).toEqual([{ fingerprint: "exec-config-event", outcome: "absent" }]);
  } finally { await database.cleanup(); }
});

test("configuration activation prevents an in-flight old reconciliation from writing branch state", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const revision = "a".repeat(40);
    const { result } = await preparedAnalysis(revision);
    const { repository, worker } = await activate(database, result);
    await repository.ingestEvent(context, reconciliationEvent("scan-before-config"));
    const [old] = await worker.claimJobs(workerIdentity, { limit: 1 });
    expect(old?.kind).toBe("branch_reconciliation");
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    let entered!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const running = worker.runJob(workerIdentity, old!.lease, {
      exactBranchReconciler: { observe: async ({ branch }: { branch: string }) => {
        entered();
        await hold;
        return { repositoryId: "commerce", branch, state: "present", immutableRevision: revision,
          providerEvidence: { provider: "github", provider_reference: "before-config",
            order: { kind: "sequence", value: "2" } } };
      } },
    } as never);
    await started;
    await repository.registerConfiguration(admin, { fingerprint: "exec-config-next", document: configuration.document });
    await repository.activateConfigurationByCas(admin, { fingerprint: "exec-config-next",
      expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "approval-2" } });
    release();
    await expect(running).rejects.toMatchObject({ code: "JOB_SUPERSEDED" });
    const schema = quoteCatalogTestSchema(database.schema);
    const state = await database.pool.query<{ old_state: string; fingerprint: string; branch_rows: string }>(
      `SELECT job.state AS old_state,active.config_fingerprint AS fingerprint,
         (SELECT count(*)::text FROM ${schema}.orchestration_branch_checkpoints WHERE tenant_id=$1) AS branch_rows
       FROM ${schema}.orchestration_jobs job
       JOIN ${schema}.orchestration_active_configurations active USING (tenant_id)
       WHERE job.tenant_id=$1 AND job.job_id=$2`, [tenantId, old!.jobId],
    );
    expect(state.rows).toEqual([{ old_state: "leased", fingerprint: "exec-config-next", branch_rows: "0" }]);
  } finally { await database.cleanup(); }
});
