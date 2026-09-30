import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import type { AnalyzerRequest, AnalyzerResult } from "../../packages/ir/src/index.js";
import { createAccessPolicyStore, createCatalogStore } from "../../packages/catalog/src/index.js";
import { applyOrchestrationMigrations, createOrchestrationRepository }
  from "../../packages/orchestration/src/index.js";
import { applyEnvironmentMigrations, createEnvironmentInboxWorker, createEnvironmentReconciler,
  createEnvironmentReconciliationWorker, createEnvironmentRepository, createEnvironmentViewRepository }
  from "../../packages/environment/src/index.js";
import { createCatalogTestDatabase } from "./support/database.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const worker = { workerId: "environment-worker", instanceId: "local-1", capabilities: ["jobs.execute"] };
const admin = { tenantId: "tenant-a", principalId: "admin", capabilities: ["configuration.admin"] };
const context = { tenantId: "tenant-a", principalId: "deploy-connector", producerId: "deploy",
  allowedEventTypes: ["deployment.changed"], allowedRepositories: ["commerce"], allowedServices: ["orders"],
  deploymentAuthorityGrants: [{ repositoryId: "commerce", serviceId: "orders", environment: "uat",
    adapterId: "deploy", sourceAuthorityIds: ["inventory"] }], capabilities: ["event.ingest"] };
const repairContext = { tenantId: "tenant-a", principalId: "repair-connector", producerId: "repair",
  allowedEventTypes: ["reconciliation.requested"], allowedRepositories: ["commerce"],
  allowedServices: ["orders"], deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
const repairRequest = (eventId: string) => ({
  event_version: "1.0.0", event_id: eventId, event_type: "reconciliation.requested",
  producer: { producer_id: "repair", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "control-plane", provider_reference: eventId },
  payload: { scope: { service_ids: ["orders"], environments: ["uat"] },
    provider_snapshot_reference: eventId },
});
const config = { fingerprint: "config-a", document: {
  config_version: "1.0.0", access_scopes: [
    { access_scope_id: "engineering", label: "Engineering" },
    { access_scope_id: "deployment", label: "Deployment" },
    { access_scope_id: "contract-read", label: "Contracts" },
  ],
  repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce",
    access_scope_id: "engineering", services: [{ service_id: "orders", root: "services/orders",
      analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
      environments: [{ name: "uat", intended_branch: "main",
        deployment_authority: { adapter_id: "deploy", access_scope_id: "deployment" } }],
    }] }], inference: { enabled: false }, logs: { enabled: false },
} };
const serving = (eventId: string, order: string, inventory: unknown[]) => ({
  event_version: "1.0.0", event_id: eventId, event_type: "deployment.changed",
  producer: { producer_id: "deploy", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"], environment: "uat" },
  provider_evidence: { provider: "deploy", provider_reference: eventId },
  payload: { change_kind: "serving_observation", observation_id: eventId, environment: "uat",
    source: { authority_id: "inventory", reference: eventId, access_label: "deployment" },
    completeness: "complete", effective_order: order, serving_state: { status: "known", inventory } },
});
const attempt = (eventId: string, artifactId: string, revision: string, order = "1") => ({
  event_version: "1.0.0", event_id: eventId, event_type: "deployment.changed",
  producer: { producer_id: "deploy", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"], environment: "uat" },
  provider_evidence: { provider: "deploy", provider_reference: eventId },
  payload: { change_kind: "attempt", deployment_id: eventId, environment: "uat",
    attempt_state: "failed", effective_order: order, artifact_id: artifactId,
    revision: { state: "known", revision } },
});
const key = { repositoryId: "commerce", serviceId: "orders", environment: "uat" };
let sourceRoot: string;
let result: AnalyzerResult;

beforeAll(async () => {
  sourceRoot = await mkdtemp(join(tmpdir(), "api-truth-environment-view-"));
  await writeFile(join(sourceRoot, "service.ts"),
    "import express from 'express'; const app = express(); app.get('/orders', (_req, res) => res.status(204).type('application/json').end());\n");
  const request: AnalyzerRequest = { exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "environment-view",
    analyzer: ANALYZER, source: { repository_id: "commerce", service_id: "orders", service_root: ".",
      immutable_revision: revisionA, source_digest: "pending", access_label: "contract-read" },
    resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }], prior_dependencies: [],
    changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
    execution_policy: { network_access: false, side_effects: "none" } };
  result = await createAnalyzer({ projectRoot: sourceRoot }).analyze(request);
  expect(result.status).toBe("success");
});
afterAll(async () => { await rm(sourceRoot, { recursive: true, force: true }); });

test("an authorized UAT view binds only the observed artifact to an exact analyzed revision", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of ["engineering", "deployment", "contract-read"]) {
      await access.putScope({ tenantId: "tenant-a" }, { scopeId, active: true });
      await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId, active: true });
    }
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin, config);
    await orchestration.activateInitialConfiguration(admin, { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const view = createEnvironmentViewRepository(database.pool, { schema: database.schema });
    const reader = { tenantId: "tenant-a", principalId: "architect" };
    const artA = { artifact_id: "artifact-a", revision: { state: "known", revision: revisionA } };
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "unknown", contract: "unavailable" });
    await orchestration.ingestEvent(context, serving("serving-a", "1", [artA]));
    await environment.recordServingObservation(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "serving-a" });
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed",
      contract: "pending_binding", active: [{ artifactId: "artifact-a", revision: revisionA }] });
    await orchestration.ingestEvent(context, attempt("failed-b", "artifact-a", revisionA));
    await environment.recordAttempt(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "failed-b" });
    expect(await view.getEnvironment(reader, key)).toMatchObject({ contract: "pending_analysis",
      latestAttempt: { deploymentId: "failed-b", state: "failed" } });
    const catalog = createCatalogStore(database.pool, { schema: database.schema });
    await catalog.ingestAnalyzerResult({ tenantId: "tenant-a", result, configFingerprint: "config-a" });
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed",
      contract: "resolved", snapshotId: result.snapshot_id });
    await orchestration.ingestEvent(repairContext, repairRequest("verify-current"));
    const pendingView = await view.getEnvironment(reader, key);
    expect(pendingView).toMatchObject({ deployment: "unknown", contract: "unavailable",
      active: [], reconciliationRequired: true });
    expect(pendingView).not.toHaveProperty("snapshotId");
    const exact = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => serving("verified-current", "2", [artA]) },
      workerIdentity: worker, eventContext: context });
    await createEnvironmentReconciliationWorker(database.pool, { schema: database.schema }, exact).drain(worker);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed",
      contract: "resolved", snapshotId: result.snapshot_id, reconciliationRequired: false });
    await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId: "contract-read", active: false });
    expect(await view.getEnvironment(reader, key)).toMatchObject({ contract: "pending_analysis" });
    await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId: "contract-read", active: true });
    await orchestration.ingestEvent(context, serving("confirmed-absent", "3", []));
    await environment.recordServingObservation(worker,
      { tenantId: "tenant-a", producerId: "deploy", eventId: "confirmed-absent" });
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "confirmed_not_deployed",
      contract: "unavailable", active: [] });
    await orchestration.ingestEvent(repairContext, repairRequest("verify-absence"));
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "unknown",
      contract: "unavailable", active: [], reconciliationRequired: true });
    await expect(view.getEnvironment(reader, { ...key, environment: "staging" }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    await expect(view.getEnvironment({ tenantId: "tenant-b", principalId: "architect" }, key))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId: "deployment", active: false });
    await expect(view.getEnvironment(reader, key))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId: "deployment", active: true });
    await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId: "engineering", active: false });
    await expect(view.getEnvironment(reader, key))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId: "engineering", active: true });
    await orchestration.registerConfiguration(admin, { ...config, fingerprint: "config-b" });
    await orchestration.activateConfigurationByCas(admin, { fingerprint: "config-b", expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "config-b-active" } });
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "unknown",
      contract: "unavailable", reconciliationRequired: true, configFingerprint: "config-b" });
  } finally { await database.cleanup(); }
});

test("a failed partial rollout remains mixed even when one revision has an analyzed snapshot", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of ["engineering", "deployment", "contract-read"]) {
      await access.putScope({ tenantId: "tenant-a" }, { scopeId, active: true });
      await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId, active: true });
    }
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin, config);
    await orchestration.activateInitialConfiguration(admin, { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const catalog = createCatalogStore(database.pool, { schema: database.schema });
    await catalog.ingestAnalyzerResult({ tenantId: "tenant-a", result, configFingerprint: "config-a" });
    for (const [eventId, artifactId, revision] of [
      ["attempt-a", "artifact-a", revisionA], ["attempt-b", "artifact-b", revisionB],
    ]) {
      await orchestration.ingestEvent(context, attempt(eventId!, artifactId!, revision!, eventId === "attempt-a" ? "1" : "2"));
      await environment.recordAttempt(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: eventId! });
    }
    await orchestration.ingestEvent(context, serving("mixed", "1", [
      { artifact_id: "artifact-a", revision: { state: "known", revision: revisionA } },
      { artifact_id: "artifact-b", revision: { state: "known", revision: revisionB } },
    ]));
    await environment.recordServingObservation(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "mixed" });
    const view = createEnvironmentViewRepository(database.pool, { schema: database.schema });
    expect(await view.getEnvironment({ tenantId: "tenant-a", principalId: "architect" }, key))
      .toMatchObject({ deployment: "transitional", contract: "ambiguous",
        latestAttempt: { deploymentId: "attempt-b", state: "failed" }, active: [
        { artifactId: "artifact-a", revision: revisionA, snapshotId: result.snapshot_id },
        { artifactId: "artifact-b", revision: revisionB },
      ] });
  } finally { await database.cleanup(); }
});

test("a branch pointer with an analyzed snapshot does not establish an environment deployment", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of ["engineering", "deployment", "contract-read"]) {
      await access.putScope({ tenantId: "tenant-a" }, { scopeId, active: true });
      await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId, active: true });
    }
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin, config);
    await orchestration.activateInitialConfiguration(admin, { fingerprint: "config-a" });
    const catalog = createCatalogStore(database.pool, { schema: database.schema });
    await catalog.ingestAnalyzerResult({ tenantId: "tenant-a", result, configFingerprint: "config-a" });
    await catalog.promoteBranch({ tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders",
      branch: "main", snapshotId: result.snapshot_id,
      provider: { provider: "github", provider_reference: "main-at-a", order: { kind: "sequence", value: "1" } } });
    const view = createEnvironmentViewRepository(database.pool, { schema: database.schema });
    const observed = await view.getEnvironment({ tenantId: "tenant-a", principalId: "architect" }, key);
    expect(observed).toMatchObject({ deployment: "unknown", contract: "unavailable", active: [] });
    expect(observed).not.toHaveProperty("snapshotId");
  } finally { await database.cleanup(); }
});

test("the local deployment lifecycle keeps a failed mixed rollout until authoritative rollback confirmation", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of ["engineering", "deployment", "contract-read"]) {
      await access.putScope({ tenantId: "tenant-a" }, { scopeId, active: true });
      await access.putGrant({ tenantId: "tenant-a" }, { principalId: "architect", scopeId, active: true });
    }
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin, config);
    await orchestration.activateInitialConfiguration(admin, { fingerprint: "config-a" });
    const catalog = createCatalogStore(database.pool, { schema: database.schema });
    await catalog.ingestAnalyzerResult({ tenantId: "tenant-a", result, configFingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const inbox = createEnvironmentInboxWorker(database.pool, { schema: database.schema }, environment);
    const view = createEnvironmentViewRepository(database.pool, { schema: database.schema });
    const reader = { tenantId: "tenant-a", principalId: "architect" };
    const artA = { artifact_id: "artifact-a", revision: { state: "known", revision: revisionA } };
    const artB = { artifact_id: "artifact-b", revision: { state: "known", revision: revisionB } };
    const deployed = attempt("deploy-a", "artifact-a", revisionA, "1");
    await orchestration.ingestEvent(context, { ...deployed,
      payload: { ...deployed.payload, attempt_state: "succeeded" } });
    await orchestration.ingestEvent(context, serving("serving-a", "1", [artA]));
    await inbox.drain(worker);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed",
      contract: "resolved", snapshotId: result.snapshot_id });

    await orchestration.ingestEvent(context, attempt("deploy-b-failed", "artifact-b", revisionB, "2"));
    await orchestration.ingestEvent(context, serving("mixed-rollout", "2", [artA, artB]));
    await inbox.drain(worker);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "transitional",
      contract: "ambiguous", latestAttempt: { deploymentId: "deploy-b-failed", state: "failed" } });

    const rollback = attempt("rollback-request", "artifact-a", revisionA, "3");
    await orchestration.ingestEvent(context, { ...rollback,
      payload: { ...rollback.payload, attempt_state: "rollback_requested" } });
    await inbox.drain(worker);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "transitional",
      contract: "ambiguous", latestAttempt: { deploymentId: "rollback-request", state: "rollback_requested" } });

    await orchestration.ingestEvent(context, serving("opaque-after-rollback", "cursor-3", [artA]));
    await inbox.drain(worker);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "transitional",
      reconciliationRequired: true });
    const exact = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => serving("rollback-confirmed", "cursor-4", [artA]) },
      workerIdentity: worker, eventContext: context });
    const scheduling = createEnvironmentReconciliationWorker(database.pool, { schema: database.schema }, exact);
    await expect(scheduling.drain(worker)).resolves.toMatchObject([{ state: "resolved" }]);
    await inbox.drain(worker);
    expect(await view.getEnvironment(reader, key)).toMatchObject({ deployment: "deployed",
      contract: "resolved", snapshotId: result.snapshot_id, reconciliationRequired: false });
  } finally { await database.cleanup(); }
});
