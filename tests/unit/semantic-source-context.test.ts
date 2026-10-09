import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterEach, expect, test, vi} from "vitest";
import {ANALYZER, createAnalyzer} from "../../analyzers/routing-controllers/src/index.js";
import {ANALYZER as EXPRESS_ANALYZER, createAnalyzer as createExpressAnalyzer}
  from "../../analyzers/typescript/src/index.js";
import {contractSnapshotFromAnalyzerResult} from "../../packages/catalog/src/index.js";
import {isSemanticSourceIdentifierSafe, isSemanticSourceRouteSafe} from "../../packages/semantics/src/egress.js";
import {createSemanticProvider} from "../../connectors/semantic-providers/src/index.js";
import {runGroundedSemanticDiscovery, SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION} from "../../packages/semantics/src/index.js";
import type {AnalyzerRequest, ContractSnapshot} from "../../packages/ir/src/index.js";
import type {SemanticProviderRequest} from "../../packages/semantics/src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))));
const setupSource = async (files: Record<string, string>, express = false) => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-semantic-source-")); roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, "service", path); await mkdir(dirname(absolute), {recursive: true}); await writeFile(absolute, text);
  }
  const request: AnalyzerRequest = {exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "source-semantic",
    analyzer: express ? EXPRESS_ANALYZER : ANALYZER,
    source: {repository_id: "repo-a", service_id: "orders", service_root: "service",
      immutable_revision: "a".repeat(40), source_digest: "pending", access_label: "orders-read"},
    resolution_inputs: [{kind: "source_tree", path: "service", digest: "pending"}], prior_dependencies: [],
    changed_paths: [], extraction_mode: "baseline", limits: {timeout_ms: 30_000, max_files: 20, max_output_bytes: 1_000_000},
    execution_policy: {network_access: false, side_effects: "none"}};
  const result = await (express ? createExpressAnalyzer({projectRoot: root})
    : createAnalyzer({projectRoot: root})).analyze(request);
  const snapshot = contractSnapshotFromAnalyzerResult(result, "sha256:config-a").snapshot;
  const endpointIds = snapshot.endpoints.map(endpoint => endpoint.endpoint_id);
  return {result, snapshot, endpointIds};
};
const input = (snapshot: ContractSnapshot, endpointIds: string[]) => ({snapshot,
  pin: {snapshotId: snapshot.snapshot_id, revision: snapshot.source.immutable_revision,
    configFingerprint: snapshot.config.config_fingerprint},
  selection: {version: "1" as const, tenantId: "tenant-a", repositoryId: snapshot.service.repository_id,
    serviceId: snapshot.service.service_id, selector: {kind: "revision" as const, revision: snapshot.source.immutable_revision}},
  inference: {enabled: true as const, provider: "openai" as const, model: "synthetic-model"}, endpointIds,
  intentQuery: "Find the endpoint that lists orders"});
const answer = (endpointId: string, evidenceId: string) => ({status: "suggestions",
  suggestions: [{endpointId, intent: "List orders", summary: "Tentative name from route identifiers.", evidenceIds: [evidenceId]}]});

test("projects actual registered routing-controller declaration into only exact pinned code identifiers", async () => {
  const {snapshot} = await setupSource({
    "app.ts": `import { createExpressServer } from "routing-controllers"; import { OrdersController } from "./orders";
      import { HealthController } from "./health";
      createExpressServer({ controllers: [OrdersController, HealthController] });`,
    "orders.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/orders") export class OrdersController { @Get() listOrders(): string { return "CANARY_RAW_HANDLER"; } }`,
    "health.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/health") export class HealthController { @Get() check(): string { return "ok"; } }`,
  });
  const endpointId = snapshot.endpoints.find(endpoint => endpoint.application_path === "/orders")!.endpoint_id;
  const omittedEndpointId = snapshot.endpoints.find(endpoint => endpoint.application_path === "/health")!.endpoint_id;
  const routeClaim = snapshot.claims.find(claim => claim.subject.endpoint_id === omittedEndpointId
    && claim.predicate === "route.declaration")!;
  snapshot.claims = snapshot.claims.filter(claim => claim !== routeClaim);
  const documentEvidence = structuredClone(snapshot.evidence.find(item => item.scope.endpoint_id === endpointId)!);
  documentEvidence.evidence_id = "ev-document-summary";
  documentEvidence.source = {kind: "api_document", source_id: snapshot.source.repository_id};
  documentEvidence.method = "type_declaration";
  documentEvidence.location = {path: "openapi.yaml", pointer: "#/paths/~1orders/get/summary"};
  snapshot.evidence.push(documentEvidence);
  const duplicateSummaryEvidence = structuredClone(documentEvidence);
  duplicateSummaryEvidence.evidence_id = "ev-document-summary-duplicate";
  duplicateSummaryEvidence.location = {path: "openapi.yaml", pointer: "#/paths/~1orders/get/description"};
  snapshot.evidence.push(duplicateSummaryEvidence);
  snapshot.claims.push({claim_id: "claim-document-summary", subject: {service_id: snapshot.service.service_id,
    endpoint_id: endpointId}, predicate: "operation.summary", value: "Read an order by its identifier.",
    verification: "declared", evidence_ids: [documentEvidence.evidence_id]},
  {claim_id: "claim-document-summary-duplicate", subject: {service_id: snapshot.service.service_id,
    endpoint_id: endpointId}, predicate: "operation.summary", value: "Read an order by its identifier.",
    verification: "declared", evidence_ids: [duplicateSummaryEvidence.evidence_id]});
  const selectedIds = [endpointId, omittedEndpointId];
  const provider = vi.fn(async (request: SemanticProviderRequest) => {
    expect(request.promptVersion).toBe(SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION);
    expect(request.endpoints).toHaveLength(1);
    expect(request.endpoints[0]).toMatchObject({endpointId, method: "GET", applicationPath: "/orders",
      documents: [{kind: "operation_summary", text: "Read an order by its identifier."},
        {kind: "code_route", text: "GET /orders"}, {kind: "code_action", text: "OrdersController.listOrders"}]});
    expect(request.endpoints[0]!.documents[0]!.evidenceIds).toEqual([documentEvidence.evidence_id, duplicateSummaryEvidence.evidence_id]);
    expect(JSON.stringify(request)).not.toContain("CANARY_RAW_HANDLER");
    const evidenceId = request.endpoints[0]!.documents[0]!.evidenceIds[0]!;
    return answer(endpointId, evidenceId);
  });
  await expect(runGroundedSemanticDiscovery(input(snapshot, selectedIds), provider))
    .resolves.toMatchObject({status: "suggestions", verification: "inferred", review: "unreviewed", normative: false,
      provenance: {promptVersion: SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION}, contextCoverage: {status: "partial",
        requestedEndpointIds: selectedIds, analyzedEndpointIds: [endpointId], omittedEndpointIds: [omittedEndpointId]}});
  expect(provider).toHaveBeenCalledOnce();
});

test("projects direct Express route and handler claim identifiers without implementation source", async () => {
  const snapshot = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(
    new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8"))) as ContractSnapshot;
  const endpoint = snapshot.endpoints[0]!; const routeEv = "ev-source-route", handlerEv = "ev-source-handler";
  snapshot.evidence.push(...[routeEv, handlerEv].map(evidence_id => ({evidence_id,
    source: {kind: "source_code", source_id: snapshot.source.repository_id}, source_version: snapshot.source.immutable_revision,
    location: {path: "src/orders.ts", symbol: "readOrder"}, method: "deterministic_analysis" as const,
    scope: {service_id: snapshot.service.service_id, snapshot_id: snapshot.snapshot_id,
      endpoint_id: endpoint.endpoint_id, revision: snapshot.source.immutable_revision}, limitations: [], access_label: "orders-read"})));
  snapshot.claims.push({claim_id: "claim-source-route", subject: {service_id: snapshot.service.service_id, endpoint_id: endpoint.endpoint_id},
    predicate: "route.registration", value: {method: endpoint.identity.method, path: endpoint.application_path},
    verification: "established_by_analysis", evidence_ids: [routeEv]},
  {claim_id: "claim-source-handler", subject: {service_id: snapshot.service.service_id, endpoint_id: endpoint.endpoint_id},
    predicate: "handler.symbol", value: {symbol: "readOrder"}, verification: "established_by_analysis", evidence_ids: [handlerEv]});
  const provider = vi.fn(async (request: SemanticProviderRequest) => {
    expect(request.promptVersion).toBe(SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION);
    expect(request.endpoints[0]?.documents.map(item => item.kind)).toEqual(["code_route", "code_handler"]);
    return answer(endpoint.endpoint_id, request.endpoints[0]!.documents[0]!.evidenceIds[0]!);
  });
  await expect(runGroundedSemanticDiscovery(input(snapshot, [endpoint.endpoint_id]), provider))
    .resolves.toMatchObject({status: "suggestions"});
});

test("retains ordinary auth-related API names while rejecting credential-shaped values", async () => {
  expect(isSemanticSourceIdentifierSafe("getAccessToken")).toBe(true);
  expect(isSemanticSourceIdentifierSafe("resetPassword")).toBe(true);
  expect(isSemanticSourceRouteSafe("POST", "/auth/token")).toBe(true);
  expect(isSemanticSourceIdentifierSafe("AKIAABCDEFGHIJKLMNOP")).toBe(false);
  expect(isSemanticSourceRouteSafe("GET", "/auth/AKIAABCDEFGHIJKLMNOP")).toBe(false);
});

test("actual Express analyzer projects only pinned route and stable handler identifiers", async () => {
  const {result, snapshot, endpointIds} = await setupSource({"app.ts": `import express from "express";
    const app = express();
    function readOrders(req, res) { return res.json({secret: "CANARY_RAW_HANDLER"}); }
    function mutableHandler(req, res) { return res.json({secret: "CANARY_MUTABLE_HANDLER"}); }
    app.get("/orders", readOrders);
    app.get("/mutable", mutableHandler);
    mutableHandler = readOrders;`}, true);
  const stable = snapshot.endpoints.find(endpoint => endpoint.application_path === "/orders")!;
  const mutable = snapshot.endpoints.find(endpoint => endpoint.application_path === "/mutable")!;
  expect(result.claims.find(claim => claim.predicate === "handler.symbol"
    && claim.subject.endpoint_id === stable.endpoint_id)?.value).toEqual({symbol: "readOrders"});
  expect(result.claims.some(claim => claim.predicate === "handler.symbol"
    && claim.subject.endpoint_id === mutable.endpoint_id)).toBe(false);
  const provider = vi.fn(async (request: SemanticProviderRequest) => {
    expect(request.promptVersion).toBe(SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION);
    expect(request.endpoints).toHaveLength(2);
    const stableContext = request.endpoints.find(endpoint => endpoint.endpointId === stable.endpoint_id)!;
    const mutableContext = request.endpoints.find(endpoint => endpoint.endpointId === mutable.endpoint_id)!;
    expect(stableContext.documents.map(document => [document.kind, document.text]))
      .toEqual([["code_route", "GET /orders"], ["code_handler", "readOrders"]]);
    expect(mutableContext.documents.map(document => [document.kind, document.text]))
      .toEqual([["code_route", "GET /mutable"]]);
    expect(JSON.stringify(request)).not.toMatch(/CANARY_RAW_HANDLER|CANARY_MUTABLE_HANDLER|mutableHandler|secret/);
    for (const endpoint of request.endpoints) for (const document of endpoint.documents)
      for (const evidenceId of document.evidenceIds) {
        expect(result.evidence.find(evidence => evidence.evidence_id === evidenceId)).toMatchObject({
          source: {kind: "source_code", source_id: snapshot.source.repository_id},
          source_version: snapshot.source.immutable_revision,
          scope: {endpoint_id: endpoint.endpointId, revision: snapshot.source.immutable_revision},
        });
      }
    return answer(stable.endpoint_id, stableContext.documents[0]!.evidenceIds[0]!);
  });
  await expect(runGroundedSemanticDiscovery(input(snapshot, endpointIds), provider))
    .resolves.toMatchObject({status: "suggestions", verification: "inferred", normative: false,
      provenance: {promptVersion: SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION}});
  expect(provider).toHaveBeenCalledOnce();
});

test.each([
  ["cross-endpoint evidence", (snapshot: ContractSnapshot, endpointId: string) => {
    const other = structuredClone(snapshot.evidence.find(item => item.scope.endpoint_id === endpointId)!);
    other.evidence_id = "ev-other-endpoint"; other.scope.endpoint_id = "different-endpoint"; snapshot.evidence.push(other);
    snapshot.claims.find(item => item.predicate === "route.declaration")!.evidence_ids.push(other.evidence_id);
  }],
  ["owner-asserted route", (snapshot: ContractSnapshot) => {snapshot.claims.find(item => item.predicate === "route.declaration")!.verification = "owner_asserted";}],
  ["mismatched route", (snapshot: ContractSnapshot) => {snapshot.claims.find(item => item.predicate === "route.declaration")!.value = {method: "POST", path: "/elsewhere", controller: "Other", action: "mutate"};}],
  ["unsafe path", (snapshot: ContractSnapshot, endpointId: string) => {
    const endpoint = snapshot.endpoints.find(item => item.endpoint_id === endpointId)!; endpoint.application_path = "/auth/AKIAABCDEFGHIJKLMNOP";
    snapshot.claims.find(item => item.predicate === "route.declaration")!.value = {method: endpoint.identity.method,
      path: endpoint.application_path, controller: "OrdersController", action: "listOrders"};
  }],
] as const)("withholds %s source context before provider egress", async (name, tamper) => {
  const {snapshot, endpointIds} = await setupSource({
    "app.ts": `import { createExpressServer } from "routing-controllers"; import { OrdersController } from "./orders";
      createExpressServer({ controllers: [OrdersController] });`,
    "orders.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/orders") export class OrdersController { @Get() listOrders(): string { return "ok"; } }`,
  });
  tamper(snapshot, endpointIds[0]!);
  const provider = vi.fn(async () => answer(endpointIds[0]!, "ev-unused"));
  if (name === "cross-endpoint evidence" || name === "unsafe path") {
    await expect(runGroundedSemanticDiscovery(input(snapshot, endpointIds), provider))
      .rejects.toMatchObject({code: "SEMANTIC_INVALID_CONTEXT"});
  } else {
    await expect(runGroundedSemanticDiscovery(input(snapshot, endpointIds), provider)).resolves.toMatchObject({
      status: "no_context", contextCoverage: {status: "partial", requestedEndpointIds: endpointIds,
        analyzedEndpointIds: [], omittedEndpointIds: endpointIds}});
  }
  expect(provider).not.toHaveBeenCalled();
});

test("provider adapters accept source-context prompt only for whitelisted identifiers and instruct tentative naming", async () => {
  const request: SemanticProviderRequest = {promptVersion: SEMANTIC_DISCOVERY_SOURCE_PROMPT_VERSION,
    intentQuery: "Find a list endpoint", provider: "openai", model: "model-test",
    source: {repositoryId: "repo-a", serviceId: "orders", selector: {kind: "revision", revision: "rev-a"},
      pin: {snapshotId: "snap-a", revision: "rev-a", configFingerprint: "cfg-a"}},
    endpoints: [{endpointId: "ep-orders", method: "GET", applicationPath: "/orders", documents: [
      {kind: "operation_summary", text: "Read an order.", evidenceIds: ["ev-summary"]},
      {kind: "code_route", text: "GET /orders", evidenceIds: ["ev-route"]},
      {kind: "code_action", text: "OrdersController.listOrders", evidenceIds: ["ev-action"]}]}]};
  const response = new Response(JSON.stringify({status: "completed", output: [{type: "message", role: "assistant",
    status: "completed", content: [{type: "output_text", text: JSON.stringify({result: answer("ep-orders", "ev-route")})}]}]}),
    {status: 200, headers: {"content-type": "application/json"}});
  let sentBody = "";
  const fetch: typeof globalThis.fetch = async (_url, init) => {sentBody = String(init?.body); return response.clone();};
  const port = createSemanticProvider("openai", {resolveApiKey: () => "key", fetch});
  await port(request);
  const body = JSON.parse(sentBody);
  expect(body.input[0].content[0].text).toContain("source identifiers");
  expect(body.input[0].content[0].text).toContain("tentative naming");
  expect(body.input[0].content[0].text).toContain("business workflow guarantees");
  expect(body.input[0].content[0].text).toContain("document declarations");
  const invalid = structuredClone(request);
  (invalid.endpoints[0]!.documents[0]! as {text: string}).text = "GET /api/AKIAABCDEFGHIJKLMNOP";
  await expect(port(invalid)).rejects.toMatchObject({code: "SEMANTIC_PROVIDER_INVALID_REQUEST"});
});
