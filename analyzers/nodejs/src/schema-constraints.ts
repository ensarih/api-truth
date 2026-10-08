import type { ApiSchema } from "../../../packages/ir/src/index.js";

/** Bounded JSON equality; object key order is immaterial, array order is preserved. */
export function declaredEnum(value: unknown): {value?: NonNullable<ApiSchema["enum"]>; error?: string} {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024)
    return {error: "schema_enum_unsupported"};
  let remaining = 10000;
  function canonical(item: unknown, depth: number): string {
    if (--remaining < 0 || depth > 32) throw new Error("enum budget");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(child => canonical(child, depth + 1)).join(",")}]`;
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype)
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    throw new Error("non JSON enum");
  }
  try {
    const members = value.map(item => canonical(item, 0));
    if (new Set(members).size !== members.length) return {error: "schema_enum_duplicate"};
    return {value: value as NonNullable<ApiSchema["enum"]>};
  } catch { return {error: "schema_enum_unsupported"}; }
}

/** Syntax validation only: patterns are never executed against input. */
export function declaredSchemaConstraints(input: Record<string, unknown>, pointer: string,
  diagnostic: (code: string, pointer: string) => void): ApiSchema {
  const output: ApiSchema = {};
  if (input.pattern !== undefined) {
    let valid = input.type === "string" && typeof input.pattern === "string" && input.pattern.length <= 4096;
    if (valid) {
      try { new RegExp(input.pattern as string, "u"); } catch { valid = false; }
    }
    if (valid) output.pattern = input.pattern as string;
    else diagnostic("schema_pattern_unsupported", `${pointer}/pattern`);
  }
  if (input.enum !== undefined) {
    const enumeration = declaredEnum(input.enum);
    if (enumeration.error) diagnostic(enumeration.error, `${pointer}/enum`);
    else if (enumeration.value) output.enum = enumeration.value;
  }
  return output;
}
