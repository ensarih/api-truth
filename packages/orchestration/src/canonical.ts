import { createHash } from "node:crypto";
import { OrchestrationError } from "./errors.js";

const invalid = (): never => { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); };

const compareCodePoints = (left: string, right: string): number => {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
};

const serialize = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : invalid();
  if (typeof value !== "object" || ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
      const lengthValue: unknown = descriptors.length?.value;
      if (typeof lengthValue !== "number" || Reflect.ownKeys(descriptors).length !== lengthValue + 1) return invalid();
      const items: string[] = [];
      for (let index = 0; index < lengthValue; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) return invalid();
        items.push(serialize(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length) return invalid();
    return `{${keys.sort(compareCodePoints).map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return invalid();
      return `${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalOrchestrationJson = (value: unknown): string => {
  try { return serialize(value, new Set()); } catch (error) {
    try { if (error instanceof OrchestrationError) throw error; } catch { /* hostile thrown values collapse */ }
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
};

export const canonicalOrchestrationHash = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalOrchestrationJson(value), "utf8").digest("hex")}`;

export const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const isCanonicalStringSet = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || compareUtf8(values[index - 1]!, value) < 0);

export const canonicalStringSet = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUtf8);

export const detachedFrozen = <Value>(value: Value): Value => {
  const detached = JSON.parse(canonicalOrchestrationJson(value)) as Value;
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(detached);
  return detached;
};
