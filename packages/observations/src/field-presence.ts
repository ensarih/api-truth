import {isProxy} from "node:util/types";
import {parseContractSnapshot, type ContractSnapshot} from "../../ir/src/index.js";
import type {TrustedResolvedEnvironmentPin} from "./types.js";

export type ObservedFieldPresencePolicy = Readonly<{
  version: "observed-field-presence-1";
  policyId: string;
  tenantId: string;
  repositoryId: string;
  serviceId: string;
  environment: string;
  snapshotId: string;
  revision: string;
  sourceDigest: string;
  configFingerprint: string;
  checkpointVersion: string;
  endpointId: string;
  direction: "request" | "response";
  mediaType: string;
  propertyPaths: readonly string[];
  statusCode?: number;
}>;

export type FieldPresenceDiagnostic = Readonly<{ruleId: string; count: number}>;
export type FieldPresenceResult =
  | Readonly<{
      status: "projected";
      kind: "observed_field_presence";
      nonNormative: true;
      policyVersion: "observed-field-presence-1";
      scope: Readonly<{tenantId: string; repositoryId: string; serviceId: string; environment: string;
        snapshotId: string; revision: string; sourceDigest: string; configFingerprint: string;
        checkpointVersion: string; endpointId: string; direction: "request" | "response";
        mediaType: string; statusCode?: number}>;
      fields: readonly Readonly<{path: string; state: "present" | "absent"}>[];
      diagnostics: readonly FieldPresenceDiagnostic[];
    }>
  | Readonly<{status: "withheld"; policyVersion: "observed-field-presence-1";
      diagnostics: readonly FieldPresenceDiagnostic[]}>;

export class FieldPresenceInputError extends Error {
  readonly code = "INVALID_FIELD_PRESENCE_INPUT" as const;
  constructor() { super("Invalid field-presence input"); this.name = "FieldPresenceInputError"; }
}

const fail = (): never => { throw new FieldPresenceInputError(); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object"
  && !Array.isArray(value) && !isProxy(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Clone inert JSON-shaped values without invoking getters, toJSON, or proxy traps. */
const cloneJson = (root: unknown, limits: {bytes: number; nodes: number; depth: number; maxStringBytes?: number}): unknown => {
  let bytes = 0, nodes = 0;
  const addText = (value: string, max: number): void => {
    if (value.length > max) fail();
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > limits.bytes) fail();
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.nodes || depth > limits.depth) fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { addText(value, limits.maxStringBytes ?? 16_384); return value; }
    if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return value; }
    if (typeof value !== "object" || isProxy(value)) fail();
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2048) fail();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) fail();
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) return fail();
        output.push(visit(descriptor.value, depth + 1));
      }
      if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) fail();
      if (value.length !== Object.keys(descriptors).filter(key => key !== "length").length) fail();
      return output;
    }
    if (!plain(value)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 20_000 || keys.some(key => typeof key !== "string")) fail();
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      addText(key, 1024);
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) fail();
      Object.defineProperty(output, key, {value: visit(descriptor.value, depth + 1),
        enumerable: true, writable: true, configurable: true});
    }
    return output;
  };
  return visit(root, 0);
};

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.getOwnPropertyDescriptor(record, key)?.value;
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key));
};
const boundedIdentifier = (value: unknown, max = 256): value is string => typeof value === "string"
  && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

type ParsedPolicy = ObservedFieldPresencePolicy;
const parsePolicy = (raw: unknown): ParsedPolicy => {
  if (!plain(raw)) return fail();
  const hasStatus = Object.hasOwn(raw, "statusCode");
  const keys = ["version", "policyId", "tenantId", "repositoryId", "serviceId", "environment", "snapshotId",
    "revision", "sourceDigest", "configFingerprint", "checkpointVersion", "endpointId", "direction", "mediaType",
    "propertyPaths", ...(hasStatus ? ["statusCode"] : [])];
  if (!hasExactKeys(raw, keys) || own(raw, "version") !== "observed-field-presence-1") return fail();
  for (const key of keys.filter(key => key !== "propertyPaths" && key !== "statusCode" && key !== "version"))
    if (!boundedIdentifier(own(raw, key))) return fail();
  const direction = own(raw, "direction");
  if (direction !== "request" && direction !== "response") return fail();
  const mediaType = own(raw, "mediaType");
  if (!boundedIdentifier(mediaType, 128) || !/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(mediaType)) return fail();
  const statusCode = own(raw, "statusCode");
  if (direction === "response" ? typeof statusCode !== "number" || !Number.isInteger(statusCode)
    || statusCode < 100 || statusCode > 599 : hasStatus) return fail();
  const paths = own(raw, "propertyPaths");
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 32) return fail();
  const decoded = paths.map(decodePointer);
  if (decoded.some(path => path.length > 12) || new Set(paths).size !== paths.length) return fail();
  if (decoded.some(path => decodedUnsafeLabel(path))) return fail();
  return Object.freeze({version: "observed-field-presence-1", policyId: own(raw, "policyId") as string,
    tenantId: own(raw, "tenantId") as string, repositoryId: own(raw, "repositoryId") as string,
    serviceId: own(raw, "serviceId") as string, environment: own(raw, "environment") as string,
    snapshotId: own(raw, "snapshotId") as string, revision: own(raw, "revision") as string,
    sourceDigest: own(raw, "sourceDigest") as string, configFingerprint: own(raw, "configFingerprint") as string,
    checkpointVersion: own(raw, "checkpointVersion") as string, endpointId: own(raw, "endpointId") as string,
    direction, mediaType, propertyPaths: Object.freeze(paths as string[]),
    ...(hasStatus ? {statusCode: statusCode as number} : {})});
};

const decodePointer = (raw: unknown): string[] => {
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 512 || !raw.startsWith("/")) return fail();
  return raw.slice(1).split("/").map(segment => {
    if (/~(?![01])/.test(segment)) return fail();
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!decoded || decoded.length > 128 || /[\u0000-\u001f\u007f]/.test(decoded) || decoded === "*") return fail();
    return decoded;
  });
};
const decodedUnsafeLabel = (segments: readonly string[]): boolean => segments.some(key => {
  if (key === "__proto__" || key === "prototype" || key === "constructor") return true;
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(?:email|phone|mobile|ssn|socialsecurity|creditcard|cardnumber|dateofbirth|birthdate|firstname|lastname|givenname|familyname|postalcode|streetaddress)/.test(normalized);
});

/** Strict, bounded JSON text parser. Duplicate object members are rejected before constructing values. */
const parsePayloadText = (text: unknown): unknown => {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 256 * 1024) return fail();
  let index = 0, nodes = 0, members = 0;
  const whitespace = (): void => { while (text[index] === " " || text[index] === "\n" || text[index] === "\r" || text[index] === "\t") index++; };
  const string = (): string => {
    if (text[index] !== '"') return fail();
    const start = index++;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index++;
        try { return JSON.parse(text.slice(start, index)) as string; } catch { return fail(); }
      }
      if (code < 0x20) return fail();
      if (code === 0x5c) {
        index++;
        const escaped = text[index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) return fail();
          index += 5;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) return fail();
      }
      index++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (++nodes > 10_000 || depth > 32) return fail();
    whitespace();
    const char = text[index];
    if (char === '"') return string();
    if (char === "{") {
      index++;
      whitespace();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      if (text[index] === "}") { index++; return result; }
      while (true) {
        whitespace();
        const key = string();
        if (Buffer.byteLength(key, "utf8") > 1024 || ++members > 2048 || seen.has(key)) return fail();
        seen.add(key);
        whitespace();
        if (text[index++] !== ":") return fail();
        const member = value(depth + 1);
        Object.defineProperty(result, key, {value: member, enumerable: true, writable: true, configurable: true});
        whitespace();
        if (text[index] === "}") { index++; return result; }
        if (text[index++] !== ",") return fail();
      }
    }
    if (char === "[") {
      index++;
      whitespace();
      const result: unknown[] = [];
      if (text[index] === "]") { index++; return result; }
      while (true) {
        if (result.length >= 2048) return fail();
        result.push(value(depth + 1));
        whitespace();
        if (text[index] === "]") { index++; return result; }
        if (text[index++] !== ",") return fail();
      }
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (number) {
      index += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) return fail();
      // Presence classification must not mistake a rounded fraction or underflow
      // for a declared integer. Withhold unsafe integral representations.
      if (Number.isInteger(parsed)) {
        if (!Number.isSafeInteger(parsed)) return fail();
        const parts = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(number[0])!;
        const digits = (parts[1]! + (parts[2] ?? "")).replace(/^0+/, "");
        const scale = Number(parts[3] ?? "0") - (parts[2]?.length ?? 0);
        if (digits && scale < 0 && (scale <= -digits.length || /[1-9]/.test(digits.slice(scale)))) return fail();
      }
      return parsed;
    }
    return fail();
  };
  const result = value(0);
  whitespace();
  if (index !== text.length) return fail();
  return result;
};

type Counts = Map<string, number>;
const diagnostics = (counts: Counts): readonly FieldPresenceDiagnostic[] => Object.freeze(
  [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([ruleId, count]) => Object.freeze({ruleId, count})));
const withheld = (ruleId: string): FieldPresenceResult => Object.freeze({status: "withheld",
  policyVersion: "observed-field-presence-1", diagnostics: Object.freeze([Object.freeze({ruleId, count: 1})])});

const simpleSchemaKeys = new Set(["type", "title", "description"]);
const objectSchemaKeys = new Set(["type", "title", "description", "properties", "required"]);
const schemaAtPath = (root: unknown, segments: readonly string[]): Record<string, unknown> | undefined => {
  let current: unknown = root;
  for (let index = 0; index < segments.length; index++) {
    if (!plain(current) || !hasExactKeys(current, [...Object.keys(current)])) return undefined;
    if (Object.keys(current).some(key => !objectSchemaKeys.has(key)) || own(current, "type") !== "object") return undefined;
    const properties = own(current, "properties");
    if (!plain(properties) || Object.keys(properties).length > 256) return undefined;
    const key = segments[index]!;
    if (!Object.hasOwn(properties, key)) return undefined;
    current = own(properties, key);
    if (!plain(current)) return undefined;
    const terminal = index === segments.length - 1;
    if (terminal) {
      const type = own(current, "type");
      if (!["string", "number", "integer", "boolean", "null"].includes(String(type))
        || Object.keys(current).some(candidate => !simpleSchemaKeys.has(candidate))) return undefined;
      return current;
    }
  }
  return undefined;
};

const findSelectedSchema = (snapshot: ContractSnapshot, policy: ParsedPolicy): unknown | undefined => {
  const endpoint = snapshot.endpoints.find(candidate => candidate.endpoint_id === policy.endpointId);
  if (!endpoint || snapshot.endpoints.filter(candidate => candidate.endpoint_id === policy.endpointId).length !== 1) return undefined;
  if (policy.direction === "request") {
    const bodies = endpoint.request_bodies.filter(body => body.media_type === policy.mediaType);
    return bodies.length === 1 ? bodies[0]!.schema : undefined;
  }
  const responses = endpoint.responses.filter(response => response.status.kind === "exact" && response.status.code === policy.statusCode);
  if (responses.length !== 1) return undefined;
  const contents = responses[0]!.content.filter(content => content.media_type === policy.mediaType);
  return contents.length === 1 ? contents[0]!.schema : undefined;
};

const matchesScope = (pin: unknown, snapshot: ContractSnapshot, policy: ParsedPolicy): boolean => {
  if (!plain(pin) || !hasExactKeys(pin, ["state", "tenantId", "serviceId", "repositoryId", "environment", "snapshotId",
    "revision", "configFingerprint", "checkpointVersion"])) return false;
  return own(pin, "state") === "resolved_single_revision"
    && own(pin, "tenantId") === policy.tenantId && own(pin, "repositoryId") === policy.repositoryId
    && own(pin, "serviceId") === policy.serviceId && own(pin, "environment") === policy.environment
    && own(pin, "snapshotId") === policy.snapshotId && own(pin, "revision") === policy.revision
    && own(pin, "configFingerprint") === policy.configFingerprint && own(pin, "checkpointVersion") === policy.checkpointVersion
    && snapshot.snapshot_id === policy.snapshotId && snapshot.service.service_id === policy.serviceId
    && snapshot.service.repository_id === policy.repositoryId && snapshot.source.repository_id === policy.repositoryId
    && snapshot.source.immutable_revision === policy.revision && snapshot.source.source_digest === policy.sourceDigest
    && snapshot.config.config_fingerprint === policy.configFingerprint;
};

const presenceAtPath = (payload: unknown, segments: readonly string[], leafType: string): "present" | "absent" | undefined => {
  let current: unknown = payload;
  for (const [index, key] of segments.entries()) {
    if (!plain(current)) return undefined;
    if (!Object.hasOwn(current, key)) return "absent";
    current = own(current, key);
    const terminal = index === segments.length - 1;
    if (!terminal && !plain(current)) return undefined;
    if (terminal) {
      if (leafType === "object") return plain(current) ? "present" : undefined;
      if (leafType === "string") return typeof current === "string" ? "present" : undefined;
      if (leafType === "boolean") return typeof current === "boolean" ? "present" : undefined;
      if (leafType === "number") return typeof current === "number" ? "present" : undefined;
      if (leafType === "integer") return typeof current === "number" && Number.isInteger(current) ? "present" : undefined;
      if (leafType === "null") return current === null ? "present" : undefined;
    }
  }
  return undefined;
};

/**
 * Projects only owner-selected field presence. The supplied pin is consistency context, not proof of authorization;
 * the host must authorize the policy and recheck the current pin before reading an observed payload.
 */
export const projectObservedFieldPresence = (input: unknown): FieldPresenceResult => {
  const root = cloneJson(input, {bytes: 3 * 1024 * 1024, nodes: 60_000, depth: 64, maxStringBytes: 256 * 1024});
  if (!plain(root) || !hasExactKeys(root, ["pin", "snapshot", "policy", "payloadText", "payloadCompleteness"])) return fail();
  const policy = parsePolicy(own(root, "policy"));
  const payloadCompleteness = own(root, "payloadCompleteness");
  if (!["complete_unredacted", "truncated", "redacted", "unknown"].includes(String(payloadCompleteness))) return fail();
  const parsedSnapshot = parseContractSnapshot(own(root, "snapshot"));
  if (!parsedSnapshot.ok || !matchesScope(own(root, "pin"), parsedSnapshot.value, policy)) return withheld("scope_or_snapshot_mismatch");
  const schema = findSelectedSchema(parsedSnapshot.value, policy);
  if (schema === undefined) return withheld("selected_schema_unavailable");
  if (payloadCompleteness !== "complete_unredacted") return withheld("payload_incomplete_or_redacted");
  let payload: unknown;
  try {payload = parsePayloadText(own(root, "payloadText"));}
  catch {return withheld("payload_parse_unverified");}
  if (!plain(payload)) return withheld("payload_shape_unsupported");
  const selected = policy.propertyPaths.map(path => {
    const segments = decodePointer(path);
    const leaf = schemaAtPath(schema, segments);
    if (!leaf) return undefined;
    const state = presenceAtPath(payload, segments, String(own(leaf, "type")));
    return state ? Object.freeze({path, state}) : undefined;
  });
  if (selected.some(field => field === undefined)) return withheld("schema_or_payload_shape_unsupported");
  const counts: Counts = new Map([["selected_paths", selected.length]]);
  return Object.freeze({status: "projected", kind: "observed_field_presence", nonNormative: true,
    policyVersion: "observed-field-presence-1",
    scope: Object.freeze({tenantId: policy.tenantId, repositoryId: policy.repositoryId, serviceId: policy.serviceId,
      environment: policy.environment, snapshotId: policy.snapshotId, revision: policy.revision,
      sourceDigest: policy.sourceDigest, configFingerprint: policy.configFingerprint,
      checkpointVersion: policy.checkpointVersion, endpointId: policy.endpointId, direction: policy.direction,
      mediaType: policy.mediaType, ...(policy.statusCode === undefined ? {} : {statusCode: policy.statusCode})}),
    fields: Object.freeze(selected as Array<Readonly<{path: string; state: "present" | "absent"}>>),
    diagnostics: diagnostics(counts)});
};

export type {TrustedResolvedEnvironmentPin};
