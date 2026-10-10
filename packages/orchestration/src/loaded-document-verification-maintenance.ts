import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {parseConfig} from "@api-truth/ir";
import {canonicalOrchestrationHash, canonicalOrchestrationJson, compareUtf8} from "./canonical.js";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";

const CAPABILITY = "swagger.document.verify.manage";
const PROFILE = "swagger-loaded-document-1";
const PARENT_PROFILE = "protected-handler-bytes-1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const HOST_NAME = /^[A-Za-z0-9_.:@-]{1,128}$/;
const FINGERPRINT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const MAX_CONFIG_BYTES = 1_000_000;
const DEFAULT_BATCH = 50;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);
const positiveCheckpoint = (value: unknown): value is string => typeof value === "string"
  && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;

type Active = {config_fingerprint: string; config_version: string; document_sha256: string;
  checkpoint_version: string; document: unknown};
type Job = {tenant_id: string; job_id: string; capture_identity_digest: string; load_identity_digest: string;
  verifier_profile_version: string; parent_verifier_profile_version: string;
  repository_id: string; service_id: string; environment: string; service_root: string;
  config_fingerprint: string; config_document_sha256: string; config_checkpoint_version: string;
  state: string};
type State = {state: string};
export type LoadedDocumentVerificationCancellationBinding = Readonly<{tenantId: string; principalId: string;
  capability: typeof CAPABILITY; jobId: string; captureIdentityDigest: string; loadIdentityDigest: string;
  verifierProfileVersion: typeof PROFILE; repositoryId: string; serviceId: string;
  environment: string; serviceRoot: string; oldConfigFingerprint: string;
  oldConfigDocumentSha256: string; oldCheckpointVersion: string;
  currentConfigFingerprint: string; currentConfigDocumentSha256: string;
  currentCheckpointVersion: string}>;
export type LoadedDocumentVerificationMaintenanceOptions = {schema: string; tenantId: string; principalId: string;
  allowedRepositories: readonly string[]; allowedServices: readonly string[]; batchSize?: number;
  /** A separate swagger.document.verify.manage capability is required before any database access. */
  preflightAuthorize(context: Readonly<{tenantId: string; principalId: string;
    capability: typeof CAPABILITY}>): Promise<boolean>;
  /** Bounded DB-local manager permission, applicable to the old job even if its service was removed.
   * It must lock its independent manager grant on the supplied transaction client; no network I/O. */
  authorizeCancel(client: PoolClient, binding: LoadedDocumentVerificationCancellationBinding): Promise<boolean>};
export type LoadedDocumentVerificationMaintenanceResult = Readonly<{cancelledCount: number;
  coverage: "partial"; batchLimited: boolean}>;
const MESSAGES = {INVALID_LOADED_DOCUMENT_MAINTENANCE_CONFIGURATION: "Invalid loaded-document maintenance configuration",
  LOADED_DOCUMENT_MAINTENANCE_UNAUTHORIZED: "Loaded-document maintenance unauthorized",
  LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR: "Loaded-document maintenance storage error"} as const;
export class LoadedDocumentVerificationMaintenanceError extends Error {
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
    return new Set(names).size === names.length ? names.sort(compareUtf8) : undefined;
  } catch { return undefined; }
}
function activeConfig(row: Active | undefined) {
  if (!row || !matches(FINGERPRINT, row.config_fingerprint) || !matches(DIGEST, row.document_sha256)
    || !positiveCheckpoint(row.checkpoint_version))
    throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR");
  try {
    const parsed = parseConfig(row.document);
    if (!parsed.ok || parsed.value.config_version !== row.config_version
      || canonicalOrchestrationHash(parsed.value) !== row.document_sha256
      || Buffer.byteLength(canonicalOrchestrationJson(parsed.value), "utf8") > MAX_CONFIG_BYTES) throw Error();
    return Object.freeze({fingerprint: row.config_fingerprint,
      documentSha256: row.document_sha256, checkpointVersion: row.checkpoint_version});
  } catch { throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR"); }
}
const oldJob = (job: Job, active: ReturnType<typeof activeConfig>, tenantId: string) => {
  if (job.tenant_id !== tenantId || !matches(DIGEST, job.job_id)
    || !matches(DIGEST, job.capture_identity_digest) || !matches(DIGEST, job.load_identity_digest)
    || job.verifier_profile_version !== PROFILE || job.parent_verifier_profile_version !== PARENT_PROFILE
    || !matches(NAME, job.repository_id) || !matches(NAME, job.service_id)
    || !matches(NAME, job.environment) || !matches(ROOT, job.service_root)
    || job.service_root.length > 1024 || job.service_root !== "."
      && job.service_root.split("/").some(part => part === "." || part === "..")
    || !matches(FINGERPRINT, job.config_fingerprint) || !matches(DIGEST, job.config_document_sha256)
    || !positiveCheckpoint(job.config_checkpoint_version) || job.state !== "queued") return false;
  if (job.config_fingerprint === active.fingerprint && job.config_document_sha256 === active.documentSha256
    && job.config_checkpoint_version === active.checkpointVersion) return false;
  return canonicalOrchestrationHash({kind: "loaded_document_verification_admission", tenantId,
    loadIdentityDigest: job.load_identity_digest, verifierProfileVersion: PROFILE,
    serviceRoot: job.service_root, configFingerprint: job.config_fingerprint,
    configDocumentSha256: job.config_document_sha256,
    checkpointVersion: job.config_checkpoint_version}) === job.job_id;
};
const JOB_COLUMNS = `job.tenant_id,job.job_id,job.capture_identity_digest,job.load_identity_digest,
  job.verifier_profile_version,job.parent_verifier_profile_version,
  job.repository_id,job.service_id,job.environment,job.service_root,job.config_fingerprint,
  job.config_document_sha256,job.config_checkpoint_version::text,job.state`;

/** Cancels bounded old-epoch loaded-document jobs. It never selects protected receipt/key references. */
export function createLoadedDocumentVerificationMaintenance(pool: Pool, options: LoadedDocumentVerificationMaintenanceOptions): {
  cancelSuperseded(): Promise<LoadedDocumentVerificationMaintenanceResult>} {
  const raw = ownData(options, ["schema", "tenantId", "principalId", "allowedRepositories",
    "allowedServices", "preflightAuthorize", "authorizeCancel"], ["batchSize"]);
  let schema: string;
  try { schema = raw?.schema as string; quoteOrchestrationSchemaIdentifier(schema); }
  catch { throw new LoadedDocumentVerificationMaintenanceError("INVALID_LOADED_DOCUMENT_MAINTENANCE_CONFIGURATION"); }
  const repositories = safeNames(raw?.allowedRepositories), services = safeNames(raw?.allowedServices);
  const batchSize = raw && Object.hasOwn(raw, "batchSize") ? raw.batchSize : DEFAULT_BATCH;
  if (!raw || !repositories || !services || !matches(NAME, raw.tenantId) || !matches(HOST_NAME, raw.principalId)
    || !Number.isSafeInteger(batchSize) || (batchSize as number) < 1 || (batchSize as number) > 100
    || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.authorizeCancel !== "function" || isProxy(raw.authorizeCancel))
    throw new LoadedDocumentVerificationMaintenanceError("INVALID_LOADED_DOCUMENT_MAINTENANCE_CONFIGURATION");
  const tenantId = raw.tenantId, principalId = raw.principalId;
  const preflight = raw.preflightAuthorize as LoadedDocumentVerificationMaintenanceOptions["preflightAuthorize"];
  const authorize = raw.authorizeCancel as LoadedDocumentVerificationMaintenanceOptions["authorizeCancel"];
  const context = Object.freeze({tenantId, principalId, capability: CAPABILITY as typeof CAPABILITY});
  return Object.freeze({async cancelSuperseded(): Promise<LoadedDocumentVerificationMaintenanceResult> {
    let allowed = false;
    try { allowed = await preflight(context) === true; } catch { /* Deny before DB lookup. */ }
    if (!allowed) throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_UNAUTHORIZED");
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR"); }
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, schema);
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`api-truth:loaded-document-admission:${tenantId}`]);
      const activeRows = await client.query<Active>(`SELECT configuration.config_fingerprint,
        configuration.config_version,configuration.document_sha256,active.checkpoint_version::text,
        CASE WHEN octet_length(configuration.document::text)<=$2 THEN configuration.document ELSE NULL END AS document
        FROM orchestration_active_configurations active JOIN orchestration_configurations configuration
          ON configuration.tenant_id=active.tenant_id AND configuration.config_fingerprint=active.config_fingerprint
        WHERE active.tenant_id=$1 FOR SHARE OF active`, [tenantId, MAX_CONFIG_BYTES]);
      if (activeRows.rows.length !== 1)
        throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR");
      const active = activeConfig(activeRows.rows[0]);
      const candidates = await client.query<Job>(`SELECT ${JOB_COLUMNS}
        FROM orchestration_loaded_document_verification_jobs job
        JOIN orchestration_loaded_document_verification_job_state lifecycle
          ON lifecycle.tenant_id=job.tenant_id AND lifecycle.job_id=job.job_id
        WHERE job.tenant_id=$1 AND job.repository_id=ANY($2::text[]) AND job.service_id=ANY($3::text[])
          AND (job.config_fingerprint<>$4 OR job.config_document_sha256<>$5
            OR job.config_checkpoint_version<>$6)
          AND lifecycle.state IN ('queued','leased','retry_wait')
        ORDER BY job.job_id COLLATE "C" LIMIT $7`,
      [tenantId, repositories, services, active.fingerprint, active.documentSha256,
        active.checkpointVersion, (batchSize as number) + 1]);
      let cancelledCount = 0;
      for (const job of candidates.rows.slice(0, batchSize as number)) {
        if (cancelledCount >= (batchSize as number)) break;
        if (!oldJob(job, active, tenantId))
          throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR");
        const states = await client.query<State>(`SELECT state FROM orchestration_loaded_document_verification_job_state
          WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE SKIP LOCKED`, [tenantId, job.job_id]);
        if (states.rows.length !== 1 || !states.rows[0]
          || !["queued", "leased", "retry_wait"].includes(states.rows[0].state)) continue;
        const binding: LoadedDocumentVerificationCancellationBinding = Object.freeze({tenantId, principalId,
          capability: CAPABILITY, jobId: job.job_id, captureIdentityDigest: job.capture_identity_digest,
          loadIdentityDigest: job.load_identity_digest,
          verifierProfileVersion: PROFILE, repositoryId: job.repository_id, serviceId: job.service_id,
          environment: job.environment, serviceRoot: job.service_root,
          oldConfigFingerprint: job.config_fingerprint,
          oldConfigDocumentSha256: job.config_document_sha256,
          oldCheckpointVersion: job.config_checkpoint_version,
          currentConfigFingerprint: active.fingerprint,
          currentConfigDocumentSha256: active.documentSha256,
          currentCheckpointVersion: active.checkpointVersion});
        let permitted = false;
        try { permitted = await authorize(client, binding) === true; }
        catch { throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR"); }
        if (!permitted) continue;
        const updated = await client.query(`UPDATE orchestration_loaded_document_verification_job_state
          SET state='cancelled',lease_worker_id=NULL,lease_instance_id=NULL,lease_token_hash=NULL,
            lease_expires_at=NULL,safe_error_code=NULL,terminal_reason='LOADED_DOCUMENT_CONFIG_SUPERSEDED',
            verification_error_code=NULL,
            row_version=row_version+1,
            updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND job_id=$2 AND state IN ('queued','leased','retry_wait')`,
        [tenantId, job.job_id]);
        if (updated.rowCount !== 1)
          throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR");
        cancelledCount += 1;
      }
      await client.query("COMMIT");
      return Object.freeze({cancelledCount, coverage: "partial", batchLimited: candidates.rows.length > (batchSize as number)});
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isProxy(error) && error instanceof LoadedDocumentVerificationMaintenanceError) throw error;
      throw new LoadedDocumentVerificationMaintenanceError("LOADED_DOCUMENT_MAINTENANCE_STORAGE_ERROR");
    } finally { client.release(); }
  }});
}
