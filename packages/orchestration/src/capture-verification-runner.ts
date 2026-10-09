import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash, canonicalOrchestrationJson, compareUtf8} from "./canonical.js";
import {setOrchestrationSearchPath} from "./database.js";
import {createCaptureVerificationLeaseStore, type CaptureVerificationLease,
  type CaptureVerificationLeaseOptions, type CaptureVerificationNoWork} from "./capture-verification-leases.js";
import {createObservedCaptureVerificationStore, type ObservedCaptureVerificationReceipt} from "./observed-capture-verifications.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "protected-handler-bytes-1";
const CAPABILITY = "capture.verify.execute";
const POLICY = "runtime-capture-pin-1";
const MAX_CONFIG_BYTES = 1_000_000;
const HEARTBEAT_MS = 10_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-fA-F0-9]{12,128}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REF = /^(?:capture|key):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

type ActiveRow = {config_fingerprint: string; config_version: string; document_sha256: string;
  checkpoint_version: string; document: unknown};
type JobRow = {tenant_id: string; job_id: string; capture_identity_digest: string; verifier_profile_version: string;
  repository_id: string; service_id: string; environment: string; service_root: string;
  config_fingerprint: string; config_document_sha256: string; config_checkpoint_version: string; state: string};
type ParentRow = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string;
  artifact_ref: string; configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
type StateRow = {state: string; lease_worker_id: string | null; lease_instance_id: string | null;
  lease_token_hash: string | null; live: boolean};
export type CaptureVerificationRunnerBinding = Readonly<{tenantId: string; principalId: string;
  workerId: string; instanceId: string; capability: typeof CAPABILITY; jobId: string;
  captureIdentityDigest: string; verifierProfileVersion: typeof PROFILE; repositoryId: string;
  serviceId: string; environment: string; serviceRoot: string; immutableRevision: string;
  sourceDigest: string; artifactRef: string; configuredKeyRef: string; receiptDigest: string;
  signerSpkiDigest: string; configFingerprint: string; configDocumentSha256: string;
  checkpointVersion: string}>;
export type CaptureVerificationRunnerOptions = CaptureVerificationLeaseOptions & {
  /** Trusted host creates a fixed, capture-bound verifier. It must finish cleanup before verify resolves. */
  verificationPortFactory(binding: CaptureVerificationRunnerBinding): Promise<{verify(): Promise<unknown>}>;
  /** Default 10 s; a shorter trusted value is useful for deterministic integration tests. */
  heartbeatIntervalMs?: number;
  /** Default 2; never greater than 8 in one process. */
  maxSessions?: number};
export type CaptureVerificationRunResult = CaptureVerificationNoWork
  | Readonly<{kind: "succeeded"; jobId: string; captureIdentityDigest: string;
    receipt: ObservedCaptureVerificationReceipt}>
  | Readonly<{kind: "failed" | "deferred"; jobId: string; captureIdentityDigest: string;
    reason: "unverified" | "transient" | "lease_lost"}>;
const MESSAGES = {INVALID_CAPTURE_RUNNER_CONFIGURATION: "Invalid capture runner configuration",
  CAPTURE_RUNNER_UNAUTHORIZED: "Capture runner unauthorized",
  CAPTURE_RUNNER_STORAGE_ERROR: "Capture runner storage error"} as const;
export class CaptureVerificationRunnerError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.code = code; }
}
function ownData(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const names = Reflect.ownKeys(value);
    if (names.length < required.length || names.length > required.length + optional.length
      || required.some(name => !names.includes(name))
      || names.some(name => typeof name !== "string" || !required.includes(name) && !optional.includes(name))) return undefined;
    const copy: Record<string, unknown> = Object.create(null);
    for (const name of [...required, ...optional]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor && optional.includes(name)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      copy[name] = descriptor.value;
    }
    return copy;
  } catch { return undefined; }
}
function safeNames(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > 50
      || Reflect.ownKeys(value).length !== length + 1) return undefined;
    const names: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !matches(NAME, descriptor.value)) return undefined;
      names.push(descriptor.value);
    }
    return new Set(names).size === names.length ? names : undefined;
  } catch { return undefined; }
}
function validatedActive(row: ActiveRow | undefined) {
  if (!row || typeof row.config_fingerprint !== "string" || row.config_fingerprint.length < 1
    || row.config_fingerprint.length > 512 || !matches(DIGEST, row.document_sha256)
    || !/^[1-9][0-9]{0,18}$/.test(row.checkpoint_version)) return undefined;
  try {
    const parsed = parseConfig(row.document);
    if (!parsed.ok || parsed.value.config_version !== row.config_version
      || canonicalOrchestrationHash(parsed.value) !== row.document_sha256
      || Buffer.byteLength(canonicalOrchestrationJson(parsed.value), "utf8") > MAX_CONFIG_BYTES) return undefined;
    return {fingerprint: row.config_fingerprint, documentSha256: row.document_sha256,
      checkpointVersion: row.checkpoint_version, document: parsed.value};
  } catch { return undefined; }
}
function validParent(row: ParentRow | undefined, tenantId: string, identity: string) {
  if (!row || row.tenant_id !== tenantId || row.capture_identity_digest !== identity
    || !matches(NAME, row.repository_id) || !matches(NAME, row.service_id)
    || !matches(NAME, row.environment) || !matches(REVISION, row.immutable_revision)
    || !matches(DIGEST, row.source_digest) || row.policy_version !== POLICY
    || !matches(REF, row.artifact_ref) || !row.artifact_ref.startsWith("capture:")
    || !matches(REF, row.configured_key_ref) || !row.configured_key_ref.startsWith("key:")
    || !matches(DIGEST, row.receipt_digest) || !matches(DIGEST, row.signer_spki_digest)) return false;
  const scope = {tenantId, repositoryId: row.repository_id, serviceId: row.service_id,
    immutableRevision: row.immutable_revision, sourceDigest: row.source_digest, environment: row.environment};
  return canonicalOrchestrationHash({policyVersion: POLICY, scope, artifactRef: row.artifact_ref,
    configuredKeyRef: row.configured_key_ref, receiptDigest: row.receipt_digest,
    signerSpkiDigest: row.signer_spki_digest}) === identity;
}
const JOB_COLUMNS = `tenant_id,job_id,capture_identity_digest,verifier_profile_version,repository_id,
  service_id,environment,service_root,config_fingerprint,config_document_sha256,
  config_checkpoint_version::text,state`;
const PARENT_COLUMNS = `tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,
  source_digest,environment,policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest`;

/** Runs only protected handler-byte verification. No catalog or D08 promotion. */
export function createCaptureVerificationRunner(pool: Pool, options: CaptureVerificationRunnerOptions): {
  runOne(): Promise<CaptureVerificationRunResult>} {
  const raw = ownData(options, ["schema", "tenantId", "principalId", "workerId", "instanceId",
    "allowedRepositories", "allowedServices", "preflightAuthorize", "authorizeCapture",
    "verificationPortFactory"], ["heartbeatIntervalMs", "maxSessions"]);
  const repositories = safeNames(raw?.allowedRepositories), services = safeNames(raw?.allowedServices);
  if (!raw || !repositories || !services
    || typeof raw.verificationPortFactory !== "function" || isProxy(raw.verificationPortFactory)
    || Object.hasOwn(raw, "heartbeatIntervalMs") && (!Number.isSafeInteger(raw.heartbeatIntervalMs)
      || (raw.heartbeatIntervalMs as number) < 100 || (raw.heartbeatIntervalMs as number) > HEARTBEAT_MS)
    || Object.hasOwn(raw, "maxSessions") && (!Number.isSafeInteger(raw.maxSessions)
      || (raw.maxSessions as number) < 1 || (raw.maxSessions as number) > 8))
    throw new CaptureVerificationRunnerError("INVALID_CAPTURE_RUNNER_CONFIGURATION");
  const leaseOptions: CaptureVerificationLeaseOptions = {schema: raw.schema as string,
    tenantId: raw.tenantId as string, principalId: raw.principalId as string,
    workerId: raw.workerId as string, instanceId: raw.instanceId as string,
    allowedRepositories: repositories, allowedServices: services,
    preflightAuthorize: raw.preflightAuthorize as CaptureVerificationLeaseOptions["preflightAuthorize"],
    authorizeCapture: raw.authorizeCapture as CaptureVerificationLeaseOptions["authorizeCapture"]};
  let leases: ReturnType<typeof createCaptureVerificationLeaseStore>;
  try { leases = createCaptureVerificationLeaseStore(pool, leaseOptions); }
  catch { throw new CaptureVerificationRunnerError("INVALID_CAPTURE_RUNNER_CONFIGURATION"); }
  const factory = raw.verificationPortFactory as CaptureVerificationRunnerOptions["verificationPortFactory"];
  const heartbeatIntervalMs = raw.heartbeatIntervalMs as number | undefined ?? HEARTBEAT_MS;
  const maxSessions = raw.maxSessions as number | undefined ?? 2;
  const tenantId = leaseOptions.tenantId, principalId = leaseOptions.principalId;
  const workerId = leaseOptions.workerId, instanceId = leaseOptions.instanceId;
  const allowedRepositories = new Set(leaseOptions.allowedRepositories), allowedServices = new Set(leaseOptions.allowedServices);
  const preflight = leaseOptions.preflightAuthorize, authorize = leaseOptions.authorizeCapture;
  const context = Object.freeze({tenantId, principalId, workerId, instanceId, capability: CAPABILITY as typeof CAPABILITY});
  let activeSessions = 0;
  const requirePreflight = async () => {
    let allowed = false;
    try { allowed = await preflight(context) === true; } catch { /* Deny. */ }
    if (!allowed) throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
  };
  const withTransaction = async <T>(fn: (client: PoolClient) => Promise<T>) => {
    let client: PoolClient;
    try { client = await pool.connect(); } catch { throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_STORAGE_ERROR"); }
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, leaseOptions.schema);
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CaptureVerificationRunnerError) throw error;
      throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_STORAGE_ERROR");
    } finally { client.release(); }
  };
  const authorizedBinding = async (client: PoolClient, lease: CaptureVerificationLease) => {
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      [`api-truth:capture-admission:${tenantId}`]);
    const activeRows = await client.query<ActiveRow>(`SELECT configuration.config_fingerprint,configuration.config_version,
      configuration.document_sha256,active.checkpoint_version::text,
      CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document ELSE NULL END AS document
      FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
        ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
      WHERE active.tenant_id=$1 FOR SHARE OF active`, [tenantId, MAX_CONFIG_BYTES]);
    const active = activeRows.rows.length === 1 ? validatedActive(activeRows.rows[0]) : undefined;
    if (!active || active.fingerprint !== lease.configFingerprint
      || active.documentSha256 !== lease.configDocumentSha256
      || active.checkpointVersion !== lease.checkpointVersion)
      throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    const jobs = await client.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM orchestration_capture_verification_jobs
      WHERE tenant_id=$1 AND job_id=$2 FOR SHARE`, [tenantId, lease.jobId]);
    const job = jobs.rows[0];
    if (jobs.rows.length !== 1 || !job || job.tenant_id !== tenantId || job.job_id !== lease.jobId
      || job.capture_identity_digest !== lease.captureIdentityDigest || job.verifier_profile_version !== PROFILE
      || job.state !== "queued" || !allowedRepositories.has(job.repository_id)
      || !allowedServices.has(job.service_id) || job.config_fingerprint !== active.fingerprint
      || job.config_document_sha256 !== active.documentSha256
      || job.config_checkpoint_version !== active.checkpointVersion)
      throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    const parents = await client.query<ParentRow>(`SELECT ${PARENT_COLUMNS}
      FROM orchestration_observed_capture_associations
      WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`, [tenantId, job.capture_identity_digest]);
    const parent = parents.rows[0];
    if (parents.rows.length !== 1 || !validParent(parent, tenantId, job.capture_identity_digest)
      || !parent || parent.repository_id !== job.repository_id || parent.service_id !== job.service_id
      || parent.environment !== job.environment)
      throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    const repository = active.document.repositories.find(item => item.repository_id === job.repository_id);
    const service = repository?.services.find(item => item.service_id === job.service_id);
    const environment = service?.environments.find(item => item.name === job.environment);
    if (!repository || !service || !environment || service.root !== job.service_root
      || canonicalOrchestrationHash({kind: "capture_verification_admission", tenantId,
        captureIdentityDigest: job.capture_identity_digest, verifierProfileVersion: PROFILE,
        serviceRoot: job.service_root, configFingerprint: active.fingerprint,
        configDocumentSha256: active.documentSha256, checkpointVersion: active.checkpointVersion}) !== job.job_id)
      throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    const scopeIds = [...new Set([repository.access_scope_id,
      environment.deployment_authority.access_scope_id])].sort(compareUtf8);
    const scopes = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
      FROM access_scopes WHERE tenant_id=$1 AND access_scope_id=ANY($2::text[])
      ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [tenantId, scopeIds]);
    const grants = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
      FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=ANY($3::text[])
      ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [tenantId, principalId, scopeIds]);
    if (scopes.rows.length !== scopeIds.length || grants.rows.length !== scopeIds.length
      || scopeIds.some((id, index) => scopes.rows[index]?.access_scope_id !== id || scopes.rows[index]?.active !== true
        || grants.rows[index]?.access_scope_id !== id || grants.rows[index]?.active !== true))
      throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    const binding: CaptureVerificationRunnerBinding = Object.freeze({tenantId, principalId, workerId,
      instanceId, capability: CAPABILITY, jobId: job.job_id,
      captureIdentityDigest: job.capture_identity_digest, verifierProfileVersion: PROFILE,
      repositoryId: parent.repository_id, serviceId: parent.service_id, environment: parent.environment,
      serviceRoot: job.service_root, immutableRevision: parent.immutable_revision,
      sourceDigest: parent.source_digest, artifactRef: parent.artifact_ref,
      configuredKeyRef: parent.configured_key_ref, receiptDigest: parent.receipt_digest,
      signerSpkiDigest: parent.signer_spki_digest, configFingerprint: active.fingerprint,
      configDocumentSha256: active.documentSha256, checkpointVersion: active.checkpointVersion});
    let permitted = false;
    try { permitted = await authorize(client, binding) === true; }
    catch { throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_STORAGE_ERROR"); }
    if (!permitted) throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    const states = await client.query<StateRow>(`SELECT state,lease_worker_id,lease_instance_id,lease_token_hash,
      lease_expires_at>clock_timestamp() AS live FROM orchestration_capture_verification_job_state
      WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`, [tenantId, lease.jobId]);
    const state = states.rows[0];
    if (states.rows.length !== 1 || !state || state.state !== "leased" || state.live !== true
      || state.lease_worker_id !== workerId || state.lease_instance_id !== instanceId
      || state.lease_token_hash !== hash(lease.leaseToken))
      throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    return binding;
  };
  const exactBinding = (actual: CaptureVerificationRunnerBinding, expected: CaptureVerificationRunnerBinding) =>
    Object.keys(expected).every(key => actual[key as keyof CaptureVerificationRunnerBinding]
      === expected[key as keyof CaptureVerificationRunnerBinding]);
  const scopeFor = (binding: CaptureVerificationRunnerBinding): ObservedCaptureScope => Object.freeze({
    tenantId: binding.tenantId, repositoryId: binding.repositoryId, serviceId: binding.serviceId,
    immutableRevision: binding.immutableRevision, sourceDigest: binding.sourceDigest,
    environment: binding.environment});
  const errorCode = (value: unknown): string | undefined => {
    try {
      if (!value || typeof value !== "object" || isProxy(value)) return undefined;
      const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
      return typeof code === "string" ? code : undefined;
    } catch { return undefined; }
  };
  const terminalFailure = async (lease: CaptureVerificationLease, binding: CaptureVerificationRunnerBinding) => {
    try {
      await requirePreflight();
      await withTransaction(async client => {
        const current = await authorizedBinding(client, lease);
        if (!exactBinding(current, binding)) throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
        const marked = await client.query(`UPDATE orchestration_capture_verification_job_state
          SET state='failed',lease_worker_id=NULL,lease_instance_id=NULL,lease_token_hash=NULL,
            lease_expires_at=NULL,terminal_reason='CAPTURE_VERIFICATION_UNVERIFIED',
            row_version=row_version+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_worker_id=$3
            AND lease_instance_id=$4 AND lease_token_hash=$5 AND lease_expires_at>clock_timestamp()`,
        [tenantId, lease.jobId, workerId, instanceId, hash(lease.leaseToken)]);
        if (marked.rowCount !== 1) throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
      });
      return true;
    } catch { return false; }
  };
  return Object.freeze({async runOne(): Promise<CaptureVerificationRunResult> {
    if (activeSessions >= maxSessions) throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_UNAUTHORIZED");
    activeSessions += 1;
    try {
      let lease: Awaited<ReturnType<typeof leases.claimOne>>;
      try { lease = await leases.claimOne(); }
      catch (error) { throw new CaptureVerificationRunnerError(errorCode(error) === "CAPTURE_LEASE_UNAUTHORIZED"
        ? "CAPTURE_RUNNER_UNAUTHORIZED" : "CAPTURE_RUNNER_STORAGE_ERROR"); }
      if (lease.kind === "no_work") return lease;
      let binding: CaptureVerificationRunnerBinding;
      try { await requirePreflight(); binding = await withTransaction(client => authorizedBinding(client, lease)); }
      catch (error) { return Object.freeze({kind: "deferred", jobId: lease.jobId,
        captureIdentityDigest: lease.captureIdentityDigest,
        reason: errorCode(error) === "CAPTURE_RUNNER_STORAGE_ERROR" ? "transient" : "lease_lost"}); }
      let stopped = false;
      let heartbeatFailure: "lease_lost" | "transient" | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending: Promise<void> = Promise.resolve();
      const schedule = () => {
        timer = setTimeout(() => {
          pending = leases.heartbeat({jobId: lease.jobId, leaseToken: lease.leaseToken})
            .then(() => undefined, error => { heartbeatFailure = errorCode(error) === "CAPTURE_LEASE_STORAGE_ERROR"
              ? "transient" : "lease_lost"; })
            .then(() => { if (!stopped && !heartbeatFailure) schedule(); });
        }, heartbeatIntervalMs);
      };
      let verified: unknown, failure: unknown, failed = false;
      try {
        schedule();
        const port = ownData(await factory(binding), ["verify"]);
        if (!port || typeof port.verify !== "function" || isProxy(port.verify))
          throw new CaptureVerificationRunnerError("CAPTURE_RUNNER_STORAGE_ERROR");
        verified = await (port.verify as () => Promise<unknown>).call(port);
      } catch (error) { failure = error; failed = true; }
      finally {
        stopped = true;
        if (timer) clearTimeout(timer);
        await pending;
      }
      if (heartbeatFailure) return Object.freeze({kind: "deferred", jobId: lease.jobId,
        captureIdentityDigest: lease.captureIdentityDigest, reason: heartbeatFailure});
      const unverified = errorCode(failure) === "PROTECTED_CAPTURE_UNVERIFIED";
      if (failed && !unverified) return Object.freeze({kind: "deferred", jobId: lease.jobId,
        captureIdentityDigest: lease.captureIdentityDigest, reason: "transient"});
      if (unverified) {
        const marked = await terminalFailure(lease, binding);
        return Object.freeze({kind: marked ? "failed" : "deferred", jobId: lease.jobId,
          captureIdentityDigest: lease.captureIdentityDigest, reason: marked ? "unverified" : "lease_lost"});
      }
      let finalStorageFailure = false;
      try {
        const store = createObservedCaptureVerificationStore(pool, {schema: leaseOptions.schema,
          preflightAuthorize: async selected => {
            if (Object.keys(selected).some(key => selected[key as keyof ObservedCaptureScope]
              !== scopeFor(binding)[key as keyof ObservedCaptureScope])) return false;
            try { await requirePreflight(); await leases.heartbeat({jobId: lease.jobId,
              leaseToken: lease.leaseToken}); return true; }
            catch (error) {
              if (errorCode(error) === "CAPTURE_LEASE_STORAGE_ERROR") finalStorageFailure = true;
              return false;
            }
          },
          transactionAuthorize: async (client, selected) => {
            if (Object.keys(selected).some(key => selected[key as keyof ObservedCaptureScope]
              !== scopeFor(binding)[key as keyof ObservedCaptureScope])) return false;
            try { return exactBinding(await authorizedBinding(client, lease), binding); }
            catch (error) {
              if (errorCode(error) === "CAPTURE_RUNNER_STORAGE_ERROR") finalStorageFailure = true;
              return false;
            }
          },
          verificationPort: {verify: async () => verified},
          transactionFinalize: async (client, selected, receipt) => {
            if (receipt.captureIdentityDigest !== binding.captureIdentityDigest
              || receipt.verifierProfileVersion !== PROFILE || receipt.serviceRoot !== binding.serviceRoot
              || Object.keys(selected).some(key => selected[key as keyof ObservedCaptureScope]
                !== scopeFor(binding)[key as keyof ObservedCaptureScope])) return false;
            const updated = await client.query(`UPDATE orchestration_capture_verification_job_state
              SET state='succeeded',lease_worker_id=NULL,lease_instance_id=NULL,lease_token_hash=NULL,
                lease_expires_at=NULL,verification_capture_identity_digest=$6,
                verification_profile_version=$7,verification_result_digest=$8,
                verified_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_worker_id=$3
                AND lease_instance_id=$4 AND lease_token_hash=$5 AND lease_expires_at>clock_timestamp()`,
            [tenantId, lease.jobId, workerId, instanceId, hash(lease.leaseToken),
              receipt.captureIdentityDigest, PROFILE, receipt.resultDigest]);
            return updated.rowCount === 1;
          }});
        const receipt = await store.append({scope: scopeFor(binding),
          captureIdentityDigest: binding.captureIdentityDigest});
        return Object.freeze({kind: "succeeded", jobId: lease.jobId,
          captureIdentityDigest: lease.captureIdentityDigest, receipt});
      } catch (error) {
        if (errorCode(error) === "CAPTURE_VERIFICATION_UNVERIFIED"
          || errorCode(error) === "CAPTURE_VERIFICATION_CONFLICT") {
          const marked = await terminalFailure(lease, binding);
          return Object.freeze({kind: marked ? "failed" : "deferred", jobId: lease.jobId,
            captureIdentityDigest: lease.captureIdentityDigest, reason: marked ? "unverified" : "lease_lost"});
        }
        return Object.freeze({kind: "deferred", jobId: lease.jobId,
          captureIdentityDigest: lease.captureIdentityDigest,
          reason: finalStorageFailure || errorCode(error) === "CAPTURE_VERIFICATION_STORAGE_ERROR"
            ? "transient" : "lease_lost"});
      }
    } finally { activeSessions -= 1; }
  }});
}
