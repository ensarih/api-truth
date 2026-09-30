import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import { deriveEndpointIdentity } from "../../packages/ir/src/index.js";
import { planOpenApiProjection } from "../../packages/openapi/src/index.js";

const fixture = async () => JSON.parse(await readFile(
  new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as Record<string, any>;

test("the projection planner groups one validated endpoint per OpenAPI method and path shape", async () => {
  const plan = planOpenApiProjection(await fixture());
  expect(plan.snapshotId).toBe("snapshot-orders-rev-b");
  expect(plan.groups).toEqual([
    { method: "GET", pathShape: "/api/orders/{}", endpointIds: ["ep-get"], kind: "single" },
    { method: "POST", pathShape: "/api/orders", endpointIds: ["ep-create"], kind: "selected_single" },
  ]);
  expect(plan.diagnostics).toEqual([]);
});

test("distinct resolved handlers sharing a projected operation remain a variant set", async () => {
  const snapshot = await fixture();
  const variant = structuredClone(snapshot.endpoints[1]);
  variant.endpoint_id = "ep-create-blue";
  variant.identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders",
    selectors: { consumes: ["application/json"],
      headers: [{ name: "x-channel", operator: "equals", value: "blue" }] } });
  snapshot.endpoints.unshift(variant);
  const plan = planOpenApiProjection(snapshot);
  expect(plan.groups.find((group) => group.method === "POST")).toEqual({
    method: "POST", pathShape: "/api/orders", endpointIds: ["ep-create", "ep-create-blue"],
    kind: "variant_set",
  });
  expect(plan.diagnostics).toContainEqual({ code: "VARIANT_REQUIRES_REPRESENTATION",
    endpointIds: ["ep-create", "ep-create-blue"] });
  snapshot.endpoints.reverse();
  expect(planOpenApiProjection(snapshot)).toEqual(plan);
});

test("placeholder spellings share a projected path while constrained routes are blocked", async () => {
  const snapshot = await fixture();
  const renamed = structuredClone(snapshot.endpoints[0]);
  renamed.endpoint_id = "ep-read-renamed";
  renamed.application_path = "/api/orders/{id}";
  renamed.identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "GET", application_path: renamed.application_path,
    selectors: { headers: [{ name: "x-mode", operator: "equals", value: "new" }] } });
  snapshot.endpoints.push(renamed);
  const plan = planOpenApiProjection(snapshot);
  expect(plan.groups.find((group) => group.method === "GET")?.endpointIds)
    .toEqual(["ep-get", "ep-read-renamed"]);

  snapshot.endpoints[0].application_path = "/api/orders/:orderId([0-9]+)";
  snapshot.endpoints[0].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "GET", application_path: snapshot.endpoints[0].application_path });
  const constrained = planOpenApiProjection(snapshot);
  expect(constrained.groups.find((group) => group.method === "GET")?.endpointIds)
    .toEqual(["ep-read-renamed"]);
  expect(constrained.diagnostics).toContainEqual({ code: "UNREPRESENTABLE_ROUTE",
    endpointIds: ["ep-get"] });
});

test("invalid catalog input cannot enter the projection planner", () => {
  expect(() => planOpenApiProjection({ endpoints: [] })).toThrow("Invalid contract snapshot");
});

test("an HTTP method without an OpenAPI operation slot is diagnosed and omitted", async () => {
  const snapshot = await fixture();
  snapshot.endpoints[0].identity = deriveEndpointIdentity({ identity_version: "1.0.0",
    service_id: "orders", method: "CONNECT", application_path: snapshot.endpoints[0].application_path });
  const plan = planOpenApiProjection(snapshot);
  expect(plan.groups).toEqual([{ method: "POST", pathShape: "/api/orders",
    endpointIds: ["ep-create"], kind: "selected_single" }]);
  expect(plan.diagnostics).toEqual([{ code: "UNSUPPORTED_METHOD", endpointIds: ["ep-get"] }]);
});
