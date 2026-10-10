import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash, canonicalOrchestrationJson, compareUtf8} from "./canonical.js";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "swagger-loaded-document-1" as const;
const PARENT_PROFILE = "protected-handler-bytes-1" as const;
const CAPABILITY = "swagger.document.verify.admit" as const;
const POLICY = "runtime-capture-pin-1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const PRINCIPAL = /^[A-Za-z0-9_.:@-]{1,128}$/;
const REVISION = /^[A-Fa-f0-9]{12,128}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const FINGERPRINT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY_REF = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CONFIG_BYTES = 1_000_000;
const DEFAULT_MAX_QUEUED = 1000;
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const BINDING_KEYS = ["scope", "captureIdentityDigest", "serviceRoot", "loadArtifactRef", "loadConfiguredKeyRef",
  "loadEnvelopeDigest", "loadSignerSpkiDigest"] as const;
const OPTION_KEYS = ["schema", "tenantId", "principalId", "bindings", "preflightAuthorize", "authorizeLoadedDocument"] as const;
const OPTIONAL_OPTIONS = ["maxQueuedPerTenant"] as const;
const REQUEST_KEYS = ["captureIdentityDigest"] as const;

export type LoadedDocumentVerificationAdmissionBinding = Readonly<{scope: ObservedCaptureScope;
  captureIdentityDigest: string; serviceRoot: string; loadArtifactRef: string; loadConfiguredKeyRef: string;
  loadEnvelopeDigest: string; loadSignerSpkiDigest: string}>;
type FixedBinding = LoadedDocumentVerificationAdmissionBinding & Readonly<{loadIdentityDigest: string}>;
export type LoadedDocumentVerificationAdmissionOptions = {schema: string; tenantId: string; principalId: string;
  bindings: readonly LoadedDocumentVerificationAdmissionBinding[]; maxQueuedPerTenant?: number;
  preflightAuthorize(context: Readonly<{tenantId: string; principalId: string; capability: typeof CAPABILITY}>): Promise<boolean>;
  /** DB-local host policy locks independent source, environment and signed-artifact permission for this epoch. */
  authorizeLoadedDocument(client: PoolClient, binding: LoadedDocumentAdmissionAuthorization): Promise<boolean>};
export type LoadedDocumentAdmissionAuthorization = Readonly<{tenantId: string; principalId: string;
  captureIdentityDigest: string; verifierProfileVersion: typeof PROFILE; repositoryId: string; serviceId: string;
  environment: string; immutableRevision: string; sourceDigest: string; serviceRoot: string;
  loadArtifactRef: string; loadConfiguredKeyRef: string; loadEnvelopeDigest: string; loadSignerSpkiDigest: string;
  loadIdentityDigest: string; configFingerprint: string; configDocumentSha256: string; checkpointVersion: string}>;
export type LoadedDocumentVerificationAdmissionReceipt = Readonly<{outcome: "queued" | "existing"; jobId: string;
  loadIdentityDigest: string; captureIdentityDigest: string; verifierProfileVersion: typeof PROFILE; serviceRoot: string;
  configFingerprint: string; configDocumentSha256: string; checkpointVersion: string}>;

const MESSAGES = {INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST: "Invalid loaded-document admission request",
  LOADED_DOCUMENT_ADMISSION_DENIED: "Loaded-document admission denied",
  LOADED_DOCUMENT_ADMISSION_QUOTA: "Loaded-document admission quota reached",
  LOADED_DOCUMENT_ADMISSION_CONFLICT: "Loaded-document admission conflict",
  LOADED_DOCUMENT_ADMISSION_STORAGE_ERROR: "Loaded-document admission storage error"} as const;
export class LoadedDocumentVerificationAdmissionError extends Error {
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
    const detached: Record<string, unknown> = Object.create(null);
    for (const key of [...required, ...optional]) {
      const descriptor = descriptors[key];
      if (!descriptor && optional.includes(key)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      detached[key] = descriptor.value;
    }
    return detached;
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
function validRoot(value: unknown): value is string {
  return matches(ROOT, value) && value.length <= 1024
    && (value === "." || value.split("/").every(part => part !== "." && part !== ".."));
}
function safeBinding(value: unknown, tenantId: string): FixedBinding | undefined {
  const raw = ownData(value, BINDING_KEYS), scope = safeScope(raw?.scope);
  if (!raw || !scope || scope.tenantId !== tenantId || !matches(DIGEST, raw.captureIdentityDigest)
    || !validRoot(raw.serviceRoot) || !matches(ARTIFACT, raw.loadArtifactRef) || !matches(KEY_REF, raw.loadConfiguredKeyRef)
    || !matches(DIGEST, raw.loadEnvelopeDigest) || !matches(DIGEST, raw.loadSignerSpkiDigest)) return undefined;
  const loadIdentityDigest = hash(canonicalOrchestrationJson({profileVersion: PROFILE, scope,
    captureIdentityDigest: raw.captureIdentityDigest, loadArtifactRef: raw.loadArtifactRef,
    loadConfiguredKeyRef: raw.loadConfiguredKeyRef, loadEnvelopeDigest: raw.loadEnvelopeDigest,
    loadSignerSpkiDigest: raw.loadSignerSpkiDigest}));
  return Object.freeze({scope, captureIdentityDigest: raw.captureIdentityDigest, serviceRoot: raw.serviceRoot,
    loadArtifactRef: raw.loadArtifactRef, loadConfiguredKeyRef: raw.loadConfiguredKeyRef,
    loadEnvelopeDigest: raw.loadEnvelopeDigest, loadSignerSpkiDigest: raw.loadSignerSpkiDigest,
    loadIdentityDigest});
}
type Parent = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string; artifact_ref: string;
  configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
type ByteParent = {tenant_id: string; capture_identity_digest: string; verifier_profile_version: string; service_root: string;
  source_digest: string; receipt_digest: string; signer_spki_digest: string; result_digest: string; handler_count: number};
type ActiveRow = {config_fingerprint: string; config_version: string; document_sha256: string; checkpoint_version: string; document: unknown};
type Job = {tenant_id: string; job_id: string; load_identity_digest: string; capture_identity_digest: string;
  parent_verifier_profile_version: string; verifier_profile_version: string; repository_id: string; service_id: string;
  environment: string; immutable_revision: string; source_digest: string; service_root: string; load_artifact_ref: string;
  load_configured_key_ref: string; load_envelope_digest: string; load_signer_spki_digest: string; config_fingerprint: string;
  config_document_sha256: string; config_checkpoint_version: string; state: string};

function validParent(row: Parent | undefined, binding: LoadedDocumentVerificationAdmissionBinding): row is Parent {
  if (!row || row.tenant_id !== binding.scope.tenantId || row.capture_identity_digest !== binding.captureIdentityDigest
    || row.repository_id !== binding.scope.repositoryId || row.service_id !== binding.scope.serviceId
    || row.immutable_revision !== binding.scope.immutableRevision || row.source_digest !== binding.scope.sourceDigest
    || row.environment !== binding.scope.environment || row.policy_version !== POLICY
    || !matches(ARTIFACT, row.artifact_ref) || !matches(KEY_REF, row.configured_key_ref)
    || !matches(DIGEST, row.receipt_digest) || !matches(DIGEST, row.signer_spki_digest)) return false;
  return canonicalOrchestrationHash({policyVersion: POLICY, scope: binding.scope, artifactRef: row.artifact_ref,
    configuredKeyRef: row.configured_key_ref, receiptDigest: row.receipt_digest,
    signerSpkiDigest: row.signer_spki_digest}) === binding.captureIdentityDigest;
}
function validByteParent(row: ByteParent | undefined, parent: Parent, binding: LoadedDocumentVerificationAdmissionBinding): row is ByteParent {
  return !!row && row.tenant_id === binding.scope.tenantId && row.capture_identity_digest === binding.captureIdentityDigest
    && row.verifier_profile_version === PARENT_PROFILE && row.service_root === binding.serviceRoot
    && row.source_digest === binding.scope.sourceDigest && row.receipt_digest === parent.receipt_digest
    && row.signer_spki_digest === parent.signer_spki_digest && matches(DIGEST, row.result_digest)
    && Number.isInteger(row.handler_count) && row.handler_count >= 1 && row.handler_count <= 1024;
}
function validatedActive(row: ActiveRow | undefined) {
  if (!row || !matches(FINGERPRINT, row.config_fingerprint) || !matches(DIGEST, row.document_sha256)
    || !/^[1-9][0-9]{0,18}$/.test(row.checkpoint_version))
    throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_STORAGE_ERROR");
  try {
    const parsed = parseConfig(row.document);
    if (!parsed.ok || parsed.value.config_version !== row.config_version
      || canonicalOrchestrationHash(parsed.value) !== row.document_sha256
      || Buffer.byteLength(canonicalOrchestrationJson(parsed.value), "utf8") > MAX_CONFIG_BYTES) throw Error();
    return Object.freeze({fingerprint: row.config_fingerprint, documentSha256: row.document_sha256,
      checkpointVersion: row.checkpoint_version, document: parsed.value});
  } catch {throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_STORAGE_ERROR");}
}
function equalJob(row: Job | undefined, wanted: Job): row is Job {
  return !!row && Object.keys(wanted).every(key => row[key as keyof Job] === wanted[key as keyof Job]);
}

/** Queues a separate loaded-document intent. It never runs verification or writes catalog facts. */
export function createLoadedDocumentVerificationAdmissionStore(pool: Pool,
  options: LoadedDocumentVerificationAdmissionOptions): {
  admit(request: {captureIdentityDigest: string}): Promise<LoadedDocumentVerificationAdmissionReceipt>} {
  const raw = ownData(options, OPTION_KEYS, OPTIONAL_OPTIONS);
  let schema: string;
  try {if (typeof raw?.schema !== "string") throw Error(); schema = raw.schema; quoteOrchestrationSchemaIdentifier(schema);}
  catch {throw new LoadedDocumentVerificationAdmissionError("INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST");}
  const tenantId = raw?.tenantId, principalId = raw?.principalId;
  const rawBindings = safeArray(raw?.bindings, 1, 128);
  const bindings = rawBindings?.map(item => safeBinding(item, tenantId as string));
  if (!raw || !matches(NAME, tenantId) || !matches(PRINCIPAL, principalId)
    || !rawBindings || !bindings || bindings.some(binding => !binding)
    || new Set(bindings.map(binding => binding!.captureIdentityDigest)).size !== bindings.length
    || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.authorizeLoadedDocument !== "function" || isProxy(raw.authorizeLoadedDocument)
    || Object.hasOwn(raw, "maxQueuedPerTenant") && (!Number.isSafeInteger(raw.maxQueuedPerTenant)
      || (raw.maxQueuedPerTenant as number) < 1 || (raw.maxQueuedPerTenant as number) > DEFAULT_MAX_QUEUED))
    throw new LoadedDocumentVerificationAdmissionError("INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST");
  const boundSchema = schema, fixedTenant = tenantId as string, fixedPrincipal = principalId as string;
  const scope = Object.freeze({tenantId: fixedTenant, principalId: fixedPrincipal, capability: CAPABILITY});
  const maxQueued = raw.maxQueuedPerTenant as number | undefined ?? DEFAULT_MAX_QUEUED;
  const preflight = raw.preflightAuthorize as LoadedDocumentVerificationAdmissionOptions["preflightAuthorize"];
  const authorize = raw.authorizeLoadedDocument as LoadedDocumentVerificationAdmissionOptions["authorizeLoadedDocument"];
  const byCapture = new Map((bindings as FixedBinding[]).map(binding => [binding.captureIdentityDigest, binding]));
  return Object.freeze({async admit(candidate: {captureIdentityDigest: string}) {
    const request = ownData(candidate, REQUEST_KEYS);
    if (!request || !matches(DIGEST, request.captureIdentityDigest))
      throw new LoadedDocumentVerificationAdmissionError("INVALID_LOADED_DOCUMENT_ADMISSION_REQUEST");
    const binding = byCapture.get(request.captureIdentityDigest);
    let allowed = false;
    try {allowed = await preflight(scope) === true;} catch { /* Deny. */ }
    if (!allowed) throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
    if (!binding) throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
    let client: PoolClient;
    try {client = await pool.connect();}
    catch {throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_STORAGE_ERROR");}
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, boundSchema);
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`api-truth:loaded-document-admission:${fixedTenant}`]);
      const activeRows = await client.query<ActiveRow>(`SELECT configuration.config_fingerprint,
        configuration.config_version,configuration.document_sha256,active.checkpoint_version::text,
        CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document ELSE NULL END AS document
        FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
          ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
        WHERE active.tenant_id=$1 FOR SHARE OF active`, [fixedTenant, MAX_CONFIG_BYTES]);
      if (activeRows.rows.length !== 1) throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
      const active = validatedActive(activeRows.rows[0]);
      const associationResult = await client.query<Parent>(`SELECT tenant_id,capture_identity_digest,repository_id,service_id,
        immutable_revision,source_digest,environment,policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest
        FROM orchestration_observed_capture_associations WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`,
      [fixedTenant, binding.captureIdentityDigest]);
      const parent = associationResult.rows[0];
      if (associationResult.rows.length !== 1 || !validParent(parent, binding))
        throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
      const byteRows = await client.query<ByteParent>(`SELECT tenant_id,capture_identity_digest,verifier_profile_version,
        service_root,source_digest,receipt_digest,signer_spki_digest,result_digest,handler_count
        FROM orchestration_observed_capture_verifications WHERE tenant_id=$1 AND capture_identity_digest=$2
          AND verifier_profile_version=$3 FOR SHARE`, [fixedTenant, binding.captureIdentityDigest, PARENT_PROFILE]);
      const byteParent = byteRows.rows[0];
      if (byteRows.rows.length !== 1 || !validByteParent(byteParent, parent, binding))
        throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
      const repository = active.document.repositories.find(item => item.repository_id === binding.scope.repositoryId);
      const service = repository?.services.find(item => item.service_id === binding.scope.serviceId);
      const environment = service?.environments.find(item => item.name === binding.scope.environment);
      if (!repository || !service || !environment || service.root !== binding.serviceRoot)
        throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
      const scopeIds = [...new Set([repository.access_scope_id, environment.deployment_authority.access_scope_id])].sort(compareUtf8);
      const scopes = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active FROM access_scopes
        WHERE tenant_id=$1 AND access_scope_id=ANY($2::text[]) ORDER BY access_scope_id COLLATE "C" FOR SHARE`,
      [fixedTenant, scopeIds]);
      const grants = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
        FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=ANY($3::text[])
        ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [fixedTenant, fixedPrincipal, scopeIds]);
      if (scopes.rows.length !== scopeIds.length || grants.rows.length !== scopeIds.length
        || scopeIds.some((id, index) => scopes.rows[index]?.access_scope_id !== id || scopes.rows[index]?.active !== true
          || grants.rows[index]?.access_scope_id !== id || grants.rows[index]?.active !== true))
        throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
      const loadIdentityDigest = binding.loadIdentityDigest;
      const authorization: LoadedDocumentAdmissionAuthorization = Object.freeze({tenantId: fixedTenant, principalId: fixedPrincipal,
        captureIdentityDigest: binding.captureIdentityDigest, verifierProfileVersion: PROFILE,
        repositoryId: binding.scope.repositoryId, serviceId: binding.scope.serviceId,
        environment: binding.scope.environment, immutableRevision: binding.scope.immutableRevision,
        sourceDigest: binding.scope.sourceDigest, serviceRoot: binding.serviceRoot,
        loadArtifactRef: binding.loadArtifactRef, loadConfiguredKeyRef: binding.loadConfiguredKeyRef,
        loadEnvelopeDigest: binding.loadEnvelopeDigest, loadSignerSpkiDigest: binding.loadSignerSpkiDigest,
        loadIdentityDigest, configFingerprint: active.fingerprint, configDocumentSha256: active.documentSha256,
        checkpointVersion: active.checkpointVersion});
      try {allowed = await authorize(client, authorization) === true;} catch {allowed = false;}
      if (!allowed) throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_DENIED");
      const jobId = canonicalOrchestrationHash({kind: "loaded_document_verification_admission", tenantId: fixedTenant,
        loadIdentityDigest, verifierProfileVersion: PROFILE, serviceRoot: binding.serviceRoot,
        configFingerprint: active.fingerprint, configDocumentSha256: active.documentSha256,
        checkpointVersion: active.checkpointVersion});
      const wanted: Job = {tenant_id: fixedTenant, job_id: jobId, load_identity_digest: loadIdentityDigest,
        capture_identity_digest: binding.captureIdentityDigest, parent_verifier_profile_version: PARENT_PROFILE,
        verifier_profile_version: PROFILE, repository_id: binding.scope.repositoryId, service_id: binding.scope.serviceId,
        environment: binding.scope.environment, immutable_revision: binding.scope.immutableRevision,
        source_digest: binding.scope.sourceDigest, service_root: binding.serviceRoot,
        load_artifact_ref: binding.loadArtifactRef, load_configured_key_ref: binding.loadConfiguredKeyRef,
        load_envelope_digest: binding.loadEnvelopeDigest, load_signer_spki_digest: binding.loadSignerSpkiDigest,
        config_fingerprint: active.fingerprint, config_document_sha256: active.documentSha256,
        config_checkpoint_version: active.checkpointVersion, state: "queued"};
      const prior = await client.query<Job>(`SELECT tenant_id,job_id,load_identity_digest,capture_identity_digest,
        parent_verifier_profile_version,verifier_profile_version,repository_id,service_id,environment,immutable_revision,
        source_digest,service_root,load_artifact_ref,load_configured_key_ref,load_envelope_digest,load_signer_spki_digest,
        config_fingerprint,config_document_sha256,config_checkpoint_version::text,state
        FROM orchestration_loaded_document_verification_jobs WHERE tenant_id=$1 AND job_id=$2 FOR SHARE`,
      [fixedTenant, jobId]);
      if (prior.rows.length && !equalJob(prior.rows[0], wanted))
        throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_CONFLICT");
      let outcome: "queued" | "existing" = "existing";
      if (!prior.rows.length) {
        const quota = await client.query<{count: string}>(`SELECT count(*)::text AS count
          FROM orchestration_loaded_document_verification_jobs WHERE tenant_id=$1 AND state='queued'`, [fixedTenant]);
        if (quota.rows.length !== 1 || !/^[0-9]+$/.test(quota.rows[0]!.count))
          throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_STORAGE_ERROR");
        if (BigInt(quota.rows[0]!.count) >= BigInt(maxQueued))
          throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_QUOTA");
        const inserted = await client.query(`INSERT INTO orchestration_loaded_document_verification_jobs
          (tenant_id,job_id,load_identity_digest,capture_identity_digest,parent_verifier_profile_version,
           verifier_profile_version,repository_id,service_id,environment,immutable_revision,source_digest,service_root,
           load_artifact_ref,load_configured_key_ref,load_envelope_digest,load_signer_spki_digest,config_fingerprint,
           config_document_sha256,config_checkpoint_version,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'queued')
          ON CONFLICT (tenant_id,job_id) DO NOTHING`,
        [fixedTenant, jobId, loadIdentityDigest, binding.captureIdentityDigest, PARENT_PROFILE, PROFILE,
          binding.scope.repositoryId, binding.scope.serviceId, binding.scope.environment, binding.scope.immutableRevision,
          binding.scope.sourceDigest, binding.serviceRoot, binding.loadArtifactRef, binding.loadConfiguredKeyRef,
          binding.loadEnvelopeDigest, binding.loadSignerSpkiDigest, active.fingerprint, active.documentSha256,
          active.checkpointVersion]);
        outcome = inserted.rowCount === 1 ? "queued" : "existing";
      }
      const stored = await client.query<Job>(`SELECT tenant_id,job_id,load_identity_digest,capture_identity_digest,
        parent_verifier_profile_version,verifier_profile_version,repository_id,service_id,environment,immutable_revision,
        source_digest,service_root,load_artifact_ref,load_configured_key_ref,load_envelope_digest,load_signer_spki_digest,
        config_fingerprint,config_document_sha256,config_checkpoint_version::text,state
        FROM orchestration_loaded_document_verification_jobs WHERE tenant_id=$1 AND job_id=$2 FOR SHARE`, [fixedTenant, jobId]);
      if (stored.rows.length !== 1 || !equalJob(stored.rows[0], wanted))
        throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_CONFLICT");
      await client.query("COMMIT");
      return Object.freeze({outcome, jobId, loadIdentityDigest, captureIdentityDigest: binding.captureIdentityDigest,
        verifierProfileVersion: PROFILE, serviceRoot: binding.serviceRoot, configFingerprint: active.fingerprint,
        configDocumentSha256: active.documentSha256, checkpointVersion: active.checkpointVersion});
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isProxy(error) && error instanceof LoadedDocumentVerificationAdmissionError) throw error;
      throw new LoadedDocumentVerificationAdmissionError("LOADED_DOCUMENT_ADMISSION_STORAGE_ERROR");
    } finally {client.release();}
  }});
}
