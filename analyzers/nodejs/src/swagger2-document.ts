import {resolveResponseObject} from "./response-schema-resolution.js";
/** Bounded, pure parser for a Swagger 2.0 JSON document. It never reads files or resolves remote references. */

export type Swagger2Method = "get" | "put" | "post" | "delete" | "options" | "head" | "patch";
export type Swagger2Diagnostic = {
  code: "invalid_document" | "unsupported_field" | "unsupported_construct" | "external_ref" | "missing_local_ref";
  severity: "warning" | "error";
  message: string;
  pointer: string;
};

export type Swagger2Media = { state: "unknown" } | { state: "known"; values: string[] };
export type Swagger2Security = { state: "unknown" | "anonymous" } | {
  state: "declared";
  alternatives: Array<Record<string, string[]>>;
};
export type Swagger2Parameter = Record<string, unknown> & { name: string; in: string; pointer: string };
export type Swagger2Response = {
  selector: { kind: "exact"; code: number } | { kind: "default" };
  description?: string;
  schema?: unknown;
  headers?: Record<string, unknown>;
  media: Swagger2Media;
  pointer: string;
  declarationPointer?: string;
  referencePointers?: string[];
};
export type Swagger2Operation = {
  method: Swagger2Method;
  path: string;
  operationId?: string;
  pointer: string;
  evidencePointer: string;
  parameters: Swagger2Parameter[];
  requestBodies: Array<Swagger2Parameter & { media: Swagger2Media }>;
  requestBodyConflict: boolean;
  requestBodyUnresolved: boolean;
  responses: Swagger2Response[];
  consumes: Swagger2Media;
  produces: Swagger2Media;
  security: Swagger2Security;
};
export type Swagger2ParseResult = {
  status: "success" | "partial" | "failed";
  operations: Swagger2Operation[];
  definitions: Record<string, unknown>;
  securityDefinitions: Record<string, unknown>;
  diagnostics: Swagger2Diagnostic[];
};

const methods = new Set<Swagger2Method>(["get", "put", "post", "delete", "options", "head", "patch"]);
const topFields = new Set(["swagger", "info", "host", "basePath", "schemes", "consumes", "produces", "paths", "definitions", "parameters", "responses", "securityDefinitions", "security", "tags", "externalDocs"]);
const pathFields = new Set(["$ref", "parameters", ...methods]);
const operationFields = new Set(["tags", "summary", "description", "externalDocs", "operationId", "consumes", "produces", "parameters", "responses", "schemes", "deprecated", "security"]);
const parameterFields = new Set(["name", "in", "description", "required", "schema", "type", "format", "allowEmptyValue", "items", "collectionFormat", "default", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems", "enum", "multipleOf"]);
const responseFields = new Set(["description", "schema", "headers", "examples"]);
const schemaFields = new Set(["$ref", "format", "title", "description", "default", "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems", "enum", "type", "items", "allOf", "properties", "additionalProperties", "required"]);
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const has = (value: unknown, key: string): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key);
const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const pointerPart = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

/** Parse an already-decoded JSON value. Local schema refs are validated but left intact. */
export function parseSwagger2Document(input: unknown): Swagger2ParseResult {
  const diagnostics: Swagger2Diagnostic[] = [];
  const add = (code: Swagger2Diagnostic["code"], severity: Swagger2Diagnostic["severity"], message: string, pointer: string) =>
    diagnostics.push({ code, severity, message, pointer });
  const fail = (message: string, pointer = "") => add("invalid_document", "error", message, pointer);
  if (!obj(input)) {
    fail("Document root must be a JSON object.");
    return result("failed", [], {}, {}, diagnostics);
  }
  const inspectKeys = (value: unknown, pointer: string): boolean => {
    if (Array.isArray(value)) return value.every((item, i) => inspectKeys(item, `${pointer}/${i}`));
    if (!obj(value)) return true;
    for (const [key, child] of Object.entries(value)) {
      const at = `${pointer}/${pointerPart(key)}`;
      if (forbiddenKeys.has(key)) { fail("Prototype-related keys are not allowed.", at); return false; }
      if (!inspectKeys(child, at)) return false;
    }
    return true;
  };
  if (!inspectKeys(input, "")) return result("failed", [], {}, {}, diagnostics);
  if (input.swagger !== "2.0" || !obj(input.info) || typeof input.info.title !== "string" || typeof input.info.version !== "string" || !obj(input.paths)) {
    fail("Expected a Swagger 2.0 document with info.title, info.version, and paths.");
    return result("failed", [], {}, {}, diagnostics);
  }
  const noteUnknown = (record: Record<string, unknown>, accepted: Set<string>, pointer: string) => {
    for (const key of Object.keys(record)) if (!accepted.has(key))
      add("unsupported_field", "warning", `Unsupported field '${key}' is preserved in the source document but is not interpreted.`, `${pointer}/${pointerPart(key)}`);
  };
  noteUnknown(input, topFields, "");
  for (const field of ["host", "basePath", "schemes"] as const) if (input[field] !== undefined)
    add("unsupported_construct", "warning", `Document-level '${field}' is preserved but is not applied to application route identity by this document parser.`, `/${field}`);
  const media = (value: unknown, inherited: unknown, pointer: string): Swagger2Media => {
    const selected = value === undefined ? inherited : value;
    if (selected === undefined) return { state: "unknown" };
    if (!Array.isArray(selected) || selected.some((item) => typeof item !== "string" || item.length === 0)) {
      add("unsupported_construct", "warning", "Media types must be a list of non-empty strings; the value is unknown.", pointer);
      return { state: "unknown" };
    }
    return { state: "known", values: [...new Set(selected as string[])] };
  };
  const security = (value: unknown, inherited: unknown, pointer: string): Swagger2Security => {
    const selected = value === undefined ? inherited : value;
    const selectedPointer = value === undefined ? "/security" : pointer;
    if (selected === undefined) return { state: "unknown" };
    if (!Array.isArray(selected)) {
      add("unsupported_construct", "warning", "Security declaration must be an array; security remains unknown.", selectedPointer);
      return { state: "unknown" };
    }
    if (!selected.length) return { state: "anonymous" };
    if (!selected.every((entry) => obj(entry) && Object.values(entry).every((scopes) => Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string")))) {
      add("unsupported_construct", "warning", "Security declaration is malformed; security remains unknown.", selectedPointer);
      return { state: "unknown" };
    }
    return { state: "declared", alternatives: selected as Array<Record<string, string[]>> };
  };
  const operations: Swagger2Operation[] = [];
  const operationIds = new Set<string>();
  const definitionMap = obj(input.definitions) ? input.definitions : {};
  const inspectSchema = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => inspectSchema(item, `${pointer}/${index}`)); return; }
    if (!obj(value)) return;
    noteUnknown(value, schemaFields, pointer);
    for (const [key, child] of Object.entries(value)) {
      if (key === "properties" && obj(child)) {
        for (const [name, propertySchema] of Object.entries(child)) inspectSchema(propertySchema, `${pointer}/properties/${pointerPart(name)}`);
      } else if (["items", "allOf", "additionalProperties"].includes(key)) inspectSchema(child, `${pointer}/${pointerPart(key)}`);
    }
  };
  for (const [name, schema] of Object.entries(definitionMap)) inspectSchema(schema, `/definitions/${pointerPart(name)}`);
  const inspectRefs = (value: unknown, pointer: string, seen = new Set<object>(), map = false): void => {
    if (Array.isArray(value)) { value.forEach((item, i) => inspectRefs(item, `${pointer}/${i}`, seen)); return; }
    if (!obj(value) || seen.has(value)) return;
    seen.add(value);
    if (typeof value.$ref === "string") {
      if (!value.$ref.startsWith("#/")) add("external_ref", "error", "Only document-local JSON Pointer references are allowed.", `${pointer}/$ref`);
      else {
        const parts = value.$ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
        let target: unknown = input;
        for (const part of parts) target = has(target, part) ? target[part] : undefined;
        if (target === undefined) add("missing_local_ref", "warning", `Local reference '${value.$ref}' does not resolve.`, `${pointer}/$ref`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!map && (["enum", "default", "example", "examples", "security"].includes(key) || key.startsWith("x-"))) continue;
      inspectRefs(child, `${pointer}/${pointerPart(key)}`, seen,
        !map && ["properties", "definitions", "paths", "responses", "headers", "parameters", "securityDefinitions"].includes(key));
    }
  };
  inspectRefs(input, "");
  if (diagnostics.some((item) => item.code === "external_ref")) return result("failed", [], {}, {}, diagnostics);

  for (const [path, pathItem] of Object.entries(input.paths)) {
    const pathPointer = `/paths/${pointerPart(path)}`;
    if (!path.startsWith("/") || !obj(pathItem)) { add("unsupported_construct", "warning", "Path entry must have an absolute path and object value.", pathPointer); continue; }
    noteUnknown(pathItem, pathFields, pathPointer);
    if (pathItem.$ref !== undefined) add("unsupported_construct", "warning", "Path Item references are not expanded by this parser.", `${pathPointer}/$ref`);
    const pathParameters = pathItem.parameters === undefined ? [] : pathItem.parameters;
    if (Array.isArray(pathParameters)) pathParameters.forEach((parameter, index) => { if (obj(parameter) && parameter.schema !== undefined) inspectSchema(parameter.schema, `${pathPointer}/parameters/${index}/schema`); });
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!methods.has(method as Swagger2Method)) continue;
      const pointer = `${pathPointer}/${method}`;
      if (!obj(rawOperation)) { add("unsupported_construct", "warning", "Operation must be an object.", pointer); continue; }
      noteUnknown(rawOperation, operationFields, pointer);
      if (rawOperation.operationId !== undefined) {
        if (typeof rawOperation.operationId !== "string" || rawOperation.operationId.length === 0)
          add("unsupported_construct", "warning", "Operation ID must be a non-empty string.", `${pointer}/operationId`);
        else if (operationIds.has(rawOperation.operationId))
          add("unsupported_construct", "warning", "Operation ID is repeated in this document.", `${pointer}/operationId`);
        else operationIds.add(rawOperation.operationId);
      }
      const merged = new Map<string, Swagger2Parameter>();
      let duplicateBodyDeclaration = false;
      let requestBodyUnresolved = false;
      const addParameters = (list: unknown, sourcePointer: string) => {
        if (!Array.isArray(list)) { requestBodyUnresolved = true;
          add("unsupported_construct", "warning", "Parameters must be an array.", sourcePointer); return; }
        const keys = new Set<string>();
        list.forEach((raw, index) => {
          const at = `${sourcePointer}/${index}`;
          if (!obj(raw) || typeof raw.name !== "string" || typeof raw.in !== "string") {
            requestBodyUnresolved = true;
            add("unsupported_construct", "warning", "Parameter requires string name and in fields.", at); return;
          }
          noteUnknown(raw, parameterFields, at);
          if (!new Set(["path", "query", "header", "formData", "body"]).has(raw.in)) {
            requestBodyUnresolved = true;
            add("unsupported_construct", "warning", `Unsupported parameter location '${raw.in}'.`, `${at}/in`); return;
          }
          if (raw.in === "path" && raw.required !== true)
            add("unsupported_construct", "warning", "Swagger path parameters must be required; optional path parameter was retained with a diagnostic.", `${at}/required`);
          const key = `${raw.name}\u0000${raw.in}`;
          if (keys.has(key)) {
            add("unsupported_construct", "warning", "Duplicate parameter in one declaration list.", at);
            if (raw.in === "body" || raw.in === "formData") duplicateBodyDeclaration = true;
          }
          keys.add(key);
          const normalized = { ...raw, name: raw.name, in: raw.in, pointer: at } as Swagger2Parameter;
          merged.set(`${raw.name}\u0000${raw.in}`, normalized);
        });
      };
      addParameters(pathParameters, `${pathPointer}/parameters`);
      if (rawOperation.parameters !== undefined) addParameters(rawOperation.parameters, `${pointer}/parameters`);
      if (Array.isArray(rawOperation.parameters)) rawOperation.parameters.forEach((parameter, index) => {
        if (obj(parameter) && parameter.schema !== undefined) inspectSchema(parameter.schema, `${pointer}/parameters/${index}/schema`);
      });
      const parameters = [...merged.values()];
      const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
      for (const name of placeholders) if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name))
        add("unsupported_construct", "warning", "Path placeholder has no matching path parameter declaration.", `${pointer}/parameters`);
      for (const parameter of parameters) if (parameter.in === "path" && !placeholders.includes(parameter.name))
        add("unsupported_construct", "warning", "Path parameter does not occur in route template.", parameter.pointer);
      const requestBodies = parameters.filter((item) => item.in === "body" || item.in === "formData")
        .map((item) => ({ ...item, media: media(rawOperation.consumes, input.consumes, `${pointer}/consumes`) }));
      const responses: Swagger2Response[] = [];
      if (!obj(rawOperation.responses)) add("unsupported_construct", "warning", "Operation has no valid responses map.", `${pointer}/responses`);
      else for (const [status, rawResponse] of Object.entries(rawOperation.responses)) {
        const at = `${pointer}/responses/${pointerPart(status)}`;
        if (!obj(rawResponse)) { add("unsupported_construct", "warning", "Response must be an object.", at); continue; }
        let response = rawResponse;
        let declarationPointer = at;
        let referencePointers: string[] = [];
        if (Object.hasOwn(rawResponse, "$ref")) {
          const resolved = resolveResponseObject(rawResponse, input.responses);
          if (resolved.kind === "resolved") {
            response = resolved.response;
            declarationPointer = resolved.terminalPointer ?? at;
            referencePointers = resolved.pointers;
          } else {
            add("unsupported_construct", "warning", "Reusable response reference could not be resolved under the bounded profile.", at);
            response = {};
          }
        }
        noteUnknown(response, responseFields, declarationPointer);
        if (response.schema !== undefined) inspectSchema(response.schema, `${declarationPointer}/schema`);
        if (obj(response.headers)) for (const [name, header] of Object.entries(response.headers))
          inspectSchema(header, `${declarationPointer}/headers/${pointerPart(name)}`);
        if (response.examples !== undefined) add("unsupported_construct", "warning", "Response examples are retained by the source but are not interpreted.", `${declarationPointer}/examples`);
        let selector: Swagger2Response["selector"];
        if (status === "default") selector = { kind: "default" };
        else if (/^[1-5][0-9]{2}$/.test(status)) selector = { kind: "exact", code: Number(status) };
        else { add("unsupported_construct", "warning", `Unsupported response selector '${status}'.`, at); continue; }
        responses.push({ selector, ...(typeof response.description === "string" ? { description: response.description } : {}),
          ...(response.schema !== undefined ? { schema: response.schema } : {}),
          ...(obj(response.headers) ? { headers: response.headers } : {}),
          media: response.schema === undefined ? { state: "unknown" } : media(rawOperation.produces, input.produces, `${pointer}/produces`), pointer: at, ...(referencePointers.length ? {declarationPointer, referencePointers} : {}) });
      }
      if (!responses.length) add("unsupported_construct", "warning", "Operation has no supported response selectors.", `${pointer}/responses`);
      const operation: Swagger2Operation = {
        method: method as Swagger2Method, path, ...(typeof rawOperation.operationId === "string" ? { operationId: rawOperation.operationId } : {}),
        pointer, evidencePointer: pointer, parameters: parameters.filter((item) => item.in !== "body" && item.in !== "formData"), requestBodies, responses,
        requestBodyUnresolved,
        requestBodyConflict: duplicateBodyDeclaration || requestBodies.filter(item => item.in === "body").length > 1
          || requestBodies.some(item => item.in === "body") && requestBodies.some(item => item.in === "formData"),
        consumes: media(rawOperation.consumes, input.consumes, `${pointer}/consumes`),
        produces: media(rawOperation.produces, input.produces, `${pointer}/produces`),
        security: security(rawOperation.security, input.security, `${pointer}/security`),
      };
      operations.push(operation);
    }
  }
  const status = diagnostics.some((item) => item.severity === "error") ? "failed" : diagnostics.length ? "partial" : "success";
  return result(status, operations, definitionMap, obj(input.securityDefinitions) ? input.securityDefinitions : {}, diagnostics);
}

function result(status: Swagger2ParseResult["status"], operations: Swagger2Operation[], definitions: Record<string, unknown>, securityDefinitions: Record<string, unknown>, diagnostics: Swagger2Diagnostic[]): Swagger2ParseResult {
  return { status, operations, definitions, securityDefinitions, diagnostics };
}
