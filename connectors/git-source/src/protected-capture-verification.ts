import {createHash, createPublicKey} from "node:crypto";
import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {isAbsolute, resolve} from "node:path";
import {isProxy} from "node:util/types";
import {canonicalJsonStringify} from "@api-truth/ir";
import {digestServiceTree, readServiceTree} from "../../../analyzers/nodejs/src/source.js";
import {runtimeBindingFilename, sha256, verifyRuntimeBindings} from "../../../analyzers/nodejs/src/runtime-binding.js";
import {materializeGitSource, type MaterializedGitSource} from "./index.js";
import type {RuntimeCapturePin, RuntimeCaptureScope} from "./runtime-capture-pin.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const REF_ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REF_KEY = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const PIN_KEYS = ["kind", "policyVersion", "scope", "artifactRef", "configuredKeyRef", "receiptDigest",
  "signerSpkiDigest", "identityDigest", "sessionId", "capturedAt", "signedScopeFields", "hostBoundScopeFields"] as const;
const LIMIT_KEYS = ["maxFiles", "maxBytes", "timeoutMs"] as const;
const OPTIONAL_LIMIT_KEYS = ["maxSessions"] as const;
const OPTION_KEYS = ["repoPath", "serviceRoot", "scope", "expectedCaptureIdentityDigest", "pinResolver",
  "authorize", "readReceipt", "readKey", "limits"] as const;
const LIMITATION = "Document operation correspondence and deployment are unverified";

export type ProtectedCaptureVerificationOptions = {repoPath: string; serviceRoot: string; scope: RuntimeCaptureScope;
  expectedCaptureIdentityDigest: string; pinResolver: {resolve(scope: RuntimeCaptureScope): Promise<RuntimeCapturePin>};
  authorize(scope: Readonly<RuntimeCaptureScope>, signal: AbortSignal): Promise<boolean>;
  readReceipt(artifactRef: string, signal: AbortSignal): Promise<string>;
  readKey(configuredKeyRef: string, signal: AbortSignal): Promise<string>;
  limits: {maxFiles: number; maxBytes: number; timeoutMs: number; maxSessions?: number}};
export type ProtectedCaptureVerification = {kind: "verified_handler_bytes";
  scope: RuntimeCaptureScope; serviceRoot: string; captureIdentityDigest: string; receiptDigest: string;
  signerSpkiDigest: string; sourceDigest: string; handlers: ReadonlyArray<{method: string; applicationPath: string;
    controller: string; operationId: string; handlerPath: string; handlerDigest: string; exportName: string}>;
  limitations: readonly [typeof LIMITATION]};
const messages = {INVALID_PROTECTED_CAPTURE_CONFIG: "Invalid protected capture configuration",
  PROTECTED_CAPTURE_UNAUTHORIZED: "Protected capture unauthorized",
  PROTECTED_CAPTURE_UNVERIFIED: "Protected capture unverified",
  PROTECTED_CAPTURE_SOURCE_UNAVAILABLE: "Protected capture source unavailable",
  PROTECTED_CAPTURE_BUSY: "Protected capture busy"} as const;
export class ProtectedCaptureVerificationError extends Error {
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) { super(messages[code]); this.code = code; }
}
function ownData(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => !Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some(key =>
      typeof key !== "string" || !keys.includes(key) && !optional.includes(key))) return undefined;
    const copied: Record<string, unknown> = Object.create(null);
    for (const key of [...keys, ...optional]) {
      const descriptor = descriptors[key];
      if (!descriptor && optional.includes(key)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      copied[key] = descriptor.value;
    }
    return copied;
  } catch { return undefined; }
}
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);
function safeScope(value: unknown): RuntimeCaptureScope | undefined {
  const raw = ownData(value, SCOPE_KEYS);
  if (!raw || !matches(NAME, raw.tenantId) || !matches(NAME, raw.repositoryId) || !matches(NAME, raw.serviceId)
    || !matches(/^[a-fA-F0-9]{40}$/, raw.immutableRevision) || !matches(DIGEST, raw.sourceDigest)
    || !matches(NAME, raw.environment)) return undefined;
  return Object.freeze({tenantId: raw.tenantId, repositoryId: raw.repositoryId, serviceId: raw.serviceId,
    immutableRevision: raw.immutableRevision, sourceDigest: raw.sourceDigest, environment: raw.environment});
}
function safePin(value: unknown, scope: RuntimeCaptureScope, expectedIdentity: string): RuntimeCapturePin | undefined {
  const raw = ownData(value, PIN_KEYS), selected = safeScope(raw?.scope);
  if (!raw || !selected || raw.kind !== "pinned_envelope" || raw.policyVersion !== "runtime-capture-pin-1"
    || SCOPE_KEYS.some(key => selected[key] !== scope[key]) || raw.identityDigest !== expectedIdentity
    || !matches(REF_ARTIFACT, raw.artifactRef) || !matches(REF_KEY, raw.configuredKeyRef)
    || !matches(DIGEST, raw.receiptDigest) || !matches(DIGEST, raw.signerSpkiDigest)
    || !matches(NAME, raw.sessionId) || typeof raw.capturedAt !== "string" || raw.capturedAt.length > 30)
    return undefined;
  const calculated = sha256(canonicalJsonStringify({policyVersion: raw.policyVersion, scope: selected,
    artifactRef: raw.artifactRef, configuredKeyRef: raw.configuredKeyRef,
    receiptDigest: raw.receiptDigest, signerSpkiDigest: raw.signerSpkiDigest}));
  if (calculated !== expectedIdentity) return undefined;
  return {kind: "pinned_envelope", policyVersion: "runtime-capture-pin-1", scope: selected,
    artifactRef: raw.artifactRef, configuredKeyRef: raw.configuredKeyRef,
    receiptDigest: raw.receiptDigest, signerSpkiDigest: raw.signerSpkiDigest,
    identityDigest: expectedIdentity, sessionId: raw.sessionId, capturedAt: raw.capturedAt,
    signedScopeFields: ["repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"],
    hostBoundScopeFields: ["tenantId", "policyVersion"]};
}

async function rawHandlerDigest(root: string, relativePath: string, maxBytes: number, budget: () => void): Promise<string> {
  budget();
  const absolute = resolve(root, relativePath);
  const canonical = resolve(await realpath(root), relativePath);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat(), atPath = await lstat(absolute);
    if (!opened.isFile() || !atPath.isFile() || opened.dev !== atPath.dev || opened.ino !== atPath.ino
      || await realpath(absolute) !== canonical || opened.size > maxBytes)
      throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(65_536);
    let total = 0;
    while (true) {
      budget();
      const {bytesRead} = await file.read(chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      hash.update(chunk.subarray(0, bytesRead));
    }
    const final = await file.stat();
    if (final.size !== opened.size || total !== opened.size || final.mtimeMs !== opened.mtimeMs
      || final.ctimeMs !== opened.ctimeMs)
      throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
    budget();
    return `sha256:${hash.digest("hex")}`;
  } finally {await file.close();}
}

/** Verifies signed capture handler file bytes against one host-selected immutable Git tree. */
export function createProtectedCaptureVerificationPort(options: ProtectedCaptureVerificationOptions): {
  verify(): Promise<ProtectedCaptureVerification>} {
  const raw = ownData(options, OPTION_KEYS), scope = safeScope(raw?.scope);
  const limits = ownData(raw?.limits, LIMIT_KEYS, OPTIONAL_LIMIT_KEYS), resolver = ownData(raw?.pinResolver, ["resolve"]);
  const maxSessions = limits && Object.hasOwn(limits, "maxSessions") ? limits.maxSessions : 2;
  if (!raw || !scope || !limits || !resolver || !matches(DIGEST, raw.expectedCaptureIdentityDigest)
    || typeof raw.repoPath !== "string" || !isAbsolute(raw.repoPath)
    || !matches(ROOT, raw.serviceRoot) || raw.serviceRoot.split("/").some(part => part === ".." || part === "." && raw.serviceRoot !== ".")
    || !Number.isSafeInteger(limits.maxFiles) || (limits.maxFiles as number) < 1 || (limits.maxFiles as number) > 20_000
    || !Number.isSafeInteger(limits.maxBytes) || (limits.maxBytes as number) < 1 || (limits.maxBytes as number) > 10_000_000
    || !Number.isSafeInteger(limits.timeoutMs) || (limits.timeoutMs as number) < 1 || (limits.timeoutMs as number) > 120_000
    || !Number.isSafeInteger(maxSessions) || (maxSessions as number) < 1 || (maxSessions as number) > 8
    || typeof resolver.resolve !== "function" || isProxy(resolver.resolve)
    || typeof raw.authorize !== "function" || isProxy(raw.authorize)
    || typeof raw.readReceipt !== "function" || isProxy(raw.readReceipt)
    || typeof raw.readKey !== "function" || isProxy(raw.readKey))
    throw new ProtectedCaptureVerificationError("INVALID_PROTECTED_CAPTURE_CONFIG");
  const repoPath = raw.repoPath, serviceRoot = raw.serviceRoot;
  const expectedIdentity = raw.expectedCaptureIdentityDigest;
  const maxFiles = limits.maxFiles as number, maxBytes = limits.maxBytes as number, timeoutMs = limits.timeoutMs as number;
  const resolvePin = (resolver.resolve as ProtectedCaptureVerificationOptions["pinResolver"]["resolve"]).bind(raw.pinResolver);
  const authorize = raw.authorize as ProtectedCaptureVerificationOptions["authorize"];
  const readReceipt = raw.readReceipt as ProtectedCaptureVerificationOptions["readReceipt"];
  const readKey = raw.readKey as ProtectedCaptureVerificationOptions["readKey"];
  let active = 0;
  return Object.freeze({async verify(): Promise<ProtectedCaptureVerification> {
    if (active >= (maxSessions as number)) throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_BUSY");
    active += 1;
    const controller = new AbortController(), signal = controller.signal;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const expired = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("deadline")), {once: true}));
    const budget = () => { if (signal.aborted || performance.now() >= deadline)
      throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_SOURCE_UNAVAILABLE"); };
    const phase = async <T>(run: () => Promise<T>, code: ProtectedCaptureVerificationError["code"]): Promise<T> => {
      budget();
      try { return await Promise.race([Promise.resolve().then(run), expired]); }
      catch { throw new ProtectedCaptureVerificationError(code); }
    };
    const requireAuthorization = async () => {
      if (await phase(() => authorize(scope, signal), "PROTECTED_CAPTURE_UNAUTHORIZED") !== true)
        throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNAUTHORIZED");
    };
    let tree: MaterializedGitSource | undefined;
    try {
      await requireAuthorization();
      const pinned = safePin(await phase(() => resolvePin(scope), "PROTECTED_CAPTURE_UNVERIFIED"), scope, expectedIdentity);
      if (!pinned) throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      // The Git materializer owns a separate 120-second command deadline and has no AbortSignal.
      // Await it so its disposable tree is always owned here, even if this port's deadline expires.
      tree = await materializeGitSource({repoPath, revision: scope.immutableRevision, serviceRoot,
        limits: {maxFiles, maxBytes}});
      budget();
      if (tree.revision !== scope.immutableRevision.toLowerCase())
        throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      const source = await readServiceTree(tree.projectRoot, serviceRoot, maxFiles, budget);
      budget();
      if (source.files.has(resolve(source.root, runtimeBindingFilename))
        || digestServiceTree(source.files, source.root, source.opaqueConfiguration) !== scope.sourceDigest)
        throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      const text = await phase(() => readReceipt(pinned.artifactRef, signal), "PROTECTED_CAPTURE_SOURCE_UNAVAILABLE");
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1_000_000 || sha256(text) !== pinned.receiptDigest)
        throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      const keyText = await phase(() => readKey(pinned.configuredKeyRef, signal), "PROTECTED_CAPTURE_SOURCE_UNAVAILABLE");
      let signerDigest: string;
      try {
        if (typeof keyText !== "string" || Buffer.byteLength(keyText, "utf8") > 10_000
          || !keyText.startsWith("-----BEGIN PUBLIC KEY-----")) throw Error();
        const key = createPublicKey(keyText);
        if (key.asymmetricKeyType !== "ed25519") throw Error();
        signerDigest = sha256(key.export({type: "spki", format: "der"}));
      } catch { throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED"); }
      if (signerDigest !== pinned.signerSpkiDigest) throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      const checked = verifyRuntimeBindings({text, publicKey: keyText, path: pinned.artifactRef,
        source: {repository_id: scope.repositoryId, service_id: scope.serviceId,
          immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest},
        files: source.files, root: source.root});
      if (checked.kind !== "verified" || checked.bindings.length === 0
        || checked.receipt_digest !== pinned.receiptDigest || checked.signer_digest !== pinned.signerSpkiDigest
        || checked.environment !== scope.environment || checked.session_id !== pinned.sessionId
        || checked.captured_at !== pinned.capturedAt)
        throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      // The parsing kernel decodes UTF-8; an attested file digest must additionally match raw Git bytes.
      const rawDigests = new Map<string, string>();
      for (const binding of checked.bindings) {
        budget();
        let digest = rawDigests.get(binding.handler_path);
        if (!digest) {
          digest = await rawHandlerDigest(source.root, binding.handler_path, maxBytes, budget);
          rawDigests.set(binding.handler_path, digest);
        }
        if (digest !== binding.handler_digest)
          throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      }
      // Cleanup can await external filesystem work. Recheck pin and authorization only after
      // the owned tree is fully disposed, so revocation during cleanup cannot release metadata.
      await tree.dispose();
      tree = undefined;
      const finalPin = safePin(await phase(() => resolvePin(scope), "PROTECTED_CAPTURE_UNVERIFIED"), scope, expectedIdentity);
      if (!finalPin || canonicalJsonStringify(finalPin) !== canonicalJsonStringify(pinned))
        throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_UNVERIFIED");
      await requireAuthorization();
      budget();
      return Object.freeze({kind: "verified_handler_bytes", scope, serviceRoot,
        captureIdentityDigest: expectedIdentity, receiptDigest: pinned.receiptDigest,
        signerSpkiDigest: pinned.signerSpkiDigest, sourceDigest: scope.sourceDigest,
        handlers: Object.freeze(checked.bindings.map(binding => Object.freeze({method: binding.method,
          applicationPath: binding.application_path, controller: binding.controller,
          operationId: binding.operation_id, handlerPath: binding.handler_path,
          handlerDigest: binding.handler_digest, exportName: binding.export_name}))),
        limitations: Object.freeze([LIMITATION] as const)});
    } catch (error) {
      if (error instanceof ProtectedCaptureVerificationError) throw error;
      throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_SOURCE_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      try {
        if (tree) await tree.dispose().catch(() => { throw new ProtectedCaptureVerificationError("PROTECTED_CAPTURE_SOURCE_UNAVAILABLE"); });
      } finally { active -= 1; }
    }
  }});
}
