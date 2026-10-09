import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {canonicalJsonStringify} from "@api-truth/ir";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";
import type {ObservedCaptureScope} from "./observed-captures.js";

const PROFILE = "protected-handler-bytes-1";
const POLICY = "runtime-capture-pin-1";
const LIMITATION = "Document operation correspondence and deployment are unverified";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REVISION = /^[a-fA-F0-9]{12,128}$/;
const ROOT = /^(?:\.|[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*)$/;
const HANDLER_PATH = /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/;
const IDENTIFIER = /^[A-Za-z0-9_$.-]{1,128}$/;
const METHOD = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const REQUEST_KEYS = ["scope", "captureIdentityDigest"] as const;
const RESULT_KEYS = ["kind", "scope", "serviceRoot", "captureIdentityDigest", "receiptDigest", "signerSpkiDigest",
  "sourceDigest", "handlers", "limitations"] as const;
const HANDLER_KEYS = ["method", "applicationPath", "controller", "operationId", "handlerPath", "handlerDigest", "exportName"] as const;
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

export type ObservedCaptureVerificationOptions = {schema: string;
  /** Host permission before parent lookup or verification. */
  preflightAuthorize(scope: Readonly<ObservedCaptureScope>): Promise<boolean>;
  /** Bounded DB-local grant check/lock using the SAME write transaction. No network I/O. */
  transactionAuthorize(client: PoolClient, scope: Readonly<ObservedCaptureScope>): Promise<boolean>;
  /** Host-installed, capture-bound byte verifier. A caller never supplies its result. */
  verificationPort: {verify(): Promise<unknown>}};
export type ObservedCaptureVerificationReceipt = {outcome: "inserted" | "existing";
  captureIdentityDigest: string; verifierProfileVersion: typeof PROFILE; serviceRoot: string;
  resultDigest: string; handlerCount: number};
const MESSAGES = {INVALID_CAPTURE_VERIFICATION_REQUEST: "Invalid capture verification request",
  CAPTURE_VERIFICATION_UNAUTHORIZED: "Capture verification unauthorized",
  CAPTURE_VERIFICATION_UNVERIFIED: "Capture verification unverified",
  CAPTURE_VERIFICATION_CONFLICT: "Capture verification conflict",
  CAPTURE_VERIFICATION_STORAGE_ERROR: "Capture verification storage error"} as const;
export class ObservedCaptureVerificationError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.code = code; }
}

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) return undefined;
    const detached: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      detached[key] = descriptor.value;
    }
    return detached;
  } catch { return undefined; }
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
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch { return undefined; }
}
function safeScope(value: unknown): ObservedCaptureScope | undefined {
  const raw = ownData(value, SCOPE_KEYS);
  if (!raw || !matches(NAME, raw.tenantId) || !matches(NAME, raw.repositoryId)
    || !matches(NAME, raw.serviceId) || !matches(REVISION, raw.immutableRevision)
    || !matches(DIGEST, raw.sourceDigest) || !matches(NAME, raw.environment)) return undefined;
  return Object.freeze({tenantId: raw.tenantId, repositoryId: raw.repositoryId, serviceId: raw.serviceId,
    immutableRevision: raw.immutableRevision, sourceDigest: raw.sourceDigest, environment: raw.environment});
}
type Parent = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string;
  artifact_ref: string; configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
function validParent(row: Parent | undefined, scope: ObservedCaptureScope, identity: string): row is Parent {
  if (!row || row.tenant_id !== scope.tenantId || row.repository_id !== scope.repositoryId
    || row.service_id !== scope.serviceId || row.immutable_revision !== scope.immutableRevision
    || row.source_digest !== scope.sourceDigest || row.environment !== scope.environment
    || row.capture_identity_digest !== identity || row.policy_version !== POLICY
    || !matches(/^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, row.artifact_ref)
    || !matches(/^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, row.configured_key_ref)
    || !matches(DIGEST, row.receipt_digest) || !matches(DIGEST, row.signer_spki_digest)) return false;
  return identity === hash(canonicalJsonStringify({policyVersion: POLICY, scope,
    artifactRef: row.artifact_ref, configuredKeyRef: row.configured_key_ref,
    receiptDigest: row.receipt_digest, signerSpkiDigest: row.signer_spki_digest}));
}
function safeVerification(value: unknown, scope: ObservedCaptureScope, identity: string, parent: Parent) {
  const raw = ownData(value, RESULT_KEYS), selected = safeScope(raw?.scope);
  if (!raw || !selected || raw.kind !== "verified_handler_bytes" || raw.captureIdentityDigest !== identity
    || SCOPE_KEYS.some(key => selected[key] !== scope[key])
    || raw.sourceDigest !== parent.source_digest || raw.receiptDigest !== parent.receipt_digest
    || raw.signerSpkiDigest !== parent.signer_spki_digest
    || !matches(ROOT, raw.serviceRoot) || raw.serviceRoot.length > 1024
    || raw.serviceRoot !== "." && raw.serviceRoot.split("/").some(part => part === "." || part === "..")) return undefined;
  const limitations = safeArray(raw.limitations, 1, 1);
  const handlers = safeArray(raw.handlers, 1, 1024);
  if (!limitations || limitations[0] !== LIMITATION || !handlers) return undefined;
  const detached = [], seen = new Set<string>();
  for (const candidate of handlers) {
    const handler = ownData(candidate, HANDLER_KEYS);
    if (!handler || !METHOD.has(handler.method as string)
      || typeof handler.applicationPath !== "string" || handler.applicationPath.length < 1
      || handler.applicationPath.length > 2048 || !handler.applicationPath.startsWith("/")
      || /[\u0000-\u001f\u007f]/u.test(handler.applicationPath)
      || !matches(NAME, handler.controller) || !matches(IDENTIFIER, handler.operationId)
      || !matches(IDENTIFIER, handler.exportName) || handler.operationId !== handler.exportName
      || !matches(HANDLER_PATH, handler.handlerPath) || handler.handlerPath.length > 1024
      || handler.handlerPath.split("/").some(part => part === "." || part === "..")
      || !matches(DIGEST, handler.handlerDigest)) return undefined;
    const key = `${handler.method}\u0000${handler.applicationPath}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    detached.push({method: handler.method, applicationPath: handler.applicationPath, controller: handler.controller,
      operationId: handler.operationId, handlerPath: handler.handlerPath, handlerDigest: handler.handlerDigest,
      exportName: handler.exportName});
  }
  const projection = {verifierProfileVersion: PROFILE, kind: "verified_handler_bytes", scope,
    serviceRoot: raw.serviceRoot, captureIdentityDigest: identity, receiptDigest: parent.receipt_digest,
    signerSpkiDigest: parent.signer_spki_digest, sourceDigest: parent.source_digest,
    handlers: detached, limitations: [LIMITATION]};
  const canonical = canonicalJsonStringify(projection);
  if (Buffer.byteLength(canonical, "utf8") > 1_000_000) return undefined;
  return Object.freeze({serviceRoot: raw.serviceRoot, handlerCount: detached.length, resultDigest: hash(canonical)});
}
const PARENT_SELECT = `SELECT tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,
  source_digest,environment,policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest
  FROM orchestration_observed_capture_associations WHERE tenant_id=$1 AND capture_identity_digest=$2`;
type Stored = {tenant_id: string; capture_identity_digest: string; verifier_profile_version: string;
  service_root: string; source_digest: string; receipt_digest: string; signer_spki_digest: string;
  result_digest: string; handler_count: number};

/** Append-only, capture-qualified summary of trusted handler-byte verification. No catalog/IR promotion. */
export function createObservedCaptureVerificationStore(pool: Pool, options: ObservedCaptureVerificationOptions): {
  append(request: {scope: ObservedCaptureScope; captureIdentityDigest: string}): Promise<ObservedCaptureVerificationReceipt>} {
  const raw = ownData(options, ["schema", "preflightAuthorize", "transactionAuthorize", "verificationPort"]);
  const port = ownData(raw?.verificationPort, ["verify"]);
  let schema: string;
  try { schema = raw?.schema as string; quoteOrchestrationSchemaIdentifier(schema); }
  catch { throw new ObservedCaptureVerificationError("INVALID_CAPTURE_VERIFICATION_REQUEST"); }
  if (!raw || !port || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.transactionAuthorize !== "function" || isProxy(raw.transactionAuthorize)
    || typeof port.verify !== "function" || isProxy(port.verify))
    throw new ObservedCaptureVerificationError("INVALID_CAPTURE_VERIFICATION_REQUEST");
  const preflightAuthorize = raw.preflightAuthorize as ObservedCaptureVerificationOptions["preflightAuthorize"];
  const transactionAuthorize = raw.transactionAuthorize as ObservedCaptureVerificationOptions["transactionAuthorize"];
  const verify = (port.verify as ObservedCaptureVerificationOptions["verificationPort"]["verify"]).bind(raw.verificationPort);
  return Object.freeze({async append(candidate: {scope: ObservedCaptureScope; captureIdentityDigest: string}): Promise<ObservedCaptureVerificationReceipt> {
    const input = ownData(candidate, REQUEST_KEYS), scope = safeScope(input?.scope);
    if (!input || !scope || !matches(DIGEST, input.captureIdentityDigest))
      throw new ObservedCaptureVerificationError("INVALID_CAPTURE_VERIFICATION_REQUEST");
    const identity = input.captureIdentityDigest;
    let allowed = false;
    try { allowed = await preflightAuthorize(scope) === true; } catch { /* Deny. */ }
    if (!allowed) throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_UNAUTHORIZED");
    let parent: Parent | undefined;
    try {
      const schemaSql = quoteOrchestrationSchemaIdentifier(schema);
      const result = await pool.query<Parent>(PARENT_SELECT.replace("FROM orchestration_", `FROM ${schemaSql}.orchestration_`),
        [scope.tenantId, identity]);
      parent = result.rows.length === 1 ? result.rows[0] : undefined;
    } catch { throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_STORAGE_ERROR"); }
    if (!validParent(parent, scope, identity))
      throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_UNAUTHORIZED");
    let verification: ReturnType<typeof safeVerification>;
    try { verification = safeVerification(await verify(), scope, identity, parent); } catch { /* Withhold. */ }
    if (!verification) throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_UNVERIFIED");
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_STORAGE_ERROR"); }
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, schema);
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      let authorized = false;
      try { authorized = await transactionAuthorize(client, scope) === true; } catch { /* Deny. */ }
      if (!authorized) throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_UNAUTHORIZED");
      const current = await client.query<Parent>(`${PARENT_SELECT} FOR SHARE`, [scope.tenantId, identity]);
      if (current.rows.length !== 1 || !validParent(current.rows[0], scope, identity))
        throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_UNAUTHORIZED");
      if (canonicalJsonStringify(current.rows[0]) !== canonicalJsonStringify(parent))
        throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_CONFLICT");
      const insert = await client.query(
        `INSERT INTO orchestration_observed_capture_verifications
         (tenant_id,capture_identity_digest,verifier_profile_version,service_root,source_digest,
          receipt_digest,signer_spki_digest,result_digest,handler_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id,capture_identity_digest,verifier_profile_version) DO NOTHING`,
        [scope.tenantId, identity, PROFILE, verification.serviceRoot, parent.source_digest,
          parent.receipt_digest, parent.signer_spki_digest, verification.resultDigest, verification.handlerCount]);
      const result = await client.query<Stored>(`SELECT tenant_id,capture_identity_digest,verifier_profile_version,
        service_root,source_digest,receipt_digest,signer_spki_digest,result_digest,handler_count
        FROM orchestration_observed_capture_verifications
        WHERE tenant_id=$1 AND capture_identity_digest=$2 AND verifier_profile_version=$3 FOR SHARE`,
      [scope.tenantId, identity, PROFILE]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || row.tenant_id !== scope.tenantId
        || row.capture_identity_digest !== identity || row.verifier_profile_version !== PROFILE
        || row.service_root !== verification.serviceRoot || row.source_digest !== parent.source_digest
        || row.receipt_digest !== parent.receipt_digest || row.signer_spki_digest !== parent.signer_spki_digest
        || row.result_digest !== verification.resultDigest || row.handler_count !== verification.handlerCount)
        throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_CONFLICT");
      await client.query("COMMIT");
      return Object.freeze({outcome: insert.rowCount === 1 ? "inserted" : "existing",
        captureIdentityDigest: identity, verifierProfileVersion: PROFILE, serviceRoot: verification.serviceRoot,
        resultDigest: verification.resultDigest, handlerCount: verification.handlerCount});
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof ObservedCaptureVerificationError) throw error;
      throw new ObservedCaptureVerificationError("CAPTURE_VERIFICATION_STORAGE_ERROR");
    } finally { client.release(); }
  }});
}
