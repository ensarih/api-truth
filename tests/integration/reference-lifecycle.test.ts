import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import { createReferenceEventBridge } from "../../connectors/reference/src/bridge.js";
import { normalizeLocalFact } from "../../connectors/reference/src/adapter.js";
import { buildSyntheticReferenceFixture } from "../../connectors/reference/src/fixture.js";
import type { AnalyzerRequest } from "../../packages/ir/src/index.js";
import { createAccessPolicyStore, contractSnapshotFromAnalyzerResult } from "../../packages/catalog/src/index.js";
import { applyOrchestrationMigrations, createOrchestrationRepository, createOrchestrationWorker } from "../../packages/orchestration/src/index.js";
import { applyEnvironmentMigrations, createEnvironmentInboxWorker, createEnvironmentReconciler,
  createEnvironmentReconciliationWorker, createEnvironmentRepository, createEnvironmentViewRepository }
  from "../../packages/environment/src/index.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const tenantId = "synthetic";
const repo = "synthetic-repo";
const service = "synthetic-orders";
const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);
const admin = { tenantId, principalId: "admin", capabilities: ["configuration.admin"] };
const workerIdentity = { workerId: "reference-worker", instanceId: "local", capabilities: ["jobs.execute"] };
const reader = { tenantId, principalId: "architect" };

const analyze = async (revision: string, fixture: "baseline" | "changed",
  extractionMode: "baseline" | "fallback_full_service" = "baseline") => {
  const raw: AnalyzerRequest = { exchange_version: "1.0.0", ir_version: "1.0.0",
    request_id: `reference-${revision}`, analyzer: ANALYZER,
    source: { repository_id: repo, service_id: service, service_root: ".",
      immutable_revision: revision, source_digest: "pending", access_label: "synthetic" },
    resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
    prior_dependencies: [], changed_paths: [], extraction_mode: extractionMode,
    limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
    execution_policy: { network_access: false, side_effects: "none" } };
  const result = await createAnalyzer({ projectRoot: resolve(`fixtures/typescript/orders/${fixture}/src`) }).analyze(raw);
  expect(result.status).not.toBe("failed");
  const request = { ...raw, source: { ...raw.source, source_digest: result.source.source_digest },
    resolution_inputs: [{ kind: "source_tree" as const, path: ".", digest: result.source.source_digest }] };
  return { result, request };
};

test("synthetic facts drive preview, merge, failed rollout, rollback, and repair without manual rescan", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    await applyOpenApiMigrations(database.pool, { schema: database.schema });
    const steps = buildSyntheticReferenceFixture("main");
    const config = structuredClone(steps[0]!.policy.configuration) as { repositories: Array<{ services: Array<{
      root: string; analyzer: { adapter_id: string; adapter_version: string } }> }> };
    config.repositories[0]!.services[0]!.root = ".";
    config.repositories[0]!.services[0]!.analyzer = {
      adapter_id: ANALYZER.analyzer_id, adapter_version: ANALYZER.analyzer_version };
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin, { fingerprint: "reference-config", document: config });
    await orchestration.activateInitialConfiguration(admin, { fingerprint: "reference-config" });
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    await access.putScope({ tenantId }, { scopeId: "synthetic", active: true });
    await access.putGrant({ tenantId }, { principalId: reader.principalId, scopeId: "synthetic", active: true });
    const original = await analyze(revisionA, "baseline");
    const merged = await analyze(revisionB, "changed", "fallback_full_service");
    for (const prepared of [original, merged]) {
      const converted = contractSnapshotFromAnalyzerResult(prepared.result, "reference-config");
      for (const scopeId of converted.requiredScopeIds) {
        await access.putScope({ tenantId }, { scopeId, active: true });
        await access.putGrant({ tenantId }, { principalId: reader.principalId, scopeId, active: true });
      }
    }
    const initialBranch = { ...steps[3]!.fact, event_id: "synthetic-initial-branch",
      provider_reference: "synthetic-initial-branch", sequence: "1", prior_revision: null,
      new_revision: revisionA, reference_state: "created" };
    const staleBranch = { ...steps[3]!.fact, event_id: "synthetic-branch-stale",
      provider_reference: "synthetic-branch-stale", sequence: "3", prior_revision: revisionB,
      new_revision: revisionA, reference_state: "rewritten" };
    const candidateArtifact = { artifact_id: "synthetic-artifact-c", revision: revisionC };
    const rollbackArtifacts = [...steps[4]!.policy.knownArtifacts as Array<{ artifact_id: string; revision: string }>,
      candidateArtifact];
    const rollbackPolicy: Record<string, unknown> = { ...steps[4]!.policy, knownArtifacts: rollbackArtifacts };
    const failedRollout = { ...steps[4]!.fact, event_id: "synthetic-rollout-failed",
      provider_reference: "synthetic-rollout-failed", sequence: "9", effective_order: "9",
      deployment_id: "synthetic-rollout-c", attempt_state: "failed",
      artifact_id: candidateArtifact.artifact_id, revision: revisionC };
    const mixedServing = { ...steps[5]!.fact, event_id: "synthetic-serving-mixed",
      provider_reference: "synthetic-serving-mixed", sequence: "10", effective_order: "10",
      observation_id: "synthetic-serving-mixed", reference: "synthetic-inventory-mixed",
      inventory: [{ artifact_id: "synthetic-artifact-b", revision: revisionB }, candidateArtifact] };
    const rollbackRequest = { ...steps[4]!.fact, event_id: "synthetic-rollback-request",
      provider_reference: "synthetic-rollback-request", sequence: "11", effective_order: "11",
      deployment_id: "synthetic-rollback-b", attempt_state: "rollback_requested" };
    const rollbackConfirmed = { ...steps[5]!.fact, event_id: "synthetic-rollback-confirmed",
      provider_reference: "synthetic-rollback-confirmed", sequence: "12", effective_order: "12",
      observation_id: "synthetic-rollback-confirmed", reference: "synthetic-inventory-rollback" };
    const deliveries = [...steps, { fact: initialBranch, policy: steps[3]!.policy },
      { fact: staleBranch, policy: steps[3]!.policy },
      { fact: failedRollout, policy: rollbackPolicy }, { fact: mixedServing, policy: rollbackPolicy },
      { fact: rollbackRequest, policy: rollbackPolicy }, { fact: rollbackConfirmed, policy: rollbackPolicy }];
    const bridge = createReferenceEventBridge(orchestration, {
      async verify(raw) {
        const step = deliveries.find((item) => item.fact.event_id === raw);
        if (!step) throw new Error("Unknown delivery");
        const verifiedFactJson = JSON.stringify(step.fact);
        return { verifiedFactJson, verifiedFactSha256: createHash("sha256").update(verifiedFactJson).digest("hex"),
          context: step.policy.context, knownArtifacts: step.policy.knownArtifacts,
          provider: "github", providerReference: step.fact.provider_reference as string };
      },
    });
    const worker = createOrchestrationWorker(database.pool, { schema: database.schema });
    const schema = quoteCatalogTestSchema(database.schema);
    const runOne = async (kind: string) => {
      const [claim] = await worker.claimJobs(workerIdentity, { limit: 1 });
      expect(claim?.kind).toBe(kind);
      const prepared = kind === "baseline_analysis" || kind === "branch_analysis" && !initialBranchAdvanced
        ? original : merged;
      const result = await worker.runJob(workerIdentity, claim!.lease, {
        resolver: { resolve: async () => ({ request: prepared.request, changedPaths: [], changedPathsComplete: false }) },
        analyzer: { analyze: async () => prepared.result },
      });
      expect(result).toMatchObject({ state: "succeeded" });
      return claim!.jobId;
    };

    let initialBranchAdvanced = false;
    expect(await bridge.deliver("synthetic-baseline")).toMatchObject({ disposition: "scheduled" });
    await runOne("baseline_analysis");
    expect(await bridge.deliver("synthetic-initial-branch")).toMatchObject({ disposition: "scheduled" });
    await runOne("branch_analysis");
    initialBranchAdvanced = true;
    const pointerBeforePreview = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1`, [tenantId]);
    expect(pointerBeforePreview.rows).toEqual([{ snapshot_id: original.result.snapshot_id, pointer_version: "1" }]);
    expect(await bridge.deliver("synthetic-pr-open")).toMatchObject({ disposition: "scheduled" });
    const previewJob = await runOne("pr_preview_analysis");
    const beforeMerge = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1`, [tenantId]);
    expect(beforeMerge.rows).toEqual(pointerBeforePreview.rows);
    const preview = await database.pool.query<{ last_preview_result_job_id: string | null }>(
      `SELECT last_preview_result_job_id FROM ${schema}.orchestration_pr_checkpoints WHERE tenant_id=$1`, [tenantId]);
    expect(preview.rows[0]?.last_preview_result_job_id).toBe(previewJob);

    expect(await bridge.deliver("synthetic-pr-merged")).toMatchObject({ outcome: "accepted" });
    const afterMergeFact = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1`, [tenantId]);
    expect(afterMergeFact.rows).toEqual(pointerBeforePreview.rows);
    expect(await bridge.deliver("synthetic-branch")).toMatchObject({ disposition: "scheduled" });
    await runOne("branch_analysis");
    const pointer = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch='main'`, [tenantId, repo, service]);
    expect(pointer.rows).toEqual([{ snapshot_id: merged.result.snapshot_id, pointer_version: "2" }]);

    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const inbox = createEnvironmentInboxWorker(database.pool, { schema: database.schema }, environment);
    const view = createEnvironmentViewRepository(database.pool, { schema: database.schema });
    const key = { repositoryId: repo, serviceId: service, environment: "uat" };
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "unknown", contract: "unavailable" });
    expect(await bridge.deliver("synthetic-deploy-attempt")).toMatchObject({ outcome: "accepted" });
    expect(await bridge.deliver("synthetic-serving")).toMatchObject({ outcome: "accepted" });
    expect(await inbox.drain(workerIdentity)).toMatchObject([{ state: "delivered" }, { state: "delivered" }]);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed", contract: "resolved",
      snapshotId: merged.result.snapshot_id, active: [{ artifactId: "synthetic-artifact-b", revision: revisionB }] });
    await expect(view.getEnvironment(reader, { ...key, environment: "production" }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    const publications = createOpenApiPublicationStore(database.pool, { schema: database.schema });
    const branchPreparation = await publications.prepareBranch(reader,
      { kind: "branch", repositoryId: repo, serviceId: service, branch: "main" });
    const environmentPreparation = await publications.prepareEnvironment(reader,
      { kind: "environment", repositoryId: repo, serviceId: service, environment: "uat" });
    expect(branchPreparation.provenance).toMatchObject({ snapshotId: merged.result.snapshot_id,
      revision: revisionB, selector: { kind: "branch", pointerVersion: "2" } });
    expect(environmentPreparation.provenance).toMatchObject({ snapshotId: merged.result.snapshot_id,
      revision: revisionB, selector: { kind: "environment" } });
    expect(environmentPreparation.publishable).toBe(false);
    expect(environmentPreparation.diagnostics.length).toBeGreaterThan(0);

    expect(await bridge.deliver("synthetic-reconcile")).toMatchObject({ outcome: "accepted" });
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "unknown",
      contract: "unavailable", reconciliationRequired: true });
    const repairedFact = { ...steps[5]!.fact, event_id: "synthetic-serving-repaired",
      provider_reference: "synthetic-serving-repaired", sequence: "8", effective_order: "8",
      observation_id: "synthetic-serving-repaired", reference: "synthetic-inventory-repaired" };
    const deploymentPolicy = steps[5]!.policy;
    const exact = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => normalizeLocalFact(repairedFact,
        { configuration: deploymentPolicy.configuration, context: deploymentPolicy.context,
          knownArtifacts: deploymentPolicy.knownArtifacts }) },
      workerIdentity, eventContext: steps[5]!.policy.context });
    expect(await createEnvironmentReconciliationWorker(database.pool, { schema: database.schema }, exact)
      .drain(workerIdentity)).toMatchObject([{ state: "resolved" }]);
    expect(await inbox.drain(workerIdentity)).toMatchObject([{ eventId: "synthetic-serving-repaired",
      state: "delivered" }]);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed", contract: "resolved",
      snapshotId: merged.result.snapshot_id, reconciliationRequired: false });

    expect(await bridge.deliver("synthetic-rollout-failed")).toMatchObject({ outcome: "accepted" });
    expect(await inbox.drain(workerIdentity)).toMatchObject([{ state: "delivered" }]);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed", contract: "resolved",
      snapshotId: merged.result.snapshot_id,
      latestAttempt: { deploymentId: "synthetic-rollout-c", state: "failed" } });
    const afterFailure = await database.pool.query<{ current_event_id: string }>(
      `SELECT current_event_id FROM ${schema}.environment_serving_checkpoints WHERE tenant_id=$1`, [tenantId]);
    expect(afterFailure.rows).toEqual([{ current_event_id: "synthetic-serving-repaired" }]);
    expect(await bridge.deliver("synthetic-serving-mixed")).toMatchObject({ outcome: "accepted" });
    expect(await inbox.drain(workerIdentity)).toMatchObject([{ state: "delivered" }]);
    const mixedView = await view.getEnvironment(reader, key);
    expect(mixedView).toMatchObject({ deployment: "transitional",
      contract: "ambiguous", active: [{ artifactId: "synthetic-artifact-b", revision: revisionB },
        { artifactId: "synthetic-artifact-c", revision: revisionC }] });
    expect(mixedView).not.toHaveProperty("snapshotId");
    expect(await bridge.deliver("synthetic-rollback-request")).toMatchObject({ outcome: "accepted" });
    expect(await inbox.drain(workerIdentity)).toMatchObject([{ state: "delivered" }]);
    const requestedView = await view.getEnvironment(reader, key);
    expect(requestedView).toMatchObject({ deployment: "transitional",
      contract: "ambiguous", latestAttempt: { deploymentId: "synthetic-rollback-b",
        state: "rollback_requested" } });
    expect(requestedView).not.toHaveProperty("snapshotId");
    const afterRequest = await database.pool.query<{ current_event_id: string }>(
      `SELECT current_event_id FROM ${schema}.environment_serving_checkpoints WHERE tenant_id=$1`, [tenantId]);
    expect(afterRequest.rows).toEqual([{ current_event_id: "synthetic-serving-mixed" }]);
    expect(await bridge.deliver("synthetic-rollback-confirmed")).toMatchObject({ outcome: "accepted" });
    expect(await inbox.drain(workerIdentity)).toMatchObject([{ state: "delivered" }]);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed", contract: "resolved",
      snapshotId: merged.result.snapshot_id, active: [{ artifactId: "synthetic-artifact-b", revision: revisionB }] });

    const missedFact = { ...rollbackConfirmed, event_id: "synthetic-missed-observation",
      provider_reference: "synthetic-missed-observation", sequence: "13", effective_order: "13",
      observation_id: "synthetic-missed-observation", reference: "synthetic-inventory-after-loss" };
    const periodic = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => normalizeLocalFact(missedFact,
        { configuration: rollbackPolicy.configuration, context: rollbackPolicy.context,
          knownArtifacts: rollbackPolicy.knownArtifacts }) },
      workerIdentity, eventContext: rollbackPolicy.context });
    await database.pool.query(`UPDATE ${schema}.environment_serving_checkpoints
      SET updated_at=clock_timestamp()-interval '2 seconds' WHERE tenant_id=$1`, [tenantId]);
    expect(await createEnvironmentReconciliationWorker(database.pool,
      { schema: database.schema, reconcileAfterMs: 1_000 }, periodic).drain(workerIdentity))
      .toMatchObject([{ state: "resolved" }]);
    expect(await inbox.drain(workerIdentity)).toMatchObject([{ eventId: "synthetic-missed-observation",
      state: "delivered" }]);
    const afterLossRepair = await database.pool.query<{ current_event_id: string }>(
      `SELECT current_event_id FROM ${schema}.environment_serving_checkpoints WHERE tenant_id=$1`, [tenantId]);
    expect(afterLossRepair.rows).toEqual([{ current_event_id: "synthetic-missed-observation" }]);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed", contract: "resolved",
      snapshotId: merged.result.snapshot_id });

    expect(await bridge.deliver("synthetic-branch")).toMatchObject({ outcome: "duplicate" });
    expect(await bridge.deliver("synthetic-branch-stale")).toMatchObject({ disposition: "ignored_stale" });
    const branchAnalysisCount = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_jobs
       WHERE tenant_id=$1 AND kind='branch_analysis'`, [tenantId]);
    expect(branchAnalysisCount.rows[0]?.count).toBe("2");
    const stillCurrent = await database.pool.query<{ snapshot_id: string; pointer_version: string }>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch='main'`, [tenantId, repo, service]);
    expect(stillCurrent.rows).toEqual(pointer.rows);
  } finally { await database.cleanup(); }
}, 60_000);
