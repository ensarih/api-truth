import {createPublicKey, verify} from "node:crypto";
import {TextDecoder} from "node:util";
import {isProxy} from "node:util/types";
import {Value} from "@sinclair/typebox/value";
import {RuntimeBindingReceiptSchema, sha256} from "../../../analyzers/nodejs/src/runtime-binding.js";
import {parseStrictJson} from "../../../packages/ir/src/strict-json.js";
import {canonicalJsonStringify} from "../../../packages/ir/src/index.js";

const POLICY = "runtime-capture-pin-1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REVISION = /^[a-fA-F0-9]{12,128}$/;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const BINDING_KEYS = ["scope", "artifactRef", "configuredKeyRef", "expectedReceiptDigest", "expectedSignerSpkiDigest", "policyVersion"] as const;
const OPTIONS_KEYS = ["binding", "authorize", "readReceipt", "readKey"] as const;
const OPTIONAL_OPTIONS_KEYS = ["timeoutMs"] as const;
const matches = (expression: RegExp, value: unknown): value is string => typeof value === "string" && expression.test(value);

export type RuntimeCaptureScope = {tenantId: string; repositoryId: string; serviceId: string;
  immutableRevision: string; sourceDigest: string; environment: string};
export type RuntimeCaptureBinding = {scope: RuntimeCaptureScope; artifactRef: string; configuredKeyRef: string;
  expectedReceiptDigest: string; expectedSignerSpkiDigest: string; policyVersion: typeof POLICY};
export type RuntimeCapturePin = {kind: "pinned_envelope"; policyVersion: typeof POLICY; scope: RuntimeCaptureScope;
  artifactRef: string; configuredKeyRef: string; receiptDigest: string; signerSpkiDigest: string;
  identityDigest: string; sessionId: string; capturedAt: string;
  signedScopeFields: readonly ["repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"];
  hostBoundScopeFields: readonly ["tenantId", "policyVersion"]};
export type RuntimeCapturePinOptions = {binding: RuntimeCaptureBinding;
  /** Host authorization runs before either protected source is accessed. */
  authorize: (scope: Readonly<RuntimeCaptureScope>, signal: AbortSignal) => Promise<boolean>;
  /** Reads an externally protected artifact ID, never a source-tree path. */
  readReceipt: (artifactRef: string, signal: AbortSignal) => Promise<string>;
  /** Resolves an independently configured key ID, never a receipt-supplied key. */
  readKey: (configuredKeyRef: string, signal: AbortSignal) => Promise<string>;
  /** One total authorization/read deadline, 1–30,000 ms; defaults to 10,000 ms. */
  timeoutMs?: number};

const MESSAGES = {INVALID_CAPTURE_PIN_CONFIGURATION: "Invalid capture pin configuration",
  INVALID_CAPTURE_PIN_REQUEST: "Invalid capture pin request",
  CAPTURE_NOT_AUTHORIZED: "Capture not authorized",
  CAPTURE_SOURCE_UNAVAILABLE: "Capture source unavailable",
  CAPTURE_RECEIPT_UNVERIFIED: "Capture receipt unverified"} as const;
export class RuntimeCapturePinError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.code = code; }
}

/** Read own data properties only. Accessors, inherited fields, and extra fields are rejected. */
function record(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype)
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (fields.some(field => !Object.hasOwn(descriptors, field))
      || names.some(name => typeof name !== "string" || !fields.includes(name) && !optional.includes(name))) return undefined;
    const result: Record<string, unknown> = Object.create(null);
    for (const field of [...fields, ...optional]) {
      const descriptor = descriptors[field];
      if (!descriptor && optional.includes(field)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      result[field] = descriptor.value;
    }
    return result;
  } catch { return undefined; }
}
function scopeOf(value: unknown): RuntimeCaptureScope | undefined {
  const raw = record(value, SCOPE_KEYS);
  if (!raw || !matches(NAME, raw.tenantId) || !matches(NAME, raw.repositoryId)
    || !matches(NAME, raw.serviceId) || !matches(REVISION, raw.immutableRevision)
    || !matches(DIGEST, raw.sourceDigest) || !matches(NAME, raw.environment)) return undefined;
  return Object.freeze({tenantId: raw.tenantId, repositoryId: raw.repositoryId, serviceId: raw.serviceId,
    immutableRevision: raw.immutableRevision, sourceDigest: raw.sourceDigest, environment: raw.environment});
}
function bindingOf(value: unknown): RuntimeCaptureBinding | undefined {
  const raw = record(value, BINDING_KEYS), scope = scopeOf(raw?.scope);
  if (!raw || !scope || !matches(ARTIFACT, raw.artifactRef) || !matches(KEY, raw.configuredKeyRef)
    || !matches(DIGEST, raw.expectedReceiptDigest) || !matches(DIGEST, raw.expectedSignerSpkiDigest)
    || raw.policyVersion !== POLICY) return undefined;
  return Object.freeze({scope, artifactRef: raw.artifactRef, configuredKeyRef: raw.configuredKeyRef,
    expectedReceiptDigest: raw.expectedReceiptDigest, expectedSignerSpkiDigest: raw.expectedSignerSpkiDigest,
    policyVersion: POLICY});
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const utf8 = new TextDecoder("utf-8", {fatal: true});
function decodeBase64(value: unknown, maxCharacters: number): Buffer | undefined {
  if (typeof value !== "string" || value.length > maxCharacters || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

/** Pins one externally stored, signed receipt envelope to an independently configured host binding. */
export function createRuntimeCapturePinResolver(options: RuntimeCapturePinOptions): {resolve(scope: RuntimeCaptureScope): Promise<RuntimeCapturePin>} {
  const raw = record(options, OPTIONS_KEYS, OPTIONAL_OPTIONS_KEYS), binding = bindingOf(raw?.binding);
  const timeoutMs = raw && Object.hasOwn(raw, "timeoutMs") ? raw.timeoutMs : 10_000;
  if (!raw || !binding || typeof raw.authorize !== "function" || typeof raw.readReceipt !== "function"
    || typeof raw.readKey !== "function" || typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 30_000) throw new RuntimeCapturePinError("INVALID_CAPTURE_PIN_CONFIGURATION");
  const authorize = raw.authorize as RuntimeCapturePinOptions["authorize"];
  const readReceipt = raw.readReceipt as RuntimeCapturePinOptions["readReceipt"];
  const readKey = raw.readKey as RuntimeCapturePinOptions["readKey"];
  return Object.freeze({async resolve(candidate: RuntimeCaptureScope): Promise<RuntimeCapturePin> {
    const scope = scopeOf(candidate);
    if (!scope || SCOPE_KEYS.some(field => scope[field] !== binding.scope[field]))
      throw new RuntimeCapturePinError("INVALID_CAPTURE_PIN_REQUEST");
    const controller = new AbortController();
    const signal = controller.signal;
    const deadline = performance.now() + timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const expired = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Error("deadline")), {once: true});
    });
    const phase = async <T>(callback: () => Promise<T>, code: RuntimeCapturePinError["code"]): Promise<T> => {
      if (signal.aborted || performance.now() >= deadline) throw new RuntimeCapturePinError(code);
      try { return await Promise.race([Promise.resolve().then(callback), expired]); }
      catch { throw new RuntimeCapturePinError(code); }
    };
    const requireAuthorization = async (): Promise<void> => {
      if (await phase(() => authorize(scope, signal), "CAPTURE_NOT_AUTHORIZED") !== true)
        throw new RuntimeCapturePinError("CAPTURE_NOT_AUTHORIZED");
    };
    try {
      await requireAuthorization();
      const text = await phase(() => readReceipt(binding.artifactRef, signal), "CAPTURE_SOURCE_UNAVAILABLE");
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1_000_000
        || sha256(text) !== binding.expectedReceiptDigest)
        throw new RuntimeCapturePinError("CAPTURE_RECEIPT_UNVERIFIED");
      const keyText = await phase(() => readKey(binding.configuredKeyRef, signal), "CAPTURE_SOURCE_UNAVAILABLE");
      let pin: RuntimeCapturePin;
      try {
      if (typeof keyText !== "string" || Buffer.byteLength(keyText, "utf8") > 10_000
        || !keyText.startsWith("-----BEGIN PUBLIC KEY-----")) throw Error();
      const key = createPublicKey(keyText);
      if (key.asymmetricKeyType !== "ed25519") throw Error();
      const signerSpkiDigest = sha256(key.export({type: "spki", format: "der"}));
      if (signerSpkiDigest !== binding.expectedSignerSpkiDigest) throw Error();
      const envelope = parseStrictJson(text, {maxDepth: 4, maxNodes: 8});
      if (!object(envelope) || Object.keys(envelope).length !== 2) throw Error();
      const payload = decodeBase64(envelope.payload, 1_333_336);
      const signature = decodeBase64(envelope.signature, 88);
      if (!payload || payload.length > 1_000_000 || !signature || signature.length !== 64
        || !verify(null, payload, key, signature)) throw Error();
      const receipt = parseStrictJson(utf8.decode(payload), {maxDepth: 16, maxNodes: 20_000});
      if (!Value.Check(RuntimeBindingReceiptSchema, receipt)) throw Error();
      if (new Date(receipt.captured_at).toISOString() !== receipt.captured_at
        || receipt.repository_id !== scope.repositoryId || receipt.service_id !== scope.serviceId
        || receipt.immutable_revision !== scope.immutableRevision || receipt.source_digest !== scope.sourceDigest
        || receipt.environment !== scope.environment) throw Error();
      const seen = new Set<string>();
      for (const item of receipt.bindings) {
        const identity = `${item.method}:${item.application_path}`;
        if (seen.has(identity) || item.export_name !== item.operation_id
          || item.handler_path.split("/").some(part => part === "." || part === "..")) throw Error();
        seen.add(identity);
      }
      const identityDigest = sha256(canonicalJsonStringify({policyVersion: POLICY, scope, artifactRef: binding.artifactRef,
        configuredKeyRef: binding.configuredKeyRef, receiptDigest: binding.expectedReceiptDigest, signerSpkiDigest}));
      pin = Object.freeze({kind: "pinned_envelope", policyVersion: POLICY, scope,
        artifactRef: binding.artifactRef, configuredKeyRef: binding.configuredKeyRef,
        receiptDigest: binding.expectedReceiptDigest, signerSpkiDigest, identityDigest,
        sessionId: receipt.session_id, capturedAt: receipt.captured_at,
        signedScopeFields: Object.freeze(["repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const),
        hostBoundScopeFields: Object.freeze(["tenantId", "policyVersion"] as const)});
      } catch { throw new RuntimeCapturePinError("CAPTURE_RECEIPT_UNVERIFIED"); }
      await requireAuthorization();
      return pin;
    } finally { clearTimeout(timeout); }
  }});
}
