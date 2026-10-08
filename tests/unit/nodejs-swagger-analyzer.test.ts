import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/nodejs/src/index.js";
import { parseAnalyzerResult, type AnalyzerRequest } from "../../packages/ir/src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function service(document: unknown) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-nodejs-analyzer-")); roots.push(root);
  await mkdir(join(root, "service", "api", "swagger"), { recursive: true });
  await writeFile(join(root, "service", "api", "swagger", "swagger.json"), JSON.stringify(document));
  return { root, adapter: createAnalyzer({ projectRoot: root }) };
}
async function yamlService(text: string) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-nodejs-yaml-")); roots.push(root);
  await mkdir(join(root, "service", "api", "swagger"), { recursive: true });
  await writeFile(join(root, "service", "api", "swagger", "swagger.yaml"), text);
  return { root, adapter: createAnalyzer({ projectRoot: root }) };
}
function yamlRequest(): AnalyzerRequest {
  const input = request();
  input.resolution_inputs = [{ kind: "type_manifest", path: "service/api/swagger/swagger.yaml", digest: "host-supplied-digest" }];
  return input;
}
function request(): AnalyzerRequest {
  return {
    exchange_version: "1.0.0", ir_version: "1.1.0", request_id: "swagger-test", analyzer: ANALYZER,
    source: { repository_id: "orders-repo", service_id: "orders", service_root: "service", immutable_revision: "a".repeat(40), source_digest: "host-supplied-digest", access_label: "test" },
    resolution_inputs: [{ kind: "type_manifest", path: "service/api/swagger/swagger.json", digest: "host-supplied-digest" }],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 1, max_output_bytes: 1000000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
}
const document = {
  swagger: "2.0", info: { title: "Orders", version: "1" },
  paths: { "/orders/{id}": { parameters: [{ name: "id", in: "path", required: true, type: "string" }],
    get: { operationId: "getOrder", produces: ["application/json"], responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Order" } } } },
  } },
  definitions: { Order: { type: "object", properties: { id: { type: "string" } } } },
};

test("selected Swagger 2 document yields a separate D03-valid declared route", async () => {
  const { adapter } = await service(document);
  const first = await adapter.analyze(request());
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.analyzer).toEqual(ANALYZER);
  expect(first.endpoints).toHaveLength(1);
  expect(first.endpoints[0]).toMatchObject({ application_path: "/orders/{id}", identity: { method: "GET" },
    parameters: [{ name: "id", in: "path", presence: { state: "required" } }],
    responses: [{ status: { kind: "exact", code: 200 }, content: [{ media_type: "application/json" }] }],
    security: { state: "unknown" },
  });
  expect(first.evidence.find(item => item.location.pointer === "/paths/~1orders~1{id}/get")).toMatchObject({ method: "type_declaration" });
  expect(first.claims).toContainEqual(expect.objectContaining({ predicate: "route.declaration", verification: "declared" }));
  expect(first.diagnostics.map(item => item.code)).toContain("middleware_binding_unverified");
  expect(first.diagnostics.map(item => item.code)).not.toContain("json_duplicate_keys_unverified");
  expect(first.dependencies).toContainEqual(expect.objectContaining({ from_endpoint_id: first.endpoints[0]?.endpoint_id,
    to: { kind: "schema", id: expect.stringMatching(/^schema-/) } }));
  expect(first.reproducibility_fingerprint).toBe(second.reproducibility_fingerprint);
  expect(first.endpoints).toEqual(second.endpoints);
});

test("selected Swagger 2 YAML yields declared routes while preserving basePath separately", async () => {
  const { adapter } = await yamlService(`swagger: '2.0'
info:
  title: Orders
  version: '1'
basePath: /api/v1
paths:
  /orders/{id}:
    parameters:
      - name: id
        in: path
        required: true
        type: string
    get:
      responses:
        '200':
          description: ok
`);
  const result = await adapter.analyze(yamlRequest());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints).toHaveLength(1);
  expect(result.endpoints[0]?.application_path).toBe("/orders/{id}");
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "exposure.base_path.declaration", value: "/api/v1" }));
  expect(result.diagnostics.map(item => item.code)).toContain("base_path_requires_middleware_profile");
});

test.each([
  ["duplicate key", "swagger: '2.0'\nswagger: '2.0'\n"],
  ["multiple documents", "swagger: '2.0'\n---\nswagger: '2.0'\n"],
  ["alias", "swagger: '2.0'\ninfo: &details {title: Orders, version: '1'}\ncopy: *details\npaths: {}\n"],
  ["custom tag", "swagger: '2.0'\ninfo: !custom {title: Orders, version: '1'}\npaths: {}\n"],
])("rejects unsafe YAML %s without emitting routes", async (_case, text) => {
  const { adapter } = await yamlService(text);
  const result = await adapter.analyze(yamlRequest());
  expect(result.status).toBe("failed");
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("duplicate document keys fail analysis before any operation is emitted", async () => {
  const { root, adapter } = await service(document);
  await writeFile(join(root, "service", "api", "swagger", "swagger.json"),
    '{"swagger":"2.0","info":{"title":"Orders","version":"1"},"paths":{},"paths":{"/hidden":{"get":{"responses":{"200":{"description":"ok"}}}}}}');
  const result = await adapter.analyze(request());
  expect(result.status).toBe("failed");
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("duplicate_json_key");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("unsupported document facts remain visible and prevent complete coverage", async () => {
  const withUnknown = structuredClone(document) as any;
  withUnknown.paths["/orders/{id}"].get["x-custom-routing"] = true;
  const { adapter } = await service(withUnknown);
  const result = await adapter.analyze(request());
  expect(result.status).toBe("partial");
  expect(result.coverage.status).toBe("incomplete");
  expect(result.diagnostics.map(item => item.code)).toContain("unsupported_field");
  expect(result.endpoints).toHaveLength(1);
});

test("selected malformed document fails safely, and source digest mismatch is rejected", async () => {
  const { adapter } = await service({ swagger: "3.0", paths: {} });
  const failed = await adapter.analyze(request());
  expect(failed.status).toBe("failed");
  expect(failed.endpoints).toEqual([]);
  expect(parseAnalyzerResult(failed).ok).toBe(true);
  const req = request(); req.source.source_digest = `sha256:${"0".repeat(64)}`;
  await expect(adapter.analyze(req)).rejects.toThrow("Source digest mismatch");
});

test("local unsupported routes do not suppress a valid operation or create duplicate route identities", async () => {
  const withConflict = structuredClone(document) as any;
  withConflict.paths["/orders/{key}"] = structuredClone(withConflict.paths["/orders/{id}"]);
  withConflict.paths["relative"] = { get: { responses: { "200": { description: "ok" } } } };
  const { adapter } = await service(withConflict);
  const result = await adapter.analyze(request());
  expect(result.status).toBe("partial");
  expect(result.endpoints).toHaveLength(1);
  expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(["unsupported_construct", "conflicting_route_declarations"]));
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("maps declared Swagger 2 API-key and basic security with document evidence", async () => {
  const secured = structuredClone(document) as any;
  secured.securityDefinitions = {
    apiToken: { type: "apiKey", name: "X-API-Token", in: "header" },
    basic: { type: "basic" },
  };
  secured.security = [{ apiToken: [], basic: [] }, { basic: [] }];
  const { adapter } = await service(secured);
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.security_schemes).toEqual({
    apiToken: { definition: { type: "apiKey", name: "X-API-Token", in: "header" },
      evidence_ids: [expect.any(String)] },
    basic: { definition: { type: "http", scheme: "basic" }, evidence_ids: [expect.any(String)] },
  });
  expect(result.endpoints[0]?.security).toMatchObject({ state: "declared", alternatives: [
    { requirements: [{ scheme: "apiToken", scopes: [] }, { scheme: "basic", scopes: [] }] },
    { requirements: [{ scheme: "basic", scopes: [] }] },
  ] });
  expect(result.evidence).toContainEqual(expect.objectContaining({ location: expect.objectContaining({
    pointer: "/securityDefinitions/apiToken",
  }) }));
  expect(result.diagnostics.map(item => item.code)).not.toContain("security_mapping_unresolved");
});

test("unsupported or missing Swagger security schemes keep operation security unknown", async () => {
  const secured = structuredClone(document) as any;
  secured.securityDefinitions = {
    token: { type: "apiKey", name: "key", in: "header" },
    oauth: { type: "oauth2", flow: "implicit", authorizationUrl: "https://example.test/auth", scopes: {} },
  };
  secured.security = [{ token: [], oauth: [] }, { missing: [] }];
  const { adapter } = await service(secured);
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints[0]?.security).toEqual({ state: "unknown", alternatives: [] });
  expect(result.diagnostics.map(item => item.code)).toContain("security_mapping_unresolved");
  expect(result.security_schemes?.token?.definition).toEqual({ type: "apiKey", name: "key", in: "header" });
  expect(result.security_schemes?.oauth).toBeUndefined();
});

test("operation-level anonymous security overrides inherited requirements", async () => {
  const secured = structuredClone(document) as any;
  secured.securityDefinitions = { token: { type: "apiKey", name: "key", in: "query" } };
  secured.security = [{ token: [] }];
  secured.paths["/orders/{id}"].get.security = [];
  const { adapter } = await service(secured);
  const result = await adapter.analyze(request());
  expect(result.endpoints[0]?.security).toMatchObject({ state: "anonymous", alternatives: [] });
  const securityEvidence = result.evidence.find(item => result.endpoints[0]?.security.evidence_ids?.includes(item.evidence_id));
  expect(securityEvidence?.location.pointer).toBe("/paths/~1orders~1{id}/get/security");
});


test("unsupported profile IR version fails before filesystem access", async () => {
  const adapter = createAnalyzer({ projectRoot: "/missing/profile-version-check" });
  await expect(adapter.analyze({ ...request(), ir_version: "1.0.0" }))
    .rejects.toThrow("Swagger profile requires IR 1.1.0");
});

test("composed and dictionary schemas preserve reusable references and dependency fan-out", async () => {
  const composed = {...document, definitions: {
    Order: {allOf: [{$ref: "#/definitions/Base~1Order~0"}, {type: "object", properties: {
      attributes: {type: "object", additionalProperties: {$ref: "#/definitions/Attribute"}},
      closed: {type: "object", additionalProperties: false},
    }}]},
    "Base/Order~": {type: "object", required: ["id"], properties: {id: {type: "string"}}},
    Attribute: {type: "object", properties: {next: {$ref: "#/definitions/Attribute"}}},
  }};
  const {adapter} = await service(composed);
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  const byPointer = (pointer: string) => Object.values(result.schemas).find(component => component.evidence_ids.some(id =>
    result.evidence.find(item => item.evidence_id === id)?.location.pointer === pointer))!;
  const base = byPointer("/definitions/Base~1Order~0");
  const attribute = byPointer("/definitions/Attribute");
  const order = byPointer("/definitions/Order");
  expect(order.schema).toEqual({allOf: [{$ref: `#/schemas/${base.schema_id}`}, {type: "object", properties: {
    attributes: {type: "object", additionalProperties: {$ref: `#/schemas/${attribute.schema_id}`}},
    closed: {type: "object", additionalProperties: false},
  }}]});
  expect(attribute.schema.properties?.next).toEqual({$ref: `#/schemas/${attribute.schema_id}`});
  expect(result.dependencies.filter(item => item.to.kind === "schema").map(item => item.to.id).sort())
    .toEqual([order.schema_id, base.schema_id, attribute.schema_id].sort());
  expect(result.diagnostics.map(item => item.code)).not.toContain("schema_keyword_unsupported");
  expect((await adapter.analyze(request())).schemas).toEqual(result.schemas);
});

test.each([[], null, 1, ["unsupported"], Array.from({length: 33}, () => ({type: "object"}))].map(value => [value]))(
  "malformed or excessive allOf remains diagnosed: %j", async value => {
    const {adapter} = await service({...document, definitions: {Order: {type: "object", allOf: value}}});
    const result = await adapter.analyze(request());
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.diagnostics.map(item => item.code)).toContain("schema_all_of_unsupported");
    expect(Object.values(result.schemas)[0]!.schema.allOf).toBeUndefined();
    expect(result.endpoints).toHaveLength(1);
    expect(result.status).toBe("partial");
  });

test.each([null, 1, [], "private-schema-marker"].map(value => [value]))("invalid dictionary schema stays unknown: %j", async value => {
  const {adapter} = await service({...document, definitions: {Order: {type: "object", additionalProperties: value}}});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.diagnostics.map(item => item.code)).toContain("schema_additional_properties_unsupported");
  expect(Object.values(result.schemas)[0]!.schema.additionalProperties).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("private-schema-marker");
});

test("inline request composition and open dictionaries preserve their declared shape", async () => {
  const spec = {swagger: "2.0", info: {title: "Synthetic", version: "1"}, consumes: ["application/json"], produces: ["application/json"],
    paths: {"/orders": {post: {parameters: [{in: "body", name: "order", required: true,
      schema: {allOf: [{$ref: "#/definitions/Base"}, {type: "object", additionalProperties: true}]}}],
      responses: {"200": {description: "ok", schema: {type: "object", additionalProperties: {}}}}}}},
    definitions: {Base: {type: "object", properties: {id: {type: "string"}}}}};
  const {adapter} = await service(spec);
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints[0]!.request_bodies[0]!.schema.allOf).toEqual([
    {$ref: `#/schemas/${Object.keys(result.schemas)[0]}`}, {type: "object", additionalProperties: true}]);
  expect(result.endpoints[0]!.responses[0]!.content[0]!.schema).toEqual({type: "object", additionalProperties: {}});
  expect(result.dependencies.filter(item => item.to.kind === "schema")).toHaveLength(1);
  expect(result.claims.some(item => item.predicate === "handler.binding")).toBe(false);
});

test("editing a definition referenced through a dictionary invalidates extraction", async () => {
  const spec = {...document, definitions: {
    Order: {type: "object", additionalProperties: {$ref: "#/definitions/Value"}}, Value: {type: "string"},
  }};
  const {root, adapter} = await service(spec);
  const first = await adapter.analyze(request());
  spec.definitions.Value.type = "integer";
  await writeFile(join(root, "service/api/swagger/swagger.json"), JSON.stringify(spec));
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(second).ok).toBe(true);
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.endpoints[0]!.endpoint_id).toBe(first.endpoints[0]!.endpoint_id);
  expect(second.dependencies.filter(item => item.to.kind === "schema")).toHaveLength(2);
  expect(Object.values(second.schemas).some(item => item.schema.type === "integer")).toBe(true);
});

test.each([["A/B", "#/definitions/A/B"], ["A~2B", "#/definitions/A~2B"], ["A~", "#/definitions/A~"],
  ["%41", "#/definitions/%41"], ["A#B", "#/definitions/A#B"], ["A B", "#/definitions/A B"], ["A\n", "#/definitions/A\n"], ["A\r", "#/definitions/A\r"]])("unsupported definition pointer token cannot invent a reference: %s", async (name, ref) => {
  const {adapter} = await service({...document, definitions: {
    Order: {allOf: [{$ref: ref}]}, [name]: {type: "string"},
  }});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  const order = Object.values(result.schemas).find(component => component.evidence_ids.some(id =>
    result.evidence.find(item => item.evidence_id === id)?.location.pointer === "/definitions/Order"))!;
  expect(order.schema.allOf).toEqual([{}]);
  expect(result.diagnostics.map(item => item.code)).toContain("schema_ref_unsupported");
  expect(result.dependencies.filter(item => item.to.kind === "schema").map(item => item.to.id)).toEqual([order.schema_id]);
});

test("schema bounds preserve zero, fractional numeric bounds and nested size declarations", async () => {
  const schema = {type: "object", properties: {
    amount: {type: "number", minimum: 0, maximum: 10.5, exclusiveMinimum: false, exclusiveMaximum: false},
    label: {type: "string", minLength: 0, maxLength: 12},
    values: {type: "array", minItems: 0, maxItems: 4, items: {type: "integer", minimum: -2, maximum: 3}},
  }};
  const {adapter} = await service({...document, definitions: {Order: schema}});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(Object.values(result.schemas)[0]!.schema).toEqual({type: "object", properties: {
    amount: {type: "number", minimum: 0, maximum: 10.5}, label: {type: "string", minLength: 0, maxLength: 12},
    values: {type: "array", minItems: 0, maxItems: 4, items: {type: "integer", minimum: -2, maximum: 3}},
  }});
  expect(result.diagnostics.map(item => item.code)).not.toContain("schema_keyword_unsupported");
});

test.each(["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"])(
  "malformed %s is omitted with a precise declaration diagnostic", async key => {
    const {adapter} = await service({...document, definitions: {Order: {type: "object", [key]: "private-limit-marker"}}});
    const result = await adapter.analyze(request());
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(Object.values(result.schemas)[0]!.schema).toEqual({type: "object"});
    const diagnostic = result.diagnostics.find(item => item.code === "schema_bound_unsupported")!;
    expect(result.evidence.filter(item => diagnostic.evidence_ids.includes(item.evidence_id)).map(item => item.location.pointer))
      .toContain(`/definitions/Order/${key}`);
    expect(JSON.stringify(result)).not.toContain("private-limit-marker");
  });

test.each([[-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])("invalid size limits stay unknown: %s", async value => {
  const {adapter} = await service({...document, definitions: {Order: {type: "array", minItems: value}}});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(Object.values(result.schemas)[0]!.schema.minItems).toBeUndefined();
  expect(result.diagnostics.map(item => item.code)).toContain("schema_bound_unsupported");
});

test.each([["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]])(
  "contradictory %s/%s declarations are diagnosed together", async (lower, upper) => {
    const {adapter} = await service({...document, definitions: {Order: {[lower]: 5, [upper]: 2}}});
    const result = await adapter.analyze(request());
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(Object.values(result.schemas)[0]!.schema).toEqual({});
    expect(result.diagnostics.map(item => item.code)).toContain("schema_bounds_conflict");
  });

test.each([[true], ["false"], [null]])("exclusive or invalid bounds never become inclusive: %s", async exclusive => {
  const {adapter} = await service({...document, definitions: {Order: {type: "number", minimum: 1, maximum: 9,
    exclusiveMinimum: exclusive, exclusiveMaximum: exclusive}}});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(Object.values(result.schemas)[0]!.schema).toEqual({type: "number"});
  expect(result.diagnostics.map(item => item.code)).toContain("schema_exclusive_bound_unsupported");
});

test.each([["id", "id"], [""], [1], null, "id"].map(value => [value]))(
  "malformed schema required list preserves routes with diagnostics: %j", async required => {
    const {adapter} = await service({...document, definitions: {Order: {type: "object", required}}});
    const result = await adapter.analyze(request());
    expect(parseAnalyzerResult(result).ok).toBe(true);
    expect(result.endpoints).toHaveLength(1);
    expect(Object.values(result.schemas)[0]!.schema.required).toBeUndefined();
    expect(result.diagnostics.map(item => item.code)).toContain("schema_required_unsupported");
  });

test("query, path and header limits use the same declared-bound conversion", async () => {
  const spec = {...document, paths: {"/orders/{id}": {get: {
    parameters: [{name: "id", in: "path", required: true, type: "string", minLength: 1, maxLength: 40},
      {name: "count", in: "query", type: "integer", minimum: 0, maximum: 100},
      {name: "X-Tags", in: "header", type: "array", minItems: 1, maxItems: 5, items: {type: "string"}}],
    responses: {"200": {description: "ok"}},
  }}}};
  const {adapter} = await service(spec);
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints[0]!.parameters.map(item => item.schema)).toEqual([
    {type: "string", minLength: 1, maxLength: 40}, {type: "integer", minimum: 0, maximum: 100},
    {type: "array", minItems: 1, maxItems: 5, items: {type: "string"}},
  ]);
  expect(result.diagnostics.map(item => item.code)).not.toContain("parameter_keyword_unsupported");
  expect(result.claims.some(item => item.predicate === "handler.binding")).toBe(false);
});

test("one exclusive bound leaves the independent inclusive bound declared", async () => {
  const {adapter} = await service({...document, definitions: {Order: {type: "number", minimum: 1, maximum: 9, exclusiveMinimum: true}}});
  const result = await adapter.analyze(request());
  expect(Object.values(result.schemas)[0]!.schema).toEqual({type: "number", maximum: 9});
  expect(result.diagnostics.map(item => item.code)).toContain("schema_exclusive_bound_unsupported");
});

test("standalone exclusivity flags and valid required lists remain explicit", async () => {
  const {adapter} = await service({...document, definitions: {Order: {type: "object", required: ["id"],
    exclusiveMinimum: false, properties: {id: {type: "string"}}}}});
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(Object.values(result.schemas)[0]!.schema.required).toEqual(["id"]);
  expect(result.diagnostics.map(item => item.code)).toContain("schema_exclusive_bound_unsupported");
});

test("a declared limit edit invalidates extraction without changing endpoint identity", async () => {
  const spec = {...document, definitions: {Order: {type: "number", minimum: 0, maximum: 9}}};
  const {root, adapter} = await service(spec);
  const first = await adapter.analyze(request());
  spec.definitions.Order.maximum = 8;
  await writeFile(join(root, "service/api/swagger/swagger.json"), JSON.stringify(spec));
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(second).ok).toBe(true);
  expect(second.reproducibility_fingerprint).not.toBe(first.reproducibility_fingerprint);
  expect(second.endpoints[0]!.endpoint_id).toBe(first.endpoints[0]!.endpoint_id);
  expect(Object.values(second.schemas)[0]!.schema.maximum).toBe(8);
  expect(second.dependencies.filter(item => item.to.kind === "schema")).toHaveLength(1);
});
