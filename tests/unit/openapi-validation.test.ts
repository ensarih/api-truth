import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { expect, test } from "vitest";
import { compileOpenApiSnapshot } from "../../packages/openapi/src/index.js";
import { validateOpenApiDocument, validateOpenApiLocalReferencesAndSchemas } from "../../packages/openapi/src/validation.js";

// Source: https://spec.openapis.org/oas/3.1/schema/2026-08-03
const officialSchemaText = await readFile(new URL("../fixtures/openapi/oas-3.1-schema-2026-08-03.json", import.meta.url), "utf8");
const officialSchema = JSON.parse(officialSchemaText);
// Ajv resolves the published dynamic #meta reference to the document root. With no
// dialect override, its static target is the published $defs/schema placeholder.
const ajvSchema = structuredClone(officialSchema);
const bindDefaultDialect = (value: any): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(bindDefaultDialect); return; }
  if (value.$dynamicRef === "#meta") { delete value.$dynamicRef; value.$ref = "#/$defs/schema"; }
  Object.values(value).forEach(bindDefaultDialect);
};
bindDefaultDialect(ajvSchema);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormatsModule.default(ajv);
ajv.addFormat("media-range", { type: "string", validate: () => true });
const validateDocument = ajv.compile(ajvSchema);

test("official OAI 2026-08-03 fixture is pinned by content", () => {
  expect(createHash("sha256").update(officialSchemaText).digest("hex"))
    .toBe("59f106413cb48c31299f96f024c938d3628aed6cd02cd14bcfb2fcaae7a130b6");
  expect(officialSchema.$id).toBe("https://spec.openapis.org/oas/3.1/schema/2026-08-03");
});

const document = () => ({ openapi: "3.1.0", info: { title: "Example", version: "1" },
  paths: { "/things": { get: { responses: { "200": { description: "OK", content: {
    "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
  } } } } } },
  components: { schemas: { Thing: { type: "object", properties: { id: { type: "string" } } } } },
});

test("strict compiler output conforms to the pinned official OAI document schema", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8"));
  snapshot.endpoints = [snapshot.endpoints[0]];
  snapshot.schemas = {};
  snapshot.evidence = snapshot.evidence.filter((item: any) => item.scope.endpoint_id !== "ep-create");
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0].parameters = snapshot.endpoints[0].parameters.slice(0, 1);
  snapshot.endpoints[0].responses[0].content[0].schema = { type: "string" };
  snapshot.evidence.push({ ...snapshot.evidence[0], evidence_id: "ev-verified", method: "deterministic_analysis",
    limitations: [], scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0].evidence_ids = ["ev-verified"];
  snapshot.endpoints[0].parameters[0].presence.evidence_ids = ["ev-verified"];
  snapshot.endpoints[0].security = { state: "anonymous", evidence_ids: ["ev-verified"], alternatives: [] };
  const compiled = compileOpenApiSnapshot(snapshot, "strict");
  expect(compiled.ok, JSON.stringify(compiled.diagnostics)).toBe(true);
  expect(validateDocument(compiled.document), JSON.stringify(validateDocument.errors)).toBe(true);
  expect(validateOpenApiLocalReferencesAndSchemas(compiled.document).diagnostics).toEqual([]);
  expect(validateOpenApiDocument(compiled.document)).toEqual({ ok: true, diagnostics: [] });
});

test("independent checks accept valid local references and JSON Schemas", () => {
  const value = document();
  expect(validateDocument(value), JSON.stringify(validateDocument.errors)).toBe(true);
  expect(validateOpenApiLocalReferencesAndSchemas(value).diagnostics).toEqual([]);
  expect(validateOpenApiDocument(value)).toEqual({ ok: true, diagnostics: [] });
});

test("the official schema rejects malformed OpenAPI structure", () => {
  const value: any = document();
  delete value.info.version;
  expect(validateDocument(value)).toBe(false);
  expect(validateDocument.errors?.some((error: { instancePath: string }) => error.instancePath.startsWith("/info"))).toBe(true);
  expect(validateOpenApiDocument(value).diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
});

test("local reference checks reject missing targets and malformed pointer escapes", () => {
  const value: any = document();
  value.paths["/things"].get.responses["200"].content["application/json"].schema.$ref = "#/components/schemas/Missing";
  expect(validateOpenApiLocalReferencesAndSchemas(value).diagnostics).toContainEqual(expect.objectContaining({
    code: "UNRESOLVED_LOCAL_REFERENCE", reference: "#/components/schemas/Missing",
  }));
  value.paths["/things"].get.responses["200"].content["application/json"].schema.$ref = "#/components/schemas/Bad~2Name";
  expect(validateOpenApiLocalReferencesAndSchemas(value).diagnostics).toContainEqual(expect.objectContaining({
    code: "MALFORMED_LOCAL_REFERENCE",
  }));
});

test("local JSON Pointers decode percent-encoded component names", () => {
  const value: any = document();
  value.components.schemas["Thing.Extra"] = value.components.schemas.Thing;
  value.paths["/things"].get.responses["200"].content["application/json"].schema.$ref =
    "#/components/schemas/Thing%2EExtra";
  expect(validateOpenApiDocument(value)).toEqual({ ok: true, diagnostics: [] });
});

test("JSON Schema meta-validation catches malformed nested schemas", () => {
  const value: any = document();
  value.components.schemas.Thing.properties.id.type = "strng";
  expect(validateDocument(value)).toBe(true); // The OAI document schema intentionally leaves Schema Objects open.
  expect(validateOpenApiLocalReferencesAndSchemas(value).diagnostics).toContainEqual(expect.objectContaining({
    code: "INVALID_JSON_SCHEMA", path: "/components/schemas/Thing",
  }));
  expect(validateOpenApiDocument(value).ok).toBe(false);
});

test("external references are explicitly counted as outside local resolution", () => {
  const value: any = document();
  value.paths["/things"].get.responses["200"].content["application/json"].schema.$ref =
    "https://example.com/schemas.json#/$defs/Thing";
  const result = validateOpenApiLocalReferencesAndSchemas(value);
  expect(result.diagnostics).toEqual([]);
  expect(result.externalReferencesSkipped).toBe(1);
  expect(validateOpenApiDocument(value).diagnostics).toContainEqual(expect.objectContaining({
    code: "UNSUPPORTED_EXTERNAL_REFERENCE",
  }));
});

test("inline examples are checked against nearby schemas", () => {
  const value: any = document();
  const content = value.paths["/things"].get.responses["200"].content["application/json"];
  content.schema = { type: "integer" };
  content.example = "wrong";
  expect(validateOpenApiDocument(value).diagnostics).toContainEqual(expect.objectContaining({
    code: "INVALID_EXAMPLE", path: "/paths/~1things/get/responses/200/content/application~1json/example",
  }));
  content.example = 7;
  expect(validateOpenApiDocument(value)).toEqual({ ok: true, diagnostics: [] });
  content.schema = { $ref: "#/components/schemas/Thing" };
  expect(validateOpenApiDocument(value).diagnostics).toContainEqual(expect.objectContaining({
    code: "UNVERIFIED_EXAMPLE",
  }));
});
