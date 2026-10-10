import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {canonicalJsonStringify} from "@api-truth/ir";
import type {ProtectedSwaggerLoadedDocument} from "../../../connectors/git-source/src/protected-swagger-loaded-document.js";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "swagger-loaded-document-1" as const;
const PARENT_PROFILE = "protected-handler-bytes-1" as const;
const POLICY = "runtime-capture-pin-1";
const LIMITATION = "Controlled-process load observation is not proof of a production deployment";
const LIMITATION_CONTRACT = "Document and handler correspondence does not establish normative API behavior";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REVISION = /^[A-Fa-f0-9]{12,128}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY_REF = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const BINDING_KEYS = ["scope", "captureIdentityDigest", "loadArtifactRef", "loadConfiguredKeyRef", "loadEnvelopeDigest", "loadSignerSpkiDigest"] as const;
const OPTION_KEYS = ["schema", "binding", "preflightAuthorize", "transactionAuthorize", "verificationPort"] as const;
const OPTIONAL_OPTIONS = ["transactionFinalize"] as const;
const REQUEST_KEYS = ["scope", "captureIdentityDigest"] as const;
const RESULT_KEYS = ["kind", "profileVersion", "scope", "serviceRoot", "sessionId", "loadArtifactRef", "loadConfiguredKeyRef",
  "captureIdentityDigest", "loadEnvelopeDigest", "loadSignerSpkiDigest", "document", "matches", "diagnostics", "limitations"] as const;
const DOCUMENT_KEYS = ["path", "rawSha256", "canonicalValueSha256", "digest"] as const;
const MATCH_KEYS = ["bindingIndex", "documentPointer", "handlerPath"] as const;
const DIAGNOSTIC_KEYS = ["code", "documentPointer"] as const;
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

export type ObservedLoadedDocumentVerificationBinding = Readonly<{scope: ObservedCaptureScope;
  captureIdentityDigest: string; loadArtifactRef: string; loadConfiguredKeyRef: string;
  loadEnvelopeDigest: string; loadSignerSpkiDigest: string}>;
export type ObservedLoadedDocumentVerificationOptions = {schema: string; binding: ObservedLoadedDocumentVerificationBinding;
  preflightAuthorize(scope: Readonly<ObservedCaptureScope>): Promise<boolean>;
  transactionAuthorize(client: PoolClient, scope: Readonly<ObservedCaptureScope>): Promise<boolean>;
  verificationPort: {verify(): Promise<unknown>};
  transactionFinalize?(client: PoolClient, scope: Readonly<ObservedCaptureScope>, receipt: Readonly<ObservedLoadedDocumentVerificationReceipt>): Promise<boolean>};
export type ObservedLoadedDocumentVerificationReceipt = Readonly<{outcome: "inserted" | "existing";
  captureIdentityDigest: string; loadIdentityDigest: string; verifierProfileVersion: typeof PROFILE;
  serviceRoot: string; resultDigest: string; handlerCount: number; matchCount: number; unobservedDiagnosticCount: number}>;
const MESSAGES = {INVALID_LOADED_DOCUMENT_VERIFICATION_REQUEST: "Invalid loaded-document verification request",
  LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED: "Loaded-document verification unauthorized",
  LOADED_DOCUMENT_VERIFICATION_UNVERIFIED: "Loaded-document verification unverified",
  LOADED_DOCUMENT_VERIFICATION_CONFLICT: "Loaded-document verification conflict",
  LOADED_DOCUMENT_VERIFICATION_STORAGE_ERROR: "Loaded-document verification storage error"} as const;
export class ObservedLoadedDocumentVerificationError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) {super(MESSAGES[code]); this.code = code;}
}

function ownData(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (required.some(key => !Object.hasOwn(descriptors, key))
      || names.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) return undefined;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of [...required, ...optional]) {
      const descriptor = descriptors[key];
      if (!descriptor && optional.includes(key)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {return undefined;}
}
function safeArray(value: unknown, min: number, max: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < min || length > max) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== length + 1) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {return undefined;}
}
function safeScope(value: unknown): ObservedCaptureScope | undefined {
  const raw = ownData(value, SCOPE_KEYS);
  if (!raw || !matches(NAME, raw.tenantId) || !matches(NAME, raw.repositoryId) || !matches(NAME, raw.serviceId)
    || !matches(REVISION, raw.immutableRevision) || !matches(DIGEST, raw.sourceDigest) || !matches(NAME, raw.environment)) return undefined;
  return Object.freeze({tenantId: raw.tenantId, repositoryId: raw.repositoryId, serviceId: raw.serviceId,
    immutableRevision: raw.immutableRevision, sourceDigest: raw.sourceDigest, environment: raw.environment});
}
function safeBinding(value: unknown): ObservedLoadedDocumentVerificationBinding | undefined {
  const raw = ownData(value, BINDING_KEYS), scope = safeScope(raw?.scope);
  if (!raw || !scope || !matches(DIGEST, raw.captureIdentityDigest) || !matches(ARTIFACT, raw.loadArtifactRef)
    || !matches(KEY_REF, raw.loadConfiguredKeyRef) || !matches(DIGEST, raw.loadEnvelopeDigest)
    || !matches(DIGEST, raw.loadSignerSpkiDigest)) return undefined;
  return Object.freeze({scope, captureIdentityDigest: raw.captureIdentityDigest, loadArtifactRef: raw.loadArtifactRef,
    loadConfiguredKeyRef: raw.loadConfiguredKeyRef, loadEnvelopeDigest: raw.loadEnvelopeDigest,
    loadSignerSpkiDigest: raw.loadSignerSpkiDigest});
}
function sameScope(left: ObservedCaptureScope, right: ObservedCaptureScope): boolean {
  return SCOPE_KEYS.every(key => left[key] === right[key]);
}
type Association = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string; artifact_ref: string;
  configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
type ParentVerification = {tenant_id: string; capture_identity_digest: string; verifier_profile_version: string;
  service_root: string; source_digest: string; receipt_digest: string; signer_spki_digest: string; result_digest: string; handler_count: number};
type Stored = {tenant_id: string; load_identity_digest: string; capture_identity_digest: string;
  parent_verifier_profile_version: string; verifier_profile_version: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; load_artifact_ref: string; load_configured_key_ref: string;
  load_envelope_digest: string; load_signer_spki_digest: string; service_root: string; session_id: string;
  document_raw_sha256: string; document_canonical_value_sha256: string; document_digest: string; result_digest: string;
  handler_count: number; match_count: number; unobserved_diagnostic_count: number};

function validAssociation(row: Association | undefined, scope: ObservedCaptureScope, identity: string): row is Association {
  if (!row || row.tenant_id !== scope.tenantId || row.capture_identity_digest !== identity
    || row.repository_id !== scope.repositoryId || row.service_id !== scope.serviceId
    || row.immutable_revision !== scope.immutableRevision || row.source_digest !== scope.sourceDigest
    || row.environment !== scope.environment || row.policy_version !== POLICY
    || !matches(ARTIFACT, row.artifact_ref) || !matches(KEY_REF, row.configured_key_ref)
    || !matches(DIGEST, row.receipt_digest) || !matches(DIGEST, row.signer_spki_digest)) return false;
  return identity === hash(canonicalJsonStringify({policyVersion: POLICY, scope,
    artifactRef: row.artifact_ref, configuredKeyRef: row.configured_key_ref,
    receiptDigest: row.receipt_digest, signerSpkiDigest: row.signer_spki_digest}));
}
function validParent(row: ParentVerification | undefined, scope: ObservedCaptureScope, identity: string,
  association: Association): row is ParentVerification {
  return !!row && row.tenant_id === scope.tenantId && row.capture_identity_digest === identity
    && row.verifier_profile_version === PARENT_PROFILE && row.source_digest === scope.sourceDigest
    && row.receipt_digest === association.receipt_digest && row.signer_spki_digest === association.signer_spki_digest
    && matches(ROOT, row.service_root) && row.service_root.length <= 1024
    && (row.service_root === "." || !row.service_root.split("/").some(part => part === "." || part === ".."))
    && Number.isInteger(row.handler_count) && row.handler_count >= 1 && row.handler_count <= 1024
    && matches(DIGEST, row.result_digest);
}
function loadedProjection(value: unknown, binding: ObservedLoadedDocumentVerificationBinding, parent: ParentVerification) {
  const raw = ownData(value, RESULT_KEYS), scope = safeScope(raw?.scope), document = ownData(raw?.document, DOCUMENT_KEYS);
  if (!raw || !scope || !document || raw.kind !== "protected_swagger_loaded_document_correspondence" || raw.profileVersion !== PROFILE
    || !sameScope(scope, binding.scope) || raw.captureIdentityDigest !== binding.captureIdentityDigest
    || raw.loadArtifactRef !== binding.loadArtifactRef || raw.loadConfiguredKeyRef !== binding.loadConfiguredKeyRef
    || raw.loadEnvelopeDigest !== binding.loadEnvelopeDigest || raw.loadSignerSpkiDigest !== binding.loadSignerSpkiDigest
    || raw.serviceRoot !== parent.service_root || !matches(ROOT, raw.serviceRoot)
    || typeof raw.sessionId !== "string" || !NAME.test(raw.sessionId)
    || document.path !== (raw.serviceRoot === "." ? "api/swagger/swagger.yaml" : `${raw.serviceRoot}/api/swagger/swagger.yaml`)
    || !matches(DIGEST, document.rawSha256) || !matches(DIGEST, document.canonicalValueSha256) || !matches(DIGEST, document.digest)) return undefined;
  const matchesRaw = safeArray(raw.matches, 1, 1024), diagnosticsRaw = safeArray(raw.diagnostics, 0, 1024);
  const limitations = safeArray(raw.limitations, 2, 2);
  if (!matchesRaw || matchesRaw.length !== parent.handler_count || !diagnosticsRaw || !limitations
    || limitations[0] !== LIMITATION || limitations[1] !== LIMITATION_CONTRACT) return undefined;
  const matchList: Array<{bindingIndex: number; documentPointer: string; handlerPath: string}> = [];
  const pointers = new Set<string>();
  for (let i = 0; i < matchesRaw.length; i += 1) {
    const match = ownData(matchesRaw[i], MATCH_KEYS);
    if (!match || match.bindingIndex !== i || typeof match.documentPointer !== "string"
      || match.documentPointer.length > 8192 || !/^\/paths\/(?:[^/~]|~[01])+\/(?:get|post|put|patch|delete|head|options)$/.test(match.documentPointer)
      || /[\u0000-\u001f\u007f]/u.test(match.documentPointer)
      || typeof match.handlerPath !== "string" || match.handlerPath.length > 1024
      || !/^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(match.handlerPath)
      || match.handlerPath.split("/").some(part => part === "." || part === "..")
      || pointers.has(match.documentPointer)) return undefined;
    pointers.add(match.documentPointer);
    matchList.push({bindingIndex: i, documentPointer: match.documentPointer, handlerPath: match.handlerPath});
  }
  const diagnosticList: Array<{code: "document_operation_unobserved"; documentPointer: string}> = [];
  const diagnosticPointers = new Set<string>();
  for (const item of diagnosticsRaw) {
    const diagnostic = ownData(item, DIAGNOSTIC_KEYS);
    if (!diagnostic || diagnostic.code !== "document_operation_unobserved" || typeof diagnostic.documentPointer !== "string"
      || diagnostic.documentPointer.length > 8192 || !/^\/paths\/(?:[^/~]|~[01])+\/(?:get|post|put|patch|delete|head|options)$/.test(diagnostic.documentPointer)
      || /[\u0000-\u001f\u007f]/u.test(diagnostic.documentPointer) || diagnosticPointers.has(diagnostic.documentPointer)
      || pointers.has(diagnostic.documentPointer)) return undefined;
    diagnosticPointers.add(diagnostic.documentPointer);
    diagnosticList.push({code: "document_operation_unobserved", documentPointer: diagnostic.documentPointer});
  }
  if (matchList.length + diagnosticList.length > 1024) return undefined;
  const projection: ProtectedSwaggerLoadedDocument = {kind: "protected_swagger_loaded_document_correspondence", profileVersion: PROFILE,
    scope, serviceRoot: raw.serviceRoot, sessionId: raw.sessionId, loadArtifactRef: raw.loadArtifactRef,
    loadConfiguredKeyRef: raw.loadConfiguredKeyRef, captureIdentityDigest: raw.captureIdentityDigest,
    loadEnvelopeDigest: raw.loadEnvelopeDigest, loadSignerSpkiDigest: raw.loadSignerSpkiDigest,
    document: {path: document.path, rawSha256: document.rawSha256 as string,
      canonicalValueSha256: document.canonicalValueSha256 as string, digest: document.digest as string},
    matches: matchList, diagnostics: diagnosticList, limitations: [LIMITATION, LIMITATION_CONTRACT]};
  const canonical = canonicalJsonStringify(projection);
  if (Buffer.byteLength(canonical, "utf8") > 1_000_000) return undefined;
  const loadIdentityDigest = hash(canonicalJsonStringify({profileVersion: PROFILE, scope,
    captureIdentityDigest: binding.captureIdentityDigest, loadArtifactRef: binding.loadArtifactRef,
    loadConfiguredKeyRef: binding.loadConfiguredKeyRef, loadEnvelopeDigest: binding.loadEnvelopeDigest,
    loadSignerSpkiDigest: binding.loadSignerSpkiDigest}));
  return {projection, loadIdentityDigest, resultDigest: hash(canonical), handlerCount: parent.handler_count,
    matchCount: matchList.length, unobservedDiagnosticCount: diagnosticList.length};
}

const SELECT_ASSOCIATION = `SELECT tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,
  environment,policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest
  FROM orchestration_observed_capture_associations WHERE tenant_id=$1 AND capture_identity_digest=$2`;
const SELECT_PARENT = `SELECT tenant_id,capture_identity_digest,verifier_profile_version,service_root,source_digest,
  receipt_digest,signer_spki_digest,result_digest,handler_count FROM orchestration_observed_capture_verifications
  WHERE tenant_id=$1 AND capture_identity_digest=$2 AND verifier_profile_version=$3`;
const SELECT_STORED = `SELECT tenant_id,load_identity_digest,capture_identity_digest,parent_verifier_profile_version,
  verifier_profile_version,repository_id,service_id,immutable_revision,source_digest,environment,load_artifact_ref,
  load_configured_key_ref,load_envelope_digest,load_signer_spki_digest,service_root,session_id,document_raw_sha256,
  document_canonical_value_sha256,document_digest,result_digest,handler_count,match_count,unobserved_diagnostic_count
  FROM orchestration_observed_loaded_document_verifications`;

/** Append-only durable association; it stores metadata digests only and never promotes API facts. */
export function createObservedLoadedDocumentVerificationStore(pool: Pool, options: ObservedLoadedDocumentVerificationOptions): {
  append(request: {scope: ObservedCaptureScope; captureIdentityDigest: string}): Promise<ObservedLoadedDocumentVerificationReceipt>} {
  const raw = ownData(options, OPTION_KEYS, OPTIONAL_OPTIONS), binding = safeBinding(raw?.binding);
  let schema: string;
  try {
    if (typeof raw?.schema !== "string") throw Error();
    schema = raw.schema;
    quoteOrchestrationSchemaIdentifier(schema);
  }
  catch {throw new ObservedLoadedDocumentVerificationError("INVALID_LOADED_DOCUMENT_VERIFICATION_REQUEST");}
  const schemaSql = quoteOrchestrationSchemaIdentifier(schema);
  const port = ownData(raw?.verificationPort, ["verify"]);
  if (!raw || !binding || !port || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.transactionAuthorize !== "function" || isProxy(raw.transactionAuthorize)
    || typeof port.verify !== "function" || isProxy(port.verify)
    || Object.hasOwn(raw, "transactionFinalize")
      && (typeof raw.transactionFinalize !== "function" || isProxy(raw.transactionFinalize)))
    throw new ObservedLoadedDocumentVerificationError("INVALID_LOADED_DOCUMENT_VERIFICATION_REQUEST");
  const boundSchema = schema;
  const preflightAuthorize = raw.preflightAuthorize as ObservedLoadedDocumentVerificationOptions["preflightAuthorize"];
  const transactionAuthorize = raw.transactionAuthorize as ObservedLoadedDocumentVerificationOptions["transactionAuthorize"];
  const transactionFinalize = Object.hasOwn(raw, "transactionFinalize")
    ? raw.transactionFinalize as NonNullable<ObservedLoadedDocumentVerificationOptions["transactionFinalize"]> : undefined;
  const verify = (port.verify as () => Promise<unknown>).bind(raw.verificationPort);
  return Object.freeze({async append(candidate: {scope: ObservedCaptureScope; captureIdentityDigest: string}) {
    const input = ownData(candidate, REQUEST_KEYS), scope = safeScope(input?.scope);
    if (!input || !scope || !matches(DIGEST, input.captureIdentityDigest)
      || !sameScope(scope, binding.scope) || input.captureIdentityDigest !== binding.captureIdentityDigest)
      throw new ObservedLoadedDocumentVerificationError("INVALID_LOADED_DOCUMENT_VERIFICATION_REQUEST");
    let allowed = false;
    try {allowed = await preflightAuthorize(scope) === true;} catch { /* Deny. */ }
    if (!allowed) throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED");
    let association: Association | undefined, parent: ParentVerification | undefined;
    try {
      const associationResult = await pool.query<Association>(
        SELECT_ASSOCIATION.replace("FROM orchestration_", `FROM ${schemaSql}.orchestration_`),
        [scope.tenantId, binding.captureIdentityDigest]);
      association = associationResult.rows.length === 1 ? associationResult.rows[0] : undefined;
      if (!validAssociation(association, scope, binding.captureIdentityDigest))
        throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED");
      const parentResult = await pool.query<ParentVerification>(SELECT_PARENT.replace("FROM orchestration_", `FROM ${schemaSql}.orchestration_`),
        [scope.tenantId, binding.captureIdentityDigest, PARENT_PROFILE]);
      parent = parentResult.rows.length === 1 ? parentResult.rows[0] : undefined;
      if (!validParent(parent, scope, binding.captureIdentityDigest, association))
        throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED");
    } catch (error) {
      if (!isProxy(error) && error instanceof ObservedLoadedDocumentVerificationError) throw error;
      throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_STORAGE_ERROR");
    }
    let result: ReturnType<typeof loadedProjection>;
    try {result = loadedProjection(await verify(), binding, parent);} catch { /* Withhold host-port failures. */ }
    if (!result) throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_UNVERIFIED");
    let client: PoolClient;
    try {client = await pool.connect();}
    catch {throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_STORAGE_ERROR");}
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, boundSchema);
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      let authorized = false;
      try {authorized = await transactionAuthorize(client, scope) === true;} catch { /* Deny. */ }
      if (!authorized) throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED");
      const currentAssociationResult = await client.query<Association>(`${SELECT_ASSOCIATION} FOR SHARE`,
        [scope.tenantId, binding.captureIdentityDigest]);
      const currentAssociation = currentAssociationResult.rows.length === 1 ? currentAssociationResult.rows[0] : undefined;
      if (!validAssociation(currentAssociation, scope, binding.captureIdentityDigest)
        || canonicalJsonStringify(currentAssociation) !== canonicalJsonStringify(association))
        throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_CONFLICT");
      const currentParentResult = await client.query<ParentVerification>(`${SELECT_PARENT} FOR SHARE`,
        [scope.tenantId, binding.captureIdentityDigest, PARENT_PROFILE]);
      const currentParent = currentParentResult.rows.length === 1 ? currentParentResult.rows[0] : undefined;
      if (!validParent(currentParent, scope, binding.captureIdentityDigest, currentAssociation)
        || canonicalJsonStringify(currentParent) !== canonicalJsonStringify(parent))
        throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_CONFLICT");
      const insert = await client.query(`INSERT INTO orchestration_observed_loaded_document_verifications
        (tenant_id,load_identity_digest,capture_identity_digest,parent_verifier_profile_version,verifier_profile_version,
         repository_id,service_id,immutable_revision,source_digest,environment,load_artifact_ref,load_configured_key_ref,
         load_envelope_digest,load_signer_spki_digest,service_root,session_id,document_raw_sha256,
         document_canonical_value_sha256,document_digest,result_digest,handler_count,match_count,unobserved_diagnostic_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        ON CONFLICT (tenant_id,load_identity_digest) DO NOTHING`,
      [scope.tenantId, result.loadIdentityDigest, binding.captureIdentityDigest, PARENT_PROFILE, PROFILE,
        scope.repositoryId, scope.serviceId, scope.immutableRevision, scope.sourceDigest, scope.environment,
        binding.loadArtifactRef, binding.loadConfiguredKeyRef, binding.loadEnvelopeDigest, binding.loadSignerSpkiDigest,
        result.projection.serviceRoot, result.projection.sessionId, result.projection.document.rawSha256,
        result.projection.document.canonicalValueSha256, result.projection.document.digest, result.resultDigest,
        result.handlerCount, result.matchCount, result.unobservedDiagnosticCount]);
      const storedResult = await client.query<Stored>(`${SELECT_STORED}
        WHERE tenant_id=$1 AND load_identity_digest=$2 FOR SHARE`, [scope.tenantId, result.loadIdentityDigest]);
      const row = storedResult.rows[0];
      if (storedResult.rows.length !== 1 || !row || row.tenant_id !== scope.tenantId
        || row.load_identity_digest !== result.loadIdentityDigest || row.capture_identity_digest !== binding.captureIdentityDigest
        || row.parent_verifier_profile_version !== PARENT_PROFILE || row.verifier_profile_version !== PROFILE
        || row.repository_id !== scope.repositoryId || row.service_id !== scope.serviceId
        || row.immutable_revision !== scope.immutableRevision || row.source_digest !== scope.sourceDigest
        || row.environment !== scope.environment || row.load_artifact_ref !== binding.loadArtifactRef
        || row.load_configured_key_ref !== binding.loadConfiguredKeyRef || row.load_envelope_digest !== binding.loadEnvelopeDigest
        || row.load_signer_spki_digest !== binding.loadSignerSpkiDigest || row.service_root !== result.projection.serviceRoot
        || row.session_id !== result.projection.sessionId || row.document_raw_sha256 !== result.projection.document.rawSha256
        || row.document_canonical_value_sha256 !== result.projection.document.canonicalValueSha256
        || row.document_digest !== result.projection.document.digest || row.result_digest !== result.resultDigest
        || row.handler_count !== result.handlerCount || row.match_count !== result.matchCount
        || row.unobserved_diagnostic_count !== result.unobservedDiagnosticCount)
        throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_CONFLICT");
      const receipt: ObservedLoadedDocumentVerificationReceipt = Object.freeze({outcome: insert.rowCount === 1 ? "inserted" : "existing",
        captureIdentityDigest: binding.captureIdentityDigest, loadIdentityDigest: result.loadIdentityDigest,
        verifierProfileVersion: PROFILE, serviceRoot: result.projection.serviceRoot, resultDigest: result.resultDigest,
        handlerCount: result.handlerCount, matchCount: result.matchCount,
        unobservedDiagnosticCount: result.unobservedDiagnosticCount});
      if (transactionFinalize) {
        let finalized: boolean;
        try {finalized = await transactionFinalize(client, scope, receipt) === true;}
        catch {throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_STORAGE_ERROR");}
        if (!finalized) throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED");
      }
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isProxy(error) && error instanceof ObservedLoadedDocumentVerificationError) throw error;
      throw new ObservedLoadedDocumentVerificationError("LOADED_DOCUMENT_VERIFICATION_STORAGE_ERROR");
    } finally {client.release();}
  }});
}
