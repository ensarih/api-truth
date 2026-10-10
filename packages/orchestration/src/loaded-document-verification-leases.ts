import {createHash, randomBytes} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash, canonicalOrchestrationJson, compareUtf8} from "./canonical.js";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "swagger-loaded-document-1" as const;
const CAPTURE_PROFILE = "protected-handler-bytes-1" as const;
const POLICY = "runtime-capture-pin-1";
const CAPABILITY = "swagger.document.verify.execute" as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const PRINCIPAL = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const REVISION = /^[A-Fa-f0-9]{12,128}$/;
const FINGERPRINT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY_REF = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CONFIG_BYTES = 1_000_000;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const WINDOW = 32;
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

const NAME_ARRAY_MAX = 50;

export type LoadedDocumentVerificationLeaseBinding = Readonly<{tenantId: string; principalId: string; workerId: string;
  instanceId: string; capability: typeof CAPABILITY; jobId: string; loadIdentityDigest: string; captureIdentityDigest: string;
  verifierProfileVersion: typeof PROFILE; repositoryId: string; serviceId: string; environment: string;
  serviceRoot: string; immutableRevision: string; sourceDigest: string; loadArtifactRef: string;
  loadConfiguredKeyRef: string; loadEnvelopeDigest: string; loadSignerSpkiDigest: string;
  configFingerprint: string; configDocumentSha256: string; checkpointVersion: string}>;
export type LoadedDocumentVerificationLeaseOptions = {schema: string; tenantId: string; principalId: string;
  workerId: string; instanceId: string; allowedRepositories: readonly string[]; allowedServices: readonly string[];
  preflightAuthorize(context: Readonly<{tenantId: string; principalId: string; workerId: string; instanceId: string;
    capability: typeof CAPABILITY}>): Promise<boolean>;
  /** DB-local host policy locks source/environment and load-artifact execution permission for this exact epoch. */
  authorizeLoadedDocument(client: PoolClient, binding: LoadedDocumentVerificationLeaseBinding): Promise<boolean>};
export type LoadedDocumentVerificationLease = Readonly<{kind: "leased"; jobId: string; loadIdentityDigest: string;
  captureIdentityDigest: string; leaseToken: string; leaseExpiresAt: string; attemptCount: number;
  configFingerprint: string; configDocumentSha256: string; checkpointVersion: string;
  binding: LoadedDocumentVerificationLeaseBinding}>;
export type LoadedDocumentVerificationNoWork = Readonly<{kind: "no_work"; coverage: "partial"; windowLimited: boolean}>;

const MESSAGES = {INVALID_LOADED_DOCUMENT_LEASE_REQUEST: "Invalid loaded-document lease request",
  LOADED_DOCUMENT_LEASE_UNAUTHORIZED: "Loaded-document lease unauthorized",
  LOADED_DOCUMENT_LEASE_CONFLICT: "Loaded-document lease conflict",
  LOADED_DOCUMENT_LEASE_STORAGE_ERROR: "Loaded-document lease storage error"} as const;
export class LoadedDocumentVerificationLeaseError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) {super(MESSAGES[code]); this.code = code;}
}
function ownData(value: unknown, required: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== required.length || required.some(key => !Object.hasOwn(descriptors, key))
      || keys.some(key => typeof key !== "string" || !required.includes(key))) return undefined;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of required) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {return undefined;}
}
function safeNames(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > NAME_ARRAY_MAX) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== length + 1) return undefined;
    const output: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !matches(NAME, descriptor.value)) return undefined;
      output.push(descriptor.value);
    }
    if (new Set(output).size !== output.length) return undefined;
    return output.sort(compareUtf8);
  } catch {return undefined;}
}
function validRoot(value: unknown): value is string {
  return matches(ROOT, value) && value.length <= 1024
    && (value === "." || value.split("/").every(part => part !== "." && part !== ".."));
}
type ActiveRow = {config_fingerprint: string; config_version: string; document_sha256: string; checkpoint_version: string; document: unknown};
type Parent = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string; artifact_ref: string;
  configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
type ByteParent = {tenant_id: string; capture_identity_digest: string; verifier_profile_version: string; service_root: string;
  source_digest: string; receipt_digest: string; signer_spki_digest: string; result_digest: string; handler_count: number};
type Job = {tenant_id: string; job_id: string; load_identity_digest: string; capture_identity_digest: string;
  parent_verifier_profile_version: string; verifier_profile_version: string; repository_id: string; service_id: string;
  environment: string; immutable_revision: string; source_digest: string; service_root: string; load_artifact_ref: string;
  load_configured_key_ref: string; load_envelope_digest: string; load_signer_spki_digest: string; config_fingerprint: string;
  config_document_sha256: string; config_checkpoint_version: string; admitted_at: Date; state: string};
type State = {state: string; attempt_count: number; lease_worker_id: string | null; lease_instance_id: string | null;
  lease_token_hash: string | null; lease_expires_at: Date | null; lease_expired: boolean | null};
function validatedActive(row: ActiveRow | undefined) {
  if (!row || !matches(FINGERPRINT, row.config_fingerprint) || !matches(DIGEST, row.document_sha256)
    || !/^[1-9][0-9]{0,18}$/.test(row.checkpoint_version))
    throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");
  try {
    const parsed = parseConfig(row.document);
    if (!parsed.ok || parsed.value.config_version !== row.config_version
      || canonicalOrchestrationHash(parsed.value) !== row.document_sha256
      || Buffer.byteLength(canonicalOrchestrationJson(parsed.value), "utf8") > MAX_CONFIG_BYTES) throw Error();
    return Object.freeze({fingerprint: row.config_fingerprint, documentSha256: row.document_sha256,
      checkpointVersion: row.checkpoint_version, document: parsed.value});
  } catch {throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");}
}
function validJob(row: Job | undefined, tenantId: string, active: ReturnType<typeof validatedActive>, parent: Parent): row is Job {
  if (!row || row.tenant_id !== tenantId || row.capture_identity_digest !== parent.capture_identity_digest
    || row.parent_verifier_profile_version !== CAPTURE_PROFILE || row.verifier_profile_version !== PROFILE
    || row.repository_id !== parent.repository_id || row.service_id !== parent.service_id
    || row.environment !== parent.environment || row.immutable_revision !== parent.immutable_revision
    || row.source_digest !== parent.source_digest || !validRoot(row.service_root)
    || !matches(ARTIFACT, row.load_artifact_ref) || !matches(KEY_REF, row.load_configured_key_ref)
    || !matches(DIGEST, row.load_envelope_digest) || !matches(DIGEST, row.load_signer_spki_digest)
    || !matches(DIGEST, row.load_identity_digest) || row.config_fingerprint !== active.fingerprint
    || row.config_document_sha256 !== active.documentSha256 || row.config_checkpoint_version !== active.checkpointVersion) return false;
  const scope: ObservedCaptureScope = {tenantId, repositoryId: row.repository_id, serviceId: row.service_id,
    immutableRevision: row.immutable_revision, sourceDigest: row.source_digest, environment: row.environment};
  const expectedLoadIdentity = hash(canonicalOrchestrationJson({profileVersion: PROFILE, scope,
    captureIdentityDigest: row.capture_identity_digest, loadArtifactRef: row.load_artifact_ref,
    loadConfiguredKeyRef: row.load_configured_key_ref, loadEnvelopeDigest: row.load_envelope_digest,
    loadSignerSpkiDigest: row.load_signer_spki_digest}));
  if (expectedLoadIdentity !== row.load_identity_digest) return false;
  const repository = active.document.repositories.find(item => item.repository_id === row.repository_id);
  const service = repository?.services.find(item => item.service_id === row.service_id);
  const environment = service?.environments.find(item => item.name === row.environment);
  if (!repository || !service || !environment || service.root !== row.service_root) return false;
  const expectedJob = canonicalOrchestrationHash({kind: "loaded_document_verification_admission", tenantId,
    loadIdentityDigest: row.load_identity_digest, verifierProfileVersion: PROFILE, serviceRoot: row.service_root,
    configFingerprint: row.config_fingerprint, configDocumentSha256: row.config_document_sha256,
    checkpointVersion: row.config_checkpoint_version});
  return expectedJob === row.job_id;
}
function validParent(row: Parent | undefined, tenantId: string, identity: string): row is Parent {
  if (!row || row.tenant_id !== tenantId || row.capture_identity_digest !== identity
    || !matches(NAME, row.repository_id) || !matches(NAME, row.service_id) || !matches(NAME, row.environment)
    || !matches(REVISION, row.immutable_revision) || !matches(DIGEST, row.source_digest) || row.policy_version !== POLICY
    || !matches(ARTIFACT, row.artifact_ref) || !matches(KEY_REF, row.configured_key_ref)
    || !matches(DIGEST, row.receipt_digest) || !matches(DIGEST, row.signer_spki_digest)) return false;
  const scope: ObservedCaptureScope = {tenantId, repositoryId: row.repository_id, serviceId: row.service_id,
    immutableRevision: row.immutable_revision, sourceDigest: row.source_digest, environment: row.environment};
  return canonicalOrchestrationHash({policyVersion: POLICY, scope, artifactRef: row.artifact_ref,
    configuredKeyRef: row.configured_key_ref, receiptDigest: row.receipt_digest,
    signerSpkiDigest: row.signer_spki_digest}) === identity;
}
function validByteParent(row: ByteParent | undefined, job: Job, parent: Parent): row is ByteParent {
  return !!row && row.tenant_id === job.tenant_id && row.capture_identity_digest === job.capture_identity_digest
    && row.verifier_profile_version === CAPTURE_PROFILE && row.service_root === job.service_root
    && row.source_digest === job.source_digest && row.receipt_digest === parent.receipt_digest
    && row.signer_spki_digest === parent.signer_spki_digest && matches(DIGEST, row.result_digest)
    && Number.isInteger(row.handler_count) && row.handler_count >= 1 && row.handler_count <= 1024;
}
const JOB_COLUMNS = `job.tenant_id,job.job_id,job.load_identity_digest,job.capture_identity_digest,
  job.parent_verifier_profile_version,job.verifier_profile_version,job.repository_id,job.service_id,job.environment,
  job.immutable_revision,job.source_digest,job.service_root,job.load_artifact_ref,job.load_configured_key_ref,
  job.load_envelope_digest,job.load_signer_spki_digest,job.config_fingerprint,job.config_document_sha256,
  job.config_checkpoint_version::text,job.admitted_at,state.state`;
const PARENT_COLUMNS = `tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,
  environment,policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest`;

/** Claim/renew a loaded-document verification job only; no artifact reads or summary/catalog writes. */
export function createLoadedDocumentVerificationLeaseStore(pool: Pool, options: LoadedDocumentVerificationLeaseOptions): {
  claimOne(): Promise<LoadedDocumentVerificationLease | LoadedDocumentVerificationNoWork>;
  heartbeat(request: {jobId: string; leaseToken: string}): Promise<LoadedDocumentVerificationLease>} {
  const OPTION_KEYS = ["schema", "tenantId", "principalId", "workerId", "instanceId", "allowedRepositories",
    "allowedServices", "preflightAuthorize", "authorizeLoadedDocument"] as const;
  const raw = ownData(options, OPTION_KEYS);
  let schema: string;
  try {if (typeof raw?.schema !== "string") throw Error(); schema = raw.schema; quoteOrchestrationSchemaIdentifier(schema);}
  catch {throw new LoadedDocumentVerificationLeaseError("INVALID_LOADED_DOCUMENT_LEASE_REQUEST");}
  const repositories = safeNames(raw?.allowedRepositories), services = safeNames(raw?.allowedServices);
  if (!raw || !matches(NAME, raw.tenantId) || !matches(PRINCIPAL, raw.principalId)
    || !matches(NAME, raw.workerId) || !matches(NAME, raw.instanceId) || !repositories || !services
    || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.authorizeLoadedDocument !== "function" || isProxy(raw.authorizeLoadedDocument))
    throw new LoadedDocumentVerificationLeaseError("INVALID_LOADED_DOCUMENT_LEASE_REQUEST");
  const boundSchema = schema, tenantId = raw.tenantId as string, principalId = raw.principalId as string;
  const workerId = raw.workerId as string, instanceId = raw.instanceId as string;
  const context = Object.freeze({tenantId, principalId, workerId, instanceId, capability: CAPABILITY});
  const preflight = raw.preflightAuthorize as LoadedDocumentVerificationLeaseOptions["preflightAuthorize"];
  const authorize = raw.authorizeLoadedDocument as LoadedDocumentVerificationLeaseOptions["authorizeLoadedDocument"];
  const denied = (windowLimited: boolean): LoadedDocumentVerificationNoWork => Object.freeze({kind: "no_work",
    coverage: "partial", windowLimited});
  const requirePreflight = async () => {
    let allowed = false;
    try {allowed = await preflight(context) === true;} catch { /* Deny. */ }
    if (!allowed) throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_UNAUTHORIZED");
  };
  const transaction = async <T>(run: (client: PoolClient) => Promise<T>): Promise<T> => {
    let client: PoolClient;
    try {client = await pool.connect();} catch {throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");}
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, boundSchema);
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`api-truth:loaded-document-admission:${tenantId}`]);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isProxy(error) && error instanceof LoadedDocumentVerificationLeaseError) throw error;
      throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");
    } finally {client.release();}
  };
  const activeIn = async (client: PoolClient) => {
    const result = await client.query<ActiveRow>(`SELECT configuration.config_fingerprint,configuration.config_version,
      configuration.document_sha256,active.checkpoint_version::text,
      CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document ELSE NULL END AS document
      FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
        ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
      WHERE active.tenant_id=$1 FOR SHARE OF active`, [tenantId, MAX_CONFIG_BYTES]);
    return result.rows.length === 1 ? validatedActive(result.rows[0]) : undefined;
  };
  const parentFor = async (client: PoolClient, identity: string) => {
    const result = await client.query<Parent>(`SELECT ${PARENT_COLUMNS} FROM orchestration_observed_capture_associations
      WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`, [tenantId, identity]);
    const parent = result.rows[0];
    if (result.rows.length !== 1 || !validParent(parent, tenantId, identity))
      throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");
    return parent;
  };
  const jobFor = async (client: PoolClient, jobId: string, lock = false) => {
    const result = await client.query<Job>(`SELECT ${JOB_COLUMNS} FROM orchestration_loaded_document_verification_jobs job
      JOIN orchestration_loaded_document_verification_job_state state USING(tenant_id,job_id)
      WHERE job.tenant_id=$1 AND job.job_id=$2 ${lock ? "FOR SHARE OF job" : ""}`, [tenantId, jobId]);
    return result.rows.length === 1 ? result.rows[0] : undefined;
  };
  const authorizeJob = async (client: PoolClient, active: ReturnType<typeof validatedActive>, job: Job) => {
    const repository = active.document.repositories.find(item => item.repository_id === job.repository_id);
    const service = repository?.services.find(item => item.service_id === job.service_id);
    const environment = service?.environments.find(item => item.name === job.environment);
    if (!repository || !service || !environment || service.root !== job.service_root) return false;
    const scopeIds = [...new Set([repository.access_scope_id, environment.deployment_authority.access_scope_id])].sort(compareUtf8);
    const scopes = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active FROM access_scopes
      WHERE tenant_id=$1 AND access_scope_id=ANY($2::text[]) ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [tenantId, scopeIds]);
    const grants = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
      FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=ANY($3::text[])
      ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [tenantId, principalId, scopeIds]);
    if (scopes.rows.length !== scopeIds.length || grants.rows.length !== scopeIds.length
      || scopeIds.some((id, index) => scopes.rows[index]?.access_scope_id !== id || scopes.rows[index]?.active !== true
        || grants.rows[index]?.access_scope_id !== id || grants.rows[index]?.active !== true)) return false;
    const binding: LoadedDocumentVerificationLeaseBinding = Object.freeze({tenantId, principalId, workerId, instanceId,
      capability: CAPABILITY, jobId: job.job_id, loadIdentityDigest: job.load_identity_digest,
      captureIdentityDigest: job.capture_identity_digest, verifierProfileVersion: PROFILE,
      repositoryId: job.repository_id, serviceId: job.service_id, environment: job.environment,
      serviceRoot: job.service_root, immutableRevision: job.immutable_revision, sourceDigest: job.source_digest,
      loadArtifactRef: job.load_artifact_ref, loadConfiguredKeyRef: job.load_configured_key_ref,
      loadEnvelopeDigest: job.load_envelope_digest, loadSignerSpkiDigest: job.load_signer_spki_digest,
      configFingerprint: active.fingerprint, configDocumentSha256: active.documentSha256,
      checkpointVersion: active.checkpointVersion});
    try {return await authorize(client, binding) === true;} catch {return false;}
  };
  const verifyParents = async (client: PoolClient, active: ReturnType<typeof validatedActive>, job: Job) => {
    const parent = await parentFor(client, job.capture_identity_digest);
    if (!validJob(job, tenantId, active, parent) || !repositories.includes(job.repository_id) || !services.includes(job.service_id))
      throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_UNAUTHORIZED");
    const result = await client.query<ByteParent>(`SELECT tenant_id,capture_identity_digest,verifier_profile_version,
      service_root,source_digest,receipt_digest,signer_spki_digest,result_digest,handler_count
      FROM orchestration_observed_capture_verifications WHERE tenant_id=$1 AND capture_identity_digest=$2
        AND verifier_profile_version=$3 FOR SHARE`, [tenantId, job.capture_identity_digest, CAPTURE_PROFILE]);
    const bytes = result.rows[0];
    if (result.rows.length !== 1 || !validByteParent(bytes, job, parent))
      throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_UNAUTHORIZED");
    return parent;
  };
  const leaseResult = (job: Job, token: string, expires: Date, attempts: number): LoadedDocumentVerificationLease =>
    Object.freeze({kind: "leased", jobId: job.job_id, loadIdentityDigest: job.load_identity_digest,
      captureIdentityDigest: job.capture_identity_digest, leaseToken: token, leaseExpiresAt: expires.toISOString(),
      attemptCount: attempts, configFingerprint: job.config_fingerprint,
      configDocumentSha256: job.config_document_sha256, checkpointVersion: job.config_checkpoint_version,
      binding: Object.freeze({tenantId, principalId, workerId, instanceId, capability: CAPABILITY,
        jobId: job.job_id, loadIdentityDigest: job.load_identity_digest, captureIdentityDigest: job.capture_identity_digest,
        verifierProfileVersion: PROFILE, repositoryId: job.repository_id, serviceId: job.service_id,
        environment: job.environment, serviceRoot: job.service_root, immutableRevision: job.immutable_revision,
        sourceDigest: job.source_digest, loadArtifactRef: job.load_artifact_ref,
        loadConfiguredKeyRef: job.load_configured_key_ref, loadEnvelopeDigest: job.load_envelope_digest,
        loadSignerSpkiDigest: job.load_signer_spki_digest, configFingerprint: job.config_fingerprint,
        configDocumentSha256: job.config_document_sha256, checkpointVersion: job.config_checkpoint_version})});
  return Object.freeze({async claimOne(): Promise<LoadedDocumentVerificationLease | LoadedDocumentVerificationNoWork> {
    await requirePreflight();
    return transaction(async client => {
      const active = await activeIn(client);
      if (!active) return denied(false);
      const capacity = await client.query<{count: string}>(`SELECT count(*)::text AS count
        FROM orchestration_loaded_document_verification_job_state
        WHERE tenant_id=$1 AND state='leased' AND lease_expires_at>clock_timestamp()`, [tenantId]);
      if (capacity.rows.length !== 1 || !/^[0-9]+$/.test(capacity.rows[0]!.count))
        throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");
      if (Number(capacity.rows[0]!.count) >= 2) return denied(true);
      const candidates = await client.query<Job>(`SELECT ${JOB_COLUMNS}
        FROM orchestration_loaded_document_verification_jobs job
        JOIN orchestration_loaded_document_verification_job_state state USING(tenant_id,job_id)
        WHERE job.tenant_id=$1 AND job.repository_id=ANY($2::text[]) AND job.service_id=ANY($3::text[])
          AND job.config_fingerprint=$4 AND job.config_document_sha256=$5 AND job.config_checkpoint_version=$6
          AND state.available_at<=clock_timestamp()
          AND (state.state='queued' OR state.state='leased' AND state.lease_expires_at<=clock_timestamp())
        ORDER BY job.admitted_at,job.job_id LIMIT ${WINDOW}`,
      [tenantId, repositories, services, active.fingerprint, active.documentSha256, active.checkpointVersion]);
      for (const job of candidates.rows) {
        const parent = await verifyParents(client, active, job);
        if (!await authorizeJob(client, active, job)) continue;
        const locked = await client.query<State>(`SELECT state,attempt_count,lease_worker_id,lease_instance_id,
          lease_token_hash,lease_expires_at,lease_expires_at<=clock_timestamp() AS lease_expired
          FROM orchestration_loaded_document_verification_job_state WHERE tenant_id=$1 AND job_id=$2
          FOR UPDATE SKIP LOCKED`, [tenantId, job.job_id]);
        const state = locked.rows[0];
        if (locked.rows.length !== 1 || !state) continue;
        const ready = state.state === "queued" || state.state === "leased" && state.lease_expired === true;
        if (!ready) continue;
        if (state.attempt_count >= MAX_ATTEMPTS) {
          if (state.state !== "leased") throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");
          await client.query(`UPDATE orchestration_loaded_document_verification_job_state
            SET state='failed',lease_worker_id=NULL,lease_instance_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
              safe_error_code='LOADED_DOCUMENT_LEASE_EXHAUSTED',row_version=row_version+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND job_id=$2`, [tenantId, job.job_id]);
          continue;
        }
        const serviceCapacity = await client.query<{count: string}>(`SELECT count(*)::text AS count
          FROM orchestration_loaded_document_verification_job_state state
          JOIN orchestration_loaded_document_verification_jobs leased USING(tenant_id,job_id)
          WHERE state.tenant_id=$1 AND leased.repository_id=$2 AND leased.service_id=$3 AND leased.environment=$4
            AND state.state='leased' AND state.lease_expires_at>clock_timestamp()`,
        [tenantId, job.repository_id, job.service_id, job.environment]);
        if (serviceCapacity.rows.length !== 1 || !/^[0-9]+$/.test(serviceCapacity.rows[0]!.count))
          throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_STORAGE_ERROR");
        if (Number(serviceCapacity.rows[0]!.count) >= 1) continue;
        const token = randomBytes(32).toString("hex");
        const updated = await client.query<{lease_expires_at: Date; attempt_count: number}>(`UPDATE
          orchestration_loaded_document_verification_job_state
          SET state='leased',attempt_count=attempt_count+1,lease_worker_id=$3,lease_instance_id=$4,lease_token_hash=$5,
            lease_expires_at=clock_timestamp()+($6::integer * interval '1 millisecond'),safe_error_code=NULL,
            row_version=row_version+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND job_id=$2 AND attempt_count<$7
            AND (state='queued' OR state='leased' AND lease_expires_at<=clock_timestamp())
          RETURNING lease_expires_at,attempt_count`,
        [tenantId, job.job_id, workerId, instanceId, hash(token), LEASE_MS, MAX_ATTEMPTS]);
        if (updated.rows.length !== 1 || !(updated.rows[0]!.lease_expires_at instanceof Date)) continue;
        const attemptInsert = await client.query(`INSERT INTO orchestration_loaded_document_verification_lease_attempts
          (tenant_id,job_id,attempt_no,worker_id,instance_id,initial_lease_expires_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,job_id,attempt_no) DO NOTHING`,
        [tenantId, job.job_id, updated.rows[0]!.attempt_count, workerId, instanceId, updated.rows[0]!.lease_expires_at]);
        if (attemptInsert.rowCount !== 1) throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_CONFLICT");
        return leaseResult(job, token, updated.rows[0]!.lease_expires_at, updated.rows[0]!.attempt_count);
      }
      return denied(candidates.rows.length >= WINDOW);
    });
  }, async heartbeat(candidate: {jobId: string; leaseToken: string}): Promise<LoadedDocumentVerificationLease> {
    const request = ownData(candidate, ["jobId", "leaseToken"]);
    if (!request || !matches(DIGEST, request.jobId) || !matches(TOKEN, request.leaseToken))
      throw new LoadedDocumentVerificationLeaseError("INVALID_LOADED_DOCUMENT_LEASE_REQUEST");
    const jobId = request.jobId as string, token = request.leaseToken as string;
    await requirePreflight();
    return transaction(async client => {
      const active = await activeIn(client), job = await jobFor(client, jobId, true);
      if (!active || !job || !repositories.includes(job.repository_id) || !services.includes(job.service_id)
        || job.config_fingerprint !== active.fingerprint || job.config_document_sha256 !== active.documentSha256
        || job.config_checkpoint_version !== active.checkpointVersion)
        throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_UNAUTHORIZED");
      const parent = await verifyParents(client, active, job);
      if (!await authorizeJob(client, active, job)) throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_UNAUTHORIZED");
      const locked = await client.query<State>(`SELECT state,attempt_count,lease_worker_id,lease_instance_id,
        lease_token_hash,lease_expires_at,lease_expires_at<=clock_timestamp() AS lease_expired
        FROM orchestration_loaded_document_verification_job_state WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`,
      [tenantId, job.job_id]);
      const state = locked.rows[0];
      if (locked.rows.length !== 1 || !state || state.state !== "leased" || state.lease_worker_id !== workerId
        || state.lease_instance_id !== instanceId || state.lease_token_hash !== hash(token)
        || !(state.lease_expires_at instanceof Date) || state.lease_expired !== false)
        throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_CONFLICT");
      const renewed = await client.query<{lease_expires_at: Date}>(`UPDATE orchestration_loaded_document_verification_job_state
        SET lease_expires_at=clock_timestamp()+($3::integer * interval '1 millisecond'),
          row_version=row_version+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_expires_at>clock_timestamp()
          AND lease_worker_id=$4 AND lease_instance_id=$5 AND lease_token_hash=$6 RETURNING lease_expires_at`,
      [tenantId, job.job_id, LEASE_MS, workerId, instanceId, hash(token)]);
      if (renewed.rows.length !== 1 || !(renewed.rows[0]!.lease_expires_at instanceof Date))
        throw new LoadedDocumentVerificationLeaseError("LOADED_DOCUMENT_LEASE_CONFLICT");
      return leaseResult(job, token, renewed.rows[0]!.lease_expires_at, state.attempt_count);
    });
  }});
}
