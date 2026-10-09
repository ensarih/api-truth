import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {expect, test} from "@playwright/test";
import {createPortalServer, type PortalOptions} from "../../apps/portal/src/server.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";
import type {OperationSearchResult, QuerySelection} from "../../packages/query/src/index.js";

test("keyword candidates require a displayed environment pin and explicit selection before provider discovery", async ({page}) => {
  const principal = {tenantId: "tenant-browser", principalId: "reader-browser"};
  const pin = {snapshotId: "snapshot-browser", revision: "rev-browser",
    configFingerprint: "config-browser", checkpointVersion: "7"};
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url),
    "utf8")) as ContractSnapshot;
  snapshot.snapshot_id = pin.snapshotId;
  snapshot.source.immutable_revision = pin.revision;
  snapshot.config.config_fingerprint = pin.configFingerprint;
  snapshot.endpoints = [snapshot.endpoints[0]!];
  const endpointId = snapshot.endpoints[0]!.endpoint_id;
  const calls: Array<{selection: unknown; options: unknown}> = [];
  let discoverCalls = 0;
  let releaseCandidate: ((result: OperationSearchResult) => void) | undefined;
  let delayCandidate = false;
  const candidate = (selected: QuerySelection): OperationSearchResult => ({status: "candidates", matchMode: "keyword",
    selector: selected, pin, candidates: [{endpointId, method: "GET", path: "/orders",
      label: "Find orders", evidenceIds: ["ev-route"], score: 3}], truncated: false, complete: false});
  const query: PortalOptions["query"] = {
    searchServices: async () => ({services: [], truncated: false}),
    readContract: async (_principal, selection) => ({status: "resolved" as const,
      selector: selection as QuerySelection, pin, publication: {status: "absent" as const}, snapshot}),
    compareContracts: async () => ({status: "unavailable" as const, beforeStatus: "unknown" as const,
      afterStatus: "unknown" as const}),
    readPublication: async () => {throw new Error("unused");},
    readOperationCandidates: async (_principal, selection, options) => {
      calls.push({selection, options});
      if (delayCandidate) return new Promise<OperationSearchResult>(resolve => {releaseCandidate = resolve;});
      return candidate(selection as QuerySelection);
    },
  };
  const server = createPortalServer({authenticate: async request =>
    request.headers.authorization === "Bearer browser-fixture" ? principal : undefined,
  query, semantic: {discover: async (_principal, _selection, endpointIds) => {
    discoverCalls += 1;
    return {status: "suggestions" as const, suggestions: [{endpointId: (endpointIds as string[])[0]!,
      intent: "Find orders", summary: "Tentative result", evidenceIds: ["ev-route"]}],
      verification: "inferred" as const, review: "unreviewed" as const, normative: false as const,
      provenance: {provider: "openai" as const, model: "synthetic-model",
        promptVersion: "semantic-discovery-source-1" as const,
        selector: {kind: "environment" as const, environment: "uat", expectedCheckpointVersion: "7"}, pin}};
  }}});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  await page.setExtraHTTPHeaders({authorization: "Bearer browser-fixture"});
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator("#contract input[name=repositoryId]").fill("commerce");
    await page.locator("#contract input[name=serviceId]").fill("orders");
    await page.locator("#contract input[name=value]").fill("uat");
    await page.getByRole("button", {name: "View contract"}).click();
    await expect(page.locator("#contract-status")).toContainText("Contract available");
    await expect(page.locator('#discovery input[name="endpointId"]:checked')).toHaveCount(0);
    await page.locator('#candidates textarea[name="intentQuery"]').fill("Find orders");
    await page.getByRole("button", {name: "Find candidate APIs"}).click();
    await expect(page.locator("#candidate-status")).toContainText("Search context is incomplete");
    await expect(page.locator("#candidate-results")).toContainText("Find orders");
    expect(calls[0]).toMatchObject({selection: {selector: {kind: "environment", environment: "uat",
      expectedCheckpointVersion: "7"}}, options: {intentQuery: "Find orders", limit: 20}});
    expect(discoverCalls).toBe(0);
    await page.locator("#candidate-results input[type=checkbox]").check();
    await expect(page.locator('#discovery input[name="endpointId"]:checked')).toHaveCount(1);
    await page.locator('#discover textarea[name="intentQuery"]').fill("Find orders");
    await page.getByRole("button", {name: "Find an API for this task"}).click();
    await expect(page.locator("#discovery-status")).toContainText("inferred, unreviewed");
    expect(discoverCalls).toBe(1);
    delayCandidate = true;
    await page.getByRole("button", {name: "Find candidate APIs"}).click();
    await expect(page.locator("#candidate-status")).toContainText("Checking keyword candidates");
    await page.locator('#candidates textarea[name="intentQuery"]').fill("another task");
    releaseCandidate?.(candidate(calls.at(-1)!.selection as QuerySelection));
    await expect(page.locator("#candidate-status")).toContainText("Candidate inputs changed");
    await expect(page.locator("#candidate-results")).toBeEmpty();
  } finally {server.closeAllConnections(); server.close(); await once(server, "close");}
});
