import {afterEach, expect, test, vi} from "vitest";
import {Client, InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import type {ApiTruthMcpOptions} from "../../apps/mcp/src/server.js";
import type {createSemanticService} from "../../packages/semantics/src/service.js";

const principal = {tenantId: "tenant-a", principalId: "reader-a"};
const selection = {version: "1", tenantId: principal.tenantId, repositoryId: "commerce", serviceId: "orders",
  selector: {kind: "environment", environment: "uat", expectedCheckpointVersion: "7"}};
const base = {repositoryId: selection.repositoryId, serviceId: selection.serviceId,
  view: selection.selector, endpointIds: ["ep-get"]};
const tools = ["api_truth_get_semantic_history", "api_truth_get_semantic_history_reviews",
  "api_truth_record_semantic_history_review"] as const;
const methods = ["readHistory", "readHistoryReviews", "recordHistoryReview"] as const;
const inputs = [{...base, limit: 20}, {...base, historyId: "1", limit: 20},
  {...base, historyId: "1", decision: "acknowledged", expectedVersion: "0"}];
type History = Pick<ReturnType<typeof createSemanticService>, typeof methods[number]>;
const envelope = {status: "resolved", records: [], truncated: false, verification: "inferred", normative: false};
const opened: Array<{client: Client; server: ReturnType<typeof createApiTruthMcpServer>}> = [];
afterEach(async () => {await Promise.allSettled(opened.splice(0).flatMap(({client, server}) => [client.close(), server.close()]));});

const open = async (options: {enabled?: boolean; capability?: typeof methods[number];
  operation?: (...args: unknown[]) => Promise<unknown>; authenticate?: ApiTruthMcpOptions["authenticate"];
  maxOutputBytes?: number; discoveryOnly?: boolean} = {}) => {
  const calls = Object.fromEntries(methods.map(method => [method, vi.fn(options.operation ?? (async () => envelope))]));
  const history = options.capability ? {[options.capability]: calls[options.capability]} : calls;
  const authenticate = vi.fn(options.authenticate ?? (async () => principal));
  const query = Object.fromEntries(["searchServices", "readContract", "readEndpoint", "readSchema", "compareContracts"]
    .map(method => [method, vi.fn()])) as unknown as ApiTruthMcpOptions["query"];
  const server = createApiTruthMcpServer({query, authenticate,
    ...(options.enabled === false ? {} : {semanticHistory: history as unknown as History}),
    ...(options.discoveryOnly ? {semantic: {discover: vi.fn()} as never} : {}),
    ...(options.maxOutputBytes === undefined ? {} : {maxOutputBytes: options.maxOutputBytes})});
  const client = new Client({name: "semantic-history-test", version: "1.0.0"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport); opened.push({client, server});
  return {client, calls, authenticate};
};

test("history and review tools require a separate explicit host capability", async () => {
  for (const discoveryOnly of [false, true]) {
    const {client} = await open({enabled: false, discoveryOnly});
    expect((await client.listTools()).tools.filter(tool => tools.includes(tool.name as typeof tools[number]))).toEqual([]);
  }
  for (const [index, capability] of methods.entries()) {
    const {client} = await open({capability});
    expect((await client.listTools()).tools.filter(tool => tools.includes(tool.name as typeof tools[number]))
      .map(tool => tool.name)).toEqual([tools[index]]);
  }
});

test("advertises strict bounded private metadata inputs and accurate write annotations", async () => {
  const {client} = await open();
  const advertised = (await client.listTools()).tools;
  for (const [index, name] of tools.entries()) {
    const tool = advertised.find(tool => tool.name === name)!;
    expect(tool.inputSchema).toMatchObject({additionalProperties: false});
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/tenantId|principalId|credential|capabilities|accessScope/);
    expect(tool.annotations).toMatchObject({readOnlyHint: index !== 2, destructiveHint: false,
      idempotentHint: true, openWorldHint: false});
    expect(tool.description).toMatch(/private.*same-principal/i);
    expect(tool.description).toMatch(/inferred.*non-normative/i);
    expect(tool.description).toMatch(/no.*model/i);
    expect(tool.description).toMatch(/prose.*approval/i);
  }
});

test.each(tools.map((name, index) => ({name, index})))("$name injects authenticated identity and preserves exact selection", async ({name, index}) => {
  const {client, calls} = await open();
  expect((await client.callTool({name, arguments: inputs[index]})).structuredContent).toEqual({ok: true, data: envelope});
  const suffix = index === 0 ? [20] : index === 1 ? ["1", 20]
    : [{historyId: "1", decision: "acknowledged", expectedVersion: "0"}];
  expect(calls[methods[index]!]).toHaveBeenCalledWith(principal, selection, base.endpointIds, ...suffix);
  expect(methods.filter((_, methodIndex) => methodIndex !== index).every(method => calls[method]!.mock.calls.length === 0)).toBe(true);
});

test.each(tools.map((name, index) => ({name, index})))("$name rejects forged identities, extras, unpinned views and invalid endpoints", async ({name, index}) => {
  const {client, calls, authenticate} = await open();
  const invalid = [{tenantId: "foreign"}, {principalId: "foreign"}, {principal: principal}, {credential: "secret"},
    {extra: true}, {repositoryId: ""}, {serviceId: "bad\u0000id"}, {endpointIds: []},
    {endpointIds: ["ep-get", "ep-get"]}, {endpointIds: Array.from({length: 17}, (_, i) => `ep-${i}`)},
    {endpointIds: [""]}, {endpointIds: ["bad\nendpoint"]},
    {view: {kind: "environment", environment: "uat"}}, {view: {kind: "branch", branch: "main"}},
    {view: {...base.view, expectedCheckpointVersion: "0"}},
    {view: {...base.view, expectedCheckpointVersion: "9223372036854775808"}},
    {view: {...base.view, principalId: "foreign"}}];
  for (const patch of invalid) {
    expect((await client.callTool({name, arguments: {...inputs[index], ...patch}})).isError).toBe(true);
  }
  expect(authenticate).not.toHaveBeenCalled();
  for (const method of methods) expect(calls[method]).not.toHaveBeenCalled();
});

test.each(tools.slice(0, 2).map((name, index) => ({name, index})))("$name requires an explicit integral limit from 1 through 20", async ({name, index}) => {
  const {client, calls} = await open();
  for (const limit of [undefined, 0, 21, 1.5, "1", null]) {
    expect((await client.callTool({name, arguments: {...inputs[index], limit}})).isError).toBe(true);
  }
  expect(calls[methods[index]!]).not.toHaveBeenCalled();
});

test.each(tools.slice(1).map((name, offset) => ({name, index: offset + 1})))("$name requires a canonical positive PostgreSQL bigint history ID", async ({name, index}) => {
  const {client, calls} = await open();
  for (const historyId of [undefined, "", "0", "01", "+1", "-1", "1.0", "1e2", " 1", "9223372036854775808", 1]) {
    expect((await client.callTool({name, arguments: {...inputs[index], historyId}})).isError).toBe(true);
  }
  expect(calls[methods[index]!]).not.toHaveBeenCalled();
  expect((await client.callTool({name, arguments: {...inputs[index], historyId: "9223372036854775807"}})).isError).not.toBe(true);
});

test("review writes accept only enumerated decisions and canonical nonnegative versions below PostgreSQL bigint maximum", async () => {
  const {client, calls} = await open();
  for (const expectedVersion of [undefined, "", "00", "01", "+0", "-1", "0.0", "1e2", " 0", "9223372036854775807", 0]) {
    expect((await client.callTool({name: tools[2], arguments: {...inputs[2], expectedVersion}})).isError).toBe(true);
  }
  for (const decision of [undefined, "approved", "rejected", "", 1]) {
    expect((await client.callTool({name: tools[2], arguments: {...inputs[2], decision}})).isError).toBe(true);
  }
  expect(calls.recordHistoryReview).not.toHaveBeenCalled();
  for (const decision of ["acknowledged", "follow_up", "dismissed"]) {
    expect((await client.callTool({name: tools[2], arguments: {...inputs[2], decision,
      expectedVersion: "9223372036854775806"}})).isError).not.toBe(true);
  }
});

test("all history tools accept an explicit revision or versioned branch selection", async () => {
  const {client, calls} = await open();
  for (const [index, name] of tools.entries()) {
    for (const view of [{kind: "revision", revision: "rev-a"}, {kind: "branch", branch: "main", expectedPointerVersion: "3"}]) {
      expect((await client.callTool({name, arguments: {...inputs[index], view}})).isError).not.toBe(true);
      expect(calls[methods[index]!]).toHaveBeenLastCalledWith(principal,
        {...selection, selector: view}, base.endpointIds, ...(index === 0 ? [20] : index === 1 ? ["1", 20]
          : [{historyId: "1", decision: "acknowledged", expectedVersion: "0"}]));
    }
  }
});

test.each(tools.map((name, index) => ({name, index})))("$name rejects unauthenticated calls before invoking the semantic service", async ({name, index}) => {
  const {client, calls} = await open({authenticate: async () => undefined});
  expect((await client.callTool({name, arguments: inputs[index]})).structuredContent).toEqual({ok: false, error: "NOT_AUTHORIZED"});
  for (const method of methods) expect(calls[method]).not.toHaveBeenCalled();
});

test.each(tools.flatMap((name, index) => [["SEMANTIC_NOT_FOUND_OR_DENIED", "NOT_FOUND_OR_DENIED"],
  ["SEMANTIC_STALE_CONTEXT", "STALE_SELECTION"], ["SEMANTIC_REVIEW_CONFLICT", "REVIEW_CONFLICT"],
  ["SEMANTIC_INVALID_REQUEST", "INVALID_REQUEST"], ["SEMANTIC_STORAGE_ERROR", "QUERY_UNAVAILABLE"]]
  .map(([code, error]) => ({name, index, code, error}))))("$name normalizes $code without error details", async ({name, index, code, error}) => {
  const {client} = await open({operation: async () => {throw Object.assign(new Error("PRIVATE_DATABASE_CANARY"), {code});}});
  const result = await client.callTool({name, arguments: inputs[index]});
  expect(result.structuredContent).toEqual({ok: false, error});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_DATABASE_CANARY");
});

test("hostile thrown proxies and accessors cannot run traps or disclose error details", async () => {
  const trap = vi.fn(() => {throw new Error("PRIVATE_CANARY");});
  const proxy = new Proxy({}, {get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, getPrototypeOf: trap});
  const getter = Object.defineProperty({}, "code", {get: trap});
  for (const thrown of [proxy, getter]) {
    const {client} = await open({operation: async () => {throw thrown;}});
    for (const [index, name] of tools.entries()) {
      const result = await client.callTool({name, arguments: inputs[index]});
      expect(result.structuredContent).toEqual({ok: false, error: "QUERY_UNAVAILABLE"});
      expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
    }
  }
  expect(trap).not.toHaveBeenCalled();
});

test.each(tools.map((name, index) => ({name, index})))("$name applies the configured output bound without partial metadata", async ({name, index}) => {
  const {client} = await open({maxOutputBytes: 1024,
    operation: async () => ({...envelope, records: [{private: "PRIVATE_METADATA_CANARY".repeat(100)}]})});
  const result = await client.callTool({name, arguments: inputs[index]});
  expect(result.structuredContent).toEqual({ok: false, error: "RESULT_TOO_LARGE"});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_METADATA_CANARY");
});
