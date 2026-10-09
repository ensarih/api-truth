import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createPortalServer, type PortalOptions } from "../../apps/portal/src/server.js";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import type { QueryContractResult, QueryHistoricalPublication, QuerySelection } from "../../packages/query/src/index.js";

const context = Object.freeze({ tenantId: "tenant-browser", principalId: "browser-reader" });
const publicationId = `sha256:${"a".repeat(64)}`;
const pin = Object.freeze({ snapshotId: "snapshot-browser-uat", revision: "rev-browser",
  configFingerprint: "config-browser", checkpointVersion: "7" });
const publicationSelector = Object.freeze({ kind: "environment" as const, repositoryId: "commerce",
  serviceId: "orders", environment: "uat", snapshotId: pin.snapshotId, revision: pin.revision,
  configFingerprint: pin.configFingerprint, checkpointVersion: pin.checkpointVersion,
  resolvedSnapshotIds: [pin.snapshotId] });
const publication = Object.freeze({ status: "current" as const, publicationId,
  contentSha256: `sha256:${"b".repeat(64)}`, checkpointVersion: pin.checkpointVersion,
  selector: publicationSelector });
const openApiBytes = new TextEncoder().encode(JSON.stringify({ openapi: "3.1.0",
  info: { title: "Orders", version: "rev-browser" }, paths: {} }));

const fixtureSnapshot = async (): Promise<ContractSnapshot> => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url),
    "utf8")) as ContractSnapshot;
  snapshot.snapshot_id = pin.snapshotId;
  snapshot.source.immutable_revision = pin.revision;
  snapshot.config.config_fingerprint = pin.configFingerprint;
  snapshot.endpoints = [snapshot.endpoints[0]!];
  snapshot.schemas = {};
  snapshot.endpoints[0]!.application_path = "/orders/{id}";
  return snapshot;
};

test("search, service selection, UAT details, export, and unknown state work in a real browser", async ({ page }) => {
  const snapshot = await fixtureSnapshot();
  const authenticatedPaths: string[] = [];
  const query: PortalOptions["query"] = {
    searchServices: async (_principal, request) => {
      expect(request).toEqual({ tenantId: context.tenantId, query: "orders", limit: 20, environment: "uat" });
      return { services: [{ repositoryId: "commerce", serviceId: "orders",
        environment: { name: "uat", status: "resolved", pin, publication } }], truncated: false };
    },
    readContract: async (_principal, rawSelection): Promise<QueryContractResult> => {
      const selected = rawSelection as QuerySelection;
      if (selected.selector.kind === "environment" && selected.selector.environment === "staging")
        return { status: "unknown", selector: selected };
      return { status: "resolved", selector: selected, pin, publication, snapshot };
    },
    compareContracts: async () => ({ status: "unavailable", beforeStatus: "unknown", afterStatus: "unknown" }),
    readPublication: async (): Promise<QueryHistoricalPublication> => ({ publicationId,
      contentSha256: publication.contentSha256, bytes: openApiBytes, selector: publicationSelector, pin }),
    readMetadataObservations: async (principal, rawSelection, options) => {
      expect(principal).toEqual(context);
      expect(rawSelection).toMatchObject({repositoryId: "commerce", serviceId: "orders",
        selector: {kind: "environment", environment: "uat", expectedCheckpointVersion: "7"}});
      expect(options).toEqual({limit: 20});
      return {status: "resolved", selector: rawSelection as QuerySelection, pin, records: [], truncated: false};
    },
  };
  const server = createPortalServer({
    authenticate: async (request) => {
      if (request.headers.authorization !== "Bearer browser-fixture") return undefined;
      authenticatedPaths.push(request.url ?? "");
      return context;
    },
    query,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing portal port");
  await page.setExtraHTTPHeaders({ authorization: "Bearer browser-fixture" });
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator("#search input[name=query]").fill("orders");
    await page.locator("#search input[name=environment]").fill("uat");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#search-status")).toHaveText("Results");

    await page.getByRole("button", { name: "commerce / orders — uat: resolved" }).click();
    await expect(page.locator("#contract-status")).toContainText("Contract available.");
    await expect(page.locator("#contract input[name=repositoryId]")).toHaveValue("commerce");
    await expect(page.locator("#contract input[name=serviceId]")).toHaveValue("orders");
    await expect(page.locator("#contract input[name=value]")).toHaveValue("uat");

    await page.getByRole("button", {name: "View runtime activity"}).click();
    await expect(page.locator("#detail")).toContainText('"checkpointVersion": "7"');
    await expect(page.locator("#detail")).toContainText('"records": []');

    await page.getByRole("button", { name: "GET /orders/{id}" }).click();
    await expect(page.locator("#detail")).toContainText(`"endpoint_id": "${snapshot.endpoints[0]!.endpoint_id}"`);

    const link = page.locator("#download");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href",
      `/api/openapi/${encodeURIComponent(publicationId)}?repositoryId=commerce&serviceId=orders`);
    const downloadStarted = page.waitForEvent("download");
    await link.click();
    expect((await downloadStarted).suggestedFilename()).toBe(`openapi-${publicationId.slice(7,19)}.json`);

    await page.locator("#contract input[name=value]").fill("staging");
    await page.getByRole("button", { name: "View contract" }).click();
    await expect(page.locator("#contract-status"))
      .toHaveText("Contract state: unknown. No contract is available here.");
    await expect(page.locator("#endpoints")).toBeEmpty();
    await expect(link).toBeHidden();
    expect(authenticatedPaths.some((path) => path.startsWith("/api/services?"))).toBe(true);
    expect(authenticatedPaths.some((path) => path.startsWith("/api/endpoint?"))).toBe(true);
    expect(authenticatedPaths.some((path) => path.startsWith("/api/openapi/"))).toBe(true);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("intent discovery requires explicit checked operations and preserves the displayed environment pin", async ({ page }) => {
  const snapshot = await fixtureSnapshot();
  const calls: unknown[] = []; let delayDiscovery = false;
  const query: PortalOptions["query"] = {
    searchServices: async () => ({services: [], truncated: false}),
    readContract: async (_principal, selected) => ({status: "resolved", selector: selected as QuerySelection,
      pin, publication, snapshot}),
    compareContracts: async () => ({status: "unavailable", beforeStatus: "unknown", afterStatus: "unknown"}),
    readPublication: async () => ({publicationId, contentSha256: publication.contentSha256,
      bytes: openApiBytes, selector: publicationSelector, pin}),
  };
  const semantic: NonNullable<PortalOptions["semantic"]> = {discover: async (who, selected, ids, intent) => {
    if(delayDiscovery){delayDiscovery=false;await new Promise(resolve=>setTimeout(resolve,200));}
    calls.push({who, selected, ids: ids as readonly string[], intent});
    return {status: "suggestions", suggestions: [{endpointId: (ids as readonly string[])[0]!, intent: "List orders",
      summary: "<img src=x onerror=alert(1)> inferred result", evidenceIds: ["evidence-1"]}],
      verification: "inferred", review: "unreviewed", normative: false,
      provenance: {provider: "openai", model: "test-model", promptVersion: "semantic-discovery-1",
        selector: (selected as QuerySelection).selector, pin}};
  }};
  const server = createPortalServer({authenticate: async request => request.headers.authorization === "Bearer browser-fixture" ? context : undefined,
    query, semantic});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing portal port");
  await page.setExtraHTTPHeaders({authorization: "Bearer browser-fixture"});
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(page.locator("#discovery")).toBeVisible();
    await expect(page.locator("#discovery")).toContainText("may be sent to the host-configured inference provider");
    await page.locator("#contract input[name=repositoryId]").fill("commerce");
    await page.locator("#contract input[name=serviceId]").fill("orders");
    await page.locator("#contract input[name=value]").fill("uat");
    await page.getByRole("button", {name: "View contract"}).click();
    await expect(page.locator("#contract-status")).toContainText("Contract available.");
    await expect(page.locator('#discovery input[name="endpointId"]')).toBeChecked();
    await page.locator('#discover textarea[name="intentQuery"]').fill("Find orders for this task");
    await page.getByRole("button", {name: "Find an API for this task"}).click();
    await expect(page.locator("#discovery-status")).toContainText("inferred, unreviewed");
    await expect(page.locator("#discovery-results")).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator("#discovery-results img")).toHaveCount(0);
    expect(calls).toEqual([{who: context, selected: {version: "1", tenantId: context.tenantId,
      repositoryId: "commerce", serviceId: "orders", selector: {kind: "environment", environment: "uat",
        expectedCheckpointVersion: "7"}}, ids: [snapshot.endpoints[0]!.endpoint_id], intent: "Find orders for this task"}]);
    delayDiscovery=true;
    await page.getByRole("button", {name: "Find an API for this task"}).click();
    await expect(page.locator("#discovery-status")).toHaveText("Checking selected operations…");
    await page.locator('#discover textarea[name="intentQuery"]').fill("new intent while pending");
    await expect(page.locator("#discovery-status")).toHaveText("Discovery inputs changed. Submit again to update results.");
    await page.waitForTimeout(250);
    await expect(page.locator("#discovery-results")).toBeEmpty();
    await expect(page.locator("#discovery-status")).toHaveText("Discovery inputs changed. Submit again to update results.");
    delayDiscovery=true;
    await page.getByRole("button", {name: "Find an API for this task"}).click();
    await expect(page.locator("#discovery-status")).toHaveText("Checking selected operations…");
    await page.locator("#contract input[name=value]").fill("another-view");
    await expect(page.locator("#discovery-status")).toHaveText("View the selected contract again before discovery.");
    await page.waitForTimeout(250);
    await expect(page.locator("#discovery-results")).toBeEmpty();
    await expect(page.locator("#discovery-status")).toHaveText("View the selected contract again before discovery.");
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});

test("intent discovery does not preselect the first operations when a contract has more than sixteen", async ({ page }) => {
  const snapshot = await fixtureSnapshot(); const source = snapshot.endpoints[0]!;
  snapshot.endpoints = Array.from({length: 17}, (_, index) => ({...source, endpoint_id: `ep-${index}`}));
  const calls: string[][] = [];
  const query: PortalOptions["query"] = {
    searchServices: async () => ({services: [], truncated: false}),
    readContract: async (_principal, selected) => ({status: "resolved", selector: selected as QuerySelection,
      pin, publication, snapshot}),
    compareContracts: async () => ({status: "unavailable", beforeStatus: "unknown", afterStatus: "unknown"}),
    readPublication: async () => ({publicationId, contentSha256: publication.contentSha256,
      bytes: openApiBytes, selector: publicationSelector, pin}),
  };
  const semantic: NonNullable<PortalOptions["semantic"]> = {discover: async (_who, _selected, ids) => {
    calls.push([...(ids as readonly string[])]);
    return {status: "no_match", reason: "No match", verification: "inferred", review: "unreviewed", normative: false,
      provenance: {provider: "openai", model: "test-model", promptVersion: "semantic-discovery-1",
        selector: {kind: "environment", environment: "uat", expectedCheckpointVersion: "7"}, pin}};
  }};
  const server = createPortalServer({authenticate: async () => context, query, semantic});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing portal port");
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator("#contract input[name=repositoryId]").fill("commerce");
    await page.locator("#contract input[name=serviceId]").fill("orders");
    await page.locator("#contract input[name=value]").fill("uat");
    await page.getByRole("button", {name: "View contract"}).click();
    await expect(page.locator('#discovery input[name="endpointId"]')).toHaveCount(17);
    await expect(page.locator('#discovery input[name="endpointId"]:checked')).toHaveCount(0);
    await page.locator('#discover textarea[name="intentQuery"]').fill("find it");
    await page.getByRole("button", {name: "Find an API for this task"}).click();
    await expect(page.locator("#discovery-status")).toContainText("Choose between 1 and 16");
    expect(calls).toEqual([]);
    await page.locator('#discovery input[name="endpointId"][value="ep-16"]').check();
    await page.getByRole("button", {name: "Find an API for this task"}).click();
    await expect(page.locator("#discovery-status")).toContainText("No matching operation");
    expect(calls).toEqual([["ep-16"]]);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});

test("a late contract response cannot replace a newer selection", async ({ page }) => {
  const source = (await fixtureSnapshot()).endpoints[0]!;
  const query: PortalOptions["query"] = {
    searchServices: async () => ({services: [], truncated: false}),
    readContract: async (_principal, selected) => {
      const view = selected as QuerySelection;
      const value = view.selector.kind === "environment" ? view.selector.environment : "revision";
      if (value === "uat") await new Promise(resolve => setTimeout(resolve, 250));
      const endpoint = {...source, endpoint_id: value === "uat" ? "ep-old" : "ep-new",
        application_path: value === "uat" ? "/old" : "/new"};
      return {status: "resolved", selector: view, pin, publication,
        snapshot: {...(await fixtureSnapshot()), endpoints: [endpoint]}};
    },
    compareContracts: async () => ({status: "unavailable", beforeStatus: "unknown", afterStatus: "unknown"}),
    readPublication: async () => ({publicationId, contentSha256: publication.contentSha256,
      bytes: openApiBytes, selector: publicationSelector, pin}),
  };
  const server = createPortalServer({authenticate: async () => context, query});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing portal port");
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator("#contract input[name=repositoryId]").fill("commerce");
    await page.locator("#contract input[name=serviceId]").fill("orders");
    const value = page.locator("#contract input[name=value]");
    await value.fill("uat"); await page.getByRole("button", {name: "View contract"}).click();
    await value.fill("staging"); await page.getByRole("button", {name: "View contract"}).click();
    await expect(page.getByRole("button", {name: "GET /new"})).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByRole("button", {name: "GET /new"})).toBeVisible();
    await expect(page.getByRole("button", {name: "GET /old"})).toHaveCount(0);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});
