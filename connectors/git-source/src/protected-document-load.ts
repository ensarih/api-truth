import {createHash, createPublicKey, verify} from "node:crypto";
import {isProxy} from "node:util/types";
import {TextDecoder} from "node:util";
import {canonicalJsonStringify} from "@api-truth/ir";
import {parseStrictJson} from "../../../packages/ir/src/strict-json.js";

const PROFILE = "swagger-document-load-capture-1" as const;
const PURPOSE = "api-truth:swagger-document-load-observation-1" as const;
const OBSERVATION_KIND = "unsigned_runtime_document_load" as const;
const LIMITATION = "A signed load observation does not prove production deployment or normative API behavior" as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REVISION = /^[a-fA-F0-9]{12,128}$/;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY_REF = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const OPTION_KEYS = ["binding", "authorize", "readArtifact", "readKey"] as const;
const OPTIONAL_OPTION_KEYS = ["timeoutMs", "signal"] as const;
const BINDING_KEYS = ["scope", "artifactRef", "configuredKeyRef", "expectedEnvelopeDigest", "expectedSignerSpkiDigest", "expectedObservation"] as const;
const utf8 = new TextDecoder("utf-8", {fatal: true});
const sha256 = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const nativeSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

export type ProtectedDocumentLoadScope = {tenantId: string; repositoryId: string; serviceId: string;
  immutableRevision: string; sourceDigest: string; environment: string};
export type ProtectedDocumentLoadObservation = {kind: typeof OBSERVATION_KIND; profileVersion: typeof PROFILE;
  source: {repositoryId: string; serviceId: string; immutableRevision: string; sourceDigest: string;
    environment: string; sessionId: string};
  framework: {nodeVersion: string; routerDigest: string; runnerDigest: string; swayDigest: string;
    jsonRefsDigest: string; pathLoaderDigest: string};
  document: {path: "api/swagger/swagger.yaml"; rawSha256: string; canonicalValueSha256: string};
  bindings: ReadonlyArray<{method: string; application_path: string; controller: string; operation_id: string;
    export_name: string; handler_path: string; handler_digest: string; mock_mode: false}>};
export type ProtectedDocumentLoadBinding = {scope: ProtectedDocumentLoadScope; artifactRef: string;
  configuredKeyRef: string; expectedEnvelopeDigest: string; expectedSignerSpkiDigest: string;
  expectedObservation: ProtectedDocumentLoadObservation};
export type ProtectedDocumentLoadVerifierOptions = {binding: ProtectedDocumentLoadBinding;
  authorize(scope: Readonly<ProtectedDocumentLoadScope>, signal: AbortSignal): Promise<boolean>;
  readArtifact(artifactRef: string, signal: AbortSignal): Promise<string>;
  readKey(configuredKeyRef: string, signal: AbortSignal): Promise<string>; timeoutMs?: number; signal?: AbortSignal};
export type VerifiedProtectedDocumentLoad = {kind: "verified_signed_document_load_observation";
  profileVersion: typeof PROFILE; purpose: typeof PURPOSE; scope: ProtectedDocumentLoadScope; artifactRef: string;
  configuredKeyRef: string; envelopeDigest: string; signerSpkiDigest: string;
  observation: ProtectedDocumentLoadObservation; limitations: readonly [typeof LIMITATION]};

const messages = {INVALID_DOCUMENT_LOAD_CONFIG: "Invalid document-load verification configuration",
  DOCUMENT_LOAD_UNAUTHORIZED: "Document-load verification unauthorized",
  DOCUMENT_LOAD_UNAVAILABLE: "Document-load evidence unavailable",
  DOCUMENT_LOAD_UNVERIFIED: "Document-load evidence unverified"} as const;
export class ProtectedDocumentLoadError extends Error {
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) {super(messages[code]); this.code = code;}
}

/** Copy an exact own-data object without invoking accessors or proxy traps. */
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (required.some(key => !Object.hasOwn(descriptors, key))
      || Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) return undefined;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of [...required, ...optional]) {
      const descriptor = descriptors[key];
      if (!descriptor && optional.includes(key)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {return undefined;}
}
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);
function inertArray(value: unknown, maxLength: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1 || !Object.hasOwn(descriptors, "length")) return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {return undefined;}
}
function scopeOf(value: unknown): ProtectedDocumentLoadScope | undefined {
  const raw = data(value, SCOPE_KEYS);
  if (!raw || !matches(NAME, raw.tenantId) || !matches(NAME, raw.repositoryId) || !matches(NAME, raw.serviceId)
    || !matches(REVISION, raw.immutableRevision) || !matches(DIGEST, raw.sourceDigest) || !matches(NAME, raw.environment)) return undefined;
  return Object.freeze({tenantId: raw.tenantId, repositoryId: raw.repositoryId, serviceId: raw.serviceId,
    immutableRevision: raw.immutableRevision, sourceDigest: raw.sourceDigest, environment: raw.environment});
}
function isAbortSignal(value: unknown): value is AbortSignal {
  try {return !!value && typeof value === "object" && !isProxy(value)
    && Object.getPrototypeOf(value) === AbortSignal.prototype && typeof nativeSignalAborted?.call(value) === "boolean";}
  catch {return false;}
}
function base64(value: unknown, max: number): Buffer | undefined {
  if (typeof value !== "string" || value.length > max
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

function expectedObservation(value: unknown, scope: ProtectedDocumentLoadScope): ProtectedDocumentLoadObservation | undefined {
  const top = data(value, ["kind", "profileVersion", "source", "framework", "document", "bindings"]);
  const rawBindings = inertArray(top?.bindings, 1024);
  if (!top || top.kind !== OBSERVATION_KIND || top.profileVersion !== PROFILE || !rawBindings
    || rawBindings.length < 1) return undefined;
  const source = data(top.source, ["repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment", "sessionId"]);
  if (!source || source.repositoryId !== scope.repositoryId || source.serviceId !== scope.serviceId
    || source.immutableRevision !== scope.immutableRevision || source.sourceDigest !== scope.sourceDigest
    || source.environment !== scope.environment || !matches(NAME, source.sessionId)) return undefined;
  const framework = data(top.framework, ["nodeVersion", "routerDigest", "runnerDigest", "swayDigest", "jsonRefsDigest", "pathLoaderDigest"]);
  if (!framework || !matches(/^22\.19\.0$/, framework.nodeVersion)
    || [framework.routerDigest, framework.runnerDigest, framework.swayDigest, framework.jsonRefsDigest, framework.pathLoaderDigest]
      .some(item => !matches(DIGEST, item))) return undefined;
  const document = data(top.document, ["path", "rawSha256", "canonicalValueSha256"]);
  if (!document || document.path !== "api/swagger/swagger.yaml" || !matches(DIGEST, document.rawSha256)
    || !matches(DIGEST, document.canonicalValueSha256)) return undefined;
  const bindings: Array<ProtectedDocumentLoadObservation["bindings"][number]> = [];
  const seen = new Set<string>();
  for (const item of rawBindings) {
    const binding = data(item, ["method", "application_path", "controller", "operation_id", "export_name", "handler_path", "handler_digest", "mock_mode"]);
    if (!binding || typeof binding.method !== "string"
      || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(binding.method)
      || typeof binding.application_path !== "string" || binding.application_path.length > 2048 || !binding.application_path.startsWith("/")
      || !matches(NAME, binding.controller) || !matches(/^[A-Za-z0-9_$.-]{1,128}$/, binding.operation_id)
      || binding.export_name !== binding.operation_id || typeof binding.handler_path !== "string"
      || binding.handler_path.length > 1024 || !/^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(binding.handler_path)
      || binding.handler_path.split("/").some(part => part === "." || part === "..")
      || !matches(DIGEST, binding.handler_digest) || binding.mock_mode !== false) return undefined;
    const identity = `${binding.method}:${binding.application_path}`;
    if (seen.has(identity)) return undefined;
    seen.add(identity);
    bindings.push(Object.freeze({method: binding.method as string, application_path: binding.application_path,
      controller: binding.controller, operation_id: binding.operation_id, export_name: binding.export_name,
      handler_path: binding.handler_path, handler_digest: binding.handler_digest, mock_mode: false}));
  }
  return Object.freeze({kind: OBSERVATION_KIND, profileVersion: PROFILE,
    source: Object.freeze({repositoryId: source.repositoryId, serviceId: source.serviceId,
      immutableRevision: source.immutableRevision, sourceDigest: source.sourceDigest,
      environment: source.environment, sessionId: source.sessionId}),
    framework: Object.freeze({nodeVersion: framework.nodeVersion as string, routerDigest: framework.routerDigest as string,
      runnerDigest: framework.runnerDigest as string, swayDigest: framework.swayDigest as string,
      jsonRefsDigest: framework.jsonRefsDigest as string, pathLoaderDigest: framework.pathLoaderDigest as string}),
    document: Object.freeze({path: "api/swagger/swagger.yaml", rawSha256: document.rawSha256,
      canonicalValueSha256: document.canonicalValueSha256}), bindings: Object.freeze(bindings)});
}

/** Verifies a host-selected Ed25519-signed load observation; it does not establish deployment or normative authority. */
export function createProtectedDocumentLoadVerifier(options: ProtectedDocumentLoadVerifierOptions): {
  verify(): Promise<VerifiedProtectedDocumentLoad>} {
  const raw = data(options, OPTION_KEYS, OPTIONAL_OPTION_KEYS);
  const bindingRaw = data(raw?.binding, BINDING_KEYS);
  const scope = scopeOf(bindingRaw?.scope);
  const artifactRef = bindingRaw?.artifactRef, configuredKeyRef = bindingRaw?.configuredKeyRef;
  const envelopeDigest = bindingRaw?.expectedEnvelopeDigest, signerDigest = bindingRaw?.expectedSignerSpkiDigest;
  const observation = scope ? expectedObservation(bindingRaw?.expectedObservation, scope) : undefined;
  const timeoutMs = raw && Object.hasOwn(raw, "timeoutMs") ? raw.timeoutMs : 10_000;
  const externalSignal = raw?.signal as AbortSignal | undefined;
  if (!raw || !bindingRaw || !scope || !matches(ARTIFACT, artifactRef) || !matches(KEY_REF, configuredKeyRef)
    || !matches(DIGEST, envelopeDigest) || !matches(DIGEST, signerDigest) || !observation
    || typeof raw.authorize !== "function" || isProxy(raw.authorize)
    || typeof raw.readArtifact !== "function" || isProxy(raw.readArtifact)
    || typeof raw.readKey !== "function" || isProxy(raw.readKey)
    || typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || externalSignal !== undefined && !isAbortSignal(externalSignal))
    throw new ProtectedDocumentLoadError("INVALID_DOCUMENT_LOAD_CONFIG");
  const authorize = raw.authorize as ProtectedDocumentLoadVerifierOptions["authorize"];
  const readArtifact = raw.readArtifact as ProtectedDocumentLoadVerifierOptions["readArtifact"];
  const readKey = raw.readKey as ProtectedDocumentLoadVerifierOptions["readKey"];
  let expectedJson: string;
  let expectedSignedPayload: string;
  try {
    expectedJson = canonicalJsonStringify(observation);
    expectedSignedPayload = canonicalJsonStringify({scope, observation});
    if (Buffer.byteLength(expectedSignedPayload, "utf8") > 1_000_000) throw Error();
  } catch {throw new ProtectedDocumentLoadError("INVALID_DOCUMENT_LOAD_CONFIG");}
  const boundScope = scope;
  return Object.freeze({async verify(): Promise<VerifiedProtectedDocumentLoad> {
    const controller = new AbortController(), signal = controller.signal;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const expired = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("deadline")), {once: true}));
    void expired.catch(() => undefined);
    const abortFromCaller = () => controller.abort();
    if (externalSignal) {
      EventTarget.prototype.addEventListener.call(externalSignal, "abort", abortFromCaller, {once: true});
      const aborted = nativeSignalAborted?.call(externalSignal);
      if (aborted === true) controller.abort();
    }
    const phase = async <T>(fn: () => Promise<T>, code: ProtectedDocumentLoadError["code"]): Promise<T> => {
      if (signal.aborted || performance.now() >= deadline) throw new ProtectedDocumentLoadError(code);
      try {
        const result = await Promise.race([Promise.resolve().then(fn), expired]);
        if (signal.aborted || performance.now() >= deadline) throw Error("deadline");
        return result;
      }
      catch {throw new ProtectedDocumentLoadError(code);}
    };
    const checkAuth = async () => {
      if (await phase(() => authorize(boundScope, signal), "DOCUMENT_LOAD_UNAUTHORIZED") !== true)
        throw new ProtectedDocumentLoadError("DOCUMENT_LOAD_UNAUTHORIZED");
    };
    try {
      await checkAuth();
      const envelopeText = await phase(() => readArtifact(artifactRef, signal), "DOCUMENT_LOAD_UNAVAILABLE");
      if (typeof envelopeText !== "string" || Buffer.byteLength(envelopeText, "utf8") > 1_400_000
        || sha256(envelopeText) !== envelopeDigest) throw new ProtectedDocumentLoadError("DOCUMENT_LOAD_UNVERIFIED");
      const keyText = await phase(() => readKey(configuredKeyRef, signal), "DOCUMENT_LOAD_UNAVAILABLE");
      let verifiedObservation: ProtectedDocumentLoadObservation;
      let actualSignerDigest: string;
      try {
        if (typeof keyText !== "string" || Buffer.byteLength(keyText, "utf8") > 10_000
          || !keyText.startsWith("-----BEGIN PUBLIC KEY-----")) throw Error();
        const key = createPublicKey(keyText);
        if (key.asymmetricKeyType !== "ed25519") throw Error();
        actualSignerDigest = sha256(key.export({type: "spki", format: "der"}));
        if (actualSignerDigest !== signerDigest) throw Error();
        const envelope = parseStrictJson(envelopeText, {maxDepth: 4, maxNodes: 8});
        const envelopeData = data(envelope, ["purpose", "payload", "signature"]);
        if (!envelopeData || envelopeData.purpose !== PURPOSE) throw Error();
        const payload = base64(envelopeData.payload, 1_333_336), signature = base64(envelopeData.signature, 88);
        if (!payload || payload.length > 1_000_000 || !signature || signature.length !== 64
          || !verify(null, Buffer.concat([Buffer.from(`${PURPOSE}\n`, "utf8"), payload]), key, signature)) throw Error();
        const payloadText = utf8.decode(payload);
        const parsed = parseStrictJson(payloadText, {maxDepth: 24, maxNodes: 30_000});
        if (canonicalJsonStringify(parsed) !== payloadText) throw Error();
        const signed = data(parsed, ["scope", "observation"]);
        const signedScope = scopeOf(signed?.scope);
        const actual = signed && expectedObservation(signed.observation, boundScope);
        if (!signed || !signedScope || SCOPE_KEYS.some(key => signedScope[key] !== boundScope[key])
          || !actual || canonicalJsonStringify(actual) !== expectedJson
          || canonicalJsonStringify({scope: signedScope, observation: actual}) !== expectedSignedPayload) throw Error();
        verifiedObservation = actual;
      } catch {throw new ProtectedDocumentLoadError("DOCUMENT_LOAD_UNVERIFIED");}
      await checkAuth();
      return Object.freeze({kind: "verified_signed_document_load_observation", profileVersion: PROFILE,
        purpose: PURPOSE, scope: boundScope, artifactRef, configuredKeyRef,
        envelopeDigest: envelopeDigest as string, signerSpkiDigest: actualSignerDigest!,
        observation: verifiedObservation!, limitations: Object.freeze([LIMITATION] as const)});
    } catch (error) {
      if (error instanceof ProtectedDocumentLoadError) throw error;
      throw new ProtectedDocumentLoadError("DOCUMENT_LOAD_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      if (externalSignal) EventTarget.prototype.removeEventListener.call(externalSignal, "abort", abortFromCaller);
    }
  }});
}
