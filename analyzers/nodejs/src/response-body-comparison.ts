import type {ApiSchema} from "../../../packages/ir/src/index.js";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
/** Type discrepancies between declarations only. No schema validation or runtime assertion. */
export function compareResponseBodyTypes(actual: ApiSchema, expected: unknown): {kind: "compared" | "unresolved"; mismatches: string[]} {
  let nodes = 0, unresolved = false;
  const mismatches = new Set<string>();
  const visit = (shape: ApiSchema, schema: unknown, path: string, depth: number): void => {
    if (++nodes > 10000 || depth > 64 || mismatches.size >= 32) { unresolved = true; return; }
    if (!object(schema) || ["$ref", "allOf", "anyOf", "oneOf", "not"].some(key => Object.hasOwn(schema, key))) { unresolved = true; return; }
    if (shape.anyOf) { for (const variant of shape.anyOf) visit(variant, schema, path, depth + 1); return; }
    if (schema.type !== undefined && (typeof schema.type !== "string" || !types.has(schema.type))) { unresolved = true; return; }
    if (schema.type && shape.type && schema.type !== shape.type && !(schema.type === "number" && shape.type === "integer")) {
      mismatches.add(path || "/"); return;
    }
    if (shape.type === "object" && schema.properties !== undefined) {
      if (!object(schema.properties)) { unresolved = true; return; }
      for (const [name, child] of Object.entries(shape.properties ?? {}))
        if (Object.hasOwn(schema.properties, name)) visit(child, schema.properties[name], `${path}/${pointer(name)}`, depth + 1);
    }
    if (shape.type === "array" && shape.items && schema.items !== undefined) visit(shape.items, schema.items, `${path}/*`, depth + 1);
  };
  visit(actual, expected, "", 0);
  return unresolved ? {kind: "unresolved", mismatches: []} : {kind: "compared", mismatches: [...mismatches].sort()};
}

/** Missing documented fields in a source literal; does not infer contract requiredness. */
export function compareResponseBodyPresence(actual: ApiSchema, expected: unknown): {kind: "compared" | "unresolved"; missing: string[]} {
  let nodes = 0, unresolved = false;
  const missing = new Set<string>();
  const consume = (): boolean => { if (++nodes > 10000) unresolved = true; return !unresolved; };
  const visit = (shape: ApiSchema, schema: unknown, path: string, depth: number): void => {
    if (!consume() || depth > 64) { unresolved = true; return; }
    if (!object(schema) || ["$ref", "allOf", "anyOf", "oneOf", "not"].some(key => Object.hasOwn(schema, key))) { unresolved = true; return; }
    if (schema.type !== undefined && (typeof schema.type !== "string" || !types.has(schema.type))) { unresolved = true; return; }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 10000
      || schema.required.some(name => typeof name !== "string" || !name.length)
      || new Set(schema.required).size !== schema.required.length)) { unresolved = true; return; }
    if (shape.anyOf) { for (const variant of shape.anyOf) visit(variant, schema, path, depth + 1); return; }
    if (shape.type === "object" && (schema.type === undefined || schema.type === "object")) {
      for (const name of (schema.required ?? []) as string[]) {
        if (!consume()) return;
        if (!Object.hasOwn(shape.properties ?? {}, name)) missing.add(`${path}/${pointer(name)}`);
        if (missing.size > 32) { unresolved = true; return; }
      }
      if (schema.properties !== undefined && !object(schema.properties)) { unresolved = true; return; }
      if (object(schema.properties)) for (const [name, child] of Object.entries(shape.properties ?? {})) {
        if (!consume()) return;
        if (Object.hasOwn(schema.properties, name)) visit(child, schema.properties[name], `${path}/${pointer(name)}`, depth + 1);
      }
    }
    if (shape.type === "array" && (schema.type === undefined || schema.type === "array") && shape.items && schema.items !== undefined)
      visit(shape.items, schema.items, `${path}/*`, depth + 1);
  };
  visit(actual, expected, "", 0);
  return unresolved ? {kind: "unresolved", missing: []} : {kind: "compared", missing: [...missing].sort()};
}
