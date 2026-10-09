import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {isAbsolute, resolve} from "node:path";
import {isProxy} from "node:util/types";
import {canonicalJsonStringify, deriveEndpointIdentity} from "@api-truth/ir";
import {createHandlerCandidateResolver} from "../../../analyzers/nodejs/src/handler-candidates.js";
import {resolveSwaggerFrameworkLock} from "../../../analyzers/nodejs/src/framework-lock.js";
import {findSwaggerMiddlewareBinding} from "../../../analyzers/nodejs/src/middleware-binding.js";
import {resolveSwaggerRoutingConfiguration} from "../../../analyzers/nodejs/src/routing-config.js";
import {digestServiceTree, readServiceTree} from "../../../analyzers/nodejs/src/source.js";
import {resolveSwaggerStartup} from "../../../analyzers/nodejs/src/startup.js";
import {parseStrictYaml} from "../../../analyzers/nodejs/src/strict-yaml.js";
import {parseSwagger2Document} from "../../../analyzers/nodejs/src/swagger2-document.js";
import {materializeGitSource, type MaterializedGitSource} from "./index.js";
import {createProtectedCaptureVerificationPort, type ProtectedCaptureVerification,
  type ProtectedCaptureVerificationOptions} from "./protected-capture-verification.js";

export const SWAGGER_DOCUMENT_CORRESPONDENCE_PROFILE = "swagger-document-value-1" as const;
const LIMITATION = "Actual runtime document loading and deployment are unverified";
const LIMITATION_CONTRACT = "Document declarations and captured handler bytes do not prove normative contracts or future dispatch";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const REF_ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REF_KEY = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const KEYS = ["repoPath", "serviceRoot", "scope", "expectedCaptureIdentityDigest", "pinResolver", "authorize",
  "readReceipt", "readKey", "limits", "documentPath", "expectedRawDocumentSha256"] as const;
const PIN_KEYS = ["kind", "policyVersion", "scope", "artifactRef", "configuredKeyRef", "receiptDigest",
  "signerSpkiDigest", "identityDigest", "sessionId", "capturedAt", "signedScopeFields", "hostBoundScopeFields"] as const;
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const pointerPart = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const documentPathFor = (root: string) => root === "." ? "api/swagger/swagger.yaml" : `${root}/api/swagger/swagger.yaml`;

export type ProtectedSwaggerDocumentCorrespondenceOptions = ProtectedCaptureVerificationOptions & {
  documentPath: string; expectedRawDocumentSha256: string;
};
export type CorrespondenceDiagnosticCode = "captured_binding_unmatched" | "captured_binding_ambiguous"
  | "document_operation_unobserved" | "document_operation_unresolved" | "middleware_policy_unverified";
export type CorrespondenceDiagnostic = {code: CorrespondenceDiagnosticCode; bindingIndex?: number;
  documentPointer?: string};
export type ProtectedSwaggerDocumentCorrespondence = {
  kind: "protected_swagger_document_value_correspondence";
  profileVersion: typeof SWAGGER_DOCUMENT_CORRESPONDENCE_PROFILE;
  scope: ProtectedCaptureVerification["scope"]; serviceRoot: string;
  captureIdentityDigest: string; receiptDigest: string; signerSpkiDigest: string; sourceDigest: string;
  document: {path: string; rawSha256: string; digest: string};
  matches: ReadonlyArray<{bindingIndex: number; documentPointer: string; handlerPath: string}>;
  diagnostics: ReadonlyArray<CorrespondenceDiagnostic>;
  limitations: readonly [typeof LIMITATION, typeof LIMITATION_CONTRACT];
};
const messages = {INVALID_PROTECTED_DOCUMENT_CONFIG: "Invalid protected document configuration",
  PROTECTED_DOCUMENT_UNAUTHORIZED: "Protected document unauthorized",
  PROTECTED_DOCUMENT_UNVERIFIED: "Protected document unverified",
  PROTECTED_DOCUMENT_SOURCE_UNAVAILABLE: "Protected document source unavailable",
  PROTECTED_DOCUMENT_BUSY: "Protected document busy"} as const;
export class ProtectedSwaggerDocumentCorrespondenceError extends Error {
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) {super(messages[code]); this.code = code;}
}
function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)))
      return undefined;
    const copied: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      copied[key] = descriptor.value;
    }
    return copied;
  } catch {return undefined;}
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const safeBasePath = (value: unknown): string | undefined => {
  if (value === undefined) return "";
  if (typeof value !== "string" || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/.test(value)
    || value.split("/").some(segment => segment === "." || segment === "..")) return undefined;
  return value === "/" ? "" : value.replace(/\/$/, "");
};

async function rawSelectedDocument(projectRoot: string, path: string, maxBytes: number) {
  const absolute = resolve(projectRoot, path);
  const canonical = resolve(await realpath(projectRoot), path);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    const atPath = await lstat(absolute);
    if (!opened.isFile() || !atPath.isFile() || opened.dev !== atPath.dev || opened.ino !== atPath.ino
      || await realpath(absolute) !== canonical || opened.size > maxBytes)
      throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1 - total));
      const {bytesRead} = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    return {text: new TextDecoder("utf-8", {fatal: true}).decode(bytes), rawSha256: sha(bytes),
      digest: `sha256:${createHash("sha256").update(path).update("\0").update(bytes).digest("hex")}`};
  } finally {await file.close();}
}

/** Compares verified signed values with one selected document; it does not attest what document the runtime loaded. */
export function createProtectedSwaggerDocumentCorrespondencePort(options: ProtectedSwaggerDocumentCorrespondenceOptions): {
  verify(): Promise<ProtectedSwaggerDocumentCorrespondence>} {
  const raw = ownData(options, KEYS);
  if (!raw || typeof raw.repoPath !== "string" || !isAbsolute(raw.repoPath)
    || typeof raw.serviceRoot !== "string" || !ROOT.test(raw.serviceRoot)
    || raw.serviceRoot.split("/").some(part => part === ".." || part === "." && raw.serviceRoot !== ".")
    || raw.documentPath !== documentPathFor(raw.serviceRoot)
    || typeof raw.expectedRawDocumentSha256 !== "string" || !DIGEST.test(raw.expectedRawDocumentSha256))
    throw new ProtectedSwaggerDocumentCorrespondenceError("INVALID_PROTECTED_DOCUMENT_CONFIG");
  const baseOptions = {repoPath: raw.repoPath, serviceRoot: raw.serviceRoot, scope: raw.scope,
    expectedCaptureIdentityDigest: raw.expectedCaptureIdentityDigest, pinResolver: raw.pinResolver,
    authorize: raw.authorize, readReceipt: raw.readReceipt, readKey: raw.readKey, limits: raw.limits} as ProtectedCaptureVerificationOptions;
  let verified: ReturnType<typeof createProtectedCaptureVerificationPort>;
  try {verified = createProtectedCaptureVerificationPort(baseOptions);}
  catch {throw new ProtectedSwaggerDocumentCorrespondenceError("INVALID_PROTECTED_DOCUMENT_CONFIG");}
  const repoPath = raw.repoPath, serviceRoot = raw.serviceRoot, documentPath = raw.documentPath;
  const expectedRawDocumentSha256 = raw.expectedRawDocumentSha256;
  const rawLimits = raw.limits as ProtectedCaptureVerificationOptions["limits"];
  const limits = Object.freeze({maxFiles: rawLimits.maxFiles, maxBytes: rawLimits.maxBytes,
    timeoutMs: rawLimits.timeoutMs, maxSessions: rawLimits.maxSessions ?? 2});
  const authorize = raw.authorize as ProtectedCaptureVerificationOptions["authorize"];
  const pinPort = raw.pinResolver as ProtectedCaptureVerificationOptions["pinResolver"];
  const resolvePin = pinPort.resolve.bind(pinPort);
  let active = 0;
  return Object.freeze({async verify(): Promise<ProtectedSwaggerDocumentCorrespondence> {
    if (active >= limits.maxSessions)
      throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_BUSY");
    active++;
    const controller = new AbortController(), signal = controller.signal;
    const deadline = performance.now() + limits.timeoutMs;
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    const timedOut = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("deadline")), {once: true}));
    // The inner byte verifier can still be disposing its Git checkout when this timer fires.
    // Attach a handler now, before any later phase races against the deadline promise.
    void timedOut.catch(() => undefined);
    const budget = () => {if (signal.aborted || performance.now() >= deadline)
      throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_SOURCE_UNAVAILABLE");};
    const requireAuthorization = async (scope: ProtectedCaptureVerification["scope"]) => {
      budget();
      let allowed: boolean;
      try {allowed = await Promise.race([authorize(scope, signal), timedOut]);}
      catch {throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNAUTHORIZED");}
      if (allowed !== true) throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNAUTHORIZED");
    };
    const checkedPin = async (capture: ProtectedCaptureVerification) => {
      budget();
      let value: unknown;
      try {value = await Promise.race([resolvePin(capture.scope), timedOut]);}
      catch {throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");}
      const pin = ownData(value, PIN_KEYS);
      const scope = ownData(pin?.scope, ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"]);
      if (!pin || !scope || pin.kind !== "pinned_envelope" || pin.policyVersion !== "runtime-capture-pin-1"
        || pin.identityDigest !== capture.captureIdentityDigest || pin.receiptDigest !== capture.receiptDigest
        || pin.signerSpkiDigest !== capture.signerSpkiDigest
        || typeof pin.artifactRef !== "string" || !REF_ARTIFACT.test(pin.artifactRef)
        || typeof pin.configuredKeyRef !== "string" || !REF_KEY.test(pin.configuredKeyRef)
        || typeof pin.sessionId !== "string" || !NAME.test(pin.sessionId)
        || typeof pin.capturedAt !== "string" || pin.capturedAt.length > 30
        || Object.entries(scope).some(([key, item]) => item !== capture.scope[key as keyof typeof capture.scope]))
        throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      const calculated = sha(canonicalJsonStringify({policyVersion: pin.policyVersion, scope,
        artifactRef: pin.artifactRef, configuredKeyRef: pin.configuredKeyRef,
        receiptDigest: pin.receiptDigest, signerSpkiDigest: pin.signerSpkiDigest}));
      if (calculated !== capture.captureIdentityDigest)
        throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      return {artifactRef: pin.artifactRef, configuredKeyRef: pin.configuredKeyRef,
        sessionId: pin.sessionId, capturedAt: pin.capturedAt};
    };
    let tree: MaterializedGitSource | undefined;
    try {
      // The inner verifier owns its signed receipt, key, Git materialization, cleanup and final authorization.
      const capture = await verified.verify();
      await requireAuthorization(capture.scope);
      const beforePin = await checkedPin(capture);
      // The Git materializer has its own 120-second bound and no AbortSignal. Always await and own its result.
      tree = await materializeGitSource({repoPath, revision: capture.scope.immutableRevision, serviceRoot,
        limits: {maxFiles: limits.maxFiles, maxBytes: limits.maxBytes}});
      budget();
      if (tree.revision !== capture.scope.immutableRevision.toLowerCase())
        throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      const source = await readServiceTree(tree.projectRoot, serviceRoot, limits.maxFiles, budget);
      budget();
      if (digestServiceTree(source.files, source.root, source.opaqueConfiguration) !== capture.sourceDigest)
        throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      const text = source.files.get(resolve(source.root, "api/swagger/swagger.yaml"));
      const selected = await rawSelectedDocument(tree.projectRoot, documentPath, 1_000_000);
      if (text === undefined || text !== selected.text || selected.rawSha256 !== expectedRawDocumentSha256)
        throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      let parsedValue: unknown;
      try {parsedValue = parseStrictYaml(text);}
      catch {throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");}
      if (!record(parsedValue)) throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      let parsed: ReturnType<typeof parseSwagger2Document>;
      try {parsed = parseSwagger2Document(parsedValue);}
      catch {throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");}
      if (parsed.status === "failed" || parsed.operations.length > 1024)
        throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      const result = compare(capture, source.files, source.opaqueConfiguration, source.root,
        parsedValue, parsed.operations, documentPath, selected.digest, expectedRawDocumentSha256, budget);
      await tree.dispose(); tree = undefined;
      await requireAuthorization(capture.scope);
      const afterPin = await checkedPin(capture);
      if (Object.keys(beforePin).some(key => beforePin[key as keyof typeof beforePin]
        !== afterPin[key as keyof typeof afterPin]))
        throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_UNVERIFIED");
      await requireAuthorization(capture.scope);
      budget();
      return result;
    } catch (error) {
      if (error instanceof ProtectedSwaggerDocumentCorrespondenceError) throw error;
      throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_SOURCE_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      try {if (tree) await tree.dispose();}
      catch {throw new ProtectedSwaggerDocumentCorrespondenceError("PROTECTED_DOCUMENT_SOURCE_UNAVAILABLE");}
      finally {active--;}
    }
  }});
}

type Operation = ReturnType<typeof parseSwagger2Document>["operations"][number];
function compare(capture: ProtectedCaptureVerification, files: Map<string, string>, opaque: Map<string, string>,
  root: string, document: Record<string, unknown>, operations: Operation[], documentPath: string,
  documentDigest: string, rawSha256: string, budget: () => void): ProtectedSwaggerDocumentCorrespondence {
  const diagnostics: CorrespondenceDiagnostic[] = [];
  const matches: Array<{bindingIndex: number; documentPointer: string; handlerPath: string}> = [];
  const binding = findSwaggerMiddlewareBinding(files, root);
  const startup = resolveSwaggerStartup(files, root, binding, budget);
  const routing = resolveSwaggerRoutingConfiguration(files, root, opaque,
    binding?.mock_mode ? {value: binding.mock_mode.value, location: {path: binding.path, pointer: binding.mock_mode.pointer}} : undefined,
    startup.kind === "declared" && startup.environment_name
      ? {name: startup.environment_name, location: {path: "package.json", pointer: "/scripts/start"}} : undefined);
  const lock = resolveSwaggerFrameworkLock(files, root, opaque);
  const policyReady = !!binding && startup.kind === "declared" && startup.environment_inputs.length === 0
    && (startup.environment_name === undefined || startup.environment_name === capture.scope.environment)
    && routing.kind === "supported" && lock.kind === "locked" && lock.conformance_target
    && lock.routing_dependencies.kind === "locked" && lock.routing_dependencies.conformance_target;
  const basePath = safeBasePath(document.basePath);
  if (!policyReady || basePath === undefined) diagnostics.push({code: "middleware_policy_unverified"});
  const resolveHandler = policyReady ? createHandlerCandidateResolver(files, root, routing, budget) : undefined;
  const paths = record(document.paths) ? document.paths : {};
  const ids = new Map<string, number>();
  for (const operation of operations) if (operation.operationId)
    ids.set(operation.operationId, (ids.get(operation.operationId) ?? 0) + 1);
  const routeKeys = new Map<string, number>();
  const entries = operations.map(operation => {
    budget();
    const applicationPath = basePath === undefined ? undefined : `${basePath}${operation.path}`;
    let routeKey: string | undefined;
    try {if (applicationPath) routeKey = deriveEndpointIdentity({identity_version: "1.0.0",
      service_id: capture.scope.serviceId, method: operation.method, application_path: applicationPath}).route_key;}
    catch { /* Unsupported template stays unresolved. */ }
    if (routeKey) routeKeys.set(routeKey, (routeKeys.get(routeKey) ?? 0) + 1);
    const pathItem = paths[operation.path];
    const rawOperation = record(pathItem) ? pathItem[operation.method] : undefined;
    const effectiveController = record(rawOperation) && rawOperation["x-swagger-router-controller"] !== undefined
      ? rawOperation["x-swagger-router-controller"] : record(pathItem) ? pathItem["x-swagger-router-controller"] : undefined;
    const interfaceValue = record(rawOperation) && rawOperation["x-controller-interface"] !== undefined
      ? rawOperation["x-controller-interface"] : record(pathItem) && pathItem["x-controller-interface"] !== undefined
        ? pathItem["x-controller-interface"] : document["x-controller-interface"];
    const supported = policyReady && routeKey && record(pathItem) && pathItem.$ref === undefined
      && record(rawOperation) && rawOperation.$ref === undefined
      && rawOperation["x-swagger-pipe"] === undefined && pathItem["x-swagger-pipe"] === undefined
      && (interfaceValue === undefined || interfaceValue === "middleware")
      && typeof effectiveController === "string" && effectiveController.length > 0
      && !!operation.operationId && ids.get(operation.operationId) === 1;
    if (!supported) diagnostics.push({code: "document_operation_unresolved", documentPointer: operation.pointer});
    return {operation, applicationPath, routeKey, controller: effectiveController, supported: !!supported};
  });
  const matchedPointers = new Set<string>();
  capture.handlers.forEach((handler, bindingIndex) => {
    budget();
    if (!policyReady || basePath === undefined) {
      diagnostics.push({code: "captured_binding_unmatched", bindingIndex}); return;
    }
    const routeCandidates = entries.filter(item => item.supported && item.operation.method.toUpperCase() === handler.method
      && item.applicationPath === handler.applicationPath);
    if (routeCandidates.length > 1 || routeCandidates.some(item => item.routeKey && routeKeys.get(item.routeKey)! > 1)) {
      diagnostics.push({code: "captured_binding_ambiguous", bindingIndex}); return;
    }
    const selected = routeCandidates[0];
    if (!selected || selected.controller !== handler.controller || selected.operation.operationId !== handler.operationId
      || handler.exportName !== selected.operation.operationId || !resolveHandler) {
      diagnostics.push({code: "captured_binding_unmatched", bindingIndex,
        ...(selected ? {documentPointer: selected.operation.pointer} : {})}); return;
    }
    const candidate = resolveHandler(handler.controller, handler.operationId);
    if (candidate.kind !== "candidate" || candidate.path !== handler.handlerPath
      || candidate.export_name !== handler.exportName) {
      diagnostics.push({code: "captured_binding_unmatched", bindingIndex, documentPointer: selected.operation.pointer}); return;
    }
    matches.push({bindingIndex, documentPointer: selected.operation.pointer, handlerPath: handler.handlerPath});
    matchedPointers.add(selected.operation.pointer);
  });
  for (const operation of operations) if (!matchedPointers.has(operation.pointer))
    diagnostics.push({code: "document_operation_unobserved", documentPointer: operation.pointer});
  return Object.freeze({kind: "protected_swagger_document_value_correspondence",
    profileVersion: SWAGGER_DOCUMENT_CORRESPONDENCE_PROFILE, scope: capture.scope, serviceRoot: capture.serviceRoot,
    captureIdentityDigest: capture.captureIdentityDigest, receiptDigest: capture.receiptDigest,
    signerSpkiDigest: capture.signerSpkiDigest, sourceDigest: capture.sourceDigest,
    document: Object.freeze({path: documentPath, rawSha256, digest: documentDigest}),
    matches: Object.freeze(matches.map(item => Object.freeze(item))),
    diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item))),
    limitations: Object.freeze([LIMITATION, LIMITATION_CONTRACT] as const)});
}
