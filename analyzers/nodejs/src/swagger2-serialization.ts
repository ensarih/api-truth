import type { Endpoint } from "../../../packages/ir/src/index.js";
import type { Swagger2Parameter } from "./swagger2-document.js";

export function declaredPresence(parameter: Swagger2Parameter): "required" | "optional" | "unknown" {
  if (parameter.in === "path") return parameter.required === true ? "required" : "unknown";
  return parameter.required === true ? "required" : parameter.required === undefined || parameter.required === false
    ? "optional" : "unknown";
}

const primitives = new Set(["string", "number", "integer", "boolean"]);
/** Exact flat primitive mappings only; unsupported delimiters never acquire a default. */
export function parameterSerialization(parameter: Swagger2Parameter): Endpoint["parameters"][number]["serialization"] | undefined {
  if (parameter.schema !== undefined || parameter.allowEmptyValue !== undefined && parameter.allowEmptyValue !== false
    || !["query", "path", "header"].includes(parameter.in)) return undefined;
  const scalarStyle = parameter.in === "query" ? "form" : "simple";
  if (typeof parameter.type === "string" && primitives.has(parameter.type))
    return parameter.collectionFormat === undefined && parameter.items === undefined
      ? {style: scalarStyle, explode: false} : undefined;
  if (parameter.type !== "array" || !parameter.items || typeof parameter.items !== "object" || Array.isArray(parameter.items))
    return undefined;
  const items = parameter.items as Record<string, unknown>;
  if (typeof items.type !== "string" || !primitives.has(items.type) || items.collectionFormat !== undefined
    || items.items !== undefined || items.$ref !== undefined || items.properties !== undefined) return undefined;
  const format = parameter.collectionFormat === undefined ? "csv" : parameter.collectionFormat;
  if (format === "csv") return {style: scalarStyle, explode: false};
  if (parameter.in !== "query") return undefined;
  if (format === "multi") return {style: "form", explode: true};
  if (format === "ssv") return {style: "spaceDelimited", explode: false};
  if (format === "pipes") return {style: "pipeDelimited", explode: false};
  return undefined;
}

/** Flat form fields only; nested arrays and unsupported constraints remain unresolved. */
export function supportedFormField(parameter: Swagger2Parameter): boolean {
  if (parameter.type === "array") {
    const allowed = new Set(["name", "in", "pointer", "media", "required", "type", "description",
      "items", "collectionFormat", "allowEmptyValue"]);
    if (!parameter.name || Object.keys(parameter).some(key => !allowed.has(key))
      || declaredPresence(parameter) === "unknown"
      || parameter.description !== undefined && typeof parameter.description !== "string"
      || !parameter.items || typeof parameter.items !== "object" || Array.isArray(parameter.items)) return false;
    const items = parameter.items as Record<string, unknown>;
    if (Object.keys(items).some(key => !["type", "format", "description", "enum"].includes(key))
      || typeof items.type !== "string" || !primitives.has(items.type)) return false;
    return supportedFormField({...items, name: "item", in: "formData", pointer: parameter.pointer})
      && parameterSerialization({...parameter, in: "query"}) !== undefined;
  }
  const allowed = new Set(["name", "in", "pointer", "media", "required", "type", "format", "description", "enum", "allowEmptyValue"]);
  if (!parameter.name || Object.keys(parameter).some(key => !allowed.has(key))
    || parameter.allowEmptyValue !== undefined && parameter.allowEmptyValue !== false
    || declaredPresence(parameter) === "unknown"
    || typeof parameter.type !== "string" || !primitives.has(parameter.type) && parameter.type !== "file"
    || parameter.format !== undefined && (typeof parameter.format !== "string" || !parameter.format.length)
    || parameter.description !== undefined && typeof parameter.description !== "string") return false;
  if (parameter.type === "file") return parameter.enum === undefined && parameter.format === undefined;
  if (parameter.enum === undefined) return true;
  return Array.isArray(parameter.enum) && parameter.enum.length > 0 && parameter.enum.every(value =>
    parameter.type === "string" ? typeof value === "string" : parameter.type === "boolean" ? typeof value === "boolean"
      : typeof value === "number" && Number.isFinite(value) && (parameter.type !== "integer" || Number.isInteger(value)));
}


export function formFieldEncoding(parameter: Swagger2Parameter): Omit<
  NonNullable<Endpoint["request_bodies"][number]["encoding"]>[string], "evidence_ids"> {
  return parameter.type === "file" ? {content_type: "application/octet-stream"}
    : {style: parameter.type === "array" && parameter.collectionFormat === "ssv" ? "spaceDelimited"
      : parameter.type === "array" && parameter.collectionFormat === "pipes" ? "pipeDelimited" : "form",
    explode: parameter.type === "array" && parameter.collectionFormat === "multi"};
}
