import {isProxy} from "node:util/types";
import type {ContractSnapshot} from "../../ir/src/index.js";
import type {ObservationContext, SanitizedObservationResult, TrustedRouteMapping,
  UnresolvedObservationReason} from "./types.js";

export const OBSERVATION_POLICY_VERSION = "metadata-only-1" as const;

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const maxBytes = 64 * 1024;
const maxNodes = 512;
const maxDepth = 7;
const maxMembers = 128;
const maxStringBytes = 4096;
const maxUrlBytes = 2048;
const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const segment = /^[A-Za-z0-9._~-]+$/;
const parameter = /^(?:\{[A-Za-z_][A-Za-z0-9_]*\}|:[A-Za-z_][A-Za-z0-9_]*)$/;

type ParsedObservation = {url: string; method: string; statusCode: number; revision?: string};
type SafeObject = Record<string, unknown>;

const reject = (reason: "invalid_observation" | "invalid_context" | "invalid_mapping"): SanitizedObservationResult =>
  ({status: "rejected", reason, policyVersion: OBSERVATION_POLICY_VERSION});
const unresolved = (reason: UnresolvedObservationReason, observation?: ParsedObservation): SanitizedObservationResult =>
  ({status: "unresolved", reason, ...(observation ? {method: observation.method,
    statusCode: observation.statusCode} : {}), completeness: "metadata_only", policyVersion: OBSERVATION_POLICY_VERSION});

/** Inspect own data descriptors only. No getter, toJSON, or custom iterator is run. */
const inertJson = (root: unknown): root is SafeObject => {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const add = (value: string): boolean => {
    if (value.length > maxStringBytes) return false;
    const length = Buffer.byteLength(value, "utf8");
    bytes += length;
    return length <= maxStringBytes && bytes <= maxBytes;
  };
  const walk = (value: unknown, depth: number): boolean => {
    if (++nodes > maxNodes || depth > maxDepth) return false;
    if (typeof value === "string") return add(value);
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean" || value === null) return true;
    if (typeof value !== "object" || isProxy(value) || seen.has(value)) return false;
    seen.add(value);
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    if (array && prototype !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maxMembers + (array ? 1 : 0)) return false;
    for (const key of keys) {
      if (typeof key !== "string" || !add(key)) return false;
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      if (!walk(descriptor.value, depth + 1)) return false;
    }
    if (array && keys.length - 1 !== value.length) return false;
    return true;
  };
  try { return !!root && typeof root === "object" && !Array.isArray(root) && walk(root, 0); }
  catch { return false; }
};

const ownValue = (object: SafeObject, key: string): unknown =>
  Object.getOwnPropertyDescriptor(object, key)?.value;

const parseObservation = (raw: unknown): ParsedObservation | undefined => {
  if (!inertJson(raw)) return undefined;
  const url = ownValue(raw, "url");
  const method = ownValue(raw, "method");
  const statusCode = ownValue(raw, "statusCode");
  const revision = ownValue(raw, "revision");
  if (typeof url !== "string" || !url || Buffer.byteLength(url) > maxUrlBytes ||
    typeof method !== "string" || !methods.has(method) ||
    typeof statusCode !== "number" || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599 ||
    (revision !== undefined && (typeof revision !== "string" || !revision || !token.test(revision)))) return undefined;
  return {url, method, statusCode, ...(revision === undefined ? {} : {revision})};
};

type TemplatePart = {kind: "literal" | "parameter"; text: string};
const parseTemplate = (path: string): TemplatePart[] | undefined => {
  if (path.length > 1024 || !path.startsWith("/") || path.includes("//") || path.includes("%") ||
    path.includes("\\") || path.includes("?") || path.includes("#")) return undefined;
  if (path === "/") return [];
  const parts = path.slice(1).split("/");
  if (parts.length > 64) return undefined;
  const parsed: TemplatePart[] = [];
  for (const part of parts) {
    if (!part || part === "." || part === "..") return undefined;
    if (parameter.test(part)) parsed.push({kind: "parameter", text: ""});
    else if (segment.test(part)) parsed.push({kind: "literal", text: part});
    else return undefined;
  }
  return parsed;
};

const shape = (parts: TemplatePart[]): string =>
  `/${parts.map(part => part.kind === "parameter" ? "{}" : part.text).join("/")}`;

const matchPath = (path: string, parts: TemplatePart[]): boolean => {
  if (path === "/") return parts.length === 0;
  const values = path.slice(1).split("/");
  return values.length === parts.length && values.every((value, index) => {
    const part = parts[index]!;
    return !!value && segment.test(value) && value !== "." && value !== ".." &&
      (part.kind === "parameter" || part.text === value);
  });
};

const parseUrl = (raw: string): {origin: string; path: string} | undefined => {
  if (raw.includes("#") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  const match = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/.exec(raw);
  if (!match) return undefined;
  const path = match[2] || "/";
  if (!parseTemplate(path) || path.includes("{") || path.includes("}")) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== path || url.origin !== new URL(match[1]!).origin) return undefined;
    return {origin: url.origin, path};
  } catch { return undefined; }
};

const validOrigin = (origin: string): boolean => {
  if (origin.length > 255 || origin.includes("%") || origin.includes("#") || origin.includes("?") ||
    origin.includes("@") || origin.includes("\\")) return false;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash && url.origin === origin;
  } catch { return false; }
};

const validContext = (context: ObservationContext): boolean => {
  const {pin, snapshot, mappings, attestation} = context;
  return !!pin && !!snapshot && Array.isArray(mappings) && mappings.length <= 32 &&
    !!attestation && [attestation.revision, attestation.sourceId, attestation.sourceVersion]
      .every(value => typeof value === "string" && token.test(value)) &&
    typeof attestation.windowStart === "string" && attestation.windowStart.length <= 24 &&
    utcTimestamp.test(attestation.windowStart) &&
    typeof attestation.windowEnd === "string" && attestation.windowEnd.length <= 24 &&
    utcTimestamp.test(attestation.windowEnd) &&
    Number.isFinite(Date.parse(attestation.windowStart)) &&
    Date.parse(attestation.windowStart) <= Date.parse(attestation.windowEnd) &&
    [pin.tenantId, pin.serviceId, pin.repositoryId, pin.environment, pin.snapshotId,
      pin.revision, pin.configFingerprint, pin.checkpointVersion].every(value =>
      typeof value === "string" && token.test(value)) &&
    snapshot.snapshot_id === pin.snapshotId && snapshot.service?.service_id === pin.serviceId &&
    snapshot.service?.repository_id === pin.repositoryId && snapshot.source?.repository_id === pin.repositoryId &&
    snapshot.source?.immutable_revision === pin.revision &&
    snapshot.config?.config_fingerprint === pin.configFingerprint && Array.isArray(snapshot.endpoints) &&
    snapshot.endpoints.length <= 4096;
};

const validMapping = (mapping: TrustedRouteMapping, context: ObservationContext): boolean => {
  const pin = context.pin;
  const publicParts = parseTemplate(mapping.publicPathTemplate);
  const appParts = parseTemplate(mapping.applicationPathTemplate);
  return !!publicParts && !!appParts && validOrigin(mapping.publicOrigin) &&
    [mapping.mappingId, mapping.tenantId, mapping.serviceId, mapping.repositoryId, mapping.environment,
      mapping.snapshotId, mapping.revision, mapping.configFingerprint, mapping.checkpointVersion]
      .every(value => typeof value === "string" && token.test(value)) &&
    mapping.tenantId === pin.tenantId && mapping.serviceId === pin.serviceId &&
    mapping.repositoryId === pin.repositoryId && mapping.environment === pin.environment &&
    mapping.snapshotId === pin.snapshotId && mapping.revision === pin.revision &&
    mapping.configFingerprint === pin.configFingerprint && mapping.checkpointVersion === pin.checkpointVersion &&
    methods.has(mapping.method) && Array.isArray(mapping.routingEvidenceIds) &&
    mapping.routingEvidenceIds.length > 0 && mapping.routingEvidenceIds.length <= 16 &&
    mapping.routingEvidenceIds.every(id => typeof id === "string" && token.test(id));
};

const hasSelectors = (endpoint: ContractSnapshot["endpoints"][number]): boolean => {
  const selectors = endpoint.identity.selectors;
  return Object.values(selectors).some(value => Array.isArray(value) && value.length > 0);
};

/** Correlate already authorized source and routing evidence with one inert metadata record. */
export const correlateMetadataObservation = (raw: unknown, context: ObservationContext): SanitizedObservationResult => {
  const observation = parseObservation(raw);
  if (!observation) return reject("invalid_observation");
  try {
    if (!validContext(context)) return reject("invalid_context");
    if (context.pin.state !== "resolved_single_revision") return unresolved("environment_unresolved", observation);
    if (context.attestation.revision !== context.pin.revision) return reject("invalid_context");
    if (!observation.revision) return unresolved("revision_unknown", observation);
    if (observation.revision !== context.attestation.revision) return unresolved("revision_mismatch", observation);
    const url = parseUrl(observation.url);
    if (!url) return unresolved("invalid_url", observation);
    if (!context.mappings.every(mapping => validMapping(mapping, context))
      || new Set(context.mappings.map(mapping=>mapping.mappingId)).size!==context.mappings.length)
      return reject("invalid_mapping");
    const matches = context.mappings.filter(mapping => mapping.method === observation.method &&
      mapping.publicOrigin === url.origin && matchPath(url.path, parseTemplate(mapping.publicPathTemplate)!));
    if (!matches.length) return unresolved("no_mapping", observation);
    if (matches.length !== 1) return unresolved("ambiguous_mapping", observation);
    const mapping = matches[0]!;
    const appShape = shape(parseTemplate(mapping.applicationPathTemplate)!);
    const endpoints = context.snapshot.endpoints.filter(endpoint => endpoint.identity.method === observation.method &&
      endpoint.identity.service_id === context.pin.serviceId && endpoint.identity.normalized_path_shape === appShape);
    if (!endpoints.length) return unresolved("no_endpoint", observation);
    if (endpoints.some(hasSelectors)) return unresolved("unsupported_route_selectors", observation);
    if (endpoints.length !== 1) return unresolved("ambiguous_endpoint", observation);
    return {status: "confirmed", endpointId: endpoints[0]!.endpoint_id, mappingId: mapping.mappingId,
      method: observation.method, statusCode: observation.statusCode, completeness: "metadata_only",
      policyVersion: OBSERVATION_POLICY_VERSION};
  } catch { return reject("invalid_context"); }
};
