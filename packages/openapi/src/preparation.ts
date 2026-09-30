import { createHash } from "node:crypto";
import { parseContractSnapshot, type ContractSnapshot } from "@api-truth/ir";
import { compileOpenApiSnapshot, type OpenApiCompileDiagnostic, type OpenApiCompileMode } from "./compiler.js";

type SelectorBase = Readonly<{
  repositoryId: string;
  serviceId: string;
  snapshotId: string;
  revision: string;
  configFingerprint: string;
}>;

export type OpenApiPublicationSelector =
  | (SelectorBase & Readonly<{ kind: "revision" }>)
  | (SelectorBase & Readonly<{ kind: "branch"; branch: string; pointerVersion: string }>)
  | (SelectorBase & Readonly<{
    kind: "environment";
    environment: string;
    checkpointVersion: string;
    /** Asserted preflight observation; the publisher must re-read authoritative rows. */
    resolvedSnapshotIds: readonly string[];
  }>);

export type OpenApiPublicationProvenance = Readonly<{
  selector: OpenApiPublicationSelector;
  snapshotId: string;
  repositoryId: string;
  serviceId: string;
  revision: string;
  sourceDigest: string;
  configVersion: string;
  configFingerprint: string;
}>;

export type OpenApiPublicationPreparation = Readonly<{
  publishable: boolean;
  mode: OpenApiCompileMode;
  document?: Readonly<Record<string, unknown>>;
  bytes?: Uint8Array;
  contentSha256?: `sha256:${string}`;
  diagnostics: readonly OpenApiCompileDiagnostic[];
  provenance: OpenApiPublicationProvenance;
}>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const plainDataRecord = (value: unknown): Record<string, unknown> | undefined => {
  try {
    if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length
      || keys.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]!))) return undefined;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
  } catch { return undefined; }
};

const singleSnapshotId = (value: unknown): string | undefined => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 1)
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== 2 || !("value" in descriptors["0"]!)) return undefined;
    return nonEmpty(descriptors["0"]!.value) ? descriptors["0"]!.value as string : undefined;
  } catch { return undefined; }
};

const parseSelector = (value: unknown): OpenApiPublicationSelector => {
  value = plainDataRecord(value);
  const base = ["kind", "repositoryId", "serviceId", "snapshotId", "revision", "configFingerprint"];
  if (!isObject(value) || !base.slice(1).every((key) => nonEmpty(value[key])))
    throw new Error("Invalid OpenAPI publication selector");
  if (value.kind === "revision" && hasOnlyKeys(value, base))
    return Object.freeze({ kind: "revision", repositoryId: value.repositoryId as string,
      serviceId: value.serviceId as string, snapshotId: value.snapshotId as string,
      revision: value.revision as string, configFingerprint: value.configFingerprint as string });
  if (value.kind === "branch" && hasOnlyKeys(value, [...base, "branch", "pointerVersion"])
    && nonEmpty(value.branch) && nonEmpty(value.pointerVersion))
    return Object.freeze({ kind: "branch", repositoryId: value.repositoryId as string,
      serviceId: value.serviceId as string, snapshotId: value.snapshotId as string,
      revision: value.revision as string, configFingerprint: value.configFingerprint as string,
      branch: value.branch, pointerVersion: value.pointerVersion });
  const resolvedSnapshotId = singleSnapshotId(value.resolvedSnapshotIds);
  if (value.kind === "environment" && hasOnlyKeys(value,
    [...base, "environment", "checkpointVersion", "resolvedSnapshotIds"])
    && nonEmpty(value.environment) && nonEmpty(value.checkpointVersion)
    && resolvedSnapshotId !== undefined)
    return Object.freeze({ kind: "environment", repositoryId: value.repositoryId as string,
      serviceId: value.serviceId as string, snapshotId: value.snapshotId as string,
      revision: value.revision as string, configFingerprint: value.configFingerprint as string,
      environment: value.environment, checkpointVersion: value.checkpointVersion,
      resolvedSnapshotIds: Object.freeze([resolvedSnapshotId]) });
  throw new Error("Invalid OpenAPI publication selector");
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Invalid OpenAPI document value");
  return json;
};

const freezeJson = <Value>(value: Value): Readonly<Value> => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Pure preparation from an already selected snapshot. The publisher must atomically verify
 * branch pointer or environment checkpoint pins against current storage before promotion.
 */
export const prepareOpenApiPublication = (input: {
  snapshot: ContractSnapshot;
  mode: OpenApiCompileMode;
  selector: OpenApiPublicationSelector;
}): OpenApiPublicationPreparation => {
  const request = plainDataRecord(input);
  if (request === undefined || !hasOnlyKeys(request, ["snapshot", "mode", "selector"]))
    throw new Error("Invalid OpenAPI publication input");
  if (request.mode !== "draft" && request.mode !== "strict") throw new Error("Invalid OpenAPI compile mode");
  const parsed = parseContractSnapshot(request.snapshot);
  if (!parsed.ok) throw new Error("Invalid contract snapshot");
  const snapshot = parsed.value;
  const selector = parseSelector(request.selector);
  if (selector.repositoryId !== snapshot.service.repository_id
    || selector.repositoryId !== snapshot.source.repository_id
    || selector.serviceId !== snapshot.service.service_id
    || selector.snapshotId !== snapshot.snapshot_id
    || selector.revision !== snapshot.source.immutable_revision
    || selector.configFingerprint !== snapshot.config.config_fingerprint
    || selector.kind === "environment" && selector.resolvedSnapshotIds[0] !== snapshot.snapshot_id)
    throw new Error("OpenAPI publication selector does not match snapshot");

  const provenance: OpenApiPublicationProvenance = Object.freeze({
    selector, snapshotId: snapshot.snapshot_id, repositoryId: snapshot.service.repository_id,
    serviceId: snapshot.service.service_id, revision: snapshot.source.immutable_revision,
    sourceDigest: snapshot.source.source_digest, configVersion: snapshot.config.config_version,
    configFingerprint: snapshot.config.config_fingerprint,
  });
  const compiled = compileOpenApiSnapshot(snapshot, request.mode);
  if (compiled.document === undefined) return Object.freeze({
    publishable: false, mode: request.mode, diagnostics: compiled.diagnostics, provenance,
  });
  const document = freezeJson({ ...compiled.document, "x-api-truth-provenance": {
    snapshotId: provenance.snapshotId, repositoryId: provenance.repositoryId,
    serviceId: provenance.serviceId, revision: provenance.revision,
    sourceDigest: provenance.sourceDigest, configVersion: provenance.configVersion,
    configFingerprint: provenance.configFingerprint,
  } });
  const canonicalBytes = new TextEncoder().encode(canonicalJson(document));
  const contentSha256 = `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}` as const;
  return Object.freeze({ publishable: request.mode === "strict" && compiled.diagnostics.length === 0,
    mode: request.mode, document,
    get bytes() { return new Uint8Array(canonicalBytes); }, contentSha256,
    diagnostics: compiled.diagnostics, provenance });
};
