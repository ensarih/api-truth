import { once } from "node:events";
import { expect, test } from "vitest";
import { createPortalServer } from "../../apps/portal/src/server.js";
import type { QueryReader } from "../../packages/query/src/index.js";

const detailMethods: Pick<QueryReader, "readContract" | "compareContracts" | "readPublication"> = {
  readContract: async () => { throw new Error("not called"); },
  compareContracts: async () => { throw new Error("not called"); },
  readPublication: async () => { throw new Error("not called"); },
};

test("portal requires host authentication and searches only the trusted tenant", async () => {
  const searches: unknown[] = [];
  const server = createPortalServer({
    authenticate: async (request) => request.headers.authorization === "Bearer fixture"
      ? { tenantId: "tenant-a", principalId: "reader-a" } : undefined,
    query: { ...detailMethods, searchServices: async (context, request) => {
      searches.push({ context, request });
      return { services: [{ repositoryId: "commerce", serviceId: "orders",
        environment: { name: "uat", status: "unknown" as const } }], truncated: false };
    } },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local port");
    const base = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${base}/api/services?query=ord`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect(searches).toEqual([]);

    const forged = await fetch(`${base}/api/services?query=ord&tenantId=other`,
      { headers: { authorization: "Bearer fixture" } });
    expect(forged.status).toBe(400);
    expect(searches).toEqual([]);

    const response = await fetch(`${base}/api/services?query=ord&environment=uat&limit=2`,
      { headers: { authorization: "Bearer fixture" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ services: [{ repositoryId: "commerce", serviceId: "orders",
      environment: { name: "uat", status: "unknown" } }], truncated: false });
    expect(searches).toEqual([{ context: { tenantId: "tenant-a", principalId: "reader-a" },
      request: { tenantId: "tenant-a", query: "ord", environment: "uat", limit: 2 } }]);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const page = await fetch(base, { headers: { authorization: "Bearer fixture" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("API Truth");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("portal exposes bounded result errors without database details", async () => {
  let failure: Error & { code?: string } = Object.assign(new Error("private-db-marker"),
    { code: "QUERY_RESULT_LIMIT_EXCEEDED" });
  const server = createPortalServer({
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "reader-a" }),
    query: { ...detailMethods, searchServices: async () => { throw failure; } },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local port");
    const base = `http://127.0.0.1:${address.port}`;
    const capped = await fetch(`${base}/api/services`);
    expect(capped.status).toBe(422);
    expect(await capped.text()).toBe('{"error":"RESULT_LIMIT_EXCEEDED"}');
    failure = new Error("private-db-marker");
    const unavailable = await fetch(`${base}/api/services`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe('{"error":"QUERY_UNAVAILABLE"}');
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
