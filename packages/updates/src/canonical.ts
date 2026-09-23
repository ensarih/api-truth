import { createHash } from "node:crypto";
import { UpdateError } from "./errors.js";

const invalidCanonicalValue = (): never => {
  throw new UpdateError("INVALID_UPDATE_INPUT");
};

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

const serializeCanonical = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidCanonicalValue();
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) return invalidCanonicalValue();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
        || typeof lengthDescriptor.value !== "number"
        || Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1) {
        return invalidCanonicalValue();
      }
      const members: string[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) return invalidCanonicalValue();
        members.push(serializeCanonical(descriptor.value, ancestors));
      }
      return `[${members.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidCanonicalValue();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length) return invalidCanonicalValue();
    const entries = keys.sort(compareCodePoints).map((key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return invalidCanonicalValue();
      return `${JSON.stringify(key)}:${serializeCanonical(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJson = (value: unknown): string => {
  try {
    return serializeCanonical(value, new Set());
  } catch (error) {
    try {
      if (error instanceof UpdateError) throw error;
    } catch (inspectionError) {
      try {
        if (inspectionError instanceof UpdateError) throw inspectionError;
      } catch {
        // Fall through to the stable input error.
      }
    }
    throw new UpdateError("INVALID_UPDATE_INPUT");
  }
};

export const canonicalSha256Hex = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const isCanonicalStringSet = (values: readonly string[]): boolean => {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && compareUtf8(values[index - 1]!, values[index]!) >= 0) return false;
  }
  return true;
};

export const isCanonicalBy = <Value>(
  values: readonly Value[],
  projection: (value: Value) => string,
): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(projection(values[index - 1]!), projection(values[index]!)) >= 0) return false;
  }
  return true;
};
