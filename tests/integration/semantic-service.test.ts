import {once} from "node:events";
import {Client, InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import {createPortalServer} from "../../apps/portal/src/server.js";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, test, vi} from "vitest";
import {ANALYZER as EXPRESS_ANALYZER, createAnalyzer as createExpressAnalyzer}
  from "../../analyzers/typescript/src/index.js";
import {snapshotContentSha256, snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {contractSnapshotFromAnalyzerResult, createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations, createEnvironmentRepository} from "../../packages/environment/src/index.js";
import type {AnalyzerRequest, ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createSemanticService} from "../../packages/semantics/src/index.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId = "tenant-semantics";
const principalId = "semantic-reader";
const repositoryId = "commerce";
const serviceId = "orders";
const environment = "uat";
const scopes = ["repository-read", "deployment-read", "contract-read", "source-read", "orders-read"] as const;
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const worker = {workerId: "environment-worker", instanceId: "semantic-1", capabilities: ["jobs.execute"]};
const producer = {tenantId, principalId: "deployment-connector", producerId: "deploy",
  allowedEventTypes: ["deployment.changed"], allowedRepositories: [repositoryId],
  allowedServices: [serviceId], deploymentAuthorityGrants: [{repositoryId, serviceId, environment,
    adapterId: "deploy", sourceAuthorityIds: ["inventory"]}], capabilities: ["event.ingest"]};
let database: CatalogTestDatabase | undefined;
let snapshot: ContractSnapshot;
let selected: {snapshotId: string; revision: string; configFingerprint: string; checkpointVersion: string};

const configuration = (enabled: boolean, fingerprint = "sha256:config-a",
  model = "synthetic-model") => ({fingerprint, document: {config_version: "1.0.0",
  access_scopes: scopes.map(access_scope_id => ({access_scope_id, label: access_scope_id})),
  repositories: [{repository_id: repositoryId, provider: "github", locator: "example/repository",
    access_scope_id: scopes[0], services: [{service_id: serviceId, root: "services/orders",
      analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
      environments: [{name: environment, intended_branch: "main",
        deployment_authority: {adapter_id: "deploy", access_scope_id: scopes[1]}}]}]}],
  inference: enabled ? {enabled: true, provider: "openai", model,
    credential: {secret_ref: {scheme: "env", locator: "SYNTHETIC_MODEL_KEY"}}} : {enabled: false},
  logs: {enabled: false}}});

const event = (eventId: string, payload: unknown) => ({event_version: "1.0.0", event_id: eventId,
  event_type: "deployment.changed", producer: {producer_id: "deploy", adapter_version: "1"},
  occurred_at: "2026-10-09T00:00:00.000Z", received_at: "2026-10-09T00:00:01.000Z",
  subjects: {repository_id: repositoryId, service_ids: [serviceId], environment},
  provider_evidence: {provider: "deploy", provider_reference: eventId}, payload});

const context = () => ({tenantId, principalId});
const selection = () => ({version: "1", tenantId, repositoryId, serviceId,
  selector: {kind: "environment", environment, expectedCheckpointVersion: selected.checkpointVersion}});
const answer = () => ({status: "suggestions", suggestions: [{endpointId: "ep-get",
  intent: "Find an existing order", summary: "Reads one stored order.",
  evidenceIds: ["ev-doc-get"]}]});

const analyzedExpressSnapshot = async (): Promise<ContractSnapshot> => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-semantic-pg-source-"));
  try {
    await writeFile(join(root, "app.ts"), `import express from "express";
      const app = express();
      function readOrders(req, res) { return res.status(200).json({secret: "CANARY_RAW_SOURCE"}); }
      app.get("/orders", readOrders);`);
    const request: AnalyzerRequest = {exchange_version: "1.0.0", ir_version: "1.0.0",
      request_id: "semantic-pg-source", analyzer: EXPRESS_ANALYZER,
      source: {repository_id: repositoryId, service_id: serviceId, service_root: ".",
        immutable_revision: "b".repeat(40), source_digest: "pending", access_label: scopes[3]},
      resolution_inputs: [{kind: "source_tree", path: ".", digest: "pending"}],
      prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
      limits: {timeout_ms: 30_000, max_files: 20, max_output_bytes: 1_000_000},
      execution_policy: {network_access: false, side_effects: "none"}};
    const result = await createExpressAnalyzer({projectRoot: root}).analyze(request);
    return contractSnapshotFromAnalyzerResult(result, "sha256:config-a").snapshot;
  } finally {await rm(root, {recursive: true, force: true});}
};

const setup = async (enabled = true, analyzedSnapshot?: ContractSnapshot): Promise<void> => {
  database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, {schema: database.schema});
  await applyEnvironmentMigrations(database.pool, {schema: database.schema});
  await applyOpenApiMigrations(database.pool, {schema: database.schema});
  const access = createAccessPolicyStore(database.pool, {schema: database.schema});
  for (const scopeId of scopes) {
    await access.putScope({tenantId}, {scopeId, active: true});
    await access.putGrant({tenantId}, {principalId, scopeId, active: true});
  }
  const orchestration = createOrchestrationRepository(database.pool, {schema: database.schema});
  await orchestration.registerConfiguration(admin, configuration(enabled));
  await orchestration.activateInitialConfiguration(admin, {fingerprint: "sha256:config-a"});
  snapshot = analyzedSnapshot ?? JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
  if (!analyzedSnapshot) {
    snapshot.evidence.push({evidence_id: "ev-doc-get", source: {kind: "api_document",
    source_id: snapshot.source.repository_id},
    source_version: snapshot.source.immutable_revision, location: {pointer: "/paths/~1api~1orders/get/summary"},
    method: "type_declaration", scope: {service_id: serviceId, snapshot_id: snapshot.snapshot_id,
      endpoint_id: "ep-get", revision: snapshot.source.immutable_revision},
    limitations: [], access_label: scopes[4]});
    snapshot.claims.push({claim_id: "claim-get-summary", subject: {service_id: serviceId, endpoint_id: "ep-get"},
    predicate: "operation.summary", value: "Read a stored order by identifier.",
    verification: "declared", evidence_ids: ["ev-doc-get"]});
    const get = snapshot.endpoints.find(endpoint => endpoint.endpoint_id === "ep-get")!;
    snapshot.evidence.push({evidence_id: "ev-doc-route", source: {kind: "api_document",
      source_id: snapshot.source.repository_id}, source_version: snapshot.source.immutable_revision,
    location: {pointer: "/paths/~1api~1orders~1{orderId}/get"}, method: "type_declaration",
    scope: {service_id: serviceId, snapshot_id: snapshot.snapshot_id,
      endpoint_id: "ep-get", revision: snapshot.source.immutable_revision},
    limitations: [], access_label: scopes[4]});
    snapshot.claims.push({claim_id: "claim-get-route", subject: {service_id: serviceId, endpoint_id: "ep-get"},
      predicate: "route.declaration", value: {method: get.identity.method, path: get.application_path},
      verification: "declared", evidence_ids: ["ev-doc-route"]});
  }
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
     identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
  [tenantId, snapshot.snapshot_id, repositoryId, serviceId, snapshot.source.immutable_revision,
    snapshot.coverage.status === "complete" ? "success" : "partial",
    snapshot.ir_version, snapshot.identity_version, snapshot.config.config_fingerprint,
    snapshotIdentitySha256(snapshot), snapshotContentSha256(snapshot), [scopes[2]], JSON.stringify(snapshot)]);
  const environmentRepo = createEnvironmentRepository(database.pool, {schema: database.schema});
  await orchestration.ingestEvent(producer, event("semantic-attempt", {change_kind: "attempt",
    deployment_id: "semantic-attempt", environment, attempt_state: "succeeded", effective_order: "1",
    artifact_id: "artifact-a", revision: {state: "known", revision: snapshot.source.immutable_revision}}));
  await environmentRepo.recordAttempt(worker, {tenantId, producerId: "deploy", eventId: "semantic-attempt"});
  await orchestration.ingestEvent(producer, event("semantic-serving", {change_kind: "serving_observation",
    observation_id: "semantic-serving", environment,
    source: {authority_id: "inventory", reference: "semantic-serving", access_label: scopes[3]},
    completeness: "complete", effective_order: "1", serving_state: {status: "known",
      inventory: [{artifact_id: "artifact-a", revision: {state: "known",
        revision: snapshot.source.immutable_revision}}]}}));
  await environmentRepo.recordServingObservation(worker,
    {tenantId, producerId: "deploy", eventId: "semantic-serving"});
  const result = await createQueryReader(database.pool, {schema: database.schema}).readContract(context(),
    {version: "1", tenantId, repositoryId, serviceId, selector: {kind: "environment", environment}});
  expect(result.status).toBe("resolved");
  if (result.status !== "resolved") throw new Error("fixture unresolved");
  selected = {snapshotId: result.pin.snapshotId, revision: result.pin.revision,
    configFingerprint: result.pin.configFingerprint, checkpointVersion: result.pin.checkpointVersion!};
};
afterEach(async () => {await database?.cleanup(); database = undefined;});

const service = (providerPort: Parameters<typeof createSemanticService>[1]["providerPort"]) =>
  createSemanticService(database!.pool, {schema: database!.schema, providerPort});

test("disabled inference never sends documented content to a provider", async () => {
  await setup(false);
  const provider = vi.fn(async () => answer());
  await expect(service(provider).analyze(context(), selection(), ["ep-get"]))
    .resolves.toEqual({status: "disabled"});
  expect(provider).not.toHaveBeenCalled();
});

test("authorized exact pin yields cited inferred suggestion without changing the snapshot", async () => {
  await setup();
  const before = await database!.pool.query(`SELECT content_sha256 FROM
    ${quoteCatalogTestSchema(database!.schema)}.catalog_snapshots WHERE snapshot_id=$1`, [snapshot.snapshot_id]);
  const provider = vi.fn(async request => {
    expect(request).toMatchObject({provider: "openai", model: "synthetic-model",
      source: {pin: selected}, endpoints: [{endpointId: "ep-get", documents: [{
        kind: "operation_summary", evidenceIds: ["ev-doc-get"]}]}]});
    expect(JSON.stringify(request)).not.toMatch(/SYNTHETIC_MODEL_KEY|credential/);
    return answer();
  });
  await expect(service(provider).analyze(context(), selection(), ["ep-get"]))
    .resolves.toMatchObject({status: "suggestions", verification: "inferred",
      review: "unreviewed", normative: false, provenance: {model: "synthetic-model"}});
  expect(provider).toHaveBeenCalledTimes(1);
  const after = await database!.pool.query(`SELECT content_sha256 FROM
    ${quoteCatalogTestSchema(database!.schema)}.catalog_snapshots WHERE snapshot_id=$1`, [snapshot.snapshot_id]);
  expect(after.rows).toEqual(before.rows);
});

test.each([scopes[0], scopes[1], scopes[2], scopes[3], scopes[4]])(
  "revoked repository, environment, snapshot, source, or documentation scope blocks egress: %s",
  async scopeId => {
    await setup();
    await createAccessPolicyStore(database!.pool, {schema: database!.schema}).putGrant({tenantId},
      {principalId, scopeId, active: false});
    const provider = vi.fn(async () => answer());
    await expect(service(provider).analyze(context(), selection(), ["ep-get"]))
      .rejects.toMatchObject({code: "SEMANTIC_NOT_FOUND_OR_DENIED"});
    expect(provider).not.toHaveBeenCalled();
  });

test("revocation while the provider is running discards its answer", async () => {
  await setup();
  const provider = vi.fn(async () => {
    await createAccessPolicyStore(database!.pool, {schema: database!.schema}).putGrant({tenantId},
      {principalId, scopeId: scopes[4], active: false});
    return answer();
  });
  await expect(service(provider).analyze(context(), selection(), ["ep-get"]))
    .rejects.toMatchObject({code: "SEMANTIC_STALE_CONTEXT", message: "SEMANTIC_STALE_CONTEXT"});
  expect(provider).toHaveBeenCalledTimes(1);
});

test("checkpoint and active inference config changes while provider runs discard the answer", async () => {
  await setup();
  const providerPin = vi.fn(async () => {
    await database!.pool.query(`UPDATE ${quoteCatalogTestSchema(database!.schema)}.environment_serving_checkpoints
      SET version=version+1 WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,
    [tenantId, repositoryId, serviceId, environment]);
    return answer();
  });
  await expect(service(providerPin).analyze(context(), selection(), ["ep-get"]))
    .rejects.toMatchObject({code: "SEMANTIC_STALE_CONTEXT"});
  expect(providerPin).toHaveBeenCalledTimes(1);
  await database!.cleanup();
  database = undefined;
  await setup();
  const providerConfig = vi.fn(async () => {
    const orchestration = createOrchestrationRepository(database!.pool, {schema: database!.schema});
    await orchestration.registerConfiguration(admin, configuration(false, "sha256:config-b"));
    await orchestration.activateConfigurationByCas(admin, {fingerprint: "sha256:config-b",
      expectedCheckpointVersion: "1", providerEvidence: {provider: "synthetic",
        provider_reference: "semantic-config-change"}});
    return answer();
  });
  await expect(service(providerConfig).analyze(context(), selection(), ["ep-get"]))
    .rejects.toMatchObject({code: "SEMANTIC_STALE_CONTEXT"});
  expect(providerConfig).toHaveBeenCalledTimes(1);
});

test("provider failures return only a fixed error", async () => {
  await setup();
  await expect(service(async () => {throw new Error("CANARY_SECRET_123");})
    .analyze(context(), selection(), ["ep-get"]))
    .rejects.toMatchObject({code: "SEMANTIC_PROVIDER_ERROR", message: "SEMANTIC_PROVIDER_ERROR"});
});

test("caller cannot substitute a snapshot, provider, or credential, or invoke an accessor", async () => {
  await setup();
  const provider = vi.fn(async () => answer());
  const semantic = service(provider);
  await expect(semantic.analyze({...context(), provider: "claude"}, selection(), ["ep-get"]))
    .rejects.toMatchObject({code: "SEMANTIC_INVALID_REQUEST"});
  await expect(semantic.analyze(context(), {...selection(), snapshot}, ["ep-get"]))
    .rejects.toMatchObject({code: "SEMANTIC_INVALID_REQUEST"});
  await expect(semantic.analyze(context(), selection(), Object.defineProperty(["ep-get"], "0", {
    get() {throw new Error("CANARY_SECRET_123");}})))
    .rejects.toMatchObject({code: "SEMANTIC_INVALID_REQUEST", message: "SEMANTIC_INVALID_REQUEST"});
  expect(provider).not.toHaveBeenCalled();
});

test("host options are captured at construction and cannot redirect provider or schema", async () => {
  await setup();
  const originalProvider = vi.fn(async () => answer());
  const substitutedProvider = vi.fn(async () => {throw new Error("wrong provider");});
  const options = {schema: database!.schema, providerPort: originalProvider};
  const semantic = createSemanticService(database!.pool, options);
  options.schema = "api_truth_test_nonexistent";
  options.providerPort = substitutedProvider;
  await expect(semantic.analyze(context(), selection(), ["ep-get"]))
    .resolves.toMatchObject({status: "suggestions", normative: false});
  expect(originalProvider).toHaveBeenCalledTimes(1);
  expect(substitutedProvider).not.toHaveBeenCalled();
  expect(() => createSemanticService(database!.pool, {schema: "unsafe-schema",
    providerPort: originalProvider})).toThrowError("SEMANTIC_INVALID_REQUEST");
});

test("authorized discovery compares a bounded intent with selected documented endpoints", async () => {
  await setup();
  const provider = vi.fn(async request => {
    expect(request).toMatchObject({promptVersion: "semantic-discovery-1",
      intentQuery: "Find a stored order", endpoints: [{endpointId: "ep-get",
        documents: [{evidenceIds: ["ev-doc-get"]}]}]});
    return answer();
  });
  await expect(service(provider).discover(context(), selection(), ["ep-get"], "Find a stored order"))
    .resolves.toMatchObject({status: "suggestions", verification: "inferred",
      review: "unreviewed", normative: false,
      provenance: {promptVersion: "semantic-discovery-1", pin: selected}});
  expect(provider).toHaveBeenCalledTimes(1);
});

test("actual Express source identifiers reach the authorized pinned host without raw handler data", async () => {
  await setup(true, await analyzedExpressSnapshot());
  const endpointId = snapshot.endpoints[0]!.endpoint_id;
  expect(snapshot.claims.some(claim => claim.predicate === "operation.summary"
    || claim.predicate === "operation.description")).toBe(false);
  const provider = vi.fn(async request => {
    expect(request).toMatchObject({promptVersion: "semantic-discovery-source-1",
      source: {pin: selected}, endpoints: [{endpointId, method: "GET", applicationPath: "/orders",
        documents: [{kind: "code_route", text: "GET /orders"},
          {kind: "code_handler", text: "readOrders"}]}]});
    expect(JSON.stringify(request)).not.toMatch(/CANARY_RAW_SOURCE|secret|credential|SYNTHETIC_MODEL_KEY/);
    const evidenceId = request.endpoints[0]!.documents[0]!.evidenceIds[0]!;
    expect(snapshot.evidence.find(evidence => evidence.evidence_id === evidenceId)).toMatchObject({
      source: {kind: "source_code", source_id: repositoryId},
      source_version: snapshot.source.immutable_revision,
      scope: {endpoint_id: endpointId, revision: snapshot.source.immutable_revision},
      access_label: scopes[3],
    });
    return {status: "suggestions", suggestions: [{endpointId,
      intent: "Find orders", summary: "Tentative identifier-based name.", evidenceIds: [evidenceId]}]};
  });
  await expect(service(provider).discover(context(), selection(), [endpointId], "Find orders"))
    .resolves.toMatchObject({status: "suggestions", verification: "inferred", review: "unreviewed",
      normative: false, provenance: {promptVersion: "semantic-discovery-source-1", pin: selected}});
  expect(provider).toHaveBeenCalledTimes(1);
  await createAccessPolicyStore(database!.pool, {schema: database!.schema})
    .putGrant({tenantId}, {principalId, scopeId: scopes[3], active: false});
  await expect(service(provider).discover(context(), selection(), [endpointId], "Find orders"))
    .rejects.toMatchObject({code: "SEMANTIC_NOT_FOUND_OR_DENIED"});
  expect(provider).toHaveBeenCalledTimes(1);
});

test("discovery rejects secret-like intent before DB access and stays disabled without egress", async () => {
  await setup(false);
  const provider = vi.fn(async () => answer());
  const semantic = service(provider);
  const connect = vi.spyOn(database!.pool, "connect");
  for (const intentQuery of ["Use Bearer CANARY_SECRET_123", "ftp://user:canary@internal.example/api"]) {
    await expect(semantic.discover(context(), selection(), ["ep-get"], intentQuery))
      .rejects.toMatchObject({code: "SEMANTIC_INVALID_REQUEST", message: "SEMANTIC_INVALID_REQUEST"});
  }
  expect(connect).not.toHaveBeenCalled();
  connect.mockRestore();
  await expect(semantic.discover(context(), selection(), ["ep-get"], "Find a stored order"))
    .resolves.toEqual({status: "disabled"});
  expect(provider).not.toHaveBeenCalled();
});

test("discovery discards a result if a grant is revoked during the provider call", async () => {
  await setup();
  const provider = vi.fn(async () => {
    await createAccessPolicyStore(database!.pool, {schema: database!.schema}).putGrant({tenantId},
      {principalId, scopeId: scopes[4], active: false});
    return answer();
  });
  await expect(service(provider).discover(context(), selection(), ["ep-get"], "Find a stored order"))
    .rejects.toMatchObject({code: "SEMANTIC_STALE_CONTEXT"});
  expect(provider).toHaveBeenCalledTimes(1);
});


test("portal and MCP discovery share actual authorized PostgreSQL selection and revoke safely", async () => {
  await setup();
  const provider = vi.fn(async () => answer());
  const semantic = service(provider);
  const query = createQueryReader(database!.pool, {schema: database!.schema});
  const portal = createPortalServer({authenticate: async () => context(), query, semantic});
  const mcp = createApiTruthMcpServer({authenticate: async () => context(), query, semantic});
  const client = new Client({name: "semantic-pg", version: "1.0"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const args = {repositoryId, serviceId, view: {kind: "environment", environment,
    expectedCheckpointVersion: selected.checkpointVersion}, endpointIds: ["ep-get"], intentQuery: "Find a stored order"};
  portal.listen(0, "127.0.0.1"); await once(portal, "listening");
  const address = portal.address(); if (!address || typeof address === "string") throw new Error("fixture port");
  const post = () => fetch(`http://127.0.0.1:${address.port}/api/discover`, {method: "POST",
    headers: {"content-type": "application/json"}, body: JSON.stringify(args)});
  try {
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    const http = await post(); expect(http.status).toBe(200);
    const httpResult = await http.json();
    const tool = await client.callTool({name: "api_truth_discover_api", arguments: args});
    expect(tool.structuredContent).toEqual({ok: true, data: httpResult});
    expect(httpResult).toMatchObject({status: "suggestions", review: "unreviewed", normative: false,
      provenance: {pin: selected}});
    expect(provider).toHaveBeenCalledTimes(2);
    await createAccessPolicyStore(database!.pool, {schema: database!.schema})
      .putGrant({tenantId}, {principalId, scopeId: scopes[4], active: false});
    expect((await post()).status).toBe(404);
    const denied = await client.callTool({name: "api_truth_discover_api", arguments: args});
    expect(denied.structuredContent).toEqual({ok: false, error: "NOT_FOUND_OR_DENIED"});
    expect(provider).toHaveBeenCalledTimes(2);
  } finally {
    await Promise.allSettled([client.close(), mcp.close()]);
    portal.closeAllConnections(); await new Promise<void>(resolve => portal.close(() => resolve()));
  }
});


test("operation candidate search reads one authorized environment pin and fails before DB for invalid requests", async () => {
  await setup();
  const query = createQueryReader(database!.pool, {schema: database!.schema});
  const connect = vi.spyOn(database!.pool, "connect");
  for (const options of [{intentQuery: "ftp://user:canary@internal.example/api"},
    {intentQuery: "Find an order", limit: 21}, {intentQuery: "Find an order", limit: null}, {intentQuery: "Find an order", tenantId: "other"}]) {
    await expect(query.readOperationCandidates(context(), selection(), options))
      .rejects.toMatchObject({code: "INVALID_QUERY_SEARCH"});
  }
  await expect(query.readOperationCandidates(context(), {...selection(), selector: {kind: "environment", environment}},
    {intentQuery: "Find an order"})).rejects.toMatchObject({code: "INVALID_QUERY_SEARCH"});
  expect(connect).not.toHaveBeenCalled(); connect.mockRestore();
  const result = await query.readOperationCandidates(context(), selection(), {intentQuery: "stored order"});
  expect(result).toMatchObject({status: "candidates", pin: selected, candidates: [
    {endpointId: "ep-get", evidenceIds: expect.arrayContaining(["ev-doc-get"])}]});
  await expect(query.readOperationCandidates(context(), {...selection(), selector: {...selection().selector,
    expectedCheckpointVersion: "999"}}, {intentQuery: "stored order"}))
    .rejects.toMatchObject({code: "QUERY_STALE_SELECTION"});
  await createAccessPolicyStore(database!.pool, {schema: database!.schema})
    .putGrant({tenantId}, {principalId, scopeId: scopes[4], active: false});
  await expect(query.readOperationCandidates(context(), selection(), {intentQuery: "stored order"}))
    .rejects.toMatchObject({code: "QUERY_NOT_FOUND_OR_DENIED"});
});
