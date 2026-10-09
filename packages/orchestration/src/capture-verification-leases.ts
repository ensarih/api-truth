import {createHash, randomBytes} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash, canonicalOrchestrationJson, compareUtf8} from "./canonical.js";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "protected-handler-bytes-1";
const POLICY = "runtime-capture-pin-1";
const CAPABILITY = "capture.verify.execute";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const HOST_NAME = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const FINGERPRINT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const REVISION = /^[a-fA-F0-9]{12,128}$/;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_CONFIG_BYTES = 1_000_000;
const LEASE_MS = 30_000;
const WINDOW = 32;
const MAX_ATTEMPTS = 3;
const hash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

type Parent = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string;
  artifact_ref: string; configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
type Active = {config_fingerprint: string; config_version: string; document_sha256: string;
  checkpoint_version: string; document: unknown};
type Admission = {tenant_id: string; job_id: string; capture_identity_digest: string; verifier_profile_version: string;
  repository_id: string; service_id: string; environment: string; service_root: string;
  config_fingerprint: string; config_document_sha256: string; config_checkpoint_version: string;
  state: string};
type State = {state: string; attempt_count: number; lease_worker_id: string | null;
  lease_instance_id: string | null; lease_token_hash: string | null; lease_expires_at: Date | null;
  lease_expired: boolean | null};
type Binding = Readonly<{tenantId: string; principalId: string; workerId: string; instanceId: string;
  capability: typeof CAPABILITY; captureIdentityDigest: string; verifierProfileVersion: typeof PROFILE;
  repositoryId: string; serviceId: string; environment: string; serviceRoot: string;
  immutableRevision: string; sourceDigest: string; artifactRef: string; configuredKeyRef: string;
  receiptDigest: string; signerSpkiDigest: string; configFingerprint: string;
  configDocumentSha256: string; checkpointVersion: string}>;
export type CaptureVerificationLeaseOptions = {schema: string; tenantId: string; principalId: string;
  workerId: string; instanceId: string; allowedRepositories: readonly string[]; allowedServices: readonly string[];
  /** Host checks a distinct capture.verify.execute capability BEFORE database access. */
  preflightAuthorize(context: Readonly<{tenantId: string; principalId: string; workerId: string;
    instanceId: string; capability: typeof CAPABILITY}>): Promise<boolean>;
  /** DB-local, bounded permission check: lock independent source/environment/capture execution grants
   * against the exact active configuration SHA/epoch. No external I/O in this transaction. */
  authorizeCapture(client: PoolClient, binding: Binding): Promise<boolean>};
export type CaptureVerificationLease = Readonly<{kind: "leased"; jobId: string; captureIdentityDigest: string;
  leaseToken: string; leaseExpiresAt: string; attemptCount: number; configFingerprint: string;
  configDocumentSha256: string; checkpointVersion: string}>;
export type CaptureVerificationNoWork = Readonly<{kind: "no_work"; coverage: "partial"; windowLimited: boolean}>;
const MESSAGES = {INVALID_CAPTURE_LEASE_REQUEST: "Invalid capture lease request",
  CAPTURE_LEASE_UNAUTHORIZED: "Capture lease unauthorized",
  CAPTURE_LEASE_CONFLICT: "Capture lease conflict",
  CAPTURE_LEASE_STORAGE_ERROR: "Capture lease storage error"} as const;
export class CaptureVerificationLeaseError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.code = code; }
}
function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const names = Reflect.ownKeys(value);
    if (names.length !== keys.length || keys.some(key => !names.includes(key))) return undefined;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return undefined; }
}
function safeNames(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > 50) return undefined;
    const names = Reflect.ownKeys(value);
    if (names.length !== length + 1) return undefined;
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !matches(NAME, descriptor.value)) return undefined;
      result.push(descriptor.value);
    }
    if (new Set(result).size !== result.length) return undefined;
    return result.sort(compareUtf8);
  } catch { return undefined; }
}
const validRoot = (value: unknown): value is string => matches(ROOT, value) && value.length <= 1024
  && (value === "." || value.split("/").every(part => part !== "." && part !== ".."));
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
  if (!row || !matches(FINGERPRINT, row.config_fingerprint) || !matches(DIGEST, row.document_sha256)
    || !/^[1-9][0-9]{0,18}$/.test(row.checkpoint_version))
    throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
  try {
    const parsed = parseConfig(row.document);
    if (!parsed.ok || parsed.value.config_version !== row.config_version
      || canonicalOrchestrationHash(parsed.value) !== row.document_sha256
      || Buffer.byteLength(canonicalOrchestrationJson(parsed.value), "utf8") > MAX_CONFIG_BYTES) throw Error();
    return Object.freeze({fingerprint: row.config_fingerprint, documentSha256: row.document_sha256,
      checkpointVersion: row.checkpoint_version, document: parsed.value});
  } catch { throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR"); }
}
function validAdmission(job: Admission | undefined, tenantId: string, active: ReturnType<typeof validatedActive>, parent: Parent): job is Admission {
  if (!job || job.tenant_id !== tenantId || job.capture_identity_digest !== parent.capture_identity_digest
    || job.verifier_profile_version !== PROFILE || job.state !== "queued"
    || job.repository_id !== parent.repository_id || job.service_id !== parent.service_id
    || job.environment !== parent.environment || !validRoot(job.service_root)
    || job.config_fingerprint !== active.fingerprint || job.config_document_sha256 !== active.documentSha256
    || job.config_checkpoint_version !== active.checkpointVersion) return false;
  const repository = active.document.repositories.find(item => item.repository_id === job.repository_id);
  const service = repository?.services.find(item => item.service_id === job.service_id);
  if (!service || service.root !== job.service_root
    || !service.environments.some(item => item.name === job.environment)) return false;
  return canonicalOrchestrationHash({kind: "capture_verification_admission", tenantId,
    captureIdentityDigest: job.capture_identity_digest, verifierProfileVersion: PROFILE,
    serviceRoot: job.service_root, configFingerprint: job.config_fingerprint,
    configDocumentSha256: job.config_document_sha256,
    checkpointVersion: job.config_checkpoint_version}) === job.job_id;
}
const JOB_COLUMNS = `job.tenant_id,job.job_id,job.capture_identity_digest,job.verifier_profile_version,
  job.repository_id,job.service_id,job.environment,job.service_root,job.config_fingerprint,
  job.config_document_sha256,job.config_checkpoint_version::text,job.state`;
const PARENT_COLUMNS = `tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,
  source_digest,environment,policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest`;

/** Only claim and heartbeat. It neither executes a verifier nor writes 0007 or D08 state. */
export function createCaptureVerificationLeaseStore(pool: Pool, options: CaptureVerificationLeaseOptions): {
  claimOne(): Promise<CaptureVerificationLease | CaptureVerificationNoWork>;
  heartbeat(request: {jobId: string; leaseToken: string}): Promise<CaptureVerificationLease>} {
  const raw = ownData(options, ["schema", "tenantId", "principalId", "workerId", "instanceId",
    "allowedRepositories", "allowedServices", "preflightAuthorize", "authorizeCapture"]);
  let schema: string;
  try { schema = raw?.schema as string; quoteOrchestrationSchemaIdentifier(schema); }
  catch { throw new CaptureVerificationLeaseError("INVALID_CAPTURE_LEASE_REQUEST"); }
  const repositories = safeNames(raw?.allowedRepositories), services = safeNames(raw?.allowedServices);
  if (!raw || !matches(NAME, raw.tenantId) || !matches(HOST_NAME, raw.principalId)
    || !matches(NAME, raw.workerId) || !matches(NAME, raw.instanceId) || !repositories || !services
    || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.authorizeCapture !== "function" || isProxy(raw.authorizeCapture))
    throw new CaptureVerificationLeaseError("INVALID_CAPTURE_LEASE_REQUEST");
  const context = Object.freeze({tenantId: raw.tenantId, principalId: raw.principalId,
    workerId: raw.workerId, instanceId: raw.instanceId, capability: CAPABILITY as typeof CAPABILITY});
  const preflight = raw.preflightAuthorize as CaptureVerificationLeaseOptions["preflightAuthorize"];
  const authorize = raw.authorizeCapture as CaptureVerificationLeaseOptions["authorizeCapture"];
  const noWork = (windowLimited: boolean): CaptureVerificationNoWork => Object.freeze({kind: "no_work", coverage: "partial", windowLimited});
  const requirePreflight = async () => {
    let allowed = false;
    try { allowed = await preflight(context) === true; } catch { /* Deny. */ }
    if (!allowed) throw new CaptureVerificationLeaseError("CAPTURE_LEASE_UNAUTHORIZED");
  };
  const transaction = async <T>(run: (client: PoolClient) => Promise<T>): Promise<T> => {
    let client: PoolClient;
    try { client = await pool.connect(); } catch { throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR"); }
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, schema);
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`api-truth:capture-admission:${context.tenantId}`]);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CaptureVerificationLeaseError) throw error;
      throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
    } finally { client.release(); }
  };
  const activeIn = async (client: PoolClient) => {
    const result = await client.query<Active>(`SELECT configuration.config_fingerprint,configuration.config_version,
      configuration.document_sha256,active.checkpoint_version::text,
      CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document ELSE NULL END AS document
      FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
        ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
      WHERE active.tenant_id=$1 FOR SHARE OF active`, [context.tenantId, MAX_CONFIG_BYTES]);
    return result.rows.length === 1 ? validatedActive(result.rows[0]) : undefined;
  };
  const parentFor = async (client: PoolClient, identity: string) => {
    const result = await client.query<Parent>(`SELECT ${PARENT_COLUMNS}
      FROM orchestration_observed_capture_associations
      WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`, [context.tenantId, identity]);
    const parent = result.rows[0];
    if (result.rows.length !== 1 || !validParent(parent, context.tenantId, identity))
      throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
    return parent;
  };
  const permitted = async (client: PoolClient, active: ReturnType<typeof validatedActive>, job: Admission, parent: Parent) => {
    const repository = active.document.repositories.find(item => item.repository_id === job.repository_id)!;
    const environment = repository.services.find(item => item.service_id === job.service_id)!
      .environments.find(item => item.name === job.environment)!;
    const scopeIds = [...new Set([repository.access_scope_id, environment.deployment_authority.access_scope_id])].sort(compareUtf8);
    const scopes = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
      FROM access_scopes WHERE tenant_id=$1 AND access_scope_id=ANY($2::text[])
      ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [context.tenantId, scopeIds]);
    const grants = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
      FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=ANY($3::text[])
      ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [context.tenantId, context.principalId, scopeIds]);
    if (scopes.rows.length !== scopeIds.length || grants.rows.length !== scopeIds.length
      || scopeIds.some((id, index) => scopes.rows[index]?.access_scope_id !== id || scopes.rows[index]?.active !== true
        || grants.rows[index]?.access_scope_id !== id || grants.rows[index]?.active !== true)) return false;
    const binding: Binding = Object.freeze({tenantId: context.tenantId, principalId: context.principalId,
      workerId: context.workerId, instanceId: context.instanceId, capability: CAPABILITY,
      captureIdentityDigest: job.capture_identity_digest, verifierProfileVersion: PROFILE,
      repositoryId: parent.repository_id, serviceId: parent.service_id, environment: parent.environment,
      serviceRoot: job.service_root, immutableRevision: parent.immutable_revision, sourceDigest: parent.source_digest,
      artifactRef: parent.artifact_ref, configuredKeyRef: parent.configured_key_ref,
      receiptDigest: parent.receipt_digest, signerSpkiDigest: parent.signer_spki_digest,
      configFingerprint: active.fingerprint, configDocumentSha256: active.documentSha256,
      checkpointVersion: active.checkpointVersion});
    try { return await authorize(client, binding) === true; } catch { return false; }
  };
  const jobFor = async (client: PoolClient, jobId: string) => {
    const result = await client.query<Admission>(`SELECT ${JOB_COLUMNS} FROM orchestration_capture_verification_jobs job
      WHERE job.tenant_id=$1 AND job.job_id=$2`, [context.tenantId, jobId]);
    return result.rows.length === 1 ? result.rows[0] : undefined;
  };
  return Object.freeze({async claimOne(): Promise<CaptureVerificationLease | CaptureVerificationNoWork> {
    await requirePreflight();
    return transaction(async client => {
      const active = await activeIn(client);
      if (!active) return noWork(false);
      const capacity = await client.query<{count: string}>(`SELECT count(*)::text AS count
        FROM orchestration_capture_verification_job_state
        WHERE tenant_id=$1 AND state='leased' AND lease_expires_at>clock_timestamp()`, [context.tenantId]);
      if (capacity.rows.length !== 1 || !/^[0-9]+$/.test(capacity.rows[0]!.count))
        throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
      if (Number(capacity.rows[0]!.count) >= 2) return noWork(true);
      const candidates = await client.query<Admission>(`SELECT ${JOB_COLUMNS}
        FROM orchestration_capture_verification_jobs job
        JOIN orchestration_capture_verification_job_state lifecycle
          ON lifecycle.tenant_id=job.tenant_id AND lifecycle.job_id=job.job_id
        WHERE job.tenant_id=$1 AND job.repository_id=ANY($2::text[]) AND job.service_id=ANY($3::text[])
          AND job.config_fingerprint=$4 AND job.config_document_sha256=$5
          AND job.config_checkpoint_version=$6
          AND lifecycle.available_at<=clock_timestamp()
          AND (lifecycle.state='queued' OR lifecycle.state='leased' AND lifecycle.lease_expires_at<=clock_timestamp())
        ORDER BY job.admitted_at,job.job_id LIMIT ${WINDOW}`,
      [context.tenantId, repositories, services, active.fingerprint, active.documentSha256, active.checkpointVersion]);
      for (const job of candidates.rows) {
        const parent = await parentFor(client, job.capture_identity_digest);
        if (!validAdmission(job, context.tenantId, active, parent))
          throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
        if (!await permitted(client, active, job, parent)) continue;
        const locked = await client.query<State>(`SELECT state,attempt_count,lease_worker_id,lease_instance_id,
          lease_token_hash,lease_expires_at,lease_expires_at<=clock_timestamp() AS lease_expired
          FROM orchestration_capture_verification_job_state
          WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE SKIP LOCKED`, [context.tenantId, job.job_id]);
        const state = locked.rows[0];
        if (locked.rows.length !== 1 || !state) continue;
        const ready = state.state === "queued" || state.state === "leased" && state.lease_expired === true;
        if (!ready) continue;
        if (state.attempt_count >= MAX_ATTEMPTS) {
          if (state.state !== "leased") throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
          await client.query(`UPDATE orchestration_capture_verification_job_state
            SET state='failed',lease_worker_id=NULL,lease_instance_id=NULL,lease_token_hash=NULL,
              lease_expires_at=NULL,safe_error_code='CAPTURE_LEASE_EXHAUSTED',row_version=row_version+1,
              updated_at=clock_timestamp() WHERE tenant_id=$1 AND job_id=$2`, [context.tenantId, job.job_id]);
          continue;
        }
        const serviceCapacity = await client.query<{count: string}>(`SELECT count(*)::text AS count
          FROM orchestration_capture_verification_job_state lifecycle
          JOIN orchestration_capture_verification_jobs queued
            ON queued.tenant_id=lifecycle.tenant_id AND queued.job_id=lifecycle.job_id
          WHERE lifecycle.tenant_id=$1 AND queued.repository_id=$2 AND queued.service_id=$3
            AND lifecycle.state='leased' AND lifecycle.lease_expires_at>clock_timestamp()`,
        [context.tenantId, job.repository_id, job.service_id]);
        if (serviceCapacity.rows.length !== 1 || !/^[0-9]+$/.test(serviceCapacity.rows[0]!.count))
          throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
        if (Number(serviceCapacity.rows[0]!.count) >= 1) continue;
        const leaseToken = randomBytes(32).toString("hex");
        const updated = await client.query<{lease_expires_at: Date; attempt_count: number}>(
          `UPDATE orchestration_capture_verification_job_state
           SET state='leased',attempt_count=attempt_count+1,lease_worker_id=$3,lease_instance_id=$4,
             lease_token_hash=$5,lease_expires_at=clock_timestamp()+($6::integer * interval '1 millisecond'),
             safe_error_code=NULL,row_version=row_version+1,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND job_id=$2 AND attempt_count<$7
             AND (state='queued' OR state='leased' AND lease_expires_at<=clock_timestamp())
           RETURNING lease_expires_at,attempt_count`,
        [context.tenantId, job.job_id, context.workerId, context.instanceId,
          hash(leaseToken), LEASE_MS, MAX_ATTEMPTS]);
        if (updated.rows.length !== 1 || !(updated.rows[0]!.lease_expires_at instanceof Date)) continue;
        return Object.freeze({kind: "leased" as const, jobId: job.job_id,
          captureIdentityDigest: job.capture_identity_digest, leaseToken,
          leaseExpiresAt: updated.rows[0]!.lease_expires_at.toISOString(),
          attemptCount: updated.rows[0]!.attempt_count, configFingerprint: active.fingerprint,
          configDocumentSha256: active.documentSha256, checkpointVersion: active.checkpointVersion});
      }
      return noWork(candidates.rows.length >= WINDOW);
    });
  }, async heartbeat(candidate: {jobId: string; leaseToken: string}): Promise<CaptureVerificationLease> {
    const request = ownData(candidate, ["jobId", "leaseToken"]);
    if (!request || !matches(DIGEST, request.jobId) || !matches(TOKEN, request.leaseToken))
      throw new CaptureVerificationLeaseError("INVALID_CAPTURE_LEASE_REQUEST");
    const jobId = request.jobId as string, leaseToken = request.leaseToken as string;
    await requirePreflight();
    return transaction(async client => {
      const active = await activeIn(client), job = await jobFor(client, jobId);
      if (!active || !job || !repositories.includes(job.repository_id) || !services.includes(job.service_id)
        || job.config_fingerprint !== active.fingerprint || job.config_document_sha256 !== active.documentSha256
        || job.config_checkpoint_version !== active.checkpointVersion)
        throw new CaptureVerificationLeaseError("CAPTURE_LEASE_UNAUTHORIZED");
      const parent = await parentFor(client, job.capture_identity_digest);
      if (!validAdmission(job, context.tenantId, active, parent))
        throw new CaptureVerificationLeaseError("CAPTURE_LEASE_STORAGE_ERROR");
      if (!await permitted(client, active, job, parent))
        throw new CaptureVerificationLeaseError("CAPTURE_LEASE_UNAUTHORIZED");
      const locked = await client.query<State>(`SELECT state,attempt_count,lease_worker_id,lease_instance_id,
        lease_token_hash,lease_expires_at,lease_expires_at<=clock_timestamp() AS lease_expired
        FROM orchestration_capture_verification_job_state
        WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`, [context.tenantId, job.job_id]);
      const state = locked.rows[0];
      if (!state || locked.rows.length !== 1 || state.state !== "leased"
        || state.lease_worker_id !== context.workerId || state.lease_instance_id !== context.instanceId
        || state.lease_token_hash !== hash(leaseToken)
        || !(state.lease_expires_at instanceof Date) || state.lease_expired !== false)
        throw new CaptureVerificationLeaseError("CAPTURE_LEASE_CONFLICT");
      const renewed = await client.query<{lease_expires_at: Date}>(`UPDATE orchestration_capture_verification_job_state
        SET lease_expires_at=clock_timestamp()+($3::integer * interval '1 millisecond'),
          row_version=row_version+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_expires_at>clock_timestamp()
          AND lease_worker_id=$4 AND lease_instance_id=$5 AND lease_token_hash=$6
        RETURNING lease_expires_at`,
      [context.tenantId, job.job_id, LEASE_MS, context.workerId, context.instanceId, hash(leaseToken)]);
      if (renewed.rows.length !== 1 || !(renewed.rows[0]!.lease_expires_at instanceof Date))
        throw new CaptureVerificationLeaseError("CAPTURE_LEASE_CONFLICT");
      return Object.freeze({kind: "leased", jobId: job.job_id, captureIdentityDigest: job.capture_identity_digest,
        leaseToken, leaseExpiresAt: renewed.rows[0]!.lease_expires_at.toISOString(),
        attemptCount: state.attempt_count, configFingerprint: active.fingerprint,
        configDocumentSha256: active.documentSha256, checkpointVersion: active.checkpointVersion});
    });
  }});
}
