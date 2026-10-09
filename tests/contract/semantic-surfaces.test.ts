import { once } from "node:events";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createApiTruthMcpServer } from "../../apps/mcp/src/server.js";
import { createPortalServer, type PortalOptions } from "../../apps/portal/src/server.js";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import type { QueryReader, QuerySelection } from "../../packages/query/src/index.js";
import type { SemanticAnalysisResult } from "../../packages/semantics/src/types.js";

const principal = Object.freeze({tenantId: "tenant-a", principalId: "reader-a"});
const pin = Object.freeze({snapshotId: "snapshot-a", revision: "rev-a", configFingerprint: "config-a", checkpointVersion: "7"});
const publication = Object.freeze({status: "absent" as const});
const selected: QuerySelection = Object.freeze({version: "1", tenantId: principal.tenantId,
  repositoryId: "commerce", serviceId: "orders", selector: {kind: "environment" as const, environment: "uat", expectedCheckpointVersion: "7"}});
const fixture = async (): Promise<ContractSnapshot> => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
  snapshot.snapshot_id = pin.snapshotId; snapshot.source.immutable_revision = pin.revision;
  snapshot.config.config_fingerprint = pin.configFingerprint;
  snapshot.endpoints = [snapshot.endpoints[0]!]; return snapshot;
};
const suggestion = {status: "suggestions", suggestions: [{endpointId: "ep-get", intent: "List orders",
  summary: "Returns orders", evidenceIds: ["evidence-1"]}], verification: "inferred", review: "unreviewed", normative: false,
  provenance: {provider: "openai", model: "test-model", promptVersion: "semantic-discovery-1",
    selector: selected.selector, pin}} satisfies SemanticAnalysisResult;
const strictView = {kind: "environment", environment: "uat", expectedCheckpointVersion: "7"};
const payload = (extras: Record<string, unknown> = {}) => ({repositoryId: "commerce", serviceId: "orders",
  view: strictView, endpointIds: ["ep-get"], intentQuery: "Find orders", ...extras});

const opened: Array<{client: Client; server: ReturnType<typeof createApiTruthMcpServer>}> = [];
afterEach(async () => Promise.allSettled(opened.splice(0).flatMap(({client, server}) => [client.close(), server.close()])));

describe("optional semantic discovery surfaces", () => {
  test("MCP advertises discovery only when enabled and invokes it with authenticated identity and explicit pin", async () => {
    const query = {readContract: vi.fn(), readEndpoint: vi.fn(), readSchema: vi.fn(), compareContracts: vi.fn(),
      searchServices: vi.fn(), readPublication: vi.fn() } as unknown as QueryReader;
    const discover = vi.fn(async (): Promise<SemanticAnalysisResult> => suggestion);
    const server = createApiTruthMcpServer({query, authenticate: async () => principal, semantic: {discover}});
    const client = new Client({name: "surface-test", version: "1.0"});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport); opened.push({client, server});
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain("api_truth_discover_api");
    const tool = tools.tools.find(item => item.name === "api_truth_discover_api")!;
    expect(tool.annotations).toMatchObject({readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false});
    expect(tool.description).toContain("host-configured inference provider");
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/tenantId|principalId/);
    const result = await client.callTool({name: "api_truth_discover_api", arguments: payload()});
    expect(result.structuredContent).toMatchObject({ok: true, data: {status: "suggestions", review: "unreviewed", normative: false}});
    vi.mocked(discover).mockRejectedValueOnce(Object.assign(new Error("provider secret"), {code: "SEMANTIC_STALE_CONTEXT"}));
    const stale = await client.callTool({name: "api_truth_discover_api", arguments: payload()});
    expect(stale.structuredContent).toEqual({ok: false, error: "STALE_SELECTION"});
    expect(JSON.stringify(stale)).not.toContain("provider secret");
    expect(discover).toHaveBeenCalledWith(principal, selected, ["ep-get"], "Find orders");
  });

  test("MCP rejects missing pins, excess endpoints and forged identity before semantic calls", async () => {
    const query = {readContract: vi.fn(), readEndpoint: vi.fn(), readSchema: vi.fn(), compareContracts: vi.fn(),
      searchServices: vi.fn(), readPublication: vi.fn() } as unknown as QueryReader;
    const discover = vi.fn(async (): Promise<SemanticAnalysisResult> => suggestion);
    const server = createApiTruthMcpServer({query, authenticate: async () => principal, semantic: {discover}});
    const client = new Client({name: "surface-test", version: "1.0"});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport); opened.push({client, server});
    for (const args of [payload({view: {kind: "environment", environment: "uat"}}),
      payload({endpointIds: Array.from({length: 17}, (_, i) => `e-${i}`)}),
      payload({tenantId: "tenant-other"})]) {
      const result = await client.callTool({name: "api_truth_discover_api", arguments: args});
      expect(result.isError).toBe(true);
    }
    expect(discover).not.toHaveBeenCalled();
  });

  test("portal discovery uses authenticated principal, proves the selected pin and rejects unsafe request shapes", async () => {
    const snapshot = await fixture(); const contractCalls: unknown[] = [];
    const query: PortalOptions["query"] = {
      searchServices: async () => ({services: [], truncated: false}),
      readContract: async (context, selection) => { contractCalls.push([context, selection]);
        return {status: "resolved", selector: selection as QuerySelection, pin, publication, snapshot}; },
      compareContracts: async () => ({status: "unavailable", beforeStatus: "unknown", afterStatus: "unknown"}),
      readPublication: async () => {throw new Error("unused");},
    };
    const discover = vi.fn(async (): Promise<SemanticAnalysisResult> => suggestion);
    const server = createPortalServer({authenticate: async request => request.headers.authorization === "Bearer test" ? principal : undefined,
      query, semantic: {discover}});
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (body: string, type = "application/json") => fetch(`${base}/api/discover`, {method: "POST",
      headers: {authorization: "Bearer test", "content-type": type}, body});
    try {
      const good = await post(JSON.stringify(payload()));
      expect(good.status, await good.clone().text()).toBe(200);
      expect(await good.json()).toMatchObject({status: "suggestions", review: "unreviewed", normative: false});
      expect(discover).toHaveBeenCalledWith(principal, selected, ["ep-get"], "Find orders");
      expect(contractCalls[0]).toEqual([principal, selected]);
      const anonymous = await fetch(`${base}/api/discover`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(payload())});
      expect(anonymous.status).toBe(401);
      const badRequests = [
        post('{"repositoryId":"commerce","repositoryId":"other","serviceId":"orders","view":{"kind":"environment","environment":"uat","expectedCheckpointVersion":"7"},"endpointIds":["ep-get"],"intentQuery":"x"}'),
        post(JSON.stringify(payload({tenantId: "tenant-other"}))),
        post(JSON.stringify(payload({repositoryId: {toString: "commerce"}}))),
        post(JSON.stringify(payload({extra: true}))),
        post(JSON.stringify(payload({view: {kind: "branch", branch: "main"}}))),
        post(JSON.stringify(payload({endpointIds: Array.from({length: 17}, (_, i) => `endpoint-${i}`)}))),
        post(JSON.stringify(payload({endpointIds: ["ep-get", "ep-get"]}))),
        post(JSON.stringify(payload({intentQuery: "x".repeat(513)}))),
        post("{" + "\"x\":".repeat(12) + "0" + "}"),
        post("x".repeat(8193)),
        post("{}", "text/plain"),
        fetch(`${base}/api/discover?intentQuery=private`, {headers: {authorization: "Bearer test"}}),
      ];
      const responses = await Promise.all(badRequests);
      expect(responses.every(response => response.status >= 400)).toBe(true);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(contractCalls).toHaveLength(1);
      vi.mocked(discover).mockResolvedValueOnce({...suggestion, provenance: {...suggestion.provenance,
        pin: {...pin, revision: "different-revision"}}});
      const stale = await post(JSON.stringify(payload()));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({error: "STALE_SELECTION"});
      expect(discover).toHaveBeenCalledTimes(2);
      vi.mocked(discover).mockRejectedValueOnce(Object.assign(new Error("secret storage details"), {code: "SEMANTIC_STORAGE_ERROR"}));
      const unavailable = await post(JSON.stringify(payload()));
      expect(unavailable.status).toBe(503);
      const unavailableBody = await unavailable.json();
      expect(unavailableBody).toEqual({error: "SEMANTIC_UNAVAILABLE"});
      expect(JSON.stringify(unavailableBody)).not.toContain("secret storage details");
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });

  test("portal hides the discovery endpoint unless the host explicitly enables it", async () => {
    const query: PortalOptions["query"] = {searchServices: async () => ({services: [], truncated: false}),
      readContract: async (_context, selection) => ({status: "unknown", selector: selection as QuerySelection}),
      compareContracts: async () => ({status: "unavailable", beforeStatus: "unknown", afterStatus: "unknown"}),
      readPublication: async () => {throw new Error("unused");}};
    const server = createPortalServer({authenticate: async () => principal, query});
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw Error("no port");
    try {
      const base = `http://127.0.0.1:${address.port}`;
      const page = await fetch(base); expect(await page.text()).toContain('id="discovery" hidden');
      const script = await fetch(`${base}/app.js`); expect(await script.text()).toContain("semanticEnabled=false");
      const response = await fetch(`${base}/api/discover`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
      expect(response.status).toBe(404);
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
});


test("portal closes oversized and timed-out discovery request sockets after fixed responses", async () => {
  const query: PortalOptions["query"] = {searchServices: async () => ({services: [], truncated: false}),
    readContract: async (_context, selection) => ({status: "unknown", selector: selection as QuerySelection}),
    compareContracts: async () => ({status: "unavailable", beforeStatus: "unknown", afterStatus: "unknown"}),
    readPublication: async () => {throw new Error("unused");}};
  const server = createPortalServer({authenticate: async () => principal, query,
    semantic: {discover: async () => suggestion}});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no port");
  const exchange = (body: string, contentLength: number) => new Promise<string>((resolve, reject) => {
    const socket = createConnection(address.port, "127.0.0.1"); let response = "";
    socket.setTimeout(5_000, () => {socket.destroy(new Error("socket did not close"));});
    socket.on("connect", () => socket.write(`POST /api/discover HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\nConnection: keep-alive\r\n\r\n${body}`));
    socket.on("data", chunk => {response += chunk.toString("utf8");});
    socket.on("error", error => {if (error.message === "socket did not close") reject(error);});
    socket.on("close", () => resolve(response));
  });
  try {
    const oversized = await exchange("x".repeat(8193), 8193);
    expect(oversized).toContain("HTTP/1.1 400");
    expect(oversized.toLowerCase()).toContain("connection: close");
    const timeout = await exchange("{", 100);
    expect(timeout).toContain("HTTP/1.1 408");
    expect(timeout.toLowerCase()).toContain("connection: close");
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
}, 8_000);
