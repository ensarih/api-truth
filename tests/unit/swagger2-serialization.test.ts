import { expect, test } from "vitest";
import { ANALYZER, extractSwagger2Document } from "../../analyzers/nodejs/src/index.js";
import { parseAnalyzerResult, type AnalyzerRequest } from "../../packages/ir/src/index.js";

const request: AnalyzerRequest = {
  exchange_version: "1.0.0", ir_version: "1.1.0", request_id: "serialization",
  analyzer: ANALYZER,
  source: {repository_id: "example", service_id: "example", service_root: ".",
    immutable_revision: "a".repeat(40), source_digest: "test", access_label: "test"},
  resolution_inputs: [{kind: "type_manifest", path: "swagger.json", digest: "test"}],
  prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
  limits: {timeout_ms: 30000, max_files: 1, max_output_bytes: 1000000},
  execution_policy: {network_access: false, side_effects: "none"},
};
function analyze(parameters: unknown[], options: {consumes?: string[]; globalConsumes?: string[]; path?: string | undefined; inherited?: unknown[]} = {}) {
  const document = {swagger: "2.0", info: {title: "Example", version: "1"},
    ...(options.globalConsumes ? {consumes: options.globalConsumes} : {}),
    paths: {[options.path ?? "/example"]: {
      ...(options.inherited ? {parameters: options.inherited} : {}),
      post: {parameters, ...(options.consumes ? {consumes: options.consumes} : {}),
        responses: {"200": {description: "ok"}}},
    }},
  };
  const result = extractSwagger2Document(request, "swagger.json", JSON.stringify(document));
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints).toHaveLength(1);
  return result;
}
const array = (location: string, format?: string) => ({name: "values", in: location,
  ...(location === "path" ? {required: true} : {}), type: "array", items: {type: "string"},
  ...(format === undefined ? {} : {collectionFormat: format})});

test.each([
  ["query", undefined, "form", false], ["query", "csv", "form", false],
  ["query", "ssv", "spaceDelimited", false], ["query", "pipes", "pipeDelimited", false],
  ["query", "multi", "form", true], ["header", "csv", "simple", false],
  ["path", undefined, "simple", false],
])("maps %s array %s without replacing the delimiter", (location, format, style, explode) => {
  const result = analyze([array(location as string, format)], {path: location === "path" ? "/example/{values}" : undefined});
  expect(result.endpoints[0]?.parameters[0]?.serialization).toEqual({style, explode});
  const declaration = result.claims.find(item => item.predicate === "parameter.serialization");
  expect(declaration).toMatchObject({verification: "declared", value: {style, explode}});
  expect(result.evidence.find(item => declaration?.evidence_ids.includes(item.evidence_id))?.location.pointer)
    .toBe("/paths/~1example" + (location === "path" ? "~1{values}" : "") + "/post/parameters/0");
});

test.each([
  ["query", "tsv"], ["path", "multi"], ["header", "pipes"], ["query", "unknown"],
])("keeps unsupported %s serialization %s unresolved", (location, format) => {
  const result = analyze([array(location, format)], {path: location === "path" ? "/example/{values}" : undefined});
  expect(result.endpoints[0]?.parameters[0]?.serialization).toEqual({format: "swagger2-unresolved"});
  expect(result.diagnostics.map(item => item.code)).toContain("parameter_serialization_unresolved");
  expect(result.claims.some(item => item.predicate === "parameter.serialization")).toBe(false);
});

test("primitive parameters follow location style and declared optional defaults", () => {
  const result = analyze([{name: "id", in: "path", required: true, type: "string"},
    {name: "count", in: "query", type: "integer"}, {name: "enabled", in: "header", type: "boolean"}],
  {path: "/example/{id}"});
  expect(result.endpoints[0]?.parameters.map(item => [item.presence.state, item.serialization])).toEqual([
    ["required", {style: "simple", explode: false}], ["optional", {style: "form", explode: false}],
    ["optional", {style: "simple", explode: false}],
  ]);
});

test("malformed or nested declarations cannot acquire a supported serialization", () => {
  for (const parameter of [
    {...array("query"), items: {type: "array", items: {type: "string"}}},
    {...array("query"), items: undefined}, {...array("query"), items: {$ref: "#/definitions/Missing"}},
    {name: "v", in: "query", type: "object"}, {name: "v", in: "query", type: "string", collectionFormat: "csv"},
    {name: "v", in: "query", type: "string", allowEmptyValue: true},
    {name: "v", in: "query", schema: {type: "string"}},
  ]) {
    const result = analyze([parameter]);
    expect(result.endpoints[0]?.parameters[0]?.serialization).toEqual({format: "swagger2-unresolved"});
    expect(result.diagnostics.map(item => item.code)).toContain("parameter_serialization_unresolved");
  }
  const result = analyze([{name: "id", in: "path", type: "string"}, {name: "q", in: "query", type: "string", required: "false"}],
    {path: "/example/{id}"});
  expect(result.endpoints[0]?.parameters.map(item => item.presence.state)).toEqual(["unknown", "unknown"]);
});

test("form fields aggregate once per inherited or overridden consumes with exact presence evidence", () => {
  const parameters = [{name: "name", in: "formData", type: "string", required: true},
    {name: "count", in: "formData", type: "integer"}, {name: "enabled", in: "formData", type: "boolean", required: false}];
  const result = analyze(parameters, {globalConsumes: ["application/x-www-form-urlencoded", "multipart/form-data"]});
  expect(result.endpoints[0]?.request_bodies).toMatchObject([
    {media_type: "application/x-www-form-urlencoded", serialization: {format: "urlencoded"}, presence: {state: "required"},
      schema: {type: "object", properties: {name: {type: "string"}, count: {type: "integer"}, enabled: {type: "boolean"}}, required: ["name"]}},
    {media_type: "multipart/form-data", serialization: {format: "multipart"}, presence: {state: "required"}},
  ]);
  const ids = result.endpoints[0]!.request_bodies[0]!.presence.evidence_ids;
  expect(result.evidence.filter(item => ids.includes(item.evidence_id)).map(item => item.location.pointer))
    .toEqual(expect.arrayContaining(["/consumes", "/paths/~1example/post/parameters/0"]));
  expect(analyze(parameters, {globalConsumes: ["multipart/form-data"], consumes: ["application/x-www-form-urlencoded"]})
    .endpoints[0]?.request_bodies.map(item => item.media_type)).toEqual(["application/x-www-form-urlencoded"]);
  expect(result.claims).toContainEqual(expect.objectContaining({predicate: "request.form.field.presence",
    value: {name: "count", state: "optional"}, verification: "declared"}));
});

test("all optional fields imply an optional form body; operation fields override inherited fields", () => {
  const result = analyze([{name: "name", in: "formData", type: "string"}],
    {consumes: ["application/x-www-form-urlencoded"], inherited: [{name: "name", in: "formData", type: "integer", required: true}]});
  expect(result.endpoints[0]?.request_bodies[0]).toMatchObject({presence: {state: "optional"},
    schema: {type: "object", properties: {name: {type: "string"}}}});
  expect(result.endpoints[0]?.request_bodies[0]?.schema.required).toBeUndefined();
});

test("multipart file declarations become binary string properties without inventing URL-encoded files", () => {
  const result = analyze([{name: "file", in: "formData", type: "file", required: true},
    {name: "label", in: "formData", type: "string"}],
  {consumes: ["application/x-www-form-urlencoded", "multipart/form-data"]});
  expect(result.endpoints[0]?.request_bodies).toMatchObject([{media_type: "multipart/form-data",
    schema: {type: "object", properties: {file: {type: "string", format: "binary"}, label: {type: "string"}}, required: ["file"]}}]);
  expect(result.diagnostics.map(item => item.code)).toContain("form_file_media_unresolved");
});

test("unsupported fields never become a partial body that appears complete", () => {
  for (const unsupported of [
    {name: "list", in: "formData", type: "array", items: {type: "string"}, collectionFormat: "tsv"},
    {name: "obj", in: "formData", type: "object"},
    {name: "list", in: "formData", type: "array", items: {type: "array", items: {type: "string"}}},
    {name: "list", in: "formData", type: "array", items: {type: "string", maxLength: 5}}, {name: "a", in: "formData", type: "string", allowEmptyValue: true},
    {name: "a", in: "formData", type: "string", maxLength: 5},
    {name: "a", in: "formData", type: "string", required: "false"},
    {name: "a", in: "formData", schema: {type: "string"}},
    {name: "a", in: "formData", type: "string", format: ""},
    {name: "a", in: "formData", type: "integer", enum: ["wrong"]},
  ]) {
    const result = analyze([{name: "good", in: "formData", type: "string"}, unsupported], {consumes: ["multipart/form-data"]});
    expect(result.endpoints[0]?.request_bodies).toEqual([]);
    expect(result.diagnostics.map(item => item.code)).toContain("form_field_unresolved");
  }
});

test("unknown media and conflicting body/form declarations keep the route but emit no guessed bodies", () => {
  for (const options of [{}, {consumes: []}, {consumes: ["application/json"]}]) {
    const result = analyze([{name: "a", in: "formData", type: "string"}], options);
    expect(result.endpoints[0]?.request_bodies).toEqual([]);
    expect(result.diagnostics.map(item => item.code)).toContain("form_media_unresolved");
  }
  for (const parameters of [
    [{name: "a", in: "formData", type: "string"}, {name: "body", in: "body", schema: {type: "string"}}],
    [{name: "a", in: "formData", type: "string"}, {name: "a", in: "formData", type: "integer"}],
    [{name: "one", in: "body", schema: {type: "string"}}, {name: "two", in: "body", schema: {type: "integer"}}],
  ]) {
    const result = analyze(parameters, {consumes: ["multipart/form-data"]});
    expect(result.endpoints[0]?.request_bodies).toEqual([]);
    expect(result.diagnostics.map(item => item.code)).toContain("request_body_declarations_conflict");
  }
});


test("malformed formats and unknown item keywords remain visible without invalid IR", () => {
  const invalid = analyze([{name: "q", in: "query", type: "string", format: ""}]);
  expect(invalid.diagnostics.map(item => item.code)).toContain("schema_format_unsupported");
  const unknown = analyze([{...array("query"), items: {type: "string", customKeyword: true}}]);
  expect(unknown.diagnostics.map(item => item.code)).toContain("schema_keyword_unsupported");
});

test("normal body declarations use optional defaults but malformed presence stays unknown", () => {
  const first = analyze([{name: "body", in: "body", schema: {type: "string"}}], {consumes: ["application/json"]});
  expect(first.endpoints[0]?.request_bodies[0]?.presence.state).toBe("optional");
  const invalid = analyze([{name: "body", in: "body", schema: {type: "string"}, required: "false"}],
    {consumes: ["application/json"]});
  expect(invalid.endpoints[0]?.request_bodies[0]?.presence.state).toBe("unknown");
});

test("malformed or referenced parameter entries cannot silently disappear from a form body", () => {
  for (const invalid of [{name: 7, in: "formData", type: "string"}, null, {$ref: "#/parameters/missing"},
    {name: "other", in: "unsupported", type: "string"}]) {
    const result = analyze([{name: "known", in: "formData", type: "string"}, invalid], {consumes: ["multipart/form-data"]});
    expect(result.endpoints[0]?.request_bodies).toEqual([]);
    expect(result.diagnostics.map(item => item.code)).toContain("request_body_declarations_unresolved");
  }
});

test.each(["csv", "multi", "ssv", "pipes", undefined])("form array %s retains its exact encoding and field evidence", format => {
  const result = analyze([{...array("formData", format), required: false}],
    {consumes: ["application/x-www-form-urlencoded", "multipart/form-data"]});
  const expected = format === "multi" ? {style: "form", explode: true}
    : format === "ssv" ? {style: "spaceDelimited", explode: false}
    : format === "pipes" ? {style: "pipeDelimited", explode: false} : {style: "form", explode: false};
  expect(result.endpoints[0]?.request_bodies).toHaveLength(2);
  for (const body of result.endpoints[0]!.request_bodies) {
    expect(body.schema.properties?.values).toEqual({type: "array", items: {type: "string"}});
    expect(body.encoding?.values).toMatchObject(expected);
    expect(result.evidence.filter(item => body.encoding?.values?.evidence_ids.includes(item.evidence_id))
      .map(item => item.location.pointer)).toEqual(expect.arrayContaining([
      "/paths/~1example/post/parameters/0", "/paths/~1example/post/consumes",
    ]));
  }
});
test("file parts carry content type instead of URL-style serialization", () => {
  const result = analyze([{name: "file", in: "formData", type: "file"}], {consumes: ["multipart/form-data"]});
  expect(result.endpoints[0]?.request_bodies[0]?.encoding?.file).toMatchObject({
    content_type: "application/octet-stream", evidence_ids: expect.any(Array),
  });
  expect(result.endpoints[0]?.request_bodies[0]?.encoding?.file?.style).toBeUndefined();
});


test("duplicate scalar and item enums keep form bodies unresolved", () => {
  for (const field of [{name: "value", in: "formData", type: "string", enum: ["a", "a"]},
    {name: "values", in: "formData", type: "array", items: {type: "string", enum: ["a", "a"]}}]) {
    const result = analyze([field], {consumes: ["multipart/form-data"]});
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]!.request_bodies).toEqual([]);
    expect(result.diagnostics.map(item => item.code)).toContain("form_field_unresolved");
  }
});
