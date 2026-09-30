import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

export type OpenApiValidationDiagnostic = Readonly<{
  code: "INVALID_DOCUMENT" | "MALFORMED_LOCAL_REFERENCE" | "UNRESOLVED_LOCAL_REFERENCE"
    | "INVALID_JSON_SCHEMA" | "UNSUPPORTED_EXTERNAL_REFERENCE" | "UNSUPPORTED_JSON_SCHEMA_DIALECT"
    | "INVALID_EXAMPLE" | "UNVERIFIED_EXAMPLE";
  path: string;
  reference?: string;
  detail?: string;
}>;

export type OpenApiLocalValidationResult = Readonly<{
  diagnostics: readonly OpenApiValidationDiagnostic[];
  externalReferencesSkipped: number;
}>;

export type OpenApiDocumentValidationResult = Readonly<{
  ok: boolean;
  diagnostics: readonly OpenApiValidationDiagnostic[];
}>;

const ajv = new Ajv2020({ strict: false, allErrors: true });
const escapePointer = (part: string): string => part.replaceAll("~", "~0").replaceAll("/", "~1");
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const pinnedSha256 = "59f106413cb48c31299f96f024c938d3628aed6cd02cd14bcfb2fcaae7a130b6";
const source = readFileSync(new URL("../schema/oas-3.1-schema-2026-08-03.json", import.meta.url), "utf8");
if (createHash("sha256").update(source).digest("hex") !== pinnedSha256)
  throw new Error("Pinned OpenAPI 3.1 validation schema integrity check failed");
const documentSchema = JSON.parse(source) as Record<string, unknown>;
// Ajv resolves the published dynamic #meta placeholder to the document root.
// Bind it to the published default Schema Object target; Schema Objects are
// independently checked below against the draft 2020-12 meta-schema.
const boundDocumentSchema = structuredClone(documentSchema);
const bindDefaultDialect = (value: unknown): void => {
  if (!record(value) && !Array.isArray(value)) return;
  if (Array.isArray(value)) { value.forEach(bindDefaultDialect); return; }
  if (value.$dynamicRef === "#meta") { delete value.$dynamicRef; value.$ref = "#/$defs/schema"; }
  Object.values(value).forEach(bindDefaultDialect);
};
bindDefaultDialect(boundDocumentSchema);
const documentAjv = new Ajv2020({ strict: false, allErrors: true });
addFormatsModule.default(documentAjv);
documentAjv.addFormat("media-range", { type: "string", validate: (value: string) =>
  /^[^\s/;]+\/[^\s/;]+(?:\s*;\s*[^\s=;]+=[^;]+)*$/.test(value) });
const validateStructure = documentAjv.compile(boundDocumentSchema);

const resolveLocalReference = (document: unknown, reference: string): "resolved" | "missing" | "malformed" => {
  let decoded: string;
  try { decoded = decodeURIComponent(reference.slice(1)); }
  catch { return "malformed"; }
  if (decoded === "") return "resolved";
  if (!decoded.startsWith("/")) return "malformed";
  let current: unknown = document;
  for (const raw of decoded.slice(1).split("/")) {
    if (/~(?![01])/.test(raw)) return "malformed";
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return "missing";
      current = current[Number(part)];
    } else if (record(current) && Object.hasOwn(current, part)) current = current[part];
    else return "missing";
  }
  return current === undefined ? "missing" : "resolved";
};

/** Checks references and Schema Objects omitted by the official OAI document schema. */
export const validateOpenApiLocalReferencesAndSchemas = (document: unknown): OpenApiLocalValidationResult => {
  const diagnostics: OpenApiValidationDiagnostic[] = [];
  const schemaRoots = new Map<string, unknown>();
  const seen = new WeakSet<object>();
  let externalReferencesSkipped = 0;
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      if (object.$ref.startsWith("#")) {
        const status = resolveLocalReference(document, object.$ref);
        if (status !== "resolved") diagnostics.push({
          code: status === "malformed" ? "MALFORMED_LOCAL_REFERENCE" : "UNRESOLVED_LOCAL_REFERENCE",
          path: `${path}/$ref`, reference: object.$ref,
        });
      } else externalReferencesSkipped++;
    }
    for (const [key, child] of Object.entries(object)) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (key === "schema") schemaRoots.set(childPath, child);
      if (path === "/components/schemas") schemaRoots.set(childPath, child);
      visit(child, childPath);
    }
  };
  visit(document, "");
  for (const [path, schema] of schemaRoots) {
    if (!ajv.validateSchema(schema as Parameters<typeof ajv.validateSchema>[0])) diagnostics.push({
      code: "INVALID_JSON_SCHEMA", path,
      detail: ajv.errorsText(ajv.errors, { separator: "; " }),
    });
  }
  diagnostics.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code));
  return { diagnostics, externalReferencesSkipped };
};

const hasReference = (schema: unknown): boolean => {
  if (Array.isArray(schema)) return schema.some(hasReference);
  if (!record(schema)) return false;
  return typeof schema.$ref === "string" || Object.values(schema).some(hasReference);
};

/** Offline, fail-closed validation before an OpenAPI document is published. */
export const validateOpenApiDocument = (document: unknown): OpenApiDocumentValidationResult => {
  const diagnostics: OpenApiValidationDiagnostic[] = [];
  if (!validateStructure(document)) for (const error of validateStructure.errors ?? []) diagnostics.push({
    code: "INVALID_DOCUMENT", path: error.instancePath || "/", detail: error.message ?? error.keyword,
  });
  const local = validateOpenApiLocalReferencesAndSchemas(document);
  diagnostics.push(...local.diagnostics);
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}/${index}`)); return; }
    if (!record(value)) return;
    if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) diagnostics.push({
      code: "UNSUPPORTED_EXTERNAL_REFERENCE", path: `${path}/$ref`, reference: value.$ref,
    });
    if (path === "" && value.jsonSchemaDialect !== undefined
      && value.jsonSchemaDialect !== "https://spec.openapis.org/oas/3.1/dialect/2024-11-10"
      && value.jsonSchemaDialect !== "https://spec.openapis.org/oas/3.1/dialect/base") diagnostics.push({
      code: "UNSUPPORTED_JSON_SCHEMA_DIALECT", path: "/jsonSchemaDialect",
    });
    if (value.$schema !== undefined && value.$schema !== "https://json-schema.org/draft/2020-12/schema"
      && value.$schema !== "https://spec.openapis.org/oas/3.1/dialect/2024-11-10"
      && value.$schema !== "https://spec.openapis.org/oas/3.1/dialect/base") diagnostics.push({
      code: "UNSUPPORTED_JSON_SCHEMA_DIALECT", path: `${path}/$schema`,
    });
    if (Object.hasOwn(value, "schema") && (Object.hasOwn(value, "example") || Object.hasOwn(value, "examples"))) {
      const examples: { path: string; value: unknown }[] = [];
      if (Object.hasOwn(value, "example")) examples.push({ path: `${path}/example`, value: value.example });
      if (record(value.examples)) for (const [key, item] of Object.entries(value.examples)) {
        const examplePath = `${path}/examples/${escapePointer(key)}`;
        if (record(item) && Object.hasOwn(item, "value")) examples.push({ path: `${examplePath}/value`, value: item.value });
        else diagnostics.push({ code: "UNVERIFIED_EXAMPLE", path: examplePath });
      }
      if (hasReference(value.schema)) for (const item of examples)
        diagnostics.push({ code: "UNVERIFIED_EXAMPLE", path: item.path });
      else {
        try {
          const validateExample = new Ajv2020({ strict: false }).compile(value.schema as Parameters<Ajv2020["compile"]>[0]);
          for (const item of examples) if (!validateExample(item.value)) diagnostics.push({
            code: "INVALID_EXAMPLE", path: item.path, detail: documentAjv.errorsText(validateExample.errors),
          });
        } catch {
          for (const item of examples) diagnostics.push({ code: "UNVERIFIED_EXAMPLE", path: item.path });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}/${escapePointer(key)}`);
  };
  visit(document, "");
  diagnostics.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code));
  return { ok: diagnostics.length === 0, diagnostics };
};
