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
