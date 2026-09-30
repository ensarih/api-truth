import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseContractSnapshot, type ContractSnapshot } from "@api-truth/ir";
import { createCatalogStore, type PrincipalContext } from "@api-truth/catalog";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../catalog/src/canonical.js";
import { prepareOpenApiPublication, type OpenApiPublicationPreparation, type OpenApiPublicationSelector } from "./preparation.js";
import { quoteOpenApiSchema } from "./migrations.js";

export type RevisionSelector = Extract<OpenApiPublicationSelector, { kind: "revision" }>;
export type PublicationKey = Readonly<{ repositoryId: string; serviceId: string; kind: "revision"; revision: string }>;
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
const sha = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const version = /^[1-9][0-9]*$/;
const validContext = (context: PrincipalContext): void => {
  if (!context || !nonEmpty(context.tenantId) || !nonEmpty(context.principalId)) fail("INVALID_PUBLICATION");
};
const keyFromSelector = (selector: OpenApiPublicationSelector): PublicationKey => {
  if (selector.kind !== "revision") return fail("UNSUPPORTED_SELECTOR");
  return { repositoryId: selector.repositoryId, serviceId: selector.serviceId,
    kind: "revision", revision: selector.revision };
};
const validKey = (key: PublicationKey): void => {
  const runtimeKind = (key as { kind?: unknown } | undefined)?.kind;
  if (runtimeKind === "branch" || runtimeKind === "environment") fail("UNSUPPORTED_SELECTOR");
  if (!key || key.kind !== "revision" || !nonEmpty(key.repositoryId)
    || !nonEmpty(key.serviceId) || !nonEmpty(key.revision)) fail("INVALID_PUBLICATION");
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
  const same = (rows: { access_scope_id: string }[]) =>
    rows.length === scopes.length && rows.every((item, index) => item.access_scope_id === scopes[index]);
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
    p.selector.serviceId, p.selector.kind === "revision" ? p.selector.revision : "",
    p.snapshotId, p.revision, p.configVersion, p.configFingerprint, p.sourceDigest,
    preparation.contentSha256]), "utf8"));
};

type PublicationRow = { publication_id: string; content_sha256: string; snapshot_id: string;
  repository_id: string; service_id: string; immutable_revision: string;
  config_version: string; config_fingerprint: string; source_digest: string;
  snapshot_content_sha256: string; bytes: Buffer; pointer_version?: string };
const verifyPublication = (row: PublicationRow, snapshot: ContractSnapshot, contentSha256: string): void => {
  if (row.repository_id !== snapshot.service.repository_id || row.service_id !== snapshot.service.service_id
    || row.immutable_revision !== snapshot.source.immutable_revision
    || row.config_version !== snapshot.config.config_version
    || row.config_fingerprint !== snapshot.config.config_fingerprint
    || row.source_digest !== snapshot.source.source_digest
    || row.snapshot_content_sha256 !== contentSha256) fail("CORRUPT_STORAGE");
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
  return {
    async prepareRevision(context: PrincipalContext, selector: RevisionSelector): Promise<OpenApiPublicationPreparation> {
      validContext(context);
      keyFromSelector(selector);
      const stored = await catalog.getSnapshot(context, selector.snapshotId);
      return prepareOpenApiPublication({ snapshot: stored.snapshot, mode: "strict", selector });
    },
    async publish(context: PrincipalContext, prepared: OpenApiPublicationPreparation,
      expected: ExpectedPublicationPointer): Promise<PublishedOpenApi> {
      validContext(context);
      if (!prepared || prepared.mode !== "strict" || prepared.publishable !== true
        || !prepared.provenance || !prepared.contentSha256 || !prepared.bytes
        || !Array.isArray(prepared.diagnostics) || prepared.diagnostics.length !== 0) return fail("INVALID_PUBLICATION");
      const selector = prepared.provenance.selector;
      const key = keyFromSelector(selector);
      if (!expected || expected.state !== "absent" && (expected.state !== "present"
        || typeof expected.pointerVersion !== "string" || !version.test(expected.pointerVersion)))
        return fail("INVALID_PUBLICATION");
      const bytes = new Uint8Array(prepared.bytes);
      if (sha(bytes) !== prepared.contentSha256) return fail("INVALID_PUBLICATION");
      return transaction(pool, options.schema, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify([context.tenantId, key.repositoryId, key.serviceId, key.kind, key.revision])]);
        const authorized = await authorizedSnapshot(client, context, selector.snapshotId);
        const checked = prepareOpenApiPublication({ snapshot: authorized.snapshot, mode: "strict", selector });
        if (!checked.publishable || checked.contentSha256 !== prepared.contentSha256
          || !Buffer.from(checked.bytes!).equals(Buffer.from(bytes))
          || JSON.stringify(checked.provenance) !== JSON.stringify(prepared.provenance)) return fail("INVALID_PUBLICATION");
        const id = publicationId(context.tenantId, checked);
        const pointer = await client.query<{ publication_id: string; pointer_version: string }>(
          `SELECT publication_id, pointer_version::text AS pointer_version FROM openapi_current_pointers
           WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND selector_kind=$4 AND selector_value=$5 FOR UPDATE`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, key.revision]);
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
          selector_kind,selector_value,snapshot_id,immutable_revision,config_version,config_fingerprint,
          source_digest,snapshot_content_sha256,content_sha256)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (publication_id) DO NOTHING`,
          [id, context.tenantId, key.repositoryId, key.serviceId, key.kind, key.revision,
            selector.snapshotId, selector.revision, checked.provenance.configVersion,
            selector.configFingerprint, checked.provenance.sourceDigest, authorized.contentSha256,
            checked.contentSha256]);
        const next = current ? (BigInt(current.pointer_version) + 1n).toString() : "1";
        if (current) await client.query(`UPDATE openapi_current_pointers SET publication_id=$6,
          pointer_version=$7::bigint,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND selector_kind=$4 AND selector_value=$5`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, key.revision, id, next]);
        else await client.query(`INSERT INTO openapi_current_pointers(tenant_id,repository_id,service_id,
          selector_kind,selector_value,publication_id,pointer_version) VALUES ($1,$2,$3,$4,$5,$6,1)`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, key.revision, id]);
        return { publicationId: id, contentSha256: checked.contentSha256!, pointerVersion: next,
          bytes, snapshotId: selector.snapshotId };
      });
    },
    async readCurrent(context: PrincipalContext, key: PublicationKey): Promise<PublishedOpenApi> {
      validContext(context); validKey(key);
      return transaction(pool, options.schema, async (client) => {
        const result = await client.query<PublicationRow>(`SELECT p.publication_id,p.content_sha256,p.snapshot_id,
          p.repository_id,p.service_id,p.immutable_revision,p.config_version,p.config_fingerprint,
          p.source_digest,p.snapshot_content_sha256,
          a.bytes,c.pointer_version::text AS pointer_version FROM openapi_current_pointers c
          JOIN openapi_publications p ON p.publication_id=c.publication_id
            AND p.tenant_id=c.tenant_id AND p.repository_id=c.repository_id
            AND p.service_id=c.service_id AND p.selector_kind=c.selector_kind
            AND p.selector_value=c.selector_value
          JOIN openapi_artifacts a ON a.tenant_id=p.tenant_id AND a.content_sha256=p.content_sha256
          WHERE c.tenant_id=$1 AND c.repository_id=$2 AND c.service_id=$3
            AND c.selector_kind=$4 AND c.selector_value=$5`,
          [context.tenantId, key.repositoryId, key.serviceId, key.kind, key.revision]);
        const row = result.rows[0];
        if (!row) return fail("NOT_FOUND_OR_DENIED");
        const authorized = await authorizedSnapshot(client, context, row.snapshot_id);
        verifyPublication(row, authorized.snapshot, authorized.contentSha256);
        if (authorized.snapshot.service.repository_id !== key.repositoryId
          || authorized.snapshot.service.service_id !== key.serviceId
          || authorized.snapshot.source.immutable_revision !== key.revision) return fail("CORRUPT_STORAGE");
        return materialize(row);
      });
    },
    async readPublication(context: PrincipalContext, id: string): Promise<PublishedOpenApi> {
      validContext(context);
      if (!nonEmpty(id)) return fail("INVALID_PUBLICATION");
      return transaction(pool, options.schema, async (client) => {
        const result = await client.query<PublicationRow>(`SELECT p.publication_id,p.content_sha256,p.snapshot_id,
          p.repository_id,p.service_id,p.immutable_revision,p.config_version,p.config_fingerprint,
          p.source_digest,p.snapshot_content_sha256,a.bytes
          FROM openapi_publications p JOIN openapi_artifacts a
            ON a.tenant_id=p.tenant_id AND a.content_sha256=p.content_sha256
          WHERE p.tenant_id=$1 AND p.publication_id=$2`, [context.tenantId, id]);
        const row = result.rows[0];
        if (!row) return fail("NOT_FOUND_OR_DENIED");
        const authorized = await authorizedSnapshot(client, context, row.snapshot_id);
        verifyPublication(row, authorized.snapshot, authorized.contentSha256);
        return materialize(row);
      });
    },
  };
};
