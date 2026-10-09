import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import type {Pool, PoolClient} from "pg";
import {canonicalJsonStringify} from "@api-truth/ir";
import {quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath} from "./database.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const REVISION = /^[a-fA-F0-9]{12,128}$/;
const ARTIFACT = /^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY = /^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const POLICY = "runtime-capture-pin-1";
const SCOPE_KEYS = ["tenantId", "repositoryId", "serviceId", "immutableRevision", "sourceDigest", "environment"] as const;
const PIN_KEYS = ["kind", "policyVersion", "scope", "artifactRef", "configuredKeyRef", "receiptDigest",
  "signerSpkiDigest", "identityDigest", "sessionId", "capturedAt", "signedScopeFields", "hostBoundScopeFields"] as const;
const hash = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

export type ObservedCaptureScope = {tenantId: string; repositoryId: string; serviceId: string;
  immutableRevision: string; sourceDigest: string; environment: string};
export type ObservedCapturePin = {kind: "pinned_envelope"; policyVersion: typeof POLICY;
  scope: ObservedCaptureScope; artifactRef: string; configuredKeyRef: string; receiptDigest: string;
  signerSpkiDigest: string; identityDigest: string; sessionId: string; capturedAt: string;
  signedScopeFields: readonly string[]; hostBoundScopeFields: readonly string[]};
export type ObservedCaptureAssociationOptions = {schema: string;
  /** Trusted host authorization before external receipt/key access. */
  preflightAuthorize(scope: Readonly<ObservedCaptureScope>): Promise<boolean>;
  /** Trusted DB-local authorization: lock/check grants using this same transaction client; no network I/O. */
  transactionAuthorize(client: PoolClient, scope: Readonly<ObservedCaptureScope>): Promise<boolean>;
  /** Host-installed external signed receipt resolver; never supplied by a request or repository. */
  pinResolver: {resolve(scope: ObservedCaptureScope): Promise<ObservedCapturePin>}};
export type ObservedCaptureAssociationReceipt = {outcome: "inserted" | "existing";
  captureIdentityDigest: string; scope: ObservedCaptureScope; receiptDigest: string; signerSpkiDigest: string};

const MESSAGES = {INVALID_CAPTURE_ASSOCIATION_REQUEST: "Invalid capture association request",
  CAPTURE_ASSOCIATION_UNAUTHORIZED: "Capture association unauthorized",
  CAPTURE_ASSOCIATION_UNVERIFIED: "Capture association unverified",
  CAPTURE_ASSOCIATION_CONFLICT: "Capture association conflict",
  CAPTURE_ASSOCIATION_STORAGE_ERROR: "Capture association storage error"} as const;
export class ObservedCaptureAssociationError extends Error {
  readonly code: keyof typeof MESSAGES;
  constructor(code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.code = code; }
}

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) return undefined;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      result[key] = descriptor.value;
    }
    return result;
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
function safePin(value: unknown, expected: ObservedCaptureScope): ObservedCapturePin | undefined {
  const raw = ownData(value, PIN_KEYS), scope = safeScope(raw?.scope);
  if (!raw || !scope || raw.kind !== "pinned_envelope" || raw.policyVersion !== POLICY
    || SCOPE_KEYS.some(key => scope[key] !== expected[key])
    || !matches(ARTIFACT, raw.artifactRef) || !matches(KEY, raw.configuredKeyRef)
    || !matches(DIGEST, raw.receiptDigest) || !matches(DIGEST, raw.signerSpkiDigest)
    || !matches(DIGEST, raw.identityDigest)
    || !matches(NAME, raw.sessionId) || typeof raw.capturedAt !== "string" || raw.capturedAt.length > 30) return undefined;
  const calculated = hash(canonicalJsonStringify({policyVersion: POLICY, scope,
    artifactRef: raw.artifactRef, configuredKeyRef: raw.configuredKeyRef,
    receiptDigest: raw.receiptDigest, signerSpkiDigest: raw.signerSpkiDigest}));
  if (calculated !== raw.identityDigest) return undefined;
  return {kind: "pinned_envelope", policyVersion: POLICY, scope, artifactRef: raw.artifactRef,
    configuredKeyRef: raw.configuredKeyRef, receiptDigest: raw.receiptDigest,
    signerSpkiDigest: raw.signerSpkiDigest, identityDigest: raw.identityDigest,
    sessionId: raw.sessionId, capturedAt: raw.capturedAt,
    signedScopeFields: [], hostBoundScopeFields: []};
}

type Stored = {tenant_id: string; capture_identity_digest: string; repository_id: string; service_id: string;
  immutable_revision: string; source_digest: string; environment: string; policy_version: string;
  artifact_ref: string; configured_key_ref: string; receipt_digest: string; signer_spki_digest: string};
const equal = (row: Stored, pin: ObservedCapturePin): boolean => row.tenant_id === pin.scope.tenantId
  && row.capture_identity_digest === pin.identityDigest && row.repository_id === pin.scope.repositoryId
  && row.service_id === pin.scope.serviceId && row.immutable_revision === pin.scope.immutableRevision
  && row.source_digest === pin.scope.sourceDigest && row.environment === pin.scope.environment
  && row.policy_version === pin.policyVersion && row.artifact_ref === pin.artifactRef
  && row.configured_key_ref === pin.configuredKeyRef && row.receipt_digest === pin.receiptDigest
  && row.signer_spki_digest === pin.signerSpkiDigest;

/** Append-only receipt provenance. It never reads or writes D08 snapshot/pointer tables. */
export function createObservedCaptureAssociationStore(pool: Pool, options: ObservedCaptureAssociationOptions): {
  append(scope: ObservedCaptureScope): Promise<ObservedCaptureAssociationReceipt>} {
  const raw = ownData(options, ["schema", "preflightAuthorize", "transactionAuthorize", "pinResolver"]);
  const resolver = ownData(raw?.pinResolver, ["resolve"]);
  let schema: string;
  try { schema = raw?.schema as string; quoteOrchestrationSchemaIdentifier(schema); }
  catch { throw new ObservedCaptureAssociationError("INVALID_CAPTURE_ASSOCIATION_REQUEST"); }
  if (!raw || !resolver || typeof raw.preflightAuthorize !== "function" || isProxy(raw.preflightAuthorize)
    || typeof raw.transactionAuthorize !== "function" || isProxy(raw.transactionAuthorize)
    || typeof resolver.resolve !== "function" || isProxy(resolver.resolve))
    throw new ObservedCaptureAssociationError("INVALID_CAPTURE_ASSOCIATION_REQUEST");
  const preflightAuthorize = raw.preflightAuthorize as ObservedCaptureAssociationOptions["preflightAuthorize"];
  const transactionAuthorize = raw.transactionAuthorize as ObservedCaptureAssociationOptions["transactionAuthorize"];
  const resolve = (resolver.resolve as ObservedCaptureAssociationOptions["pinResolver"]["resolve"]).bind(raw.pinResolver);
  return Object.freeze({async append(candidate: ObservedCaptureScope): Promise<ObservedCaptureAssociationReceipt> {
    const scope = safeScope(candidate);
    if (!scope) throw new ObservedCaptureAssociationError("INVALID_CAPTURE_ASSOCIATION_REQUEST");
    let preflight = false;
    try { preflight = await preflightAuthorize(scope) === true; } catch { /* Deny. */ }
    if (!preflight) throw new ObservedCaptureAssociationError("CAPTURE_ASSOCIATION_UNAUTHORIZED");
    let pin: ObservedCapturePin | undefined;
    try { pin = safePin(await resolve(scope), scope); } catch { /* Withhold. */ }
    if (!pin) throw new ObservedCaptureAssociationError("CAPTURE_ASSOCIATION_UNVERIFIED");
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { throw new ObservedCaptureAssociationError("CAPTURE_ASSOCIATION_STORAGE_ERROR"); }
    try {
      await client.query("BEGIN");
      await setOrchestrationSearchPath(client, schema);
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      let authorized = false;
      try { authorized = await transactionAuthorize(client, scope) === true; } catch { /* Deny. */ }
      if (!authorized) throw new ObservedCaptureAssociationError("CAPTURE_ASSOCIATION_UNAUTHORIZED");
      const insert = await client.query(
        `INSERT INTO orchestration_observed_capture_associations
         (tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,environment,
          policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id,capture_identity_digest) DO NOTHING`,
        [scope.tenantId, pin.identityDigest, scope.repositoryId, scope.serviceId, scope.immutableRevision,
          scope.sourceDigest, scope.environment, pin.policyVersion, pin.artifactRef, pin.configuredKeyRef,
          pin.receiptDigest, pin.signerSpkiDigest]);
      const stored = await client.query<Stored>(
        `SELECT tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,
          environment,policy_version,artifact_ref,configured_key_ref,receipt_digest,signer_spki_digest
         FROM orchestration_observed_capture_associations WHERE tenant_id=$1 AND capture_identity_digest=$2 FOR SHARE`,
        [scope.tenantId, pin.identityDigest]);
      if (stored.rows.length !== 1 || !equal(stored.rows[0]!, pin))
        throw new ObservedCaptureAssociationError("CAPTURE_ASSOCIATION_CONFLICT");
      await client.query("COMMIT");
      return Object.freeze({outcome: insert.rowCount === 1 ? "inserted" : "existing",
        captureIdentityDigest: pin.identityDigest, scope, receiptDigest: pin.receiptDigest,
        signerSpkiDigest: pin.signerSpkiDigest});
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof ObservedCaptureAssociationError) throw error;
      throw new ObservedCaptureAssociationError("CAPTURE_ASSOCIATION_STORAGE_ERROR");
    } finally { client.release(); }
  }});
}
