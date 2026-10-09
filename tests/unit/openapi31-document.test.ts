import {expect, test} from "vitest";
import {ANALYZER, extractOpenApi31Document} from "../../analyzers/openapi31/src/index.js";
import {parseAnalyzerResult, type AnalyzerRequest} from "../../packages/ir/src/index.js";

const request: AnalyzerRequest = {exchange_version: "1.0.0", ir_version: "1.1.0", request_id: "oas31-test", analyzer: ANALYZER,
  source: {repository_id: "repo", service_id: "svc", service_root: "service", immutable_revision: "a".repeat(40), source_digest: "sha256:" + "a".repeat(64), access_label: "test"},
  resolution_inputs: [{kind: "type_manifest", path: "service/openapi.json", digest: "sha256:" + "a".repeat(64)}], prior_dependencies: [],
  changed_paths: [], extraction_mode: "baseline", limits: {timeout_ms: 30000, max_files: 1, max_output_bytes: 1_000_000},
  execution_policy: {network_access: false, side_effects: "none"}};
const doc = (schema: unknown, openapi = "3.1.1") => ({openapi, info: {title: "Orders", version: "1"}, paths: {"/orders": {post: {
  requestBody: {content: {"application/json": {schema}}}, responses: {"200": {description: "ok"}},
}}}, components: {schemas: {Order: schema}}});
const run = (value: unknown) => extractOpenApi31Document(request, "service/openapi.json", JSON.stringify(value));

test("3.1 accepts exact 3.1.0/3.1.1 and projects unions, const, and prefixItems", () => {
  const value = doc({type: ["object", "null"], properties: {kind: {const: "order"}, tuple: {type: "array", prefixItems: [{type: "string"}, {type: "integer"}]}}});
  for (const version of ["3.1.0", "3.1.1"]) {
    const result = run({...value, openapi: version});
    const parsed = parseAnalyzerResult(result);
    expect(parsed.ok).toBe(true);
    expect(result.status).toBe("partial");
    expect(Object.values(result.schemas)[0]?.schema).toMatchObject({type: ["object", "null"], properties: {
      kind: {const: "order"}, tuple: {type: "array", prefixItems: [{type: "string"}, {type: "integer"}]},
    }});
    const malformed = structuredClone(result) as any;
    malformed.schemas[Object.keys(malformed.schemas)[0]!].schema.type = ["object", "mystery"];
    expect(parseAnalyzerResult(malformed).ok).toBe(false);
  }
});

test.each([
  ["boolean schema", false], ["nested boolean schema", {type: "object", additionalProperties: false}],
  ["unknown keyword", {type: "string", contentEncoding: "base64"}],
  ["$id resource", {$id: "https://example.test/schema", type: "string"}],
  ["$anchor", {$anchor: "thing", type: "string"}], ["$dynamicRef", {$dynamicRef: "#node"}],
  ["$schema", {$schema: "https://json-schema.org/draft/2020-12/schema", type: "string"}],
  ["reference sibling", {$ref: "#/components/schemas/Named", minLength: 2}],
  ["const sibling through reference", {$ref: "#/components/schemas/Named", const: "x"}],
])("unsupported %s withholds the affected schema projection", (_label, schema) => {
  const result = run(doc(schema));
  expect(result.status).toBe("partial");
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(Object.values(result.schemas)).toHaveLength(0);
  expect(result.endpoints[0]?.request_bodies[0]?.schema).toEqual({});
  expect(result.claims.find(c => c.predicate === "request.body.declaration")?.value).not.toHaveProperty("schema");
});

test("custom dialect withholds every schema projection while preserving bounded route declaration", () => {
  const value: any = {...doc({type: "string"}), jsonSchemaDialect: "https://example.test/dialect"};
  value.paths["/orders"].post.parameters = [{name: "filter", in: "query", schema: {type: "string"}},
    {name: "format", in: "query", content: {"application/json": {schema: {type: "string"}}}}];
  value.paths["/orders"].post.responses = {"200": {description: "ok", headers: {"X-Order": {schema: {type: "string"}}},
    content: {"application/json": {schema: {type: "string"}}}}};
  const result = run(value);
  expect(result.status).toBe("partial");
  expect(result.endpoints).toHaveLength(1);
  expect(Object.values(result.schemas)).toHaveLength(0);
  expect(result.endpoints[0]?.request_bodies[0]?.schema).toEqual({});
  expect(result.claims.map(c => c.predicate)).not.toContain("parameter.schema.declaration");
  expect(result.claims.find(c => c.predicate === "parameter.content.declaration")?.value).not.toHaveProperty("schema");
  expect(result.claims.map(c => c.predicate)).not.toContain("response.header.schema");
  expect(result.claims.find(c => c.predicate === "request.body.declaration")?.value).not.toHaveProperty("schema");
  expect(result.claims.some(c => c.predicate === "response.schema.declaration")).toBe(false);
});

test("the default base dialect is accepted, while malformed type unions are diagnosed and withheld", () => {
  const baseDialect = "https://spec.openapis.org/oas/3.1/dialect/base";
  const supported = run({...doc({type: "string"}), jsonSchemaDialect: baseDialect});
  expect(Object.values(supported.schemas)).toHaveLength(1);
  const malformed = run(doc({type: ["object", "mystery"], properties: {id: {type: "string"}}}));
  expect(malformed.diagnostics.map(d => d.code)).toContain("schema_type_unsupported");
  expect(Object.values(malformed.schemas)).toHaveLength(0);
  expect(malformed.endpoints[0]?.request_bodies[0]?.schema).toEqual({});
  const invalidScalar = run(doc({type: "objectish"}));
  expect(invalidScalar.diagnostics.map(d => d.code)).toContain("schema_type_unsupported");
  expect(Object.values(invalidScalar.schemas)).toHaveLength(0);
});

test("pointer references retain shared component identity and 3.1 profile fingerprint differs", () => {
  const value = {...doc({$ref: "#/components/schemas/Order"}), components: {schemas: {Order: {type: ["string", "null"]}}}};
  const result = run(value);
  expect(result.status).toBe("partial");
  expect(result.endpoints[0]?.request_bodies[0]?.schema.$ref).toMatch(/^#\/schemas\/schema-/);
  expect(result.reproducibility_fingerprint).toMatch(/^sha256:/);
});

test("component names with escaped pointer characters resolve through own properties", () => {
  const componentName = "User/Config~v1";
  const value = {...doc({$ref: "#/components/schemas/User~1Config~0v1"}), components: {schemas: {[componentName]: {type: "string"}}}};
  const result = run(value);
  expect(result.endpoints[0]?.request_bodies[0]?.schema.$ref).toMatch(/^#\/schemas\/schema-/);
  expect(Object.values(result.schemas)).toHaveLength(1);
});

test("const object values are literal JSON data even when they contain reference-looking and special keys", () => {
  const literal = JSON.parse('{"$ref":"https://example.test/literal","constructor":"literal data"}');
  const result = run(doc({const: literal}));
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(Object.values(result.schemas)[0]?.schema.const).toEqual(literal);
});

test("oversized component compositions withhold every ref use without dangling schema IDs", () => {
  const ref = {$ref: "#/components/schemas/Many"};
  const value: any = {...doc(ref), components: {schemas: {Many: {oneOf: Array.from({length: 33}, () => ({type: "string"}))}}}};
  value.paths["/orders"].post.parameters = [{name: "filter", in: "query", schema: ref}];
  value.paths["/orders"].post.responses = {"200": {description: "ok", headers: {"X-Order": {schema: ref}},
    content: {"application/json": {schema: ref}}}};
  const result = run(value);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.status).toBe("partial");
  expect(result.diagnostics.map(d => d.code)).toContain("schema_composition_unsupported");
  expect(Object.values(result.schemas)).toHaveLength(0);
  expect(result.endpoints[0]?.request_bodies[0]?.schema).toEqual({});
  expect(result.endpoints[0]?.parameters[0]?.schema).toEqual({});
  expect(result.claims.map(c => c.predicate)).not.toContain("parameter.schema.declaration");
  expect(result.claims.map(c => c.predicate)).not.toContain("response.header.schema");
  expect(result.claims.some(c => c.predicate === "response.schema.declaration")).toBe(false);
});

test("a shared unsupported component stays withheld at every repeated use despite deduplicated diagnostics", () => {
  const unsupported = {$ref: "#/components/schemas/Order"};
  const value: any = {...doc(unsupported), components: {schemas: {Order: {
    type: "object", properties: {id: {type: "string", contentEncoding: "base64"}},
  }}}};
  value.paths["/orders"].post.parameters = [{name: "filter", in: "query", schema: unsupported}];
  value.paths["/orders"].post.responses = {"200": {description: "ok", headers: {"X-Order": {schema: unsupported}},
    content: {"application/json": {schema: unsupported}}}};
  const result = run(value);
  expect(result.diagnostics.filter(d => d.code === "schema_keyword_unsupported").length).toBeGreaterThan(0);
  expect(Object.values(result.schemas)).toHaveLength(0);
  expect(result.claims.map(c => c.predicate)).not.toContain("parameter.schema.declaration");
  expect(result.claims.some(c => c.predicate === "parameter.content.declaration" && c.value !== null
    && typeof c.value === "object" && !Array.isArray(c.value) && Object.hasOwn(c.value, "schema"))).toBe(false);
  expect(result.claims.map(c => c.predicate)).not.toContain("response.header.schema");
  expect(result.claims.some(c => c.predicate === "response.schema.declaration")).toBe(false);
  expect(result.claims.find(c => c.predicate === "request.body.declaration")?.value).not.toHaveProperty("schema");
});

test("unsupported JSON Schema version and non-pointer references do not guess dialects or fetch", () => {
  expect(run(doc({type: "string"}, "3.1.2")).status).toBe("failed");
  const result = run(doc({$ref: "other.json#/$defs/Order"}));
  expect(result.status).toBe("failed");
  expect(result.endpoints).toEqual([]);
});

test("tuple prefix references retain endpoint-to-component evidence dependencies",()=>{
  const tuple={type:"array",prefixItems:[{$ref:"#/components/schemas/Named"}]};
  const value={...doc(tuple),components:{schemas:{Named:{type:"string"}}}};
  const result=run(value);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  const named=Object.values(result.schemas).find(item=>item.schema.type==="string")!;
  expect(result.dependencies.some(item=>item.from_endpoint_id===result.endpoints[0]?.endpoint_id
    &&item.to.kind==="schema"&&item.to.id===named.schema_id)).toBe(true);
});


test("percent-encoded URI fragments are rejected instead of resolving a literal percent component", () => {
  const value = {...doc({$ref: "#/components/schemas/Foo%20Bar"}), components: {schemas: {
    "Foo Bar": {type: "integer"}, "Foo%20Bar": {type: "string"},
  }}};
  const result = run(value);
  expect(result.status).toBe("failed");
  expect(result.diagnostics.map(item => item.code)).toContain("percent_encoded_reference_unsupported");
  expect(result.endpoints).toHaveLength(0);
  expect(result.claims).toHaveLength(0);
});

test("object-valued union members are diagnosed without coercing source JSON", () => {
  const result = run(doc({type: ["string", {toString: "untrusted"}]}));
  expect(result.diagnostics.map(item => item.code)).toContain("schema_type_unsupported");
  expect(Object.values(result.schemas)).toHaveLength(0);
});
