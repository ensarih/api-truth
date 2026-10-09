import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {afterEach, expect, test, vi} from "vitest";
import {Client, InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import {createPortalServer} from "../../apps/portal/src/server.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {QueryReader, QueryOperationReader, QuerySelection, OperationSearchResult} from "../../packages/query/src/index.js";

const principal = {tenantId: "tenant-a", principalId: "reader-a"};
const pin = {snapshotId: "snapshot-a", revision: "rev-a", configFingerprint: "config-a",
  checkpointVersion: "7"};
const selected: QuerySelection = {version: "1", tenantId: principal.tenantId,
  repositoryId: "commerce", serviceId: "orders", selector: {kind: "environment",
    environment: "uat", expectedCheckpointVersion: "7"}};
const result: OperationSearchResult = {status: "candidates", matchMode: "keyword", selector: selected, pin,
  candidates: [{endpointId: "ep-get", method: "GET", path: "/orders", label: "Find orders",
    evidenceIds: ["ev-route"], score: 3}], truncated: false, complete: false};
const query = () => {
  const readOperationCandidates = vi.fn(async (_context: unknown, _selection: unknown,
    _options: unknown): Promise<OperationSearchResult> => result);
  return {searchServices: vi.fn(async () => ({services: [], truncated: false})),
  readContract: vi.fn(async (_context: unknown, selection: unknown) => {
    const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
    return {status: "resolved" as const, selector: selection as QuerySelection, pin, snapshot,
      publication: {status: "absent" as const}};
  }),
  readEndpoint: vi.fn(), readSchema: vi.fn(), compareContracts: vi.fn(),
  readPublication: vi.fn(), readOperationCandidates} as unknown as QueryReader & QueryOperationReader
    & {readOperationCandidates: typeof readOperationCandidates};
};

const opened: Array<{client: Client; server: ReturnType<typeof createApiTruthMcpServer>}> = [];
afterEach(async () => {await Promise.allSettled(opened.splice(0).flatMap(({client, server}) => [client.close(), server.close()]));});

test("MCP conditionally exposes a closed-world, authenticated, pinned keyword candidate tool", async () => {
  const reader = query();
  const server = createApiTruthMcpServer({query: reader, authenticate: async () => principal});
  const client = new Client({name: "candidate-contract", version: "1"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport); opened.push({client, server});
  const tools = await client.listTools();
  const tool = tools.tools.find(item => item.name === "api_truth_search_api_candidates")!;
  expect(tool.annotations).toMatchObject({readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: false});
  expect(JSON.stringify(tool.inputSchema)).not.toMatch(/tenantId|principalId/);
  const args = {repositoryId: "commerce", serviceId: "orders", view: {kind: "environment",
    environment: "uat", expectedCheckpointVersion: "7"}, intentQuery: "Find orders", maxResults: 4};
  const found = await client.callTool({name: tool.name, arguments: args});
  expect(found.structuredContent).toEqual({ok: true, data: result});
  expect(reader.readOperationCandidates).toHaveBeenCalledWith(principal, selected,
    {intentQuery: "Find orders", limit: 4});
  for (const bad of [{...args, tenantId: "other"}, {...args, view: {kind: "environment", environment: "uat"}},
    {...args, maxResults: 21}, {...args, intentQuery: "x".repeat(513)}]) {
    expect((await client.callTool({name: tool.name, arguments: bad})).isError).toBe(true);
  }
  expect(reader.readOperationCandidates).toHaveBeenCalledTimes(1);
  vi.mocked(reader.readOperationCandidates).mockRejectedValueOnce(Object.assign(new Error("CANARY_PRIVATE_QUERY"),
    {code: "INVALID_QUERY_SEARCH"}));
  const privateQuery = await client.callTool({name: tool.name, arguments: {...args, intentQuery: "Bearer CANARY_PRIVATE_QUERY"}});
  expect(privateQuery.structuredContent).toEqual({ok: false, error: "INVALID_REQUEST"});
  expect(JSON.stringify(privateQuery)).not.toContain("CANARY_PRIVATE_QUERY");
  const absent = createApiTruthMcpServer({query: {...reader, readOperationCandidates: undefined} as unknown as QueryReader,
    authenticate: async () => principal});
  const absentClient = new Client({name: "candidate-absent", version: "1"});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await absent.connect(b); await absentClient.connect(a); opened.push({client: absentClient, server: absent});
  expect((await absentClient.listTools()).tools.some(item => item.name === tool.name)).toBe(false);
});

test("portal candidate POST is strict, private, pinned and optional", async () => {
  const reader = query();
  const portal = createPortalServer({query: reader,
    authenticate: async request => request.headers.authorization === "Bearer test" ? principal : undefined});
  portal.listen(0, "127.0.0.1"); await once(portal, "listening");
  const address = portal.address(); if (!address || typeof address === "string") throw new Error();
  const base = `http://127.0.0.1:${address.port}`;
  const body = {repositoryId: "commerce", serviceId: "orders", view: {kind: "environment",
    environment: "uat", expectedCheckpointVersion: "7"}, intentQuery: "Find orders", limit: 4};
  const post = (input: string) => fetch(`${base}/api/candidates`, {method: "POST",
    headers: {authorization: "Bearer test", "content-type": "application/json"}, body: input});
  try {
    const found = await post(JSON.stringify(body));
    expect(found.status).toBe(200); expect(await found.json()).toEqual(result);
    expect(reader.readOperationCandidates).toHaveBeenCalledWith(principal, selected,
      {intentQuery: "Find orders", limit: 4});
    expect((await fetch(`${base}/api/candidates?intentQuery=private`, {headers: {authorization: "Bearer test"}})).status)
      .toBeGreaterThanOrEqual(400);
    for (const invalid of [{...body, tenantId: "other"}, {...body, view: {kind: "environment", environment: "uat"}},
      {...body, limit: 21}, {...body, intentQuery: "x".repeat(513)}])
      expect((await post(JSON.stringify(invalid))).status).toBe(400);
    expect((await post('{' + '"intentQuery":"x","intentQuery":"y",' +
      '"repositoryId":"commerce","serviceId":"orders","view":{"kind":"environment","environment":"uat","expectedCheckpointVersion":"7"}}')).status).toBe(400);
    const oversized = await post("x".repeat(8193));
    expect(oversized.status).toBe(400);
    expect(oversized.headers.get("connection")).toBe("close");
    expect(reader.readOperationCandidates).toHaveBeenCalledTimes(1);
    vi.mocked(reader.readOperationCandidates).mockResolvedValueOnce({status: "candidates", matchMode: "keyword", selector: selected,
      pin: {...pin, revision: "other"}, candidates: [], truncated: false, complete: false});
    expect((await post(JSON.stringify(body))).status).toBe(409);
    vi.mocked(reader.readOperationCandidates).mockResolvedValueOnce({status: "unknown", reason: "incomplete_snapshot",
      selector: selected, pin: {...pin, revision: "other"}});
    expect((await post(JSON.stringify(body))).status).toBe(409);
    vi.mocked(reader.readOperationCandidates).mockResolvedValueOnce({status: "no_match", matchMode: "keyword",
      scope: "selected_contract", selector: {...selected, selector: {kind: "environment", environment: "other",
        expectedCheckpointVersion: "7"}}, pin, truncated: false});
    expect((await post(JSON.stringify(body))).status).toBe(409);
  } finally {portal.closeAllConnections(); portal.close(); await once(portal, "close");}
});

test("portal leaves candidate search unavailable when host omits the reader", async () => {
  const reader = query();
  const {readOperationCandidates: _unused, ...withoutCandidates} = reader;
  const portal = createPortalServer({query: withoutCandidates,
    authenticate: async () => principal});
  portal.listen(0, "127.0.0.1"); await once(portal, "listening");
  const address = portal.address(); if (!address || typeof address === "string") throw new Error();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const script = await fetch(`${base}/app.js`);
    expect(await script.text()).toContain("candidateEnabled=false");
    const response = await fetch(`${base}/api/candidates`, {method: "POST",
      headers: {"content-type": "application/json"}, body: "{}"});
    expect(response.status).toBe(404);
    expect(reader.readOperationCandidates).not.toHaveBeenCalled();
  } finally {portal.closeAllConnections(); portal.close(); await once(portal, "close");}
});
