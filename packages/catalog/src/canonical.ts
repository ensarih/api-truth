import { createHash } from "node:crypto";
import type { ContractSnapshot } from "@api-truth/ir";
import { CatalogError } from "./errors.js";
import type { ProviderOrder } from "./types.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

const invalidCanonicalValue = (): never => {
  throw new CatalogError("INVALID_CATALOG_INPUT");
};

const withCanonicalInputBoundary = <Value>(operation: () => Value): Value => {
  try {
    return operation();
  } catch (error) {
    let isCatalogError = false;
    try {
      isCatalogError = error instanceof CatalogError;
    } catch {
      // A thrown Proxy can itself have hostile prototype traps.
    }
    if (isCatalogError) throw error;
    throw new CatalogError("INVALID_CATALOG_INPUT");
  }
};

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
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
  if (typeof value !== "object") return invalidCanonicalValue();
  if (ancestors.has(value)) return invalidCanonicalValue();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const members: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return invalidCanonicalValue();
        members.push(serializeCanonical(value[index], ancestors));
      }
      return `[${members.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidCanonicalValue();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length) return invalidCanonicalValue();
    const entries = keys
      .sort(compareCodePoints)
      .map((key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) return invalidCanonicalValue();
        return `${JSON.stringify(key)}:${serializeCanonical(descriptor.value, ancestors)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJson = (value: unknown): string =>
  withCanonicalInputBoundary(() => serializeCanonical(value, new Set()));

export const sha256Canonical = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;

export const canonicalScopeIds = (values: readonly string[]): string[] =>
  withCanonicalInputBoundary(() => {
    if (!Array.isArray(values) || values.length === 0
      || values.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new CatalogError("INVALID_CATALOG_INPUT");
    }
    return [...new Set(values)].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  });

export const normalizedContractContent = (
  snapshot: ContractSnapshot,
): Omit<ContractSnapshot, "created_at"> => withCanonicalInputBoundary(() => {
  const { created_at: _createdAt, ...content } = snapshot;
  return structuredClone(content);
});

export const snapshotContentSha256 = (snapshot: ContractSnapshot): `sha256:${string}` =>
  sha256Canonical(normalizedContractContent(snapshot));

export const snapshotIdentitySha256 = (snapshot: ContractSnapshot): `sha256:${string}` => {
  const identity = withCanonicalInputBoundary(() => ({
    snapshot_id: snapshot.snapshot_id,
    repository_id: snapshot.service.repository_id,
    service_id: snapshot.service.service_id,
    immutable_revision: snapshot.source.immutable_revision,
    analyzer: snapshot.analyzer,
    ir_version: snapshot.ir_version,
    identity_version: snapshot.identity_version,
    config_fingerprint: snapshot.config.config_fingerprint,
  }));
  return sha256Canonical(identity);
};

const canonicalDecimal = /^(0|[1-9][0-9]*)$/;

export const compareProviderOrder = (
  current: ProviderOrder | undefined,
  next: ProviderOrder | undefined,
): "older" | "equal" | "newer" | "unknown" => withCanonicalInputBoundary(() => {
  if (current?.kind !== "sequence" || next?.kind !== "sequence") return "unknown";
  if (!canonicalDecimal.test(current.value) || !canonicalDecimal.test(next.value)) return "unknown";
  if (next.value.length < current.value.length) return "older";
  if (next.value.length > current.value.length) return "newer";
  if (next.value === current.value) return "equal";
  return next.value < current.value ? "older" : "newer";
});
