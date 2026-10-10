import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash, canonicalOrchestrationJson, compareUtf8} from "./canonical.js";
import {setOrchestrationSearchPath} from "./database.js";
import {createLoadedDocumentVerificationLeaseStore, type LoadedDocumentVerificationLease,
  type LoadedDocumentVerificationLeaseBinding, type LoadedDocumentVerificationLeaseOptions,
  type LoadedDocumentVerificationNoWork} from "./loaded-document-verification-leases.js";
import {createObservedLoadedDocumentVerificationStore, type ObservedLoadedDocumentVerificationReceipt} from "./observed-loaded-document-verifications.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "swagger-loaded-document-1" as const;
const PARENT_PROFILE = "protected-handler-bytes-1";
const POLICY = "runtime-capture-pin-1";
const CAPABILITY = "swagger.document.verify.execute" as const;
const MAX_CONFIG_BYTES = 1_000_000;
const HEARTBEAT_MS = 10_000;
const MIN_HEARTBEAT_MS = 100;
const MAX_SESSIONS = 2;
const VERIFICATION_TIMEOUT_MS = 30_000;
const MAX_VERIFICATION_TIMEOUT_MS = 60_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const PRINCIPAL = /^[A-Za-z0-9_.:@-]{1,128}$/;
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

export type LoadedDocumentVerificationRunnerPort = {verify(): Promise<unknown>; dispose?(): Promise<void>};
export type LoadedDocumentVerificationRunContext = Readonly<{signal: AbortSignal; timeoutMs: number}>;
export type LoadedDocumentVerificationRunnerOptions = Omit<LoadedDocumentVerificationLeaseOptions,
  "preflightAuthorize" | "authorizeLoadedDocument"> & Pick<LoadedDocumentVerificationLeaseOptions,
  "preflightAuthorize" | "authorizeLoadedDocument"> & {
    /** Must honor abort/deadline and finish cleanup before its promise settles. */
    verificationPortFactory(binding: LoadedDocumentVerificationLeaseBinding,
      context: LoadedDocumentVerificationRunContext): Promise<LoadedDocumentVerificationRunnerPort>;
    heartbeatIntervalMs?: number;
    verificationTimeoutMs?: number;
    maxSessions?: number;
  };
export type LoadedDocumentVerificationRunResult = LoadedDocumentVerificationNoWork
  | Readonly<{kind: "succeeded"; jobId: string; loadIdentityDigest: string; captureIdentityDigest: string;
    receipt: ObservedLoadedDocumentVerificationReceipt}>
  | Readonly<{kind: "failed" | "deferred"; jobId: string; loadIdentityDigest: string;
    captureIdentityDigest: string; reason: "unverified" | "transient" | "lease_lost"}>;

const messages = {INVALID_LOADED_DOCUMENT_RUNNER_CONFIGURATION: "Invalid loaded-document runner configuration",
  LOADED_DOCUMENT_RUNNER_UNAUTHORIZED: "Loaded-document runner unauthorized",
  LOADED_DOCUMENT_RUNNER_STORAGE_ERROR: "Loaded-document runner storage error"} as const;
export class LoadedDocumentVerificationRunnerError extends Error {
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) {super(messages[code]); this.code = code;}
}

function ownData(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (required.some(key => !Object.hasOwn(descriptors, key))
      || keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) return undefined;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of [...required, ...optional]) {
      const descriptor = descriptors[key];
      if (!descriptor && optional.includes(key)) continue;
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {return undefined;}
}
function safeArray(value: unknown, max: number): string[] | undefined {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > max) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== length + 1) return undefined;
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !matches(NAME, descriptor.value)) return undefined;
      result.push(descriptor.value);
    }
    return new Set(result).size === result.length ? result.sort(compareUtf8) : undefined;
  } catch {return undefined;}
}
function matchingConfig(raw: Record<string, unknown> | undefined, binding: LoadedDocumentVerificationLeaseBinding): boolean {
  if (!raw || raw.config_fingerprint !== binding.configFingerprint || raw.document_sha256 !== binding.configDocumentSha256
    || raw.checkpoint_version !== binding.checkpointVersion) return false;
  try {
    const parsed = parseConfig(raw.document);
    if (!parsed.ok || parsed.value.config_version !== raw.config_version
      || canonicalOrchestrationHash(parsed.value) !== binding.configDocumentSha256
      || Buffer.byteLength(canonicalOrchestrationJson(parsed.value), "utf8") > MAX_CONFIG_BYTES) return false;
    const repository = parsed.value.repositories.find(item => item.repository_id === binding.repositoryId);
    const service = repository?.services.find(item => item.service_id === binding.serviceId);
    return service?.root === binding.serviceRoot && service.environments.some(item => item.name === binding.environment);
  } catch {return false;}
}
function exactScope(scope: ObservedCaptureScope, binding: LoadedDocumentVerificationLeaseBinding): boolean {
  return scope.tenantId === binding.tenantId && scope.repositoryId === binding.repositoryId
    && scope.serviceId === binding.serviceId && scope.environment === binding.environment
    && scope.immutableRevision === binding.immutableRevision && scope.sourceDigest === binding.sourceDigest;
}
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || isProxy(error)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
      ? descriptor.value : undefined;
  } catch {return undefined;}
}
function bindingScope(binding: LoadedDocumentVerificationLeaseBinding): ObservedCaptureScope {
  return Object.freeze({tenantId: binding.tenantId, repositoryId: binding.repositoryId, serviceId: binding.serviceId,
    environment: binding.environment, immutableRevision: binding.immutableRevision, sourceDigest: binding.sourceDigest});
}
type CaptureAssociation = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string; artifact_ref: string;
  configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
type CaptureByteVerification = {tenant_id: string; capture_identity_digest: string; verifier_profile_version: string;
  service_root: string; source_digest: string; receipt_digest: string; signer_spki_digest: string;
  result_digest: string; handler_count: number};
function liveLeaseRow(row: Record<string, unknown> | undefined, lease: LoadedDocumentVerificationLease): boolean {
  const binding = lease.binding;
  return !!row && row.state === "leased" && row.attempt_count === lease.attemptCount
    && row.lease_worker_id === binding.workerId && row.lease_instance_id === binding.instanceId
    && row.lease_token_hash === hash(lease.leaseToken) && row.live === true
    && row.job_id === lease.jobId && row.load_identity_digest === lease.loadIdentityDigest
    && row.capture_identity_digest === lease.captureIdentityDigest && row.repository_id === binding.repositoryId
    && row.service_id === binding.serviceId && row.environment === binding.environment
    && row.immutable_revision === binding.immutableRevision && row.source_digest === binding.sourceDigest
    && row.service_root === binding.serviceRoot && row.load_artifact_ref === binding.loadArtifactRef
    && row.load_configured_key_ref === binding.loadConfiguredKeyRef && row.load_envelope_digest === binding.loadEnvelopeDigest
    && row.load_signer_spki_digest === binding.loadSignerSpkiDigest && row.config_fingerprint === binding.configFingerprint
    && row.config_document_sha256 === binding.configDocumentSha256
    && row.config_checkpoint_version === binding.checkpointVersion;
}

/** Runs a host-configured verifier outside transactions and atomically records only successful summaries. */
export function createLoadedDocumentVerificationRunner(pool: Pool, options: LoadedDocumentVerificationRunnerOptions): {
  runOne(): Promise<LoadedDocumentVerificationRunResult>;
} {
  const required = ["schema", "tenantId", "principalId", "workerId", "instanceId", "allowedRepositories", "allowedServices",
    "preflightAuthorize", "authorizeLoadedDocument", "verificationPortFactory"] as const;
  const raw = ownData(options, required, ["heartbeatIntervalMs", "verificationTimeoutMs", "maxSessions"]);
  const repositories = safeArray(raw?.allowedRepositories, 50), services = safeArray(raw?.allowedServices, 50);
  const heartbeatIntervalMs = raw?.heartbeatIntervalMs === undefined ? HEARTBEAT_MS : raw.heartbeatIntervalMs;
  const maxSessions = raw?.maxSessions === undefined ? MAX_SESSIONS : raw.maxSessions;
  const verificationTimeoutMs = raw?.verificationTimeoutMs === undefined ? VERIFICATION_TIMEOUT_MS : raw.verificationTimeoutMs;
  if (!raw || typeof raw.schema !== "string" || !matches(NAME, raw.tenantId) || !matches(PRINCIPAL, raw.principalId)
    || !matches(NAME, raw.workerId) || !matches(NAME, raw.instanceId) || !repositories || !services
    || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.authorizeLoadedDocument !== "function" || isProxy(raw.authorizeLoadedDocument)
    || typeof raw.verificationPortFactory !== "function" || isProxy(raw.verificationPortFactory)
    || !Number.isSafeInteger(heartbeatIntervalMs) || (heartbeatIntervalMs as number) < MIN_HEARTBEAT_MS
    || (heartbeatIntervalMs as number) > HEARTBEAT_MS
    || !Number.isSafeInteger(verificationTimeoutMs) || (verificationTimeoutMs as number) < MIN_HEARTBEAT_MS
    || (verificationTimeoutMs as number) > MAX_VERIFICATION_TIMEOUT_MS
    || !Number.isSafeInteger(maxSessions) || (maxSessions as number) < 1 || (maxSessions as number) > MAX_SESSIONS)
    throw new LoadedDocumentVerificationRunnerError("INVALID_LOADED_DOCUMENT_RUNNER_CONFIGURATION");
  let schema: string;
  try {schema = raw.schema; /* Validate before constructing any callback or connecting. */
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw Error();}
  catch {throw new LoadedDocumentVerificationRunnerError("INVALID_LOADED_DOCUMENT_RUNNER_CONFIGURATION");}
  const tenantId = raw.tenantId as string, principalId = raw.principalId as string;
  const workerId = raw.workerId as string, instanceId = raw.instanceId as string;
  const preflight = raw.preflightAuthorize as LoadedDocumentVerificationLeaseOptions["preflightAuthorize"];
  const authorize = raw.authorizeLoadedDocument as LoadedDocumentVerificationLeaseOptions["authorizeLoadedDocument"];
  const verifyFactory = raw.verificationPortFactory as LoadedDocumentVerificationRunnerOptions["verificationPortFactory"];
  const heartbeatMs = heartbeatIntervalMs as number, sessionLimit = maxSessions as number;
  const verificationLimitMs = verificationTimeoutMs as number;
  const leaseOptions: LoadedDocumentVerificationLeaseOptions = {schema, tenantId, principalId, workerId, instanceId,
    allowedRepositories: repositories, allowedServices: services, preflightAuthorize: preflight,
    authorizeLoadedDocument: authorize};
  const leases = createLoadedDocumentVerificationLeaseStore(pool, leaseOptions);
  let activeSessions = 0;

  const transaction = async <T>(run: (client: PoolClient) => Promise<T>): Promise<T> => {
    let client: PoolClient;
    try {client = await pool.connect();} catch {throw new LoadedDocumentVerificationRunnerError("LOADED_DOCUMENT_RUNNER_STORAGE_ERROR");}
    try {
      await client.query("BEGIN"); await setOrchestrationSearchPath(client, schema);
      await client.query("SET LOCAL lock_timeout = '2000ms'"); await client.query("SET LOCAL statement_timeout = '10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
        [`api-truth:loaded-document-admission:${tenantId}`]);
      const result = await run(client); await client.query("COMMIT"); return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isProxy(error) && error instanceof LoadedDocumentVerificationRunnerError) throw error;
      throw new LoadedDocumentVerificationRunnerError("LOADED_DOCUMENT_RUNNER_STORAGE_ERROR");
    } finally {client.release();}
  };
  const requirePreflight = async () => {
    let accepted = false;
    try {accepted = await preflight(Object.freeze({tenantId, principalId, workerId, instanceId, capability: CAPABILITY})) === true;}
    catch { /* Deny. */ }
    return accepted;
  };

  const transactionAuthorized = async (client: PoolClient, lease: LoadedDocumentVerificationLease): Promise<boolean> => {
    const binding = lease.binding;
    // Share the tenant admission/capacity lock used by admission and leasing before taking any row locks.
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))",
      [`api-truth:loaded-document-admission:${tenantId}`]);
    const activeResult = await client.query<Record<string, unknown>>(`SELECT configuration.config_fingerprint,
      configuration.config_version,configuration.document_sha256,active.checkpoint_version::text,
      CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document ELSE NULL END AS document
      FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
        ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
      WHERE active.tenant_id=$1 FOR SHARE OF active`, [tenantId, MAX_CONFIG_BYTES]);
    if (activeResult.rows.length !== 1 || !matchingConfig(activeResult.rows[0], binding)) return false;
    const scope = bindingScope(binding);
    const association = await client.query<CaptureAssociation>(`SELECT tenant_id,capture_identity_digest,repository_id,
      service_id,immutable_revision,source_digest,environment,policy_version,artifact_ref,configured_key_ref,
      receipt_digest,signer_spki_digest FROM orchestration_observed_capture_associations
      WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`, [tenantId, lease.captureIdentityDigest]);
    const capture = association.rows[0];
    if (association.rows.length !== 1 || !capture || capture.tenant_id !== tenantId
      || capture.capture_identity_digest !== lease.captureIdentityDigest || capture.repository_id !== binding.repositoryId
      || capture.service_id !== binding.serviceId || capture.environment !== binding.environment
      || capture.immutable_revision !== binding.immutableRevision || capture.source_digest !== binding.sourceDigest
      || capture.policy_version !== POLICY || !matches(/^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, capture.artifact_ref)
      || !matches(/^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, capture.configured_key_ref)
      || !matches(DIGEST, capture.receipt_digest) || !matches(DIGEST, capture.signer_spki_digest)
      || canonicalOrchestrationHash({policyVersion: POLICY, scope, artifactRef: capture.artifact_ref,
        configuredKeyRef: capture.configured_key_ref, receiptDigest: capture.receipt_digest,
        signerSpkiDigest: capture.signer_spki_digest}) !== lease.captureIdentityDigest) return false;
    const byteParent = await client.query<CaptureByteVerification>(`SELECT tenant_id,capture_identity_digest,
      verifier_profile_version,service_root,source_digest,receipt_digest,signer_spki_digest,result_digest,handler_count
      FROM orchestration_observed_capture_verifications WHERE tenant_id=$1 AND capture_identity_digest=$2
       AND verifier_profile_version=$3 FOR SHARE`, [tenantId, lease.captureIdentityDigest, PARENT_PROFILE]);
    const byte = byteParent.rows[0];
    if (byteParent.rows.length !== 1 || !byte || byte.tenant_id !== tenantId
      || byte.capture_identity_digest !== lease.captureIdentityDigest || byte.verifier_profile_version !== PARENT_PROFILE
      || byte.service_root !== binding.serviceRoot || byte.source_digest !== binding.sourceDigest
      || byte.receipt_digest !== capture.receipt_digest || byte.signer_spki_digest !== capture.signer_spki_digest
      || !matches(DIGEST, byte.result_digest) || !Number.isInteger(byte.handler_count)
      || byte.handler_count < 1 || byte.handler_count > 1024) return false;
    const config = parseConfig(activeResult.rows[0]!.document);
    if (!config.ok) return false;
    const repository = config.value.repositories.find(item => item.repository_id === binding.repositoryId);
    const environment = repository?.services.find(item => item.service_id === binding.serviceId)
      ?.environments.find(item => item.name === binding.environment);
    if (!repository || !environment) return false;
    const scopeIds = [...new Set([repository.access_scope_id, environment.deployment_authority.access_scope_id])].sort(compareUtf8);
    const scopeRows = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
      FROM access_scopes WHERE tenant_id=$1 AND access_scope_id=ANY($2::text[])
      ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [tenantId, scopeIds]);
    const grantRows = await client.query<{access_scope_id: string; active: boolean}>(`SELECT access_scope_id,active
      FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=ANY($3::text[])
      ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [tenantId, principalId, scopeIds]);
    if (scopeRows.rows.length !== scopeIds.length || grantRows.rows.length !== scopeIds.length
      || scopeIds.some((id,index) => scopeRows.rows[index]?.access_scope_id !== id || scopeRows.rows[index]?.active !== true
        || grantRows.rows[index]?.access_scope_id !== id || grantRows.rows[index]?.active !== true)) return false;
    let hostAllowed = false;
    try {hostAllowed = await authorize(client, binding) === true;} catch {return false;}
    if (!hostAllowed) return false;
    const currentJob = await client.query<Record<string, unknown>>(`SELECT job.job_id,job.load_identity_digest,job.capture_identity_digest,
      job.parent_verifier_profile_version,job.verifier_profile_version,
      job.repository_id,job.service_id,job.environment,job.immutable_revision,job.source_digest,job.service_root,
      job.load_artifact_ref,job.load_configured_key_ref,job.load_envelope_digest,job.load_signer_spki_digest,
      job.config_fingerprint,job.config_document_sha256,job.config_checkpoint_version::text,
      state.state,state.attempt_count,state.lease_worker_id,state.lease_instance_id,state.lease_token_hash,
      state.lease_expires_at>clock_timestamp() AS live
      FROM orchestration_loaded_document_verification_jobs job
      JOIN orchestration_loaded_document_verification_job_state state USING(tenant_id,job_id)
      WHERE job.tenant_id=$1 AND job.job_id=$2 FOR SHARE OF job,state`, [tenantId, lease.jobId]);
    const job = currentJob.rows[0];
    return currentJob.rows.length === 1 && !!job && job.parent_verifier_profile_version === PARENT_PROFILE
      && job.verifier_profile_version === PROFILE && liveLeaseRow(job, lease);
  };

  const recordFailure = async (lease: LoadedDocumentVerificationLease, code: "unverified" | "transient"): Promise<boolean> => {
    if (!await requirePreflight()) return false;
    return transaction(async client => {
      if (!await transactionAuthorized(client, lease)) return false;
      const terminal = code === "unverified" || lease.attemptCount >= 3;
      const updated = await client.query(`UPDATE orchestration_loaded_document_verification_job_state
        SET state=$7,available_at=CASE WHEN $7='retry_wait'
            THEN clock_timestamp() + ($8::integer * interval '1 millisecond') ELSE available_at END,
          lease_worker_id=NULL,lease_instance_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
          verification_error_code=$9,row_version=row_version+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND attempt_count=$3 AND lease_worker_id=$4
          AND lease_instance_id=$5 AND lease_token_hash=$6 AND lease_expires_at>clock_timestamp()`,
      [tenantId, lease.jobId, lease.attemptCount, workerId, instanceId, hash(lease.leaseToken),
        terminal ? "failed" : "retry_wait", Math.min(60_000, 5_000 * 2 ** (lease.attemptCount - 1)),
        code === "unverified" ? "LOADED_DOCUMENT_VERIFICATION_UNVERIFIED" : "LOADED_DOCUMENT_VERIFICATION_TRANSIENT"]);
      return updated.rowCount === 1;
    });
  };

  return Object.freeze({async runOne(): Promise<LoadedDocumentVerificationRunResult> {
    if (activeSessions >= sessionLimit) return Object.freeze({kind: "no_work", coverage: "partial", windowLimited: true});
    activeSessions += 1;
    try {
      let lease: LoadedDocumentVerificationLease | undefined;
      try {
        const claim = await leases.claimOne();
        if (claim.kind === "no_work") return claim;
        lease = claim;
      } catch (error) {
        const code = errorCode(error);
        throw new LoadedDocumentVerificationRunnerError(code === "LOADED_DOCUMENT_LEASE_UNAUTHORIZED"
          ? "LOADED_DOCUMENT_RUNNER_UNAUTHORIZED" : "LOADED_DOCUMENT_RUNNER_STORAGE_ERROR");
      }
      const current = lease;
      let port: LoadedDocumentVerificationRunnerPort | undefined, disposeFailure = false;
      let verified: unknown, verifyFailed = false, verifyError: unknown;
      let heartbeatFailure: "transient" | "lease_lost" | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined, deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let pending: Promise<void> = Promise.resolve(), stopped = false, timedOut = false;
      const controller = new AbortController();
      const schedule = () => {timer = setTimeout(() => {
        pending = leases.heartbeat({jobId: current.jobId, leaseToken: current.leaseToken})
          .then(() => undefined, error => {heartbeatFailure = errorCode(error) === "LOADED_DOCUMENT_LEASE_STORAGE_ERROR"
            ? "transient" : "lease_lost"; controller.abort();})
          .then(() => {if (!stopped && !heartbeatFailure) schedule();});
      }, heartbeatMs);};
      try {
        schedule();
        deadlineTimer = setTimeout(() => {timedOut = true; controller.abort();}, verificationLimitMs);
        const made = await verifyFactory(current.binding, Object.freeze({signal: controller.signal, timeoutMs: verificationLimitMs}));
        port = ownData(made, ["verify"], ["dispose"]) as unknown as LoadedDocumentVerificationRunnerPort | undefined;
        if (!port || typeof port.verify !== "function" || isProxy(port.verify)
          || port.dispose !== undefined && (typeof port.dispose !== "function" || isProxy(port.dispose))) throw Error();
        if (controller.signal.aborted) throw Error();
        verified = await port.verify();
      } catch (error) {verifyFailed = true; verifyError = error;}
      finally {
        if (port?.dispose) {try {await port.dispose();} catch {disposeFailure = true;}}
        stopped = true; if (timer) clearTimeout(timer); if (deadlineTimer) clearTimeout(deadlineTimer); await pending;
      }
      if (heartbeatFailure) return Object.freeze({kind: "deferred", jobId: current.jobId,
        loadIdentityDigest: current.loadIdentityDigest, captureIdentityDigest: current.captureIdentityDigest, reason: heartbeatFailure});
      if (timedOut) {verifyFailed = true; verifyError = undefined;}
      if (disposeFailure) verifyFailed = true;
      if (verifyFailed) {
        const deterministic = errorCode(verifyError) === "LOADED_DOCUMENT_UNVERIFIED";
        let marked = false;
        try {marked = await recordFailure(current, deterministic ? "unverified" : "transient");} catch { /* Keep the fixed deferred result. */ }
        const transientTerminal = !deterministic && marked && current.attemptCount >= 3;
        return Object.freeze({kind: deterministic && marked || transientTerminal ? "failed" : "deferred", jobId: current.jobId,
          loadIdentityDigest: current.loadIdentityDigest, captureIdentityDigest: current.captureIdentityDigest,
          reason: deterministic && marked ? "unverified" : marked ? "transient" : "lease_lost"});
      }
      if (!await requirePreflight()) return Object.freeze({kind: "deferred", jobId: current.jobId,
        loadIdentityDigest: current.loadIdentityDigest, captureIdentityDigest: current.captureIdentityDigest, reason: "lease_lost"});
      let finalStorageFailure = false;
      const scope = bindingScope(current.binding);
      const store = createObservedLoadedDocumentVerificationStore(pool, {schema, binding: {scope,
        captureIdentityDigest: current.captureIdentityDigest, loadArtifactRef: current.binding.loadArtifactRef,
        loadConfiguredKeyRef: current.binding.loadConfiguredKeyRef, loadEnvelopeDigest: current.binding.loadEnvelopeDigest,
        loadSignerSpkiDigest: current.binding.loadSignerSpkiDigest},
        preflightAuthorize: async selected => exactScope(selected, current.binding) && requirePreflight(),
        transactionAuthorize: async (client, selected) => {
          if (!exactScope(selected, current.binding)) return false;
          try {return await transactionAuthorized(client, current);} catch {finalStorageFailure = true; return false;}
        }, verificationPort: {verify: async () => verified},
        transactionFinalize: async (client, selected, receipt) => {
          if (!exactScope(selected, current.binding) || receipt.loadIdentityDigest !== current.loadIdentityDigest
            || receipt.captureIdentityDigest !== current.captureIdentityDigest || receipt.verifierProfileVersion !== PROFILE)
            return false;
          const inserted = await client.query(`INSERT INTO orchestration_loaded_document_verification_results
            (tenant_id,job_id,load_identity_digest,capture_identity_digest,verifier_profile_version,result_digest,
             attempt_no,handler_count,match_count,unobserved_diagnostic_count)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,job_id) DO NOTHING
            RETURNING job_id`, [tenantId, current.jobId, receipt.loadIdentityDigest, receipt.captureIdentityDigest,
            PROFILE, receipt.resultDigest, current.attemptCount, receipt.handlerCount, receipt.matchCount,
            receipt.unobservedDiagnosticCount]);
          if (inserted.rows.length !== 1) return false;
          const updated = await client.query(`UPDATE orchestration_loaded_document_verification_job_state
            SET state='succeeded',lease_worker_id=NULL,lease_instance_id=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
              safe_error_code=NULL,verification_error_code=NULL,verification_result_digest=$7,
              verification_attempt_no=$8,completed_at=(SELECT completed_at FROM orchestration_loaded_document_verification_results
                WHERE tenant_id=$1 AND job_id=$2),row_version=row_version+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND attempt_count=$3 AND lease_worker_id=$4
              AND lease_instance_id=$5 AND lease_token_hash=$6 AND lease_expires_at>clock_timestamp()
            RETURNING job_id`, [tenantId, current.jobId, current.attemptCount, workerId, instanceId,
            hash(current.leaseToken), receipt.resultDigest, current.attemptCount]);
          return updated.rowCount === 1;
        }});
      try {
        const receipt = await store.append({scope, captureIdentityDigest: current.captureIdentityDigest});
        return Object.freeze({kind: "succeeded", jobId: current.jobId, loadIdentityDigest: current.loadIdentityDigest,
          captureIdentityDigest: current.captureIdentityDigest, receipt});
      } catch (error) {
        const code = errorCode(error);
        if (code === "LOADED_DOCUMENT_VERIFICATION_UNVERIFIED") {
          let marked = false; try {marked = await recordFailure(current, "unverified");} catch { /* Fixed result only. */ }
          return Object.freeze({kind: marked ? "failed" : "deferred", jobId: current.jobId,
            loadIdentityDigest: current.loadIdentityDigest, captureIdentityDigest: current.captureIdentityDigest,
            reason: marked ? "unverified" : "lease_lost"});
        }
        if (code === "LOADED_DOCUMENT_VERIFICATION_STORAGE_ERROR" || finalStorageFailure) {
          let marked = false; try {marked = await recordFailure(current, "transient");} catch { /* Fixed result only. */ }
          return Object.freeze({kind: current.attemptCount >= 3 && marked ? "failed" : "deferred",
            jobId: current.jobId, loadIdentityDigest: current.loadIdentityDigest,
            captureIdentityDigest: current.captureIdentityDigest, reason: marked ? "transient" : "lease_lost"});
        }
        return Object.freeze({kind: "deferred", jobId: current.jobId, loadIdentityDigest: current.loadIdentityDigest,
          captureIdentityDigest: current.captureIdentityDigest, reason: "lease_lost"});
      }
    } finally {activeSessions -= 1;}
  }});
}
