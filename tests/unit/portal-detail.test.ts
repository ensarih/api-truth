import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import type { QueryReader } from "../../packages/query/src/index.js";
import { createPortalServer } from "../../apps/portal/src/server.js";

const publicationId = `sha256:${"a".repeat(64)}`;
const auth = { authorization: "Bearer fixture" };
const selected = { version: "1" as const, tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders",
  selector: { kind: "environment" as const, environment: "uat" } };
const snapshot = async () => JSON.parse(await readFile("tests/fixtures/ir/express-snapshot.json", "utf8")) as ContractSnapshot;
const serve = async (query: Pick<QueryReader, "searchServices" | "readContract" | "compareContracts" | "readPublication">,
  run: (base: string) => Promise<void>) => {
  const server = createPortalServer({
    authenticate: async (request) => request.headers.authorization === "Bearer fixture"
      ? { tenantId: "tenant-a", principalId: "reader" } : undefined,
    query,
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    await run(`http://127.0.0.1:${address.port}`);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
};
const queryStub = (overrides: Partial<QueryReader> = {}) => ({
  searchServices: async () => ({ services: [], truncated: false as const }),
  readContract: async () => ({ status: "unknown" as const, selector: selected }),
  compareContracts: async () => ({ status: "unavailable" as const,
    beforeStatus: "unknown" as const, afterStatus: "unknown" as const }),
  readPublication: async () => { throw Object.assign(new Error("missing"), { code: "QUERY_NOT_FOUND_OR_DENIED" }); },
  ...overrides,
}) as Pick<QueryReader, "searchServices" | "readContract" | "compareContracts" | "readPublication">;
const selectionParams = "repositoryId=commerce&serviceId=orders&kind=environment&value=uat";

test("contract selection is explicit and unknown states expose no endpoint data", async () => {
  const calls: unknown[] = [];
  await serve(queryStub({ readContract: async (context, selection) => {
    calls.push({ context, selection });
    return { status: "transitional", selector: selected };
  } }), async (base) => {
    expect((await fetch(`${base}/api/contract?${selectionParams}`)).status).toBe(401);
    expect((await fetch(`${base}/api/contract?repositoryId=commerce&serviceId=orders`,
      { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/contract?${selectionParams}&tenantId=other`,
      { headers: auth })).status).toBe(400);
    const response = await fetch(`${base}/api/contract?${selectionParams}`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "transitional", selector: selected });
    expect(calls).toEqual([{ context: { tenantId: "tenant-a", principalId: "reader" }, selection: selected }]);
  });
});

test("contract, endpoint, schema, and evidence routes use the same authorized snapshot", async () => {
  const contract = await snapshot();
  const calls: unknown[] = [];
  const query = queryStub({ readContract: async (context, selector) => {
    calls.push({ context, selector });
    return { status: "resolved", selector: selected,
      pin: { snapshotId: contract.snapshot_id, revision: contract.source.immutable_revision,
        configFingerprint: contract.config.config_fingerprint, checkpointVersion: "7" },
      snapshot: contract, publication: { status: "absent" } };
  } });
  await serve(query, async (base) => {
    const summary = await fetch(`${base}/api/contract?${selectionParams}`, { headers: auth });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ status: "resolved", pin: { snapshotId: contract.snapshot_id },
      coverage: contract.coverage, publication: { status: "absent" },
      endpoints: expect.arrayContaining([{ endpointId: "ep-get", method: "GET", path: "/api/orders/:orderId" }]),
      schemas: expect.arrayContaining(["CreateOrder"]), evidence: expect.arrayContaining(["ev-type"]) });
    const endpoint = await fetch(`${base}/api/endpoint?${selectionParams}&endpointId=ep-get`, { headers: auth });
    expect(endpoint.status).toBe(200);
    expect(await endpoint.json()).toMatchObject({ endpoint: { endpoint_id: "ep-get" } });
    const schema = await fetch(`${base}/api/schema?${selectionParams}&schemaId=CreateOrder`, { headers: auth });
    expect(schema.status).toBe(200);
    expect(await schema.json()).toMatchObject({ schema: { schema_id: "CreateOrder" }, evidence: expect.arrayContaining([expect.objectContaining({ evidence_id: "ev-type" })]) });
    const evidence = await fetch(`${base}/api/evidence?${selectionParams}&evidenceId=ev-type`, { headers: auth });
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({ evidence: { evidence_id: "ev-type" } });
    expect(calls).toHaveLength(4);
    expect((await fetch(`${base}/api/endpoint?${selectionParams}&endpointId=missing`,
      { headers: auth })).status).toBe(404);
  });
});

test("comparison uses explicit selectors and immutable publication download checks service scope", async () => {
  const comparisons: unknown[] = [];
  const reads: unknown[] = [];
  const query = queryStub({
    compareContracts: async (context, before, after) => {
      comparisons.push({ context, before, after });
      return { status: "unavailable", beforeStatus: "unknown", afterStatus: "transitional" };
    },
    readPublication: async (context, key) => {
      reads.push({ context, key });
      return { publicationId, contentSha256: publicationId, bytes: new TextEncoder().encode('{"openapi":"3.1.0"}'),
        selector: { kind: "revision", repositoryId: "commerce", serviceId: "orders",
          snapshotId: "snapshot-a", revision: "a".repeat(40), configFingerprint: "config-a" },
        pin: { snapshotId: "snapshot-a", revision: "a".repeat(40), configFingerprint: "config-a" } };
    },
  });
  await serve(query, async (base) => {
    const comparison = await fetch(`${base}/api/compare?repositoryId=commerce&serviceId=orders&fromKind=environment&fromValue=uat&toKind=environment&toValue=production`, { headers: auth });
    expect(comparison.status).toBe(200);
    expect(await comparison.json()).toEqual({ status: "unavailable", beforeStatus: "unknown", afterStatus: "transitional" });
    expect(comparisons).toEqual([{ context: { tenantId: "tenant-a", principalId: "reader" },
      before: selected, after: { ...selected, selector: { kind: "environment", environment: "production" } } }]);
    const download = await fetch(`${base}/api/openapi/${publicationId}?repositoryId=commerce&serviceId=orders`, { headers: auth });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(await download.text()).toBe('{"openapi":"3.1.0"}');
    expect(reads).toEqual([{ context: { tenantId: "tenant-a", principalId: "reader" },
      key: { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", publicationId } }]);
    expect((await fetch(`${base}/api/openapi/${publicationId}?repositoryId=commerce&serviceId=orders&tenantId=other`,
      { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/openapi/${publicationId}?repositoryId=other&serviceId=orders`,
      { headers: auth })).status).toBe(404);
  });
});

test("the authenticated page serves a syntactically valid client script", async () => {
  await serve(queryStub(), async (base) => {
    expect((await fetch(`${base}/app.js`)).status).toBe(401);
    const response = await fetch(`${base}/app.js`, { headers: auth });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const script = await response.text();
    expect(() => new Function(script)).not.toThrow();
  });
});

test("portal maps query errors to safe HTTP responses", async () => {
  const query = queryStub({ readContract: async () => { throw Object.assign(new Error("private-db-marker"),
    { code: "QUERY_NOT_FOUND_OR_DENIED" }); } });
  await serve(query, async (base) => {
    const response = await fetch(`${base}/api/contract?${selectionParams}`, { headers: auth });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"NOT_FOUND"}');
  });
});
