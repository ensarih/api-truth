import { afterEach, describe, expect, test, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { QueryReadError, type QueryReader } from "../../packages/query/src/index.js";
import { createApiTruthMcpServer, type ApiTruthMcpPrincipal } from "../../apps/mcp/src/server.js";

const principal = Object.freeze({ tenantId: "tenant-a", principalId: "architect-a" });
const publication = Object.freeze({ status: "current" as const,
  publicationId: `sha256:${"a".repeat(64)}`, contentSha256: `sha256:${"b".repeat(64)}`,
  selector: { kind: "revision" as const, repositoryId: "commerce", serviceId: "orders",
    snapshotId: "snapshot-1", revision: "rev-1", configFingerprint: "config-1" } });
const pin = Object.freeze({ snapshotId: "snapshot-1", revision: "rev-1", configFingerprint: "config-1" });
const selection = Object.freeze({ version: "1" as const, tenantId: principal.tenantId,
  repositoryId: "commerce", serviceId: "orders", selector: { kind: "environment" as const,
    environment: "uat", expectedCheckpointVersion: "7" } });

const queryReader = (): QueryReader => ({
  searchServices: vi.fn(async () => Object.freeze({ services: Object.freeze([]), truncated: false as const })),
  readContract: vi.fn(async () => Object.freeze({ status: "unavailable" as const, selector: selection })),
  readEndpoint: vi.fn(async (_context, selected, endpointId) => Object.freeze({ status: "resolved" as const,
    selector: selected as typeof selection, pin, publication,
    endpoint: { endpoint_id: endpointId as string, method: "GET", path: "/orders", operation: { summary: "List orders" } } as never })),
  readSchema: vi.fn(async (_context, selected, schemaId) => Object.freeze({ status: "resolved" as const,
    selector: selected as typeof selection, pin, publication,
    schema: { schema_id: schemaId as string, kind: "object", properties: {} } as never })),
  compareContracts: vi.fn(async () => Object.freeze({ status: "compared" as const, before: pin, after: pin,
    beforePublication: publication, afterPublication: publication,
    differences: { contract_difference_version: "1.0.0", repository_id: "commerce", service_id: "orders",
      base_snapshot_id: "snapshot-1", target_snapshot_id: "snapshot-1", changes: [] } as never })),
  readPublication: vi.fn(async () => { throw new Error("not exposed by initial MCP tools"); }),
});

const openProtocolClient = async (query: QueryReader,
  authenticate: ReturnType<typeof vi.fn<() => Promise<ApiTruthMcpPrincipal | undefined>>>
    = vi.fn(async () => principal)) => {
  const server = createApiTruthMcpServer({ query, authenticate });
  const client = new Client({ name: "api-truth-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, authenticate };
};

const opened: Array<Awaited<ReturnType<typeof openProtocolClient>>> = [];
afterEach(async () => {
  await Promise.allSettled(opened.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
});

describe("read-only API Truth MCP tools", () => {
  test("advertises only bounded read tools with read-only closed-world annotations", async () => {
    const connection = await openProtocolClient(queryReader()); opened.push(connection);
    const listed = await connection.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "api_truth_compare_contracts", "api_truth_get_contract", "api_truth_get_endpoint",
      "api_truth_get_schema", "api_truth_search_services",
    ]);
    for (const tool of listed.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/tenantId|principalId/);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  test("injects host authentication and preserves explicit environment and publication pins", async () => {
    const query = queryReader();
    const connection = await openProtocolClient(query); opened.push(connection);
    const result = await connection.client.callTool({ name: "api_truth_get_endpoint", arguments: {
      repositoryId: "commerce", serviceId: "orders", endpointId: "endpoint-get-orders",
      view: { kind: "environment", environment: "uat", expectedCheckpointVersion: "7" },
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true, data: {
      status: "resolved", pin: { snapshotId: "snapshot-1" },
      publication: { status: "current", publicationId: publication.publicationId },
    } });
    expect(query.readEndpoint).toHaveBeenCalledWith(principal, selection, "endpoint-get-orders");
  });

  test("rejects model-supplied identity before authentication or query access", async () => {
    const query = queryReader();
    const connection = await openProtocolClient(query); opened.push(connection);
    const result = await connection.client.callTool({ name: "api_truth_search_services", arguments: {
      query: "orders", maxResults: 5, tenantId: "other-tenant", principalId: "admin",
    } });
    expect(result.isError).toBe(true);
    expect(connection.authenticate).not.toHaveBeenCalled();
    expect(query.searchServices).not.toHaveBeenCalled();
  });

  test("fails closed when the host supplies no authenticated principal", async () => {
    const query = queryReader();
    const connection = await openProtocolClient(query, vi.fn(async () => undefined)); opened.push(connection);
    const result = await connection.client.callTool({ name: "api_truth_get_contract", arguments: {
      repositoryId: "commerce", serviceId: "orders", view: { kind: "revision", revision: "rev-1" },
    } });
    expect(result).toMatchObject({ isError: true, structuredContent: { ok: false, error: "NOT_AUTHORIZED" } });
    expect(query.readContract).not.toHaveBeenCalled();
  });

  test("returns unavailable environment status without inventing a contract", async () => {
    const query = queryReader();
    const connection = await openProtocolClient(query); opened.push(connection);
    const result = await connection.client.callTool({ name: "api_truth_get_contract", arguments: {
      repositoryId: "commerce", serviceId: "orders", view: { kind: "environment", environment: "uat" },
    } });
    expect(result).toMatchObject({ structuredContent: { ok: true, data: { status: "unavailable" } } });
    expect(JSON.stringify(result.structuredContent)).not.toContain("snapshot");
  });

  test("compares two explicit views and preserves both publication pins", async () => {
    const query = queryReader();
    const connection = await openProtocolClient(query); opened.push(connection);
    const result = await connection.client.callTool({ name: "api_truth_compare_contracts", arguments: {
      repositoryId: "commerce", serviceId: "orders",
      before: { kind: "revision", revision: "rev-1" },
      after: { kind: "branch", branch: "main", expectedPointerVersion: "9" },
    } });
    expect(result).toMatchObject({ structuredContent: { ok: true, data: {
      status: "compared",
      beforePublication: { publicationId: publication.publicationId },
      afterPublication: { publicationId: publication.publicationId },
    } } });
    expect(query.compareContracts).toHaveBeenCalledWith(principal,
      { version: "1", tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders",
        selector: { kind: "revision", revision: "rev-1" } },
      { version: "1", tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders",
        selector: { kind: "branch", branch: "main", expectedPointerVersion: "9" } });
  });

  test("maps query failures to stable public codes without exposing internal details", async () => {
    const query = queryReader();
    const internal = new QueryReadError("QUERY_STALE_SELECTION");
    internal.message = "private database and repository detail";
    vi.mocked(query.readEndpoint).mockRejectedValueOnce(internal);
    const connection = await openProtocolClient(query); opened.push(connection);
    const result = await connection.client.callTool({ name: "api_truth_get_endpoint", arguments: {
      repositoryId: "commerce", serviceId: "orders", endpointId: "endpoint-get-orders",
      view: { kind: "environment", environment: "uat", expectedCheckpointVersion: "7" },
    } });
    expect(result).toMatchObject({ isError: true,
      structuredContent: { ok: false, error: "STALE_SELECTION" } });
    expect(JSON.stringify(result)).not.toContain("private database");
  });

  test("bounds serialized query results and maps failures to safe public codes", async () => {
    const query = queryReader();
    vi.mocked(query.readSchema).mockResolvedValueOnce(Object.freeze({ status: "resolved", selector: selection, pin, publication,
      schema: { schema_id: "Huge", description: "private".repeat(30_000) } as never }));
    const connection = await openProtocolClient(query); opened.push(connection);
    const result = await connection.client.callTool({ name: "api_truth_get_schema", arguments: {
      repositoryId: "commerce", serviceId: "orders", schemaId: "Huge",
      view: { kind: "revision", revision: "rev-1" },
    } });
    expect(result).toMatchObject({ isError: true, structuredContent: { ok: false, error: "RESULT_TOO_LARGE" } });
    expect(JSON.stringify(result)).not.toContain("privateprivate");
  });
});
