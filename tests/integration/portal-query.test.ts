import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../packages/catalog/src/canonical.js";
import { applyOrchestrationMigrations } from "../../packages/orchestration/src/migrations.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { createQueryReader } from "../../packages/query/src/index.js";
import { createPortalServer } from "../../apps/portal/src/server.js";
import { createApiTruthMcpServer } from "../../apps/mcp/src/server.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase } from "./support/database.js";

const context = { tenantId: "tenant-portal-query", principalId: "reader" };
const auth = { authorization: "Bearer fixture" };
let database: CatalogTestDatabase;
let snapshot: ContractSnapshot;

beforeEach(async () => {
  database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  await applyOpenApiMigrations(database.pool, { schema: database.schema });
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active)
    VALUES ($1,'read',true)`, [context.tenantId]);
  await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants
    (tenant_id,principal_id,access_scope_id,active) VALUES ($1,$2,'read',true)`,
  [context.tenantId, context.principalId]);
  snapshot = JSON.parse(await readFile("tests/fixtures/ir/express-snapshot.json", "utf8")) as ContractSnapshot;
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
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-proof",
    method: "deterministic_analysis", limitations: [],
    scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0]!.evidence_ids = ["ev-proof"];
  snapshot.endpoints[0]!.parameters[0]!.presence.evidence_ids = ["ev-proof"];
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-anonymous",
    method: "deterministic_analysis", limitations: [] });
  snapshot.endpoints[0]!.security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
     identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES ($1,$2,$3,$4,$5,'success',$6,$7,$8,$9,$10,$11,$12::jsonb)`, [context.tenantId,
    snapshot.snapshot_id,snapshot.service.repository_id,snapshot.service.service_id,
    snapshot.source.immutable_revision,snapshot.ir_version,snapshot.identity_version,
    snapshot.config.config_fingerprint,snapshotIdentitySha256(snapshot),snapshotContentSha256(snapshot),
    ["read"],JSON.stringify(snapshot)]);
});
afterEach(async () => { await database.cleanup(); });

test("portal HTTP contract and download agree on one published revision and recheck access", async () => {
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const publicationStore = createOpenApiPublicationStore(database.pool, { schema: database.schema });
  const mcp = createApiTruthMcpServer({ query: reader, authenticate: async () => context });
  const client = new Client({ name: "api-truth-cross-surface-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const server = createPortalServer({
    authenticate: async (request) => request.headers.authorization === "Bearer fixture" ? context : undefined,
    query: reader,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  const base = `http://127.0.0.1:${address.port}`;
  const selection = "repositoryId=commerce&serviceId=orders&kind=revision&value=rev-b";
  try {
    const prior = await fetch(`${base}/api/contract?${selection}`, { headers: auth });
    expect(await prior.json()).toMatchObject({ status: "resolved", publication: { status: "absent" } });

    const prepared = await publicationStore.prepareRevision(context, { kind: "revision",
      repositoryId: "commerce", serviceId: "orders", snapshotId: snapshot.snapshot_id,
      revision: "rev-b", configFingerprint: snapshot.config.config_fingerprint });
    const published = await publicationStore.publish(context, prepared, { state: "absent" });
    const selected = await fetch(`${base}/api/contract?${selection}`, { headers: auth });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ status: "resolved",
      pin: { snapshotId: snapshot.snapshot_id, revision: "rev-b" },
      publication: { status: "current", publicationId: published.publicationId } });
    const mcpResult = await client.callTool({ name: "api_truth_get_contract", arguments: {
      repositoryId: "commerce", serviceId: "orders", view: { kind: "revision", revision: "rev-b" },
    } });
    expect(mcpResult).toMatchObject({ structuredContent: { ok: true, data: { status: "resolved",
      pin: { snapshotId: snapshot.snapshot_id, revision: "rev-b" },
      publication: { status: "current", publicationId: published.publicationId } } } });
    const exported = await reader.readPublication(context, { tenantId: context.tenantId,
      repositoryId: "commerce", serviceId: "orders", publicationId: published.publicationId });
    expect(exported.bytes).toEqual(published.bytes);
    const downloadUrl = `${base}/api/openapi/${published.publicationId}?repositoryId=commerce&serviceId=orders`;
    const download = await fetch(downloadUrl, { headers: auth });
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(published.bytes);
    expect((await fetch(`${base}/api/openapi/${published.publicationId}?repositoryId=other&serviceId=orders`,
      { headers: auth })).status).toBe(404);

    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
      WHERE tenant_id=$1 AND principal_id=$2`, [context.tenantId, context.principalId]);
    expect((await fetch(`${base}/api/contract?${selection}`, { headers: auth })).status).toBe(404);
    expect((await fetch(downloadUrl, { headers: auth })).status).toBe(404);
    expect(await client.callTool({ name: "api_truth_get_contract", arguments: {
      repositoryId: "commerce", serviceId: "orders", view: { kind: "revision", revision: "rev-b" },
    } })).toMatchObject({ isError: true, structuredContent: { ok: false, error: "NOT_FOUND_OR_DENIED" } });
    await expect(reader.readPublication(context, { tenantId: context.tenantId,
      repositoryId: "commerce", serviceId: "orders", publicationId: published.publicationId }))
      .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
  } finally {
    await Promise.allSettled([client.close(), mcp.close()]);
    server.closeAllConnections(); server.close(); await once(server, "close");
  }
});
