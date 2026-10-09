import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash, canonicalOrchestrationJson, compareUtf8} from "./canonical.js";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "protected-handler-bytes-1";
const POLICY = "runtime-capture-pin-1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const HOST_NAME = /^[A-Za-z0-9_.:@-]{1,128}$/;
const REVISION = /^[a-fA-F0-9]{12,128}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const FINGERPRINT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CONFIG_BYTES = 1_000_000;
const DEFAULT_MAX_QUEUED = 1000;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

type Parent = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string;
  artifact_ref: string; configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
type Active = {config_fingerprint: string; config_version: string; document_sha256: string;
  checkpoint_version: string; document: unknown};
type Job = {tenant_id: string; job_id: string; capture_identity_digest: string; verifier_profile_version: string;
  repository_id: string; service_id: string; environment: string; service_root: string;
  config_fingerprint: string; config_document_sha256: string; config_checkpoint_version: string;
  state: string};
type HostBinding = Readonly<{tenantId: string; principalId: string; captureIdentityDigest: string;
  verifierProfileVersion: typeof PROFILE; repositoryId: string; serviceId: string; environment: string;
  immutableRevision: string; sourceDigest: string; serviceRoot: string;
  artifactRef: string; configuredKeyRef: string; receiptDigest: string; signerSpkiDigest: string;
  configFingerprint: string; configDocumentSha256: string; checkpointVersion: string}>;
export type CaptureVerificationAdmissionOptions = {schema: string; tenantId: string; principalId: string;
  maxQueuedPerTenant?: number;
  /** Host-authenticated capability check BEFORE any database lookup. */
  preflightAuthorize(context: Readonly<{tenantId: string; principalId: string}>): Promise<boolean>;
  /** Host policy must lock/check independent source, environment, and protected-capture permissions
   * and an explicit opt-in bound to the exact active config SHA/checkpoint. DB-local SQL only. */
  authorizeCapture(client: PoolClient, binding: HostBinding): Promise<boolean>};
export type CaptureVerificationAdmissionReceipt = Readonly<{outcome: "queued" | "existing"; jobId: string;
  captureIdentityDigest: string; verifierProfileVersion: typeof PROFILE; serviceRoot: string;
  configFingerprint: string; configDocumentSha256: string; checkpointVersion: string}>;

const MESSAGES = {INVALID_CAPTURE_ADMISSION_REQUEST: "Invalid capture admission request",
  CAPTURE_ADMISSION_DENIED: "Capture admission denied",
  CAPTURE_ADMISSION_QUOTA: "Capture admission quota reached",
  CAPTURE_ADMISSION_CONFLICT: "Capture admission conflict",
  CAPTURE_ADMISSION_STORAGE_ERROR: "Capture admission storage error"} as const;
export class CaptureVerificationAdmissionError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.code = code; }
}
function ownData(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const names = Reflect.ownKeys(value);
    if (names.length < keys.length || names.length > keys.length + optional.length
      || keys.some(key => !names.includes(key))
      || names.some(name => typeof name !== "string" || !keys.includes(name) && !optional.includes(name))) return undefined;
    const detached: Record<string, unknown> = Object.create(null);
    for (const key of [...keys, ...optional]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor && optional.includes(key)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      detached[key] = descriptor.value;
    }
    return detached;
  } catch { return undefined; }
}
function validRoot(value: unknown): value is string {
  return matches(ROOT, value) && value.length <= 1024
    && (value === "." || value.split("/").every(part => part !== "." && part !== ".."));
}
function validParent(row: Parent | undefined, tenantId: string, identity: string): row is Parent {
  if (!row || row.tenant_id !== tenantId || row.capture_identity_digest !== identity
    || !matches(NAME, row.repository_id) || !matches(NAME, row.service_id)
    || !matches(NAME, row.environment) || !matches(REVISION, row.immutable_revision)
    || !matches(DIGEST, row.source_digest) || row.policy_version !== POLICY
    || !matches(ARTIFACT, row.artifact_ref) || !matches(KEY, row.configured_key_ref)
    || !matches(DIGEST, row.receipt_digest) || !matches(DIGEST, row.signer_spki_digest)) return false;
  const scope: ObservedCaptureScope = {tenantId, repositoryId: row.repository_id, serviceId: row.service_id,
    immutableRevision: row.immutable_revision, sourceDigest: row.source_digest, environment: row.environment};
  return canonicalOrchestrationHash({policyVersion: POLICY, scope, artifactRef: row.artifact_ref,
    configuredKeyRef: row.configured_key_ref, receiptDigest: row.receipt_digest,
    signerSpkiDigest: row.signer_spki_digest}) === identity;
}
function validatedActive(row: Active | undefined) {
  if (!row || !matches(FINGERPRINT, row.config_fingerprint)
    || !matches(DIGEST, row.document_sha256) || !/^[1-9][0-9]{0,18}$/.test(row.checkpoint_version))
    throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_STORAGE_ERROR");
  try {
    // The SQL CASE bounds data sent to the host; a missing document is a failed closed storage state.
    const parsed = parseConfig(row.document);
    if (!parsed.ok || parsed.value.config_version !== row.config_version
      || canonicalOrchestrationHash(parsed.value) !== row.document_sha256
      || Buffer.byteLength(canonicalOrchestrationJson(parsed.value), "utf8") > MAX_CONFIG_BYTES)
      throw Error();
    return Object.freeze({fingerprint: row.config_fingerprint, documentSha256: row.document_sha256,
      checkpointVersion: row.checkpoint_version, document: parsed.value});
  } catch { throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_STORAGE_ERROR"); }
}
function equalJob(row: Job | undefined, wanted: Job): row is Job {
  return !!row && row.tenant_id === wanted.tenant_id && row.job_id === wanted.job_id
    && row.capture_identity_digest === wanted.capture_identity_digest
    && row.verifier_profile_version === wanted.verifier_profile_version
    && row.repository_id === wanted.repository_id && row.service_id === wanted.service_id
    && row.environment === wanted.environment && row.service_root === wanted.service_root
    && row.config_fingerprint === wanted.config_fingerprint
    && row.config_document_sha256 === wanted.config_document_sha256
    && row.config_checkpoint_version === wanted.config_checkpoint_version && row.state === "queued";
}

/** Admits historical capture-byte work only; no verifier execution or D08 promotion occurs here. */
export function createCaptureVerificationAdmissionStore(pool: Pool, options: CaptureVerificationAdmissionOptions): {
  admit(request: {captureIdentityDigest: string}): Promise<CaptureVerificationAdmissionReceipt>} {
  const raw = ownData(options, ["schema", "tenantId", "principalId", "preflightAuthorize", "authorizeCapture"],
    ["maxQueuedPerTenant"]);
  let schema: string;
  try { schema = raw?.schema as string; quoteOrchestrationSchemaIdentifier(schema); }
  catch { throw new CaptureVerificationAdmissionError("INVALID_CAPTURE_ADMISSION_REQUEST"); }
  const maxQueued = raw && Object.hasOwn(raw, "maxQueuedPerTenant") ? raw.maxQueuedPerTenant : DEFAULT_MAX_QUEUED;
  if (!raw || !matches(NAME, raw.tenantId) || !matches(HOST_NAME, raw.principalId)
    || !Number.isSafeInteger(maxQueued) || (maxQueued as number) < 1 || (maxQueued as number) > 1000
    || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.authorizeCapture !== "function" || isProxy(raw.authorizeCapture))
    throw new CaptureVerificationAdmissionError("INVALID_CAPTURE_ADMISSION_REQUEST");
  const context = Object.freeze({tenantId: raw.tenantId, principalId: raw.principalId});
  const preflight = raw.preflightAuthorize as CaptureVerificationAdmissionOptions["preflightAuthorize"];
  const authorize = raw.authorizeCapture as CaptureVerificationAdmissionOptions["authorizeCapture"];
  return Object.freeze({async admit(candidate: {captureIdentityDigest: string}): Promise<CaptureVerificationAdmissionReceipt> {
    const request = ownData(candidate, ["captureIdentityDigest"]);
    if (!request || !matches(DIGEST, request.captureIdentityDigest))
      throw new CaptureVerificationAdmissionError("INVALID_CAPTURE_ADMISSION_REQUEST");
    const identity = request.captureIdentityDigest;
    let permitted = false;
    try { permitted = await preflight(context) === true; } catch { /* Deny. */ }
    if (!permitted) throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_DENIED");
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_STORAGE_ERROR"); }
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, schema);
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`api-truth:capture-admission:${context.tenantId}`]);
      const activeRows = await client.query<Active>(`SELECT configuration.config_fingerprint,
        configuration.config_version,configuration.document_sha256,active.checkpoint_version::text,
        CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document ELSE NULL END AS document
        FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
          ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
        WHERE active.tenant_id=$1 FOR SHARE OF active`, [context.tenantId, MAX_CONFIG_BYTES]);
      if (activeRows.rows.length !== 1)
        throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_DENIED");
      const active = validatedActive(activeRows.rows[0]);
      const parents = await client.query<Parent>(`SELECT tenant_id,capture_identity_digest,repository_id,service_id,
        immutable_revision,source_digest,environment,policy_version,artifact_ref,configured_key_ref,
        receipt_digest,signer_spki_digest FROM orchestration_observed_capture_associations
        WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`, [context.tenantId, identity]);
      const parent = parents.rows[0];
      if (parents.rows.length !== 1 || !validParent(parent, context.tenantId, identity))
        throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_DENIED");
      const repository = active.document.repositories.find(item => item.repository_id === parent.repository_id);
      const service = repository?.services.find(item => item.service_id === parent.service_id);
      const environment = service?.environments.find(item => item.name === parent.environment);
      if (!repository || !service || !environment || !validRoot(service.root))
        throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_DENIED");
      // Catalog grants are preliminary restrictions. Protected capture/source execution is host policy below.
      const scopeIds = [...new Set([repository.access_scope_id, environment.deployment_authority.access_scope_id])]
        .sort(compareUtf8);
      const scopes = await client.query<{access_scope_id: string; active: boolean}>(
        `SELECT access_scope_id,active FROM access_scopes WHERE tenant_id=$1
          AND access_scope_id=ANY($2::text[]) ORDER BY access_scope_id COLLATE "C" FOR SHARE`,
        [context.tenantId, scopeIds]);
      const grants = await client.query<{access_scope_id: string; active: boolean}>(
        `SELECT access_scope_id,active FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2
          AND access_scope_id=ANY($3::text[]) ORDER BY access_scope_id COLLATE "C" FOR SHARE`,
        [context.tenantId, context.principalId, scopeIds]);
      if (scopes.rows.length !== scopeIds.length || grants.rows.length !== scopeIds.length
        || scopeIds.some((id, index) => scopes.rows[index]?.access_scope_id !== id || scopes.rows[index]?.active !== true
          || grants.rows[index]?.access_scope_id !== id || grants.rows[index]?.active !== true))
        throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_DENIED");
      const binding: HostBinding = Object.freeze({tenantId: context.tenantId, principalId: context.principalId,
        captureIdentityDigest: identity, verifierProfileVersion: PROFILE,
        repositoryId: parent.repository_id, serviceId: parent.service_id, environment: parent.environment,
        immutableRevision: parent.immutable_revision, sourceDigest: parent.source_digest, serviceRoot: service.root,
        artifactRef: parent.artifact_ref, configuredKeyRef: parent.configured_key_ref,
        receiptDigest: parent.receipt_digest, signerSpkiDigest: parent.signer_spki_digest,
        configFingerprint: active.fingerprint, configDocumentSha256: active.documentSha256,
        checkpointVersion: active.checkpointVersion});
      try { permitted = await authorize(client, binding) === true; } catch { permitted = false; }
      if (!permitted) throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_DENIED");
      const jobId = canonicalOrchestrationHash({kind: "capture_verification_admission", tenantId: context.tenantId,
        captureIdentityDigest: identity, verifierProfileVersion: PROFILE, serviceRoot: service.root,
        configFingerprint: active.fingerprint, configDocumentSha256: active.documentSha256,
        checkpointVersion: active.checkpointVersion});
      const wanted: Job = {tenant_id: context.tenantId, job_id: jobId, capture_identity_digest: identity,
        verifier_profile_version: PROFILE, repository_id: parent.repository_id, service_id: parent.service_id,
        environment: parent.environment, service_root: service.root, config_fingerprint: active.fingerprint,
        config_document_sha256: active.documentSha256, config_checkpoint_version: active.checkpointVersion,
        state: "queued"};
      const prior = await client.query<Job>(`SELECT tenant_id,job_id,capture_identity_digest,verifier_profile_version,
        repository_id,service_id,environment,service_root,config_fingerprint,config_document_sha256,
        config_checkpoint_version::text,state FROM orchestration_capture_verification_jobs
        WHERE tenant_id=$1 AND job_id=$2 FOR SHARE`, [context.tenantId, jobId]);
      if (prior.rows.length > 0 && !equalJob(prior.rows[0], wanted))
        throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_CONFLICT");
      let outcome: "queued" | "existing" = "existing";
      if (prior.rows.length === 0) {
        const quota = await client.query<{count: string}>(`SELECT count(*)::text AS count
          FROM orchestration_capture_verification_jobs WHERE tenant_id=$1 AND state='queued'`, [context.tenantId]);
        if (quota.rows.length !== 1 || !/^[0-9]+$/.test(quota.rows[0]!.count))
          throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_STORAGE_ERROR");
        if (BigInt(quota.rows[0]!.count) >= BigInt(maxQueued as number))
          throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_QUOTA");
        const inserted = await client.query(`INSERT INTO orchestration_capture_verification_jobs
          (tenant_id,job_id,capture_identity_digest,verifier_profile_version,repository_id,service_id,environment,
           service_root,config_fingerprint,config_document_sha256,config_checkpoint_version,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued')
          ON CONFLICT (tenant_id,job_id) DO NOTHING`,
        [context.tenantId, jobId, identity, PROFILE, parent.repository_id, parent.service_id,parent.environment,
          service.root, active.fingerprint, active.documentSha256, active.checkpointVersion]);
        outcome = inserted.rowCount === 1 ? "queued" : "existing";
      }
      const stored = await client.query<Job>(`SELECT tenant_id,job_id,capture_identity_digest,verifier_profile_version,
        repository_id,service_id,environment,service_root,config_fingerprint,config_document_sha256,
        config_checkpoint_version::text,state FROM orchestration_capture_verification_jobs
        WHERE tenant_id=$1 AND job_id=$2 FOR SHARE`, [context.tenantId, jobId]);
      if (stored.rows.length !== 1 || !equalJob(stored.rows[0], wanted))
        throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_CONFLICT");
      await client.query("COMMIT");
      return Object.freeze({outcome, jobId, captureIdentityDigest: identity, verifierProfileVersion: PROFILE,
        serviceRoot: service.root, configFingerprint: active.fingerprint,
        configDocumentSha256: active.documentSha256, checkpointVersion: active.checkpointVersion});
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CaptureVerificationAdmissionError) throw error;
      throw new CaptureVerificationAdmissionError("CAPTURE_ADMISSION_STORAGE_ERROR");
    } finally { client.release(); }
  }});
}
