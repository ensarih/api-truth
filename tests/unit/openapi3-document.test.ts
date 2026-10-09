import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, test} from "vitest";
import {ANALYZER, createAnalyzer} from "../../analyzers/openapi3/src/index.js";
import {parseAnalyzerResult, type AnalyzerRequest} from "../../packages/ir/src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
const document = {
  openapi: "3.0.3", info: {title: "Orders", version: "1"},
  servers: [{url: "https://one.example/v1"}, {url: "https://two.example/{version}", variables: {version: {default: "v2"}}}],
  paths: {"/orders/{id}": {
    parameters: [{name: "id", in: "path", required: true, schema: {type: "string"}}],
    post: {parameters: [{name: "id", in: "path", required: true, schema: {type: "integer"}},
      {name: "filter", in: "query", style: "form", explode: false, schema: {type: "array", items: {type: "string"}}}],
    requestBody: {$ref: "#/components/requestBodies/OrderInput"},
    responses: {"201": {$ref: "#/components/responses/Created"}}, security: [{key: []}]},
  }},
  components: {
    schemas: {Order: {type: "object", properties: {id: {type: "string"}}}},
    requestBodies: {OrderInput: {required: true, content: {
      "application/json": {schema: {$ref: "#/components/schemas/Order"}},
      "application/xml": {schema: {type: "string"}},
    }}},
    responses: {Created: {description: "created", headers: {"X-Count": {schema: {type: "integer"}}}, content: {
      "application/json": {schema: {$ref: "#/components/schemas/Order"}},
      "text/plain": {schema: {type: "string"}},
    }}},
    securitySchemes: {key: {type: "apiKey", name: "X-API-Key", in: "header"}},
  },
};
function request(path: string): AnalyzerRequest {
  return {exchange_version: "1.0.0", ir_version: "1.1.0", request_id: "openapi3-test", analyzer: ANALYZER,
    source: {repository_id: "orders-repo", service_id: "orders", service_root: "service",
      immutable_revision: "a".repeat(40), source_digest: "host-supplied-digest", access_label: "test"},
    resolution_inputs: [{kind: "type_manifest", path, digest: "host-supplied-digest"}], prior_dependencies: [],
    changed_paths: [], extraction_mode: "baseline", limits: {timeout_ms: 30000, max_files: 1, max_output_bytes: 1000000},
    execution_policy: {network_access: false, side_effects: "none"}};
}
async function analyze(input: unknown, extension = "json") {
  const root = await mkdtemp(join(tmpdir(), "api-truth-openapi3-")); roots.push(root);
  await mkdir(join(root, "service"));
  const path = `service/openapi.${extension}`;
  await writeFile(join(root, path), typeof input === "string" ? input : JSON.stringify(input));
  return createAnalyzer({projectRoot: root}).analyze(request(path));
}

test("selected 3.0 document preserves media variants, overrides, refs and server declarations", async () => {
  const result = await analyze(document);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints).toHaveLength(1);
  const endpoint = result.endpoints[0]!;
  expect(endpoint.application_path).toBe("/orders/{id}");
  expect(endpoint.parameters.find(p => p.name === "id")).toMatchObject({presence: {state: "required"}, schema: {type: "integer"}});
  expect(endpoint.parameters.find(p => p.name === "filter")?.serialization).toMatchObject({style: "form", explode: false});
  expect(endpoint.request_bodies.map(body => body.media_type)).toEqual(["application/json", "application/xml"]);
  expect(endpoint.request_bodies.every(body => body.presence.state === "required")).toBe(true);
  expect(endpoint.responses[0]?.content.map(content => content.media_type)).toEqual(["application/json", "text/plain"]);
  expect(endpoint.responses[0]?.headers?.[0]?.name).toBe("X-Count");
  expect(endpoint.security.state).toBe("declared");
  expect(result.claims).toContainEqual(expect.objectContaining({predicate: "exposure.servers.declaration", verification: "declared"}));
  expect(result.dependencies).toContainEqual(expect.objectContaining({from_endpoint_id: endpoint.endpoint_id,
    to: {kind: "schema", id: expect.stringMatching(/^schema-/)}}));
});

test("fixture YAML is analyzed with stable declared routes and two server options", async () => {
  const fixture = await readFile(new URL("../../fixtures/openapi3/orders/openapi.yaml", import.meta.url), "utf8");
  const result = await analyze(fixture, "yaml");
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints[0]?.application_path).toBe("/orders/{id}");
  expect(result.endpoints[0]?.responses[0]?.content.map(c => c.media_type)).toEqual(["application/json", "application/xml"]);
  expect(result.claims.find(c => c.predicate === "exposure.servers.declaration")?.value).toHaveLength(2);
});

test("3.1 explicitly fails and remote references fail without network access", async () => {
  expect((await analyze({...document, openapi: "3.1.0"})).status).toBe("failed");
  const remote = structuredClone(document) as any;
  remote.components.requestBodies.OrderInput.content["application/json"].schema.$ref = "https://example.test/order";
  const result = await analyze(remote);
  expect(result.status).toBe("failed");
  expect(result.endpoints).toEqual([]);
});

test("unsupported serialization and optional path parameter are partial, never silently required", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.parameters[0].required = false;
  input.paths["/orders/{id}"].post.parameters.push({name: "session", in: "cookie", schema: {type: "string"}});
  input.paths["/orders/{id}"].post.requestBody = {content: {"multipart/form-data": {
    schema: {type: "object"}, encoding: {file: {headers: {"X-Mode": {schema: {type: "string"}}}}},
  }}};
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.coverage.status).toBe("incomplete");
  expect(result.diagnostics.map(d => d.code)).toContain("optional_path_parameter_unsupported");
  expect(result.diagnostics.map(d => d.code)).toContain("encoding_unsupported");
  expect(result.endpoints[0]?.parameters.find(p => p.name === "id")?.presence.state).toBe("unknown");
});

test("strict parser rejects duplicate YAML keys and hostile JSON keys", async () => {
  const duplicate = await analyze("openapi: 3.0.3\ninfo: {title: Orders, version: '1'}\npaths: {}\npaths: {}\n", "yaml");
  expect(duplicate.status).toBe("failed");
  const hostile = await analyze('{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{},"__proto__":{}}');
  expect(hostile.status).toBe("failed");
});

test("parameter content, cookie serialization, form encoding and path servers keep their declarations", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].servers = [{url: "https://path.example/v3"}];
  input.paths["/orders/{id}"].post.parameters.push(
    {name: "token", in: "cookie", schema: {type: "string"}},
    {name: "format", in: "query", content: {"application/json": {schema: {type: "string"}}}},
  );
  input.paths["/orders/{id}"].post.requestBody = {content: {"application/x-www-form-urlencoded": {
    schema: {type: "object", properties: {tags: {type: "array", items: {type: "string"}}}},
    encoding: {tags: {style: "pipeDelimited", explode: false}},
  }}};
  const result = await analyze(input);
  const endpoint = result.endpoints[0]!;
  expect(endpoint.parameters.find(p => p.name === "token")?.serialization).toEqual({style: "form", explode: true});
  expect(endpoint.parameters.find(p => p.name === "format")?.serialization).toEqual({content_encoding: "application/json"});
  expect(endpoint.request_bodies[0]?.encoding?.tags).toMatchObject({style: "pipeDelimited", explode: false});
  expect(result.claims.filter(c => c.predicate === "exposure.servers.declaration" && c.subject.endpoint_id === endpoint.endpoint_id)
    .map(c => c.value)).toEqual([[{url: "https://path.example/v3"}]]);
});

test("encoding that IR cannot represent stays a declaration with an incomplete result", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.requestBody = {content: {"application/x-www-form-urlencoded": {
    schema: {type: "object", properties: {tags: {type: "array", items: {type: "string"}}}},
    encoding: {tags: {style: "pipeDelimited", explode: false, contentType: "text/plain"}},
  }}};
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.endpoints[0]?.request_bodies[0]?.encoding).toBeUndefined();
  expect(result.claims.map(c => c.predicate)).toContain("request.body.encoding.declaration");
  expect(result.diagnostics.map(d => d.code)).toContain("encoding_unsupported");
});

test("optional security alternative and malformed query style remain unknown", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.security = [{}, {key: []}];
  input.paths["/orders/{id}"].post.parameters[1].style = "deepObject";
  const result = await analyze(input);
  expect(result.endpoints[0]?.security.state).toBe("unknown");
  expect(result.endpoints[0]?.parameters.find(p => p.name === "filter")?.serialization).toEqual({format: "openapi3-unresolved"});
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining([
    "optional_security_unsupported", "parameter_serialization_unsupported",
  ]));
});

test("literal enum and example data containing $ref do not trigger reference loading", async () => {
  const input = structuredClone(document) as any;
  input.components.schemas.Order.properties.id.enum = ["open", {"$ref": "https://literal.example/value"}];
  input.components.schemas.Order.properties.id.example = {"$ref": "https://literal.example/example"};
  const result = await analyze(input);
  expect(result.status).not.toBe("failed");
  expect(result.diagnostics.map(d => d.code)).not.toContain("external_ref");
});

test("same-list duplicate parameters with conflicting requiredness and schemas are withheld", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.parameters.push(
    {name: "filter", in: "query", required: true, schema: {type: "integer"}},
  );
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.endpoints[0]?.parameters.find(p => p.name === "filter")).toBeUndefined();
  expect(result.claims.filter(c => c.subject.endpoint_id === result.endpoints[0]?.endpoint_id
    && c.predicate.startsWith("parameter.") && JSON.stringify(c.value).includes("filter"))).toHaveLength(0);
  expect(result.diagnostics.map(d => d.code)).toContain("duplicate_parameter");
});

test("parameter schema and content conflict does not create an empty schema declaration", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.parameters.push({name: "mode", in: "query", required: true,
    schema: {type: "integer"}, content: {"application/json": {schema: {type: "string"}}}});
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.endpoints[0]?.parameters.find(p => p.name === "mode")).toBeUndefined();
  expect(result.claims.filter(c => c.subject.endpoint_id === result.endpoints[0]?.endpoint_id
    && c.predicate.startsWith("parameter.") && JSON.stringify(c.value).includes("mode"))).toHaveLength(0);
  expect(result.diagnostics.map(d => d.code)).toContain("parameter_schema_content_conflict");
});

test("empty responses and missing description are diagnosed", async () => {
  const empty = structuredClone(document) as any;
  empty.paths["/orders/{id}"].post.responses = {};
  const emptyResult = await analyze(empty);
  expect(emptyResult.status).toBe("partial");
  expect(emptyResult.endpoints[0]?.responses[0]?.status.kind).toBe("unknown");
  expect(emptyResult.diagnostics.map(d => d.code)).toContain("responses_empty");
  const missing = structuredClone(document) as any;
  missing.components.responses.Created.description = undefined;
  const missingResult = await analyze(missing);
  expect(missingResult.diagnostics.map(d => d.code)).toContain("response_description_missing");
});

test("malformed media and unsupported local reference siblings remain visible", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.requestBody = {$ref: "#/components/requestBodies/OrderInput", required: false};
  input.components.responses.Created.content["bad media"] = {schema: {type: "string"}};
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.endpoints[0]?.responses[0]?.content.some(c => c.media_type === "bad media")).toBe(false);
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining([
    "response_media_unsupported", "reference_siblings_unsupported",
  ]));
});

test("cyclic reusable responses retain selector without inventing response content", async () => {
  const input = structuredClone(document) as any;
  input.components.responses.Created = {$ref: "#/components/responses/Created"};
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.endpoints[0]?.responses[0]).toMatchObject({status: {kind: "exact", code: 201}, content: []});
  expect(result.diagnostics.map(d => d.code)).toContain("local_ref_unsupported");
});

test("invalid security and server forms stay visible without a declared security conclusion", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.security = [{missing: ["read"]}];
  input.components.securitySchemes.key.name = 123;
  input.paths["/orders/{id}"].post.servers = [{url: "https://api.example/{version}", variables: {version: {enum: ["v1"]}}}];
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.endpoints[0]?.security.state).toBe("unknown");
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining([
    "security_mapping_unresolved", "security_scheme_unsupported", "server_variables_unsupported",
  ]));
});

test("request body on a method with undefined body semantics is withheld", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].get = {
    requestBody: {content: {"application/json": {schema: {type: "object"}}}},
    responses: {"200": {description: "ok"}},
  };
  const result = await analyze(input);
  const endpoint = result.endpoints.find(e => e.identity.method === "GET")!;
  expect(endpoint.request_bodies).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toContain("request_body_method_unsupported");
});

test("missing schema references retain media declarations without empty schema claims", async () => {
  const input = structuredClone(document) as any;
  input.components.requestBodies.OrderInput.content["application/json"].schema.$ref = "#/components/schemas/Missing";
  input.components.responses.Created.content["application/json"].schema.$ref = "#/components/schemas/Missing";
  const result = await analyze(input);
  expect(result.status).toBe("partial");
  expect(result.diagnostics.map(d => d.code)).toContain("missing_local_ref");
  expect(result.claims.filter(c => c.predicate === "response.schema.declaration" && JSON.stringify(c.value).includes("application/json"))).toHaveLength(0);
  expect(result.claims.filter(c => c.predicate === "request.body.declaration" && JSON.stringify(c.value).includes("application/json"))
    .every(c => !(c.value as Record<string, unknown>).schema)).toBe(true);
});

test("spec defaults are inferred from their object, while explicit requiredness is declared", async () => {
  const input = structuredClone(document) as any;
  delete input.components.requestBodies.OrderInput.required;
  const result = await analyze(input);
  const filterPresence = result.claims.find(c => c.predicate === "parameter.presence"
    && (c.value as Record<string, unknown>).name === "filter")!;
  const idPresence = result.claims.find(c => c.predicate === "parameter.presence"
    && (c.value as Record<string, unknown>).name === "id")!;
  const idSerialization = result.claims.find(c => c.predicate === "parameter.serialization"
    && (c.value as Record<string, unknown>).name === "id")!;
  const bodyPresence = result.claims.find(c => c.predicate === "request.body.presence")!;
  const bodyDeclaration = result.claims.find(c => c.predicate === "request.body.declaration")!;
  expect(filterPresence.verification).toBe("inferred");
  expect(result.evidence.find(e => e.evidence_id === filterPresence.evidence_ids[0])?.location.pointer)
    .toBe("/paths/~1orders~1{id}/post/parameters/1");
  expect(idPresence.verification).toBe("declared");
  expect(idSerialization.verification).toBe("inferred");
  expect(bodyPresence.verification).toBe("inferred");
  expect(bodyDeclaration.evidence_ids.map(id => result.evidence.find(e => e.evidence_id === id)?.location.pointer))
    .not.toContain("/components/requestBodies/OrderInput/required");
});


test("explicit serialization carries exact style and explode evidence", async () => {
  const input = structuredClone(document) as any;
  input.paths["/orders/{id}"].post.parameters[1].style = "form";
  input.paths["/orders/{id}"].post.parameters[1].explode = true;
  const result = await analyze(input);
  const claim = result.claims.find(c => c.predicate === "parameter.serialization"
    && (c.value as Record<string, unknown>).name === "filter")!;
  expect(claim.verification).toBe("declared");
  const pointers = claim.evidence_ids.map(id => result.evidence.find(e => e.evidence_id === id)?.location.pointer);
  expect(pointers).toContain("/paths/~1orders~1{id}/post/parameters/1/style");
  expect(pointers).toContain("/paths/~1orders~1{id}/post/parameters/1/explode");
});
