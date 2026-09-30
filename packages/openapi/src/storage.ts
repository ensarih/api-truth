import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseContractSnapshot, type ContractSnapshot } from "@api-truth/ir";
import { createCatalogStore, type PrincipalContext } from "@api-truth/catalog";
import { createEnvironmentViewRepository } from "@api-truth/environment";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../catalog/src/canonical.js";
import { prepareOpenApiPublication, type OpenApiPublicationPreparation, type OpenApiPublicationSelector } from "./preparation.js";
import { quoteOpenApiSchema } from "./migrations.js";
import { checkEnvironmentPin, type EnvironmentSelector } from "./environment-pin.js";
import { validateOpenApiDocument } from "./validation.js";

export type RevisionSelector = Extract<OpenApiPublicationSelector, { kind: "revision" }>;
export type BranchSelector = Extract<OpenApiPublicationSelector, { kind: "branch" }>;
export type { EnvironmentSelector } from "./environment-pin.js";
export type PublicationKey = Readonly<{ repositoryId: string; serviceId: string; kind: "revision"; revision: string }>
  | Readonly<{ repositoryId: string; serviceId: string; kind: "branch"; branch: string }>
  | Readonly<{ repositoryId: string; serviceId: string; kind: "environment"; environment: string }>;
export type ExpectedPublicationPointer = { state: "absent" } | { state: "present"; pointerVersion: string };
export type PublishedOpenApi = Readonly<{
  publicationId: string; contentSha256: string; pointerVersion?: string;
  bytes: Uint8Array; snapshotId: string;
}>;

export class OpenApiStorageError extends Error {
  constructor(public readonly code: "INVALID_PUBLICATION" | "UNSUPPORTED_SELECTOR" | "NOT_FOUND_OR_DENIED"
    | "STALE_POINTER" | "CORRUPT_STORAGE" | "STORAGE_ERROR", public readonly retryable = false) {
    super(code);
  }
}

const fail = (code: OpenApiStorageError["code"]): never => { throw new OpenApiStorageError(code); };
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const byteOrder = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));
const sha = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const version = /^[1-9][0-9]*$/;
const validContext = (context: PrincipalContext): void => {
  if (!context || !nonEmpty(context.tenantId) || !nonEmpty(context.principalId)) fail("INVALID_PUBLICATION");
};
const keyFromSelector = (selector: OpenApiPublicationSelector): PublicationKey => {
  if (selector.kind === "revision") return { repositoryId: selector.repositoryId, serviceId: selector.serviceId,
    kind: "revision", revision: selector.revision };
  if (selector.kind === "branch") return { repositoryId: selector.repositoryId, serviceId: selector.serviceId,
    kind: "branch", branch: selector.branch };
  if (selector.kind === "environment") return { repositoryId: selector.repositoryId,
    serviceId: selector.serviceId, kind: "environment", environment: selector.environment };
  return fail("INVALID_PUBLICATION");
};
const validKey = (key: PublicationKey): void => {
  const runtimeKind = (key as { kind?: unknown } | undefined)?.kind;
  if (!key || !nonEmpty(key.repositoryId) || !nonEmpty(key.serviceId)
    || key.kind === "revision" && !nonEmpty(key.revision)
    || key.kind === "branch" && !nonEmpty(key.branch)
    || key.kind === "environment" && !nonEmpty(key.environment)
    || runtimeKind !== "revision" && runtimeKind !== "branch" && runtimeKind !== "environment")
    fail("INVALID_PUBLICATION");
};
const selectorValue = (key: PublicationKey): string => key.kind === "revision" ? key.revision
  : key.kind === "branch" ? key.branch : key.environment;

const branchPointer = async (client: PoolClient, context: PrincipalContext,
  key: Extract<PublicationKey, { kind: "branch" }>): Promise<{ snapshotId: string; pointerVersion: string }> => {
  const selected = await client.query<{ snapshot_id: string; pointer_version: string;
    immutable_revision: string }>(
    `SELECT pointer.snapshot_id,pointer.pointer_version::text AS pointer_version,
       snapshot.immutable_revision FROM catalog_branch_pointers pointer
     JOIN catalog_snapshots snapshot ON snapshot.tenant_id=pointer.tenant_id
       AND snapshot.repository_id=pointer.repository_id AND snapshot.service_id=pointer.service_id
       AND snapshot.snapshot_id=pointer.snapshot_id
     WHERE pointer.tenant_id=$1 AND pointer.repository_id=$2 AND pointer.service_id=$3
       AND pointer.branch=$4 FOR SHARE OF pointer, snapshot`,
    [context.tenantId, key.repositoryId, key.serviceId, key.branch]);
  const row = selected.rows[0];
  if (!row) return fail("NOT_FOUND_OR_DENIED");
  const checkpoint = await client.query<{ desired_state: string; desired_revision: string | null;
    last_successful_snapshot_id: string | null; latest_outcome: string | null }>(
    `SELECT desired_state,desired_revision,last_successful_snapshot_id,latest_outcome
     FROM orchestration_branch_checkpoints WHERE tenant_id=$1 AND repository_id=$2
       AND service_id=$3 AND branch=$4 FOR SHARE`,
    [context.tenantId, key.repositoryId, key.serviceId, key.branch]);
  const state = checkpoint.rows[0];
  if (state && (state.desired_state !== "present" || state.desired_revision !== row.immutable_revision
    || state.last_successful_snapshot_id !== row.snapshot_id
    || state.latest_outcome === "reconciliation_required")) return fail("STALE_POINTER");
  return { snapshotId: row.snapshot_id, pointerVersion: row.pointer_version };
};

const authorizedPinnedScopes = async (client: PoolClient, context: PrincipalContext,
  scopeIds: readonly string[]): Promise<boolean> => {
  if (!Array.isArray(scopeIds) || scopeIds.length === 0
    || scopeIds.some((scopeId) => !nonEmpty(scopeId))
    || JSON.stringify(scopeIds) !== JSON.stringify([...new Set(scopeIds)].sort(byteOrder)))
    return fail("CORRUPT_STORAGE");
  const active = await client.query<{ access_scope_id: string }>(
    `SELECT access_scope_id FROM access_scopes WHERE tenant_id=$1
     AND access_scope_id=ANY($2::text[]) AND active ORDER BY access_scope_id COLLATE "C" FOR SHARE`,
    [context.tenantId, scopeIds]);
  const grants = await client.query<{ access_scope_id: string }>(
    `SELECT access_scope_id FROM principal_scope_grants WHERE tenant_id=$1 AND principal_id=$2
     AND access_scope_id=ANY($3::text[]) AND active ORDER BY access_scope_id COLLATE "C" FOR SHARE`,
    [context.tenantId, context.principalId, scopeIds]);
  return active.rows.length === scopeIds.length && grants.rows.length === scopeIds.length
    && scopeIds.every((scopeId, index) => active.rows[index]?.access_scope_id === scopeId
      && grants.rows[index]?.access_scope_id === scopeId);
};

type SnapshotRow = {
  repository_id: string; service_id: string; immutable_revision: string;
  config_fingerprint: string; identity_sha256: string; content_sha256: string;
  required_scope_ids: string[]; document: unknown;
};

const authorizedSnapshot = async (client: PoolClient, context: PrincipalContext, snapshotId: string): Promise<{
  snapshot: ContractSnapshot; contentSha256: string;
}> => {
  const selected = await client.query<SnapshotRow>(
    `SELECT repository_id, service_id, immutable_revision, config_fingerprint,
            identity_sha256, content_sha256, required_scope_ids, document
     FROM catalog_snapshots WHERE tenant_id = $1 AND snapshot_id = $2 FOR SHARE`,
    [context.tenantId, snapshotId]);
  const row = selected.rows[0];
  if (!row) return fail("NOT_FOUND_OR_DENIED");
  const scopes = row.required_scope_ids;
  if (!Array.isArray(scopes) || scopes.length === 0) return fail("CORRUPT_STORAGE");
  const active = await client.query<{ access_scope_id: string }>(
    `SELECT access_scope_id FROM access_scopes
     WHERE tenant_id = $1 AND access_scope_id = ANY($2::text[]) AND active
     ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [context.tenantId, scopes]);
  const grants = await client.query<{ access_scope_id: string }>(
    `SELECT access_scope_id FROM principal_scope_grants
     WHERE tenant_id = $1 AND principal_id = $2 AND access_scope_id = ANY($3::text[]) AND active
     ORDER BY access_scope_id COLLATE "C" FOR SHARE`, [context.tenantId, context.principalId, scopes]);
  const orderedScopes = [...scopes].sort(byteOrder);
  const same = (rows: { access_scope_id: string }[]) =>
    rows.length === orderedScopes.length
      && rows.every((item, index) => item.access_scope_id === orderedScopes[index]);
  if (!same(active.rows) || !same(grants.rows)) return fail("NOT_FOUND_OR_DENIED");
  const parsed = parseContractSnapshot(row.document);
  if (!parsed.ok) return fail("CORRUPT_STORAGE");
  const snapshot = parsed.value;
  if (snapshot.snapshot_id !== snapshotId || snapshot.service.repository_id !== row.repository_id
    || snapshot.service.service_id !== row.service_id
    || snapshot.source.immutable_revision !== row.immutable_revision
    || snapshot.config.config_fingerprint !== row.config_fingerprint
    || snapshotContentSha256(snapshot) !== row.content_sha256
    || snapshotIdentitySha256(snapshot) !== row.identity_sha256) return fail("CORRUPT_STORAGE");
  return { snapshot, contentSha256: row.content_sha256 };
};

const transaction = async <T>(pool: Pool, schema: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect().catch(() => { throw new OpenApiStorageError("STORAGE_ERROR"); });
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${quoteOpenApiSchema(schema)}, pg_catalog`);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof OpenApiStorageError) throw error;
    throw new OpenApiStorageError("STORAGE_ERROR");
  } finally { client.release(); }
};

const publicationId = (tenantId: string, preparation: OpenApiPublicationPreparation): string => {
  const p = preparation.provenance;
  return sha(Buffer.from(JSON.stringify([tenantId, p.selector.kind, p.selector.repositoryId,
    p.selector.serviceId, p.selector.kind === "revision" ? p.selector.revision
      : p.selector.kind === "branch" ? p.selector.branch : p.selector.environment,
    ...(p.selector.kind === "branch" ? [p.selector.pointerVersion]
      : p.selector.kind === "environment" ? [p.selector.checkpointVersion] : []),
    p.snapshotId, p.revision, p.configVersion, p.configFingerprint, p.sourceDigest,
    preparation.contentSha256]), "utf8"));
};

type PublicationRow = { publication_id: string; content_sha256: string; snapshot_id: string;
  repository_id: string; service_id: string; immutable_revision: string;
  selector_kind: string; selector_value: string; environment_scope_ids: string[] | null;
  config_version: string; config_fingerprint: string; source_digest: string;
  snapshot_content_sha256: string; bytes: Buffer; pointer_version?: string;
  branch_pointer_version?: string | null; environment_checkpoint_version?: string | null };
const verifyPublication = (row: PublicationRow, snapshot: ContractSnapshot, contentSha256: string): void => {
  if (row.repository_id !== snapshot.service.repository_id || row.service_id !== snapshot.service.service_id
    || row.immutable_revision !== snapshot.source.immutable_revision
    || row.config_version !== snapshot.config.config_version
    || row.config_fingerprint !== snapshot.config.config_fingerprint
    || row.source_digest !== snapshot.source.source_digest
    || row.snapshot_content_sha256 !== contentSha256) fail("CORRUPT_STORAGE");
};
const verifyManifest = (tenantId: string, row: PublicationRow, snapshot: ContractSnapshot): void => {
  const base = { repositoryId: row.repository_id, serviceId: row.service_id,
    snapshotId: row.snapshot_id, revision: row.immutable_revision,
    configFingerprint: row.config_fingerprint };
  let selector: OpenApiPublicationSelector;
  if (row.selector_kind === "revision" && row.selector_value === row.immutable_revision
    && row.branch_pointer_version == null && row.environment_checkpoint_version == null)
    selector = { kind: "revision", ...base };
  else if (row.selector_kind === "branch" && nonEmpty(row.selector_value)
    && row.branch_pointer_version && version.test(row.branch_pointer_version)
    && row.environment_checkpoint_version == null)
    selector = { kind: "branch", ...base, branch: row.selector_value,
      pointerVersion: row.branch_pointer_version };
  else if (row.selector_kind === "environment" && nonEmpty(row.selector_value)
    && row.environment_checkpoint_version && version.test(row.environment_checkpoint_version)
    && row.branch_pointer_version == null)
    selector = { kind: "environment", ...base, environment: row.selector_value,
      checkpointVersion: row.environment_checkpoint_version,
      resolvedSnapshotIds: [row.snapshot_id] };
  else return fail("CORRUPT_STORAGE");
  try {
    const checked = prepareOpenApiPublication({ snapshot, mode: "strict", selector });
    if (!checked.publishable || checked.contentSha256 !== row.content_sha256
      || !checked.bytes || !Buffer.from(checked.bytes).equals(row.bytes)
      || publicationId(tenantId, checked) !== row.publication_id
      || !validateOpenApiDocument(checked.document).ok) fail("CORRUPT_STORAGE");
  } catch { fail("CORRUPT_STORAGE"); }
};
const materialize = (row: PublicationRow): PublishedOpenApi => {
  if (sha(row.bytes) !== row.content_sha256) return fail("CORRUPT_STORAGE");
  return { publicationId: row.publication_id, contentSha256: row.content_sha256,
    ...(row.pointer_version === undefined ? {} : { pointerVersion: row.pointer_version }),
    bytes: new Uint8Array(row.bytes), snapshotId: row.snapshot_id };
};

export const createOpenApiPublicationStore = (pool: Pool, options: { schema: string }) => {
  quoteOpenApiSchema(options.schema);
  const catalog = createCatalogStore(pool, options);
  const environments = createEnvironmentViewRepository(pool, options);
  return {
    async prepareRevision(context: PrincipalContext, selector: RevisionSelector): Promise<OpenApiPublicationPreparation> {
      validContext(context);
      keyFromSelector(selector);
      const stored = await catalog.getSnapshot(context, selector.snapshotId);
      return prepareOpenApiPublication({ snapshot: stored.snapshot, mode: "strict", selector });
    },
    async prepareBranch(context: PrincipalContext,
      key: Extract<PublicationKey, { kind: "branch" }>): Promise<OpenApiPublicationPreparation> {
      validContext(context); validKey(key);
      if (key.kind !== "branch") return fail("INVALID_PUBLICATION");
      return transaction(pool, options.schema, async (client) => {
        const pointer = await branchPointer(client, context, key);
        const { snapshot } = await authorizedSnapshot(client, context, pointer.snapshotId);
        if (snapshot.service.repository_id !== key.repositoryId
          || snapshot.service.service_id !== key.serviceId) return fail("CORRUPT_STORAGE");
        const selector: BranchSelector = { kind: "branch", repositoryId: key.repositoryId,
          serviceId: key.serviceId, branch: key.branch, pointerVersion: pointer.pointerVersion,
          snapshotId: pointer.snapshotId, revision: snapshot.source.immutable_revision,
          configFingerprint: snapshot.config.config_fingerprint };
        return prepareOpenApiPublication({ snapshot, mode: "strict", selector });
      });
    },
    async prepareEnvironment(context: PrincipalContext,
      key: Extract<PublicationKey, { kind: "environment" }>): Promise<OpenApiPublicationPreparation> {
      validContext(context); validKey(key);
      if (key.kind !== "environment") return fail("INVALID_PUBLICATION");
      const view = await environments.getEnvironment(context, { repositoryId: key.repositoryId,
        serviceId: key.serviceId, environment: key.environment }).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error
          && error.code === "ENVIRONMENT_NOT_FOUND_OR_DENIED") return fail("NOT_FOUND_OR_DENIED");
        return fail("STORAGE_ERROR");
      });
      if (view.deployment !== "deployed" || view.contract !== "resolved" || !view.snapshotId
        || !view.checkpointVersion || view.reconciliationRequired) return fail("STALE_POINTER");
      const stored = await catalog.getSnapshot(context, view.snapshotId);
      const snapshot = stored.snapshot;
      const selector: EnvironmentSelector = { ...key,
        snapshotId: view.snapshotId, revision: snapshot.source.immutable_revision,
        configFingerprint: view.configFingerprint, checkpointVersion: view.checkpointVersion,
        resolvedSnapshotIds: [view.snapshotId] };
      return prepareOpenApiPublication({ snapshot, mode: "strict", selector });
    },
    async publish(context: PrincipalContext, prepared: OpenApiPublicationPreparation,
      expected: ExpectedPublicationPointer): Promise<PublishedOpenApi> {
      validContext(context);
      if (!prepared || prepared.mode !== "strict" || prepared.publishable !== true
        || !prepared.provenance || !prepared.contentSha256 || !prepared.bytes
        || !Array.isArray(prepared.diagnostics) || prepared.diagnostics.length !== 0) return fail("INVALID_PUBLICATION");
      const selector = prepared.provenance.selector;
      const key = keyFromSelector(selector);
      validKey(key);
      if (selector.kind === "branch" && !version.test(selector.pointerVersion)) return fail("INVALID_PUBLICATION");
      if (selector.kind === "environment" && !version.test(selector.checkpointVersion))
        return fail("INVALID_PUBLICATION");
      if (!expected || expected.state !== "absent" && (expected.state !== "present"
        || typeof expected.pointerVersion !== "string" || !version.test(expected.pointerVersion)))
        return fail("INVALID_PUBLICATION");
      const bytes = new Uint8Array(prepared.bytes);
      if (sha(bytes) !== prepared.contentSha256) return fail("INVALID_PUBLICATION");
      return transaction(pool, options.schema, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify([context.tenantId, key.repositoryId, key.serviceId, key.kind, selectorValue(key)])]);
        if (selector.kind === "branch" && key.kind === "branch") {
          const pointer = await branchPointer(client, context, key);
          if (pointer.snapshotId !== selector.snapshotId || pointer.pointerVersion !== selector.pointerVersion)
            return fail("STALE_POINTER");
        }
        let environmentScopeIds: readonly string[] | null = null;
        if (selector.kind === "environment") {
          const authority = await checkEnvironmentPin(client, context, selector);
          if (authority.status === "denied") return fail("NOT_FOUND_OR_DENIED");
          if (authority.status === "corrupt") return fail("CORRUPT_STORAGE");
          if (authority.status !== "match") return fail("STALE_POINTER");
          environmentScopeIds = authority.scopeIds;
        }
        const authorized = await authorizedSnapshot(client, context, selector.snapshotId);
        const checked = prepareOpenApiPublication({ snapshot: authorized.snapshot, mode: "strict", selector });
        if (!checked.publishable || checked.contentSha256 !== prepared.contentSha256
          || !Buffer.from(checked.bytes!).equals(Buffer.from(bytes))
          || JSON.stringify(checked.provenance) !== JSON.stringify(prepared.provenance)) return fail("INVALID_PUBLICATION");
        if (!validateOpenApiDocument(checked.document).ok) return fail("INVALID_PUBLICATION");
        const id = publicationId(context.tenantId, checked);
        const pointer = await client.query<{ publication_id: string; pointer_version: string }>(
          `SELECT publication_id, pointer_version::text AS pointer_version FROM openapi_current_pointers
           WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND selector_kind=$4 AND selector_value=$5 FOR UPDATE`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, selectorValue(key)]);
        const current = pointer.rows[0];
        if (current?.publication_id === id) {
          const existing = await client.query<{ bytes: Buffer }>(
            "SELECT bytes FROM openapi_artifacts WHERE tenant_id=$1 AND content_sha256=$2",
            [context.tenantId, checked.contentSha256]);
          if (!existing.rows[0]?.bytes.equals(Buffer.from(bytes))) return fail("CORRUPT_STORAGE");
          return { publicationId: id, contentSha256: checked.contentSha256!,
            pointerVersion: current.pointer_version, bytes, snapshotId: selector.snapshotId };
        }
        if (expected.state === "absent" ? current !== undefined : current?.pointer_version !== expected.pointerVersion)
          return fail("STALE_POINTER");
        await client.query(`INSERT INTO openapi_artifacts(tenant_id,content_sha256,bytes) VALUES ($1,$2,$3)
          ON CONFLICT (tenant_id,content_sha256) DO NOTHING`, [context.tenantId, checked.contentSha256, Buffer.from(bytes)]);
        const artifact = await client.query<{ bytes: Buffer }>(
          "SELECT bytes FROM openapi_artifacts WHERE tenant_id=$1 AND content_sha256=$2",
          [context.tenantId, checked.contentSha256]);
        if (!artifact.rows[0] || !artifact.rows[0].bytes.equals(Buffer.from(bytes))) return fail("CORRUPT_STORAGE");
        await client.query(`INSERT INTO openapi_publications(publication_id,tenant_id,repository_id,service_id,
          selector_kind,selector_value,branch_pointer_version,environment_checkpoint_version,environment_scope_ids,
          snapshot_id,immutable_revision,config_version,config_fingerprint,
          source_digest,snapshot_content_sha256,content_sha256)
          VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9::text[],$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (publication_id) DO NOTHING`,
          [id, context.tenantId, key.repositoryId, key.serviceId, key.kind, selectorValue(key),
            selector.kind === "branch" ? selector.pointerVersion : null,
            selector.kind === "environment" ? selector.checkpointVersion : null,
            environmentScopeIds,
            selector.snapshotId, selector.revision, checked.provenance.configVersion,
            selector.configFingerprint, checked.provenance.sourceDigest, authorized.contentSha256,
            checked.contentSha256]);
        const next = current ? (BigInt(current.pointer_version) + 1n).toString() : "1";
        if (current) await client.query(`UPDATE openapi_current_pointers SET publication_id=$6,
          pointer_version=$7::bigint,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND selector_kind=$4 AND selector_value=$5`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, selectorValue(key), id, next]);
        else await client.query(`INSERT INTO openapi_current_pointers(tenant_id,repository_id,service_id,
          selector_kind,selector_value,publication_id,pointer_version) VALUES ($1,$2,$3,$4,$5,$6,1)`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, selectorValue(key), id]);
        return { publicationId: id, contentSha256: checked.contentSha256!, pointerVersion: next,
          bytes, snapshotId: selector.snapshotId };
      });
    },
    async readCurrent(context: PrincipalContext, key: PublicationKey): Promise<PublishedOpenApi> {
      validContext(context); validKey(key);
      return transaction(pool, options.schema, async (client) => {
        const result = await client.query<PublicationRow>(`SELECT p.publication_id,p.content_sha256,p.snapshot_id,
          p.repository_id,p.service_id,p.immutable_revision,p.config_version,p.config_fingerprint,
          p.selector_kind,p.selector_value,p.environment_scope_ids,
          p.source_digest,p.snapshot_content_sha256,p.branch_pointer_version::text AS branch_pointer_version,
          p.environment_checkpoint_version::text AS environment_checkpoint_version,
          a.bytes,c.pointer_version::text AS pointer_version FROM openapi_current_pointers c
          JOIN openapi_publications p ON p.publication_id=c.publication_id
            AND p.tenant_id=c.tenant_id AND p.repository_id=c.repository_id
            AND p.service_id=c.service_id AND p.selector_kind=c.selector_kind
            AND p.selector_value=c.selector_value
          JOIN openapi_artifacts a ON a.tenant_id=p.tenant_id AND a.content_sha256=p.content_sha256
          WHERE c.tenant_id=$1 AND c.repository_id=$2 AND c.service_id=$3
            AND c.selector_kind=$4 AND c.selector_value=$5`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, selectorValue(key)]);
        const row = result.rows[0];
        if (!row) return fail("NOT_FOUND_OR_DENIED");
        if (key.kind === "branch") {
          const pointer = await branchPointer(client, context, key);
          if (pointer.snapshotId !== row.snapshot_id || pointer.pointerVersion !== row.branch_pointer_version)
            return fail("STALE_POINTER");
        }
        if (key.kind === "environment") {
          const selector: EnvironmentSelector = { ...key,
            snapshotId: row.snapshot_id, revision: row.immutable_revision,
            configFingerprint: row.config_fingerprint,
            checkpointVersion: row.environment_checkpoint_version ?? "",
            resolvedSnapshotIds: [row.snapshot_id] };
          const authority = await checkEnvironmentPin(client, context, selector);
          if (authority.status === "denied") return fail("NOT_FOUND_OR_DENIED");
          if (authority.status === "corrupt") return fail("CORRUPT_STORAGE");
          if (authority.status !== "match") return fail("STALE_POINTER");
          if (JSON.stringify(authority.scopeIds) !== JSON.stringify(row.environment_scope_ids))
            return fail("CORRUPT_STORAGE");
        }
        const authorized = await authorizedSnapshot(client, context, row.snapshot_id);
        verifyPublication(row, authorized.snapshot, authorized.contentSha256);
        verifyManifest(context.tenantId, row, authorized.snapshot);
        if (authorized.snapshot.service.repository_id !== key.repositoryId
          || authorized.snapshot.service.service_id !== key.serviceId
          || key.kind === "revision" && authorized.snapshot.source.immutable_revision !== key.revision)
          return fail("CORRUPT_STORAGE");
        return materialize(row);
      });
    },
    async readPublication(context: PrincipalContext, id: string): Promise<PublishedOpenApi> {
      validContext(context);
      if (!nonEmpty(id)) return fail("INVALID_PUBLICATION");
      return transaction(pool, options.schema, async (client) => {
        const result = await client.query<PublicationRow>(`SELECT p.publication_id,p.content_sha256,p.snapshot_id,
          p.repository_id,p.service_id,p.immutable_revision,p.config_version,p.config_fingerprint,
          p.selector_kind,p.selector_value,p.environment_scope_ids,
          p.source_digest,p.snapshot_content_sha256,
          p.branch_pointer_version::text AS branch_pointer_version,
          p.environment_checkpoint_version::text AS environment_checkpoint_version,a.bytes
          FROM openapi_publications p JOIN openapi_artifacts a
            ON a.tenant_id=p.tenant_id AND a.content_sha256=p.content_sha256
          WHERE p.tenant_id=$1 AND p.publication_id=$2`, [context.tenantId, id]);
        const row = result.rows[0];
        if (!row) return fail("NOT_FOUND_OR_DENIED");
        if (row.selector_kind === "environment") {
          if (!row.environment_scope_ids) return fail("CORRUPT_STORAGE");
          if (!await authorizedPinnedScopes(client, context, row.environment_scope_ids))
            return fail("NOT_FOUND_OR_DENIED");
        }
        const authorized = await authorizedSnapshot(client, context, row.snapshot_id);
        verifyPublication(row, authorized.snapshot, authorized.contentSha256);
        verifyManifest(context.tenantId, row, authorized.snapshot);
        return materialize(row);
      });
    },
  };
};
