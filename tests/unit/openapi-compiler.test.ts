import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { compileOpenApiSnapshot } from "../../packages/openapi/src/index.js";
import { deriveEndpointIdentity, parseContractSnapshot } from "../../packages/ir/src/index.js";

const fixture = async () => JSON.parse(await readFile(
  new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as Record<string, any>;

const singleGet = async () => {
  const snapshot = await fixture();
  snapshot.endpoints = [snapshot.endpoints[0]];
  snapshot.schemas = { Customer: snapshot.schemas.Customer };
  snapshot.evidence = snapshot.evidence.filter((item: any) => item.scope.endpoint_id !== "ep-create");
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-proof",
    method: "deterministic_analysis", limitations: [],
    scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0].evidence_ids = ["ev-proof"];
  snapshot.endpoints[0].parameters.forEach((parameter: any) => { parameter.presence.evidence_ids = ["ev-proof"]; });
  return snapshot;
};

const exportableGet = async () => {
  const snapshot = await singleGet();
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0].parameters = snapshot.endpoints[0].parameters.slice(0, 1);
  snapshot.endpoints[0].responses[0].content[0].schema = { type: "string" };
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-anonymous",
    method: "deterministic_analysis", limitations: [] });
  snapshot.endpoints[0].security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  return snapshot;
};

test("draft emits known operation facts and diagnoses unknowns without inventing defaults", async () => {
  const snapshot = await singleGet();
  snapshot.endpoints[0].parameters[1].presence.state = "optional";
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-anonymous",
    method: "deterministic_analysis", limitations: [] });
  snapshot.endpoints[0].security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.ok).toBe(true);
  const document = result.document as any;
  expect(document.openapi).toBe("3.1.0");
  expect(document.servers).toBeUndefined();
  const operation = document.paths["/api/orders/{orderId}"].get;
  expect(operation.parameters).toEqual([{ name: "orderId", in: "path", required: true,
    schema: { type: "string" }, style: "simple", explode: false },
  { name: "includeItems", in: "query", required: false, schema: { type: "boolean" }, style: "form", explode: true }]);
  expect(operation.security).toEqual([]);
  expect(operation.responses["200"].content["application/json"].schema)
    .toEqual({ $ref: "#/components/schemas/Customer" });
  expect(result.diagnostics.map((item) => item.code)).toContain("INCOMPLETE_COVERAGE");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("strict emits explicit, qualified security and deterministic documents", async () => {
  const snapshot = await singleGet();
  snapshot.schemas = {};
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0].parameters = snapshot.endpoints[0].parameters.slice(0, 1);
  snapshot.endpoints[0].responses[0].content[0].schema = { type: "string" };
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-security",
    scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id }, method: "deterministic_analysis",
    limitations: [] });
  snapshot.security_schemes = { apiToken: { definition: { type: "apiKey", name: "x-api-token", in: "header" },
    evidence_ids: ["ev-security"] } };
  snapshot.endpoints[0].security = { state: "declared", evidence_ids: ["ev-security"],
    alternatives: [{ requirements: [{ scheme: "apiToken", scopes: [] }] }] };
  const parsed = parseContractSnapshot(snapshot);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  const first = compileOpenApiSnapshot(snapshot, "strict");
  expect(first.ok).toBe(true);
  expect((first.document as any).paths["/api/orders/{orderId}"].get.security).toEqual([{ apiToken: [] }]);
  expect((first.document as any).components.securitySchemes.apiToken)
    .toEqual({ type: "apiKey", name: "x-api-token", in: "header" });
  snapshot.endpoints.reverse();
  expect(compileOpenApiSnapshot(snapshot, "strict")).toEqual(first);
});

test("selected single, unknown status, and weak security evidence cannot enter strict output", async () => {
  const snapshot = await fixture();
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("SELECTOR_REQUIRES_REPRESENTATION");
  expect((result.document as any).paths["/api/orders"]).toBeUndefined();
  snapshot.endpoints[0].responses[0].status = { kind: "unknown", reason: "dynamic" };
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNKNOWN_RESPONSE_STATUS");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("only an eligible exact field claim restores requiredness", async () => {
  const snapshot = await singleGet();
  const full = await fixture();
  snapshot.schemas = full.schemas;
  snapshot.schemas.CreateOrder.evidence_ids = ["ev-type"];
  snapshot.endpoints[0].responses[0].content[0].schema = { $ref: "#/schemas/CreateOrder" };
  snapshot.schemas.Customer.schema.required.push("address");
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-eligible",
    method: "deterministic_analysis", limitations: [], scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id,
      endpoint_id: "ep-get" } });
  snapshot.claims = [{ ...full.claims[0], claim_id: "claim-customer-id",
    subject: { service_id: "orders", endpoint_id: "ep-get", schema_pointer: "/schemas/Customer/schema/properties/id" },
    evidence_ids: ["ev-eligible"] }];
  snapshot.export_eligibility = [{ ...full.export_eligibility[0], claim_id: "claim-customer-id",
    scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_ids: ["ep-get"] },
    basis: { kind: "deterministic_analysis", evidence_ids: ["ev-eligible"] } }];
  snapshot.endpoints[0].parameters[1].presence.state = "optional";
  snapshot.endpoints[0].security = { state: "anonymous", evidence_ids: ["ev-eligible"], alternatives: [] };
  snapshot.endpoints[0].responses[0].headers = [{ name: "X-Other", schema: { type: "object",
    properties: { id: { type: "string" } }, required: ["id"] } }];
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).components.schemas.Customer.required).toEqual(["id"]);
  expect((result.document as any).paths["/api/orders/{orderId}"].get.responses["200"].headers["X-Other"].schema.required)
    .toBeUndefined();
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "UNVERIFIED_SCHEMA_CONSTRAINT", path: "/schemas/Customer/schema/required",
    endpointIds: ["ep-get"],
  }));
  expect((result.document as any).components.schemas.LineItem.properties.quantity.minimum).toBeUndefined();
  snapshot.claims[0].subject.schema_pointer = "/properties/id";
  expect((compileOpenApiSnapshot(snapshot, "draft").document as any).components.schemas.Customer.required).toBeUndefined();
  snapshot.claims[0].subject.schema_pointer = "/schemas/Customer/schema/properties/id";
  snapshot.claims[0].condition = full.claims[1].condition;
  expect((compileOpenApiSnapshot(snapshot, "draft").document as any).components.schemas.Customer.required).toBeUndefined();
});

test("weak explicit security evidence stays non-normative", async () => {
  const snapshot = await singleGet();
  snapshot.endpoints[0].security = { state: "anonymous", evidence_ids: ["ev-type"], alternatives: [] };
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics.map((item) => item.code)).toContain("UNVERIFIED_SECURITY");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("unknown parameter presence or security omits the draft operation", async () => {
  const snapshot = await singleGet();
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics.map((item) => item.code)).toContain("UNKNOWN_PARAMETER_PRESENCE");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNKNOWN_SECURITY");
  snapshot.endpoints[0].parameters[1].presence.state = "optional";
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
});

test("duplicate media and parameter facts are diagnosed rather than overwritten", async () => {
  const snapshot = await singleGet();
  snapshot.endpoints[0].parameters.push(structuredClone(snapshot.endpoints[0].parameters[0]));
  snapshot.endpoints[0].responses[0].content.push(structuredClone(snapshot.endpoints[0].responses[0].content[0]));
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("DUPLICATE_PARAMETER");
  expect(result.diagnostics.map((item) => item.code)).toContain("DUPLICATE_RESPONSE_MEDIA_TYPE");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("unused invalid schema keys stay out of output; referenced invalid keys block the operation", async () => {
  const snapshot = await exportableGet();
  snapshot.schemas["Bad/Name"] = { schema_id: "Bad/Name", schema: { type: "string" },
    evidence_ids: ["ev-type"] };
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(true);
  expect((compileOpenApiSnapshot(snapshot, "draft").document as any).components).toBeUndefined();
  snapshot.endpoints[0].responses[0].content[0].schema = { $ref: "#/schemas/Bad/Name" };
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics.map((item) => item.code)).toContain("INVALID_SCHEMA_COMPONENT_KEY");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("unsupported parameter styles and conflicting placeholder names block operations", async () => {
  const snapshot = await exportableGet();
  snapshot.endpoints[0].parameters[0].serialization.style = "deepObject";
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_PARAMETER_STYLE");
  snapshot.endpoints[0].parameters[0].serialization.style = "simple";
  const other = structuredClone(snapshot.endpoints[0]);
  other.endpoint_id = "ep-other";
  other.application_path = "/api/orders/:id";
  other.identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: other.application_path });
  other.parameters[0].name = "id";
  snapshot.endpoints.push(other);
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics.map((item) => item.code)).toContain("CONFLICTING_PATH_PARAMETER_NAMES");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("missing parameter serialization facts and deepObject on a scalar cannot use OpenAPI defaults", async () => {
  const snapshot = await exportableGet();
  delete snapshot.endpoints[0].parameters[0].serialization.style;
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNKNOWN_PARAMETER_SERIALIZATION");
  expect((result.document as any).paths).toEqual({});
  snapshot.endpoints[0].parameters[0].serialization = { style: "simple" };
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNKNOWN_PARAMETER_SERIALIZATION");
  snapshot.endpoints[0].parameters[0].serialization = { style: "simple", explode: false };
  const query = structuredClone(snapshot.endpoints[0].parameters[0]);
  query.in = "query";
  query.name = "filter";
  query.schema = { type: "string" };
  query.serialization = { style: "deepObject", explode: true };
  snapshot.endpoints[0].parameters.push(query);
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_PARAMETER_STYLE");
  expect((result.document as any).paths).toEqual({});
});

test("presence and response facts need qualified evidence for this endpoint", async () => {
  const snapshot = await exportableGet();
  snapshot.endpoints[0].parameters[0].presence.evidence_ids = ["ev-type"];
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics.map((item) => item.code)).toContain("UNVERIFIED_PARAMETER_PRESENCE");
  snapshot.endpoints[0].parameters[0].presence.evidence_ids = ["ev-proof"];
  snapshot.endpoints[0].request_bodies = [{ media_type: "application/json", schema: { type: "string" },
    serialization: { format: "json" }, presence: { state: "required", evidence_ids: ["ev-type"] } }];
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNVERIFIED_REQUEST_BODY_PRESENCE");
  snapshot.endpoints[0].request_bodies = [];
  snapshot.endpoints[0].evidence_ids = ["ev-type"];
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNVERIFIED_RESPONSE");
  snapshot.endpoints[0].evidence_ids = ["ev-proof"];
  snapshot.evidence.find((item: any) => item.evidence_id === "ev-proof").limitations = ["partial"];
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNVERIFIED_RESPONSE");
});

test("another endpoint's deterministic evidence cannot establish presence", async () => {
  const snapshot = await exportableGet();
  const other = structuredClone(snapshot.endpoints[0]);
  other.endpoint_id = "ep-other";
  other.application_path = "/api/other/:orderId";
  other.identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "GET", application_path: other.application_path });
  snapshot.endpoints.push(other);
  snapshot.evidence.push({ ...snapshot.evidence.find((item: any) => item.evidence_id === "ev-proof"),
    evidence_id: "ev-other", scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id,
      endpoint_id: "ep-other" } });
  snapshot.endpoints[0].parameters[0].presence.evidence_ids = ["ev-other"];
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "UNVERIFIED_PARAMETER_PRESENCE", endpointIds: ["ep-get"],
  }));
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("weak component evidence blocks strict export", async () => {
  const snapshot = await exportableGet();
  snapshot.endpoints[0].responses[0].content[0].schema = { $ref: "#/schemas/Customer" };
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect(result.diagnostics.map((item) => item.code)).toContain("UNVERIFIED_SCHEMA");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});

test("input must pass IR validation", () => {
  expect(() => compileOpenApiSnapshot({ endpoints: [] }, "draft")).toThrow("Invalid contract snapshot");
  expect(() => compileOpenApiSnapshot({}, "other" as any)).toThrow("Invalid OpenAPI compile mode");
});

const variantSnapshot = async () => {
  const snapshot = await exportableGet();
  const base = snapshot.endpoints[0];
  base.endpoint_id = "ep-json";
  base.application_path = "/api/orders";
  base.parameters = [];
  base.request_bodies = [{ media_type: "application/json", schema: { type: "string" },
    serialization: { format: "json" }, presence: { state: "required", evidence_ids: ["ev-json"] } }];
  base.identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: base.application_path, selectors: { consumes: ["application/json"] } });
  base.evidence_ids = ["ev-json"];
  base.security.evidence_ids = ["ev-json"];
  snapshot.evidence.push({ ...snapshot.evidence.find((item: any) => item.evidence_id === "ev-proof"),
    evidence_id: "ev-json", scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id,
      endpoint_id: "ep-json" } });
  const vnd = structuredClone(base);
  vnd.endpoint_id = "ep-vnd";
  vnd.identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: vnd.application_path, selectors: { consumes: ["application/vnd.api+json"] } });
  vnd.request_bodies = [{ media_type: "application/vnd.api+json", schema: { type: "object" },
    serialization: { format: "json" }, presence: { state: "required", evidence_ids: ["ev-vnd"] } }];
  vnd.evidence_ids = ["ev-vnd"];
  vnd.security.evidence_ids = ["ev-vnd"];
  snapshot.evidence.push({ ...snapshot.evidence.find((item: any) => item.evidence_id === "ev-json"),
    evidence_id: "ev-vnd", scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id,
      endpoint_id: "ep-vnd" } });
  snapshot.endpoints.push(vnd);
  snapshot.evidence = snapshot.evidence.filter((item: any) => item.scope.endpoint_id !== "ep-get");
  const parsed = parseContractSnapshot(snapshot);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  return snapshot;
};

test("disjoint consumes variants preserve media schemas and requiredness in any input order", async () => {
  const snapshot = await variantSnapshot();
  const first = compileOpenApiSnapshot(snapshot, "strict");
  expect(first.ok).toBe(true);
  expect((first.document as any).paths["/api/orders"].post.requestBody).toEqual({ required: true,
    content: { "application/json": { schema: { type: "string" } },
      "application/vnd.api+json": { schema: { type: "object" } } } });
  snapshot.endpoints.reverse();
  expect(compileOpenApiSnapshot(snapshot, "strict")).toEqual(first);
});

test("selected single accepts only an exact consumes match", async () => {
  const snapshot = await variantSnapshot();
  snapshot.endpoints.pop();
  snapshot.evidence = snapshot.evidence.filter((item: any) => item.scope.endpoint_id !== "ep-vnd");
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(true);
  snapshot.endpoints[0].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders", selectors: { consumes: ["application/vnd.api+json"] } });
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SELECTOR_CONSUMES_MISMATCH",
    endpointIds: ["ep-json"] }));
});

test("variant groups reject differing responses, header selectors, and overlapping media", async () => {
  const snapshot = await variantSnapshot();
  snapshot.endpoints[1].responses[0].content[0].schema = { type: "number" };
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "INCOMPATIBLE_VARIANT_CONTRACT",
    endpointIds: ["ep-json", "ep-vnd"] }));
  snapshot.endpoints[1].responses[0].content[0].schema = { type: "string" };
  snapshot.endpoints[1].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders", selectors: { consumes: ["application/vnd.api+json"],
      headers: [{ name: "x-mode", operator: "equals", value: "vnd" }] } });
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SELECTOR_REQUIRES_REPRESENTATION",
    endpointIds: ["ep-json", "ep-vnd"] }));
  snapshot.endpoints[1].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders", selectors: { consumes: ["application/json", "application/vnd.api+json"] } });
  snapshot.endpoints[1].request_bodies.push({ ...structuredClone(snapshot.endpoints[1].request_bodies[0]), media_type: "application/json" });
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "OVERLAPPING_VARIANT_MEDIA_TYPE",
    endpointIds: ["ep-json", "ep-vnd"] }));
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});


test("optional body and weak evidence omit an entire variant group", async () => {
  const snapshot = await variantSnapshot();
  snapshot.endpoints[1].request_bodies[0].presence.state = "optional";
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SELECTOR_REQUIRES_REPRESENTATION",
    endpointIds: ["ep-json", "ep-vnd"] }));
  snapshot.endpoints[1].request_bodies[0].presence.state = "required";
  snapshot.endpoints[1].request_bodies[0].presence.evidence_ids = ["ev-type"];
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "UNVERIFIED_VARIANT_CONTRACT",
    endpointIds: ["ep-json", "ep-vnd"] }));
});

test("selected consumes rejects wildcard media and header-dependent routing", async () => {
  const snapshot = await variantSnapshot();
  snapshot.endpoints.pop();
  snapshot.evidence = snapshot.evidence.filter((item: any) => item.scope.endpoint_id !== "ep-vnd");
  snapshot.endpoints[0].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders", selectors: { consumes: ["*/*"] } });
  snapshot.endpoints[0].request_bodies[0].media_type = "*/*";
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  snapshot.endpoints[0].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders", selectors: { consumes: ["application/json"],
      headers: [{ name: "x-mode", operator: "present" }] } });
  snapshot.endpoints[0].request_bodies[0].media_type = "application/json";
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SELECTOR_REQUIRES_REPRESENTATION",
    endpointIds: ["ep-json"] }));
});

test("variant aggregation rejects parameterized and malformed media", async () => {
  const snapshot = await variantSnapshot();
  snapshot.endpoints[1].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders",
    selectors: { consumes: ["application/json; charset=utf-8"] } });
  snapshot.endpoints[1].request_bodies[0].media_type = "application/json; charset=utf-8";
  let result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "SELECTOR_REQUIRES_REPRESENTATION", endpointIds: ["ep-json", "ep-vnd"],
  }));

  snapshot.endpoints[1].identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
    method: "POST", application_path: "/api/orders", selectors: { consumes: ["application//json"] } });
  snapshot.endpoints[1].request_bodies[0].media_type = "application//json";
  result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(compileOpenApiSnapshot(snapshot, "strict").ok).toBe(false);
});


test("placeholder names must agree across a consumes variant group", async () => {
  const snapshot = await variantSnapshot();
  for (const [index, endpoint] of snapshot.endpoints.entries()) {
    const name = index === 0 ? "orderId" : "id";
    endpoint.application_path = `/api/orders/:${name}`;
    endpoint.identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: "orders",
      method: "POST", application_path: endpoint.application_path,
      selectors: { consumes: endpoint.identity.selectors.consumes } });
    endpoint.parameters = [{ name, in: "path", schema: { type: "string" },
      serialization: { style: "simple", explode: false },
      presence: { state: "required", evidence_ids: [index === 0 ? "ev-json" : "ev-vnd"] } }];
  }
  const parsed = parseContractSnapshot(snapshot);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  const result = compileOpenApiSnapshot(snapshot, "draft");
  expect((result.document as any).paths).toEqual({});
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "UNVERIFIED_VARIANT_CONTRACT",
    endpointIds: ["ep-json", "ep-vnd"] }));
  expect(result.diagnostics.filter((item) => item.code === "CONFLICTING_PATH_PARAMETER_NAMES")).toHaveLength(2);
});
