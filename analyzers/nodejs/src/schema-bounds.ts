import type { ApiSchema } from "../../../packages/ir/src/index.js";

export const schemaBoundFields = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  "exclusiveMinimum", "exclusiveMaximum"] as const;
const bounds = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const;

/** Preserve representable declarations only; exclusive semantics are not in the current IR. */
export function declaredSchemaBounds(input: Record<string, unknown>, pointer: string,
  diagnostic: (code: string, pointer: string) => void): ApiSchema {
  const output: ApiSchema = {};
  for (const key of bounds) {
    const value = input[key];
    const exclusiveKey = key === "minimum" ? "exclusiveMinimum" : key === "maximum" ? "exclusiveMaximum" : undefined;
    const exclusive = exclusiveKey ? input[exclusiveKey] : undefined;
    const valid = typeof value === "number" && Number.isFinite(value)
      && (key === "minimum" || key === "maximum" || Number.isSafeInteger(value) && value >= 0);
    if (value !== undefined && !valid) diagnostic("schema_bound_unsupported", `${pointer}/${key}`);
    if (exclusiveKey && exclusive !== undefined && (exclusive !== false || !valid)) {
      diagnostic("schema_exclusive_bound_unsupported", `${pointer}/${exclusiveKey}`);
      continue;
    }
    if (valid) output[key] = value;
  }
  for (const [lower, upper] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]] as const) {
    if (output[lower] !== undefined && output[upper] !== undefined && output[lower]! > output[upper]!) {
      diagnostic("schema_bounds_conflict", `${pointer}/${lower}`);
      diagnostic("schema_bounds_conflict", `${pointer}/${upper}`);
      delete output[lower]; delete output[upper];
    }
  }
  return output;
}
