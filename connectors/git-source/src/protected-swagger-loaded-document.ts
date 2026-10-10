import {isProxy} from "node:util/types";
import {canonicalJsonStringify} from "@api-truth/ir";
import {supportedRouterDigest} from "../../../analyzers/nodejs/src/runtime-binding.js";
import {createProtectedDocumentLoadVerifier, type ProtectedDocumentLoadObservation,
  type ProtectedDocumentLoadScope, type ProtectedDocumentLoadVerifierOptions} from "./protected-document-load.js";
import {createProtectedSwaggerDocumentCorrespondencePort, type CorrespondenceDiagnostic,
  type ProtectedSwaggerDocumentCorrespondence, type ProtectedSwaggerDocumentCorrespondenceOptions} from "./protected-swagger-document-correspondence.js";

export const PROTECTED_SWAGGER_LOADED_DOCUMENT_PROFILE = "swagger-loaded-document-1" as const;
const LIMITATION = "Controlled-process load observation is not proof of a production deployment" as const;
const LIMITATION_CONTRACT = "Document and handler correspondence does not establish normative API behavior" as const;
const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const LOAD_KEYS = ["binding", "authorize", "readArtifact", "readKey"] as const;
const LOAD_OPTIONAL = ["timeoutMs", "signal"] as const;
const LOAD_BINDING_KEYS = ["scope", "artifactRef", "configuredKeyRef", "expectedEnvelopeDigest", "expectedSignerSpkiDigest", "expectedObservation"] as const;
const CORRESPONDENCE_KEYS = ["repoPath", "serviceRoot", "scope", "expectedCaptureIdentityDigest", "pinResolver",
  "authorize", "readReceipt", "readKey", "limits", "documentPath", "expectedRawDocumentSha256"] as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const DOCUMENT_PATH = (root: string) => root === "." ? "api/swagger/swagger.yaml" : `${root}/api/swagger/swagger.yaml`;

export type ProtectedSwaggerLoadedDocumentOptions = {documentLoad: ProtectedDocumentLoadVerifierOptions;
  correspondence: ProtectedSwaggerDocumentCorrespondenceOptions};
export type ProtectedSwaggerLoadedDocument = {kind: "protected_swagger_loaded_document_correspondence";
  profileVersion: typeof PROTECTED_SWAGGER_LOADED_DOCUMENT_PROFILE; scope: ProtectedDocumentLoadScope; serviceRoot: string;
  sessionId: string; loadArtifactRef: string; loadConfiguredKeyRef: string;
  captureIdentityDigest: string; loadEnvelopeDigest: string; loadSignerSpkiDigest: string;
  document: {path: string; rawSha256: string; canonicalValueSha256: string; digest: string};
  matches: ProtectedSwaggerDocumentCorrespondence["matches"];
  diagnostics: ReadonlyArray<CorrespondenceDiagnostic & {code:"document_operation_unobserved"; documentPointer:string}>;
  limitations: readonly [typeof LIMITATION, typeof LIMITATION_CONTRACT]};

const messages = {INVALID_LOADED_DOCUMENT_CONFIG: "Invalid loaded-document verification configuration",
  LOADED_DOCUMENT_UNVERIFIED: "Protected Swagger loaded document unverified"} as const;
export class ProtectedSwaggerLoadedDocumentError extends Error {
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) {super(messages[code]); this.code = code;}
}

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
function scope(value: unknown): ProtectedDocumentLoadScope | undefined {
  const raw = data(value, SCOPE_KEYS);
  if (!raw || SCOPE_KEYS.some(key => typeof raw[key] !== "string")) return undefined;
  return Object.freeze({tenantId: raw.tenantId as string, repositoryId: raw.repositoryId as string,
    serviceId: raw.serviceId as string, immutableRevision: raw.immutableRevision as string,
    sourceDigest: raw.sourceDigest as string, environment: raw.environment as string});
}
const same = (left: unknown, right: unknown) => {
  try {return canonicalJsonStringify(left) === canonicalJsonStringify(right);} catch {return false;}
};
function equalScope(left: ProtectedDocumentLoadScope, right: ProtectedDocumentLoadScope): boolean {
  return SCOPE_KEYS.every(key => left[key] === right[key]);
}
function bindingView(binding: ProtectedDocumentLoadObservation["bindings"][number]) {
  return {method: binding.method, applicationPath: binding.application_path, controller: binding.controller,
    operationId: binding.operation_id, handlerPath: binding.handler_path, handlerDigest: binding.handler_digest,
    exportName: binding.export_name};
}

/** Composes concrete signed-load and protected-source verifiers. It does not claim deployment or normative authority. */
export function createProtectedSwaggerLoadedDocumentPort(options: ProtectedSwaggerLoadedDocumentOptions): {
  verify(): Promise<ProtectedSwaggerLoadedDocument>} {
  const outer = data(options, ["documentLoad", "correspondence"]);
  const load = data(outer?.documentLoad, LOAD_KEYS, LOAD_OPTIONAL);
  const loadBinding = data(load?.binding, LOAD_BINDING_KEYS);
  const loadScope = scope(loadBinding?.scope);
  const correspondence = data(outer?.correspondence, CORRESPONDENCE_KEYS);
  const correspondenceScope = scope(correspondence?.scope);
  const serviceRoot = correspondence?.serviceRoot;
  if (!outer || !load || !loadBinding || !loadScope || !correspondence || !correspondenceScope
    || !equalScope(loadScope, correspondenceScope) || typeof serviceRoot !== "string" || !ROOT.test(serviceRoot)
    || load.authorize !== correspondence.authorize
    || serviceRoot.split("/").some(part => part === ".." || part === "." && serviceRoot !== ".")
    || correspondence.documentPath !== DOCUMENT_PATH(serviceRoot)
    || typeof correspondence.expectedRawDocumentSha256 !== "string" || !DIGEST.test(correspondence.expectedRawDocumentSha256))
    throw new ProtectedSwaggerLoadedDocumentError("INVALID_LOADED_DOCUMENT_CONFIG");

  let loadVerifier: ReturnType<typeof createProtectedDocumentLoadVerifier>;
  let correspondencePort: ReturnType<typeof createProtectedSwaggerDocumentCorrespondencePort>;
  try {
    const loadOptions = {binding: {...loadBinding, scope: loadScope}, authorize: load.authorize,
      readArtifact: load.readArtifact, readKey: load.readKey,
      ...(Object.hasOwn(load, "timeoutMs") ? {timeoutMs: load.timeoutMs} : {}),
      ...(Object.hasOwn(load, "signal") ? {signal: load.signal} : {})} as ProtectedDocumentLoadVerifierOptions;
    const correspondenceOptions = {...correspondence, scope: correspondenceScope} as ProtectedSwaggerDocumentCorrespondenceOptions;
    loadVerifier = createProtectedDocumentLoadVerifier(loadOptions);
    correspondencePort = createProtectedSwaggerDocumentCorrespondencePort(correspondenceOptions);
  } catch {throw new ProtectedSwaggerLoadedDocumentError("INVALID_LOADED_DOCUMENT_CONFIG");}
  const normalizedServiceRoot = serviceRoot;
  return Object.freeze({async verify(): Promise<ProtectedSwaggerLoadedDocument> {
    try {
      const firstLoad = await loadVerifier.verify();
      const sourceCorrespondence = await correspondencePort.verify();
      const secondLoad = await loadVerifier.verify();
      if (!same(firstLoad, secondLoad) || !equalScope(firstLoad.scope, sourceCorrespondence.scope)
        || !equalScope(firstLoad.scope, loadScope) || sourceCorrespondence.serviceRoot !== normalizedServiceRoot
        || firstLoad.observation.source.sessionId !== sourceCorrespondence.sessionId
        || firstLoad.observation.document.path !== "api/swagger/swagger.yaml"
        || sourceCorrespondence.document.path !== DOCUMENT_PATH(normalizedServiceRoot)
        || firstLoad.observation.document.rawSha256 !== sourceCorrespondence.document.rawSha256
        || firstLoad.observation.document.canonicalValueSha256 !== sourceCorrespondence.document.canonicalValueSha256
        || firstLoad.observation.framework.routerDigest !== supportedRouterDigest
        || firstLoad.observation.source.sourceDigest !== sourceCorrespondence.sourceDigest
        || !DIGEST.test(sourceCorrespondence.captureIdentityDigest)
        || !Array.isArray(sourceCorrespondence.handlers) || sourceCorrespondence.handlers.length !== firstLoad.observation.bindings.length
        || sourceCorrespondence.handlers.length < 1
        || !same(firstLoad.observation.bindings.map(bindingView), sourceCorrespondence.handlers))
        throw new ProtectedSwaggerLoadedDocumentError("LOADED_DOCUMENT_UNVERIFIED");
      const matches = sourceCorrespondence.matches;
      if (matches.length !== sourceCorrespondence.handlers.length || matches.some((match, index) =>
        match.bindingIndex !== index || match.handlerPath !== sourceCorrespondence.handlers[index]?.handlerPath
        || typeof match.documentPointer !== "string" || !match.documentPointer.startsWith("/paths/")))
        throw new ProtectedSwaggerLoadedDocumentError("LOADED_DOCUMENT_UNVERIFIED");
      const diagnostics = sourceCorrespondence.diagnostics;
      if (diagnostics.some(diagnostic => diagnostic.code !== "document_operation_unobserved"
        || typeof diagnostic.documentPointer !== "string" || !diagnostic.documentPointer.startsWith("/paths/")))
        throw new ProtectedSwaggerLoadedDocumentError("LOADED_DOCUMENT_UNVERIFIED");
      return Object.freeze({kind: "protected_swagger_loaded_document_correspondence",
        profileVersion: PROTECTED_SWAGGER_LOADED_DOCUMENT_PROFILE, scope: loadScope, serviceRoot: normalizedServiceRoot,
        sessionId: firstLoad.observation.source.sessionId, loadArtifactRef: firstLoad.artifactRef,
        loadConfiguredKeyRef: firstLoad.configuredKeyRef,
        captureIdentityDigest: sourceCorrespondence.captureIdentityDigest,
        loadEnvelopeDigest: firstLoad.envelopeDigest, loadSignerSpkiDigest: firstLoad.signerSpkiDigest,
        document: Object.freeze({path: sourceCorrespondence.document.path,
          rawSha256: sourceCorrespondence.document.rawSha256,
          canonicalValueSha256: firstLoad.observation.document.canonicalValueSha256,
          digest: sourceCorrespondence.document.digest}),
        matches: Object.freeze(matches.map(match => Object.freeze({...match}))),
        diagnostics: Object.freeze(diagnostics.map(diagnostic => Object.freeze({...diagnostic}))) as ProtectedSwaggerLoadedDocument["diagnostics"],
        limitations: Object.freeze([LIMITATION, LIMITATION_CONTRACT] as const)});
    } catch (error) {
      if (error instanceof ProtectedSwaggerLoadedDocumentError) throw error;
      throw new ProtectedSwaggerLoadedDocumentError("LOADED_DOCUMENT_UNVERIFIED");
    }
  }});
}
