import {once} from "node:events";
import {expect, test, vi} from "vitest";
import {Client, InMemoryTransport} from "@modelcontextprotocol/client";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import {createPortalServer} from "../../apps/portal/src/server.js";

const principal = {tenantId: "tenant-a", principalId: "reader-a"};
const pin = {snapshotId: "snapshot-a", revision: "revision-a", configFingerprint: "config-a", checkpointVersion: "7"};
const selection = {version: "1", tenantId: "tenant-a", repositoryId: "repo-a", serviceId: "service-a",
  selector: {kind: "environment", environment: "uat", expectedCheckpointVersion: "7"}} as const;
const unavailable = async (): Promise<never> => {throw new Error("not called");};
const query = () => ({searchServices: unavailable, readContract: unavailable, readEndpoint: unavailable,
  readSchema: unavailable, compareContracts: unavailable, readPublication: unavailable,
  readMetadataObservations: vi.fn(async () => ({status: "resolved" as const, selector: selection, pin,
    records: [], truncated: false}))});

test("portal and MCP forward identical environment pins and limits to the authorized metadata reader", async () => {
  const reader = query();
  const portal = createPortalServer({query: reader, authenticate: async () => principal});
  portal.listen(0, "127.0.0.1"); await once(portal, "listening");
  const server = createApiTruthMcpServer({query: reader, authenticate: async () => principal});
  const client = new Client({name: "observation-fixture", version: "1.0.0"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const address = portal.address(); if (!address || typeof address === "string") throw new Error();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/observations?repositoryId=repo-a&serviceId=service-a&environment=uat&expectedCheckpointVersion=7&limit=2`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({status: "resolved", pin, records: []});
    const result = await client.callTool({name: "api_truth_get_observations", arguments: {
      repositoryId: "repo-a", serviceId: "service-a", environment: "uat", expectedCheckpointVersion: "7", maxResults: 2}});
    expect(result.structuredContent).toMatchObject({ok: true, data: {pin, records: []}});
    expect(reader.readMetadataObservations.mock.calls).toEqual([[principal, selection, {limit: 2}], [principal, selection, {limit: 2}]]);
    const before = reader.readMetadataObservations.mock.calls.length;
    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/observations?repositoryId=repo-a&serviceId=service-a&environment=uat&limit=101`);
    expect(invalid.status).toBe(400);
    const forged = await client.callTool({name: "api_truth_get_observations", arguments: {
      repositoryId: "repo-a", serviceId: "service-a", environment: "uat", tenantId: "forged"}});
    expect(forged.isError).toBe(true);
    expect(reader.readMetadataObservations.mock.calls.length).toBe(before);
  } finally {
    await client.close(); await server.close(); portal.closeAllConnections(); portal.close(); await once(portal, "close");
  }
});

test("observation tool is absent when host has not enabled the metadata reader", async () => {
  const {readMetadataObservations: _unused, ...reader} = query();
  const server = createApiTruthMcpServer({query: reader, authenticate: async () => principal});
  const client = new Client({name: "observation-fixture", version: "1.0.0"});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("api_truth_get_observations");}
  finally {await client.close(); await server.close();}
});
