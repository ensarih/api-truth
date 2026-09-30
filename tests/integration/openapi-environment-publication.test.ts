import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../packages/catalog/src/canonical.js";
import { createAccessPolicyStore } from "../../packages/catalog/src/index.js";
import { applyOrchestrationMigrations, createOrchestrationRepository } from "../../packages/orchestration/src/index.js";
import { applyEnvironmentMigrations, createEnvironmentRepository,
  createEnvironmentViewRepository } from "../../packages/environment/src/index.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const revision = "a".repeat(40);
const repositoryScope = "\uE000";
const deploymentScope = "😀";
const reader = { tenantId: "tenant-a", principalId: "architect" };
const key = { kind: "environment" as const, repositoryId: "commerce", serviceId: "orders", environment: "uat" };
const admin = { tenantId: "tenant-a", principalId: "admin", capabilities: ["configuration.admin"] };
const worker = { workerId: "environment-worker", instanceId: "local-1", capabilities: ["jobs.execute"] };
const producer = { tenantId: "tenant-a", principalId: "deploy-connector", producerId: "deploy",
  allowedEventTypes: ["deployment.changed"], allowedRepositories: ["commerce"], allowedServices: ["orders"],
  deploymentAuthorityGrants: [{ repositoryId: "commerce", serviceId: "orders", environment: "uat",
    adapterId: "deploy", sourceAuthorityIds: ["inventory"] }], capabilities: ["event.ingest"] };
const config = { fingerprint: "config-a", document: {
  config_version: "1.0.0", access_scopes: [
    { access_scope_id: repositoryScope, label: "Engineering" },
    { access_scope_id: deploymentScope, label: "Deployment" },
    { access_scope_id: "contract-read", label: "Contracts" },
  ],
  repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce",
    access_scope_id: repositoryScope, services: [{ service_id: "orders", root: "services/orders",
      analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
      environments: [{ name: "uat", intended_branch: "main",
        deployment_authority: { adapter_id: "deploy", access_scope_id: deploymentScope } }] }] }],
  inference: { enabled: false }, logs: { enabled: false },
} };

const strictSnapshot = async (): Promise<ContractSnapshot> => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
  snapshot.snapshot_id = "strict-uat-snapshot";
  snapshot.source.immutable_revision = revision;
  snapshot.config.config_fingerprint = "config-a";
  snapshot.endpoints = [snapshot.endpoints[0]!];
  snapshot.schemas = {};
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0]!.parameters = snapshot.endpoints[0]!.parameters.slice(0, 1);
  snapshot.endpoints[0]!.responses[0]!.content[0]!.schema = { type: "string" };
  snapshot.evidence = snapshot.evidence.filter((item) => item.scope.endpoint_id !== "ep-create");
  snapshot.evidence = snapshot.evidence.map((item) => ({ ...item,
    scope: { ...item.scope, snapshot_id: snapshot.snapshot_id } }));
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-proof", method: "deterministic_analysis",
    limitations: [], scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0]!.evidence_ids = ["ev-proof"];
  snapshot.endpoints[0]!.parameters[0]!.presence.evidence_ids = ["ev-proof"];
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-anonymous", method: "deterministic_analysis",
    limitations: [] });
  snapshot.endpoints[0]!.security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  return snapshot;
};

const event = (eventId: string, payload: unknown) => ({
  event_version: "1.0.0", event_id: eventId, event_type: "deployment.changed",
  producer: { producer_id: "deploy", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"], environment: "uat" },
  provider_evidence: { provider: "deploy", provider_reference: eventId }, payload,
});

test("publishes only the currently resolved UAT contract and withdraws current access when reconciliation starts", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    await applyOpenApiMigrations(database.pool, { schema: database.schema });
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of [repositoryScope, deploymentScope, "contract-read"]) {
      await access.putScope({ tenantId: reader.tenantId }, { scopeId, active: true });
      await access.putGrant({ tenantId: reader.tenantId }, { principalId: reader.principalId, scopeId, active: true });
    }
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin, config);
    await orchestration.activateInitialConfiguration(admin, { fingerprint: config.fingerprint });
    const snapshot = await strictSnapshot();
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots(tenant_id,snapshot_id,repository_id,service_id,
      immutable_revision,analyzer_status,ir_version,identity_version,config_fingerprint,identity_sha256,
      content_sha256,required_scope_ids,document) VALUES($1,$2,$3,$4,$5,'success',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [reader.tenantId, snapshot.snapshot_id, snapshot.service.repository_id, snapshot.service.service_id,
        revision, snapshot.ir_version, snapshot.identity_version, config.fingerprint,
        snapshotIdentitySha256(snapshot), snapshotContentSha256(snapshot), ["contract-read"], JSON.stringify(snapshot)]);
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const attempt = event("deploy-a", { change_kind: "attempt", deployment_id: "deploy-a",
      environment: "uat", attempt_state: "succeeded", effective_order: "1",
      artifact_id: "artifact-a", revision: { state: "known", revision } });
    await orchestration.ingestEvent(producer, attempt);
    await environment.recordAttempt(worker, { tenantId: reader.tenantId, producerId: "deploy", eventId: "deploy-a" });
    const serving = event("serving-a", { change_kind: "serving_observation", observation_id: "serving-a",
      environment: "uat", source: { authority_id: "inventory", reference: "serving-a", access_label: deploymentScope },
      completeness: "complete", effective_order: "1",
      serving_state: { status: "known", inventory: [{ artifact_id: "artifact-a",
        revision: { state: "known", revision } }] } });
    await orchestration.ingestEvent(producer, serving);
    await environment.recordServingObservation(worker,
      { tenantId: reader.tenantId, producerId: "deploy", eventId: "serving-a" });
    expect(await createEnvironmentViewRepository(database.pool, { schema: database.schema })
      .getEnvironment(reader, { repositoryId: key.repositoryId, serviceId: key.serviceId,
        environment: key.environment })).toMatchObject({ deployment: "deployed", contract: "resolved",
        snapshotId: snapshot.snapshot_id });
    const store = createOpenApiPublicationStore(database.pool, { schema: database.schema });
    const prepared = await store.prepareEnvironment(reader, key);
    expect(prepared.publishable).toBe(true);
    const published = await store.publish(reader, prepared, { state: "absent" });
    expect((await store.readCurrent(reader, key)).bytes).toEqual(published.bytes);
    expect((await store.readPublication(reader, published.publicationId)).bytes).toEqual(published.bytes);
    await access.putGrant({ tenantId: reader.tenantId },
      { principalId: reader.principalId, scopeId: deploymentScope, active: false });
    await expect(store.readPublication(reader, published.publicationId))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
    await expect(store.readCurrent(reader, key))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
    await access.putGrant({ tenantId: reader.tenantId },
      { principalId: reader.principalId, scopeId: deploymentScope, active: true });
    const repairProducer = { tenantId: reader.tenantId, principalId: "repair-connector", producerId: "repair",
      allowedEventTypes: ["reconciliation.requested"], allowedRepositories: ["commerce"],
      allowedServices: ["orders"], deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
    await orchestration.ingestEvent(repairProducer, {
      event_version: "1.0.0", event_id: "verify-current", event_type: "reconciliation.requested",
      producer: { producer_id: "repair", adapter_version: "1" },
      occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
      subjects: { repository_id: "commerce", service_ids: ["orders"] },
      provider_evidence: { provider: "control-plane", provider_reference: "verify-current" },
      payload: { scope: { service_ids: ["orders"], environments: ["uat"] },
        provider_snapshot_reference: "verify-current" },
    });
    await expect(store.readCurrent(reader, key)).rejects.toMatchObject({ code: "STALE_POINTER" });
    await expect(store.publish(reader, prepared, { state: "absent" }))
      .rejects.toMatchObject({ code: "STALE_POINTER" });
    expect((await store.readPublication(reader, published.publicationId)).bytes).toEqual(published.bytes);
  } finally { await database.cleanup(); }
});
