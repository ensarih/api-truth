import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { createApiTruthMcpServer } from "../../apps/mcp/src/server.js";
import { createPortalServer } from "../../apps/portal/src/server.js";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../packages/catalog/src/canonical.js";
import { createAccessPolicyStore } from "../../packages/catalog/src/index.js";
import { applyEnvironmentMigrations, createEnvironmentRepository } from "../../packages/environment/src/index.js";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { applyOrchestrationMigrations, createOrchestrationRepository } from "../../packages/orchestration/src/index.js";
import { createQueryReader } from "../../packages/query/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const revision = "a".repeat(40);
const repositoryScope = "repository-read";
const deploymentScope = "deployment-read";
const contractScope = "contract-read";
const readerContext = Object.freeze({ tenantId: "tenant-environment-cross-surface", principalId: "architect" });
const authHeader = Object.freeze({ authorization: "Bearer environment-cross-surface" });
const environmentKey = Object.freeze({ kind: "environment" as const, repositoryId: "commerce",
  serviceId: "orders", environment: "uat" });
const admin = Object.freeze({ tenantId: readerContext.tenantId, principalId: "admin",
  capabilities: ["configuration.admin"] });
const worker = Object.freeze({ workerId: "environment-worker", instanceId: "cross-surface-1",
  capabilities: ["jobs.execute"] });
const producer = Object.freeze({ tenantId: readerContext.tenantId, principalId: "deploy-connector",
  producerId: "deploy", allowedEventTypes: ["deployment.changed"], allowedRepositories: ["commerce"],
  allowedServices: ["orders"], deploymentAuthorityGrants: [{ repositoryId: "commerce", serviceId: "orders",
    environment: "uat", adapterId: "deploy", sourceAuthorityIds: ["inventory"] }], capabilities: ["event.ingest"] });
const configuration = Object.freeze({ fingerprint: "config-environment-cross-surface", document: {
  config_version: "1.0.0", access_scopes: [
    { access_scope_id: repositoryScope, label: "Repository" },
    { access_scope_id: deploymentScope, label: "Deployment" },
    { access_scope_id: contractScope, label: "Contract" },
  ],
  repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce",
    access_scope_id: repositoryScope, services: [{ service_id: "orders", root: "services/orders",
      analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
      environments: [{ name: "uat", intended_branch: "main",
        deployment_authority: { adapter_id: "deploy", access_scope_id: deploymentScope } }] }] }],
  inference: { enabled: false }, logs: { enabled: false },
} });

const strictSnapshot = async (): Promise<ContractSnapshot> => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url),
    "utf8")) as ContractSnapshot;
  snapshot.snapshot_id = "environment-cross-surface-snapshot";
  snapshot.source.immutable_revision = revision;
  snapshot.config.config_fingerprint = configuration.fingerprint;
  snapshot.endpoints = [snapshot.endpoints[0]!];
  snapshot.schemas = {};
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0]!.parameters = snapshot.endpoints[0]!.parameters.slice(0, 1);
  snapshot.endpoints[0]!.responses[0]!.content[0]!.schema = { type: "string" };
  snapshot.evidence = snapshot.evidence.filter((item) => item.scope.endpoint_id !== "ep-create")
    .map((item) => ({ ...item, scope: { ...item.scope, snapshot_id: snapshot.snapshot_id } }));
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-proof",
    method: "deterministic_analysis", limitations: [],
    scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0]!.evidence_ids = ["ev-proof"];
  snapshot.endpoints[0]!.parameters[0]!.presence.evidence_ids = ["ev-proof"];
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-anonymous",
    method: "deterministic_analysis", limitations: [] });
  snapshot.endpoints[0]!.security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  return snapshot;
};

const deploymentEvent = (eventId: string, payload: unknown) => ({
  event_version: "1.0.0", event_id: eventId, event_type: "deployment.changed",
  producer: { producer_id: "deploy", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"], environment: "uat" },
  provider_evidence: { provider: "deploy", provider_reference: eventId }, payload,
});

test("one authorized UAT publication pin is shared by query, portal, MCP, and export", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    await applyOpenApiMigrations(database.pool, { schema: database.schema });

    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    for (const scopeId of [repositoryScope, deploymentScope, contractScope]) {
      await access.putScope({ tenantId: readerContext.tenantId }, { scopeId, active: true });
      await access.putGrant({ tenantId: readerContext.tenantId },
        { principalId: readerContext.principalId, scopeId, active: true });
    }
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin, configuration);
    await orchestration.activateInitialConfiguration(admin, { fingerprint: configuration.fingerprint });

    const snapshot = await strictSnapshot();
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
      (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
       identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
      VALUES($1,$2,$3,$4,$5,'success',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [readerContext.tenantId, snapshot.snapshot_id, snapshot.service.repository_id, snapshot.service.service_id,
      revision, snapshot.ir_version, snapshot.identity_version, configuration.fingerprint,
      snapshotIdentitySha256(snapshot), snapshotContentSha256(snapshot), [contractScope], JSON.stringify(snapshot)]);

    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const attempt = deploymentEvent("cross-surface-attempt", { change_kind: "attempt",
      deployment_id: "cross-surface-attempt", environment: "uat", attempt_state: "succeeded",
      effective_order: "1", artifact_id: "artifact-a", revision: { state: "known", revision } });
    await orchestration.ingestEvent(producer, attempt);
    await environment.recordAttempt(worker,
      { tenantId: readerContext.tenantId, producerId: "deploy", eventId: "cross-surface-attempt" });
    const serving = deploymentEvent("cross-surface-serving", { change_kind: "serving_observation",
      observation_id: "cross-surface-serving", environment: "uat",
      source: { authority_id: "inventory", reference: "cross-surface-serving", access_label: deploymentScope },
      completeness: "complete", effective_order: "1", serving_state: { status: "known",
        inventory: [{ artifact_id: "artifact-a", revision: { state: "known", revision } }] } });
    await orchestration.ingestEvent(producer, serving);
    await environment.recordServingObservation(worker,
      { tenantId: readerContext.tenantId, producerId: "deploy", eventId: "cross-surface-serving" });

    const publicationStore = createOpenApiPublicationStore(database.pool, { schema: database.schema });
    const prepared = await publicationStore.prepareEnvironment(readerContext, environmentKey);
    expect(prepared.publishable).toBe(true);
    const published = await publicationStore.publish(readerContext, prepared, { state: "absent" });
    const query = createQueryReader(database.pool, { schema: database.schema });
    const selected = { version: "1" as const, tenantId: readerContext.tenantId,
      repositoryId: environmentKey.repositoryId, serviceId: environmentKey.serviceId,
      selector: { kind: "environment" as const, environment: environmentKey.environment } };

    const mcp = createApiTruthMcpServer({ query, authenticate: async () => readerContext });
    const mcpClient = new Client({ name: "environment-cross-surface-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const portal = createPortalServer({
      authenticate: async (request) => request.headers.authorization === authHeader.authorization
        ? readerContext : undefined,
      query,
    });
    portal.listen(0, "127.0.0.1");
    await once(portal, "listening");
    const address = portal.address();
    if (!address || typeof address === "string") throw new Error("Missing portal port");
    const base = `http://127.0.0.1:${address.port}`;
    const contractUrl = `${base}/api/contract?repositoryId=commerce&serviceId=orders&kind=environment&value=uat`;
    const downloadUrl = `${base}/api/openapi/${published.publicationId}?repositoryId=commerce&serviceId=orders`;
    const historicalKey = { tenantId: readerContext.tenantId, repositoryId: "commerce",
      serviceId: "orders", publicationId: published.publicationId };
    try {
      const direct = await query.readContract(readerContext, selected);
      expect(direct.status).toBe("resolved");
      if (direct.status !== "resolved") throw new Error("Expected resolved UAT contract");

      const portalResponse = await fetch(contractUrl, { headers: authHeader });
      expect(portalResponse.status).toBe(200);
      const portalContract = await portalResponse.json() as { selector: unknown; pin: unknown; publication: unknown };
      expect(portalContract.selector).toEqual(direct.selector);
      expect(portalContract.pin).toEqual(direct.pin);
      expect(portalContract.publication).toEqual(direct.publication);

      const mcpResponse = await mcpClient.callTool({ name: "api_truth_get_contract", arguments: {
        repositoryId: "commerce", serviceId: "orders",
        view: { kind: "environment", environment: "uat" },
      } });
      expect(mcpResponse.isError).not.toBe(true);
      const mcpContract = mcpResponse.structuredContent as { ok: true;
        data: { selector: unknown; pin: unknown; publication: unknown } };
      expect(mcpContract.data.selector).toEqual(direct.selector);
      expect(mcpContract.data.pin).toEqual(direct.pin);
      expect(mcpContract.data.publication).toEqual(direct.publication);

      expect(direct.publication).toMatchObject({ status: "current",
        publicationId: published.publicationId });
      const exported = await query.readPublication(readerContext, historicalKey);
      expect(exported).toMatchObject({ publicationId: published.publicationId, pin: direct.pin });
      expect(exported.selector).toMatchObject({ kind: "environment", environment: "uat",
        snapshotId: direct.pin.snapshotId, checkpointVersion: direct.pin.checkpointVersion });
      expect(exported.bytes).toEqual(published.bytes);
      const download = await fetch(downloadUrl, { headers: authHeader });
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(exported.bytes);

      await access.putGrant({ tenantId: readerContext.tenantId },
        { principalId: readerContext.principalId, scopeId: deploymentScope, active: false });

      await expect(query.readContract(readerContext, selected))
        .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
      expect((await fetch(contractUrl, { headers: authHeader })).status).toBe(404);
      expect(await mcpClient.callTool({ name: "api_truth_get_contract", arguments: {
        repositoryId: "commerce", serviceId: "orders",
        view: { kind: "environment", environment: "uat" },
      } })).toMatchObject({ isError: true,
        structuredContent: { ok: false, error: "NOT_FOUND_OR_DENIED" } });
      await expect(query.readPublication(readerContext, historicalKey))
        .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
      expect((await fetch(downloadUrl, { headers: authHeader })).status).toBe(404);
    } finally {
      await Promise.allSettled([mcpClient.close(), mcp.close()]);
      portal.closeAllConnections();
      portal.close();
      await once(portal, "close");
    }
  } finally {
    await database.cleanup();
  }
});
