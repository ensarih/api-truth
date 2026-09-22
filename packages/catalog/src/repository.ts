import { parseContractSnapshot, type AnalyzerResult } from "@api-truth/ir";
import type { Pool, PoolClient } from "pg";

import {
  canonicalScopeIds,
  snapshotContentSha256,
  snapshotIdentitySha256,
} from "./canonical.js";
import { quoteSchemaIdentifier, withCatalogTransaction } from "./database.js";
import { CatalogError, catalogStorageError } from "./errors.js";
import { nonEmptyString, withCatalogInputBoundary } from "./input.js";
import { contractSnapshotFromAnalyzerResult } from "./snapshot.js";
import type {
  CatalogStore,
  IngestAnalyzerResultInput,
  PrincipalContext,
  SnapshotWriteResult,
  StoredSnapshot,
} from "./types.js";

type SnapshotRow = {
  tenant_id: string;
  snapshot_id: string;
  repository_id: string;
  service_id: string;
  immutable_revision: string;
  analyzer_status: string;
  ir_version: string;
  identity_version: string;
  config_fingerprint: string;
  identity_sha256: string;
  content_sha256: string;
  required_scope_ids: unknown;
  document: unknown;
};

const snapshotColumns = `
  tenant_id, snapshot_id, repository_id, service_id, immutable_revision,
  analyzer_status, ir_version, identity_version, config_fingerprint,
  identity_sha256, content_sha256, required_scope_ids, document`;

const invalidStoredRow = (cause?: unknown): never => {
  throw catalogStorageError(cause);
};

const equalStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const verifyStoredSnapshotRow = (row: SnapshotRow): StoredSnapshot => {
  try {
    if (
      typeof row.tenant_id !== "string"
      || typeof row.snapshot_id !== "string"
      || typeof row.repository_id !== "string"
      || typeof row.service_id !== "string"
      || typeof row.immutable_revision !== "string"
      || typeof row.ir_version !== "string"
      || typeof row.identity_version !== "string"
      || typeof row.config_fingerprint !== "string"
      || typeof row.identity_sha256 !== "string"
      || typeof row.content_sha256 !== "string"
      || (row.analyzer_status !== "success" && row.analyzer_status !== "partial")
      || !Array.isArray(row.required_scope_ids)
    ) return invalidStoredRow();

    const parsed = parseContractSnapshot(row.document);
    if (!parsed.ok) return invalidStoredRow();
    const snapshot = structuredClone(parsed.value);
    const requiredScopeIds = canonicalScopeIds(row.required_scope_ids);
    if (!equalStrings(requiredScopeIds, row.required_scope_ids)) return invalidStoredRow();

    const statusMatchesCoverage = row.analyzer_status === "success"
      ? snapshot.coverage.status === "complete"
      : snapshot.coverage.status === "incomplete";
    if (
      snapshot.snapshot_id !== row.snapshot_id
      || snapshot.service.repository_id !== row.repository_id
      || snapshot.source.repository_id !== row.repository_id
      || snapshot.service.service_id !== row.service_id
      || snapshot.source.immutable_revision !== row.immutable_revision
      || snapshot.ir_version !== row.ir_version
      || snapshot.identity_version !== row.identity_version
      || snapshot.config.config_fingerprint !== row.config_fingerprint
      || !statusMatchesCoverage
      || snapshotIdentitySha256(snapshot) !== row.identity_sha256
      || snapshotContentSha256(snapshot) !== row.content_sha256
    ) return invalidStoredRow();

    return {
      tenantId: row.tenant_id,
      snapshotId: row.snapshot_id,
      analyzerStatus: row.analyzer_status,
      contentSha256: row.content_sha256 as `sha256:${string}`,
      requiredScopeIds: [...requiredScopeIds],
      snapshot,
    };
  } catch (error) {
    if (error instanceof CatalogError && error.code === "CATALOG_STORAGE_ERROR") throw error;
    throw catalogStorageError(error);
  }
};

const ingestInput = (input: IngestAnalyzerResultInput): {
  tenantId: string;
  result: AnalyzerResult;
  configFingerprint: string;
} => withCatalogInputBoundary(() => ({
  tenantId: nonEmptyString(input.tenantId),
  result: input.result,
  configFingerprint: nonEmptyString(input.configFingerprint),
}));

const readInput = (context: PrincipalContext, snapshotId: string): {
  tenantId: string;
  principalId: string;
  snapshotId: string;
} => withCatalogInputBoundary(() => ({
  tenantId: nonEmptyString(context.tenantId),
  principalId: nonEmptyString(context.principalId),
  snapshotId: nonEmptyString(snapshotId),
}));

const lockRequiredScopes = async (
  client: PoolClient,
  tenantId: string,
  requiredScopeIds: string[],
): Promise<void> => {
  const scopes = await client.query<{ access_scope_id: string; active: boolean }>(
    `SELECT access_scope_id, active
     FROM access_scopes
     WHERE tenant_id = $1 AND access_scope_id = ANY($2::text[])
     ORDER BY access_scope_id COLLATE "C"
     FOR UPDATE`,
    [tenantId, requiredScopeIds],
  );
  if (
    scopes.rows.length !== requiredScopeIds.length
    || scopes.rows.some((row, index) =>
      row.access_scope_id !== requiredScopeIds[index] || row.active !== true)
  ) {
    throw new CatalogError("UNKNOWN_ACCESS_SCOPE");
  }
};

const readStoredRow = async (
  client: PoolClient,
  tenantId: string,
  snapshotId: string,
): Promise<SnapshotRow> => {
  const selected = await client.query<SnapshotRow>(
    `SELECT ${snapshotColumns}
     FROM catalog_snapshots
     WHERE tenant_id = $1 AND snapshot_id = $2`,
    [tenantId, snapshotId],
  );
  return selected.rows[0] ?? invalidStoredRow();
};

const ingestAnalyzerResult = async (
  pool: Pool,
  schema: string,
  rawInput: IngestAnalyzerResultInput,
): Promise<SnapshotWriteResult> => {
  const input = ingestInput(rawInput);
  const converted = contractSnapshotFromAnalyzerResult(input.result, input.configFingerprint);
  const { snapshot, analyzerStatus, requiredScopeIds } = converted;
  const identitySha256 = snapshotIdentitySha256(snapshot);
  const contentSha256 = snapshotContentSha256(snapshot);

  return withCatalogTransaction(pool, { schema }, async (client) => {
    await lockRequiredScopes(client, input.tenantId, requiredScopeIds);
    const inserted = await client.query(
      `INSERT INTO catalog_snapshots (
         tenant_id, snapshot_id, repository_id, service_id, immutable_revision,
         analyzer_status, ir_version, identity_version, config_fingerprint,
         identity_sha256, content_sha256, required_scope_ids, document
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (tenant_id, snapshot_id) DO NOTHING`,
      [
        input.tenantId,
        snapshot.snapshot_id,
        snapshot.service.repository_id,
        snapshot.service.service_id,
        snapshot.source.immutable_revision,
        analyzerStatus,
        snapshot.ir_version,
        snapshot.identity_version,
        snapshot.config.config_fingerprint,
        identitySha256,
        contentSha256,
        requiredScopeIds,
        JSON.stringify(snapshot),
      ],
    );

    const storedRow = await readStoredRow(client, input.tenantId, snapshot.snapshot_id);
    verifyStoredSnapshotRow(storedRow);
    if (
      storedRow.identity_sha256 !== identitySha256
      || storedRow.content_sha256 !== contentSha256
      || storedRow.analyzer_status !== analyzerStatus
      || !Array.isArray(storedRow.required_scope_ids)
      || !equalStrings(storedRow.required_scope_ids, requiredScopeIds)
    ) {
      throw new CatalogError("SNAPSHOT_IDENTITY_CONFLICT");
    }

    return {
      outcome: inserted.rowCount === 1 ? "inserted" : "existing",
      snapshotId: snapshot.snapshot_id,
      contentSha256,
      requiredScopeIds: [...requiredScopeIds],
    };
  });
};

const getSnapshot = async (
  pool: Pool,
  schema: string,
  rawContext: PrincipalContext,
  rawSnapshotId: string,
): Promise<StoredSnapshot> => {
  const input = readInput(rawContext, rawSnapshotId);
  return withCatalogTransaction(pool, { schema }, async (client) => {
    const selected = await client.query<SnapshotRow>(
      `SELECT ${snapshotColumns.replaceAll(/\b([a-z][a-z0-9_]*)\b/g, "snapshot.$1")}
       FROM catalog_snapshots AS snapshot
       WHERE snapshot.tenant_id = $1
         AND snapshot.snapshot_id = $2
         AND cardinality(snapshot.required_scope_ids) > 0
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(snapshot.required_scope_ids) AS required(access_scope_id)
           LEFT JOIN access_scopes AS scope
             ON scope.tenant_id = snapshot.tenant_id
            AND scope.access_scope_id = required.access_scope_id
            AND scope.active
           LEFT JOIN principal_scope_grants AS grant_row
             ON grant_row.tenant_id = snapshot.tenant_id
            AND grant_row.access_scope_id = required.access_scope_id
            AND grant_row.principal_id = $3
            AND grant_row.active
           WHERE scope.access_scope_id IS NULL OR grant_row.access_scope_id IS NULL
         )`,
      [input.tenantId, input.snapshotId, input.principalId],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new CatalogError("CATALOG_NOT_FOUND_OR_DENIED", { retryable: false });
    return verifyStoredSnapshotRow(row);
  });
};

const unimplementedBranchMethod = async (): Promise<never> => {
  throw new CatalogError("CATALOG_STORAGE_ERROR", { retryable: false });
};

export const createCatalogStore = (
  pool: Pool,
  options: { schema: string },
): CatalogStore => {
  const schema = withCatalogInputBoundary(() => {
    quoteSchemaIdentifier(options.schema);
    return options.schema;
  });
  return {
    ingestAnalyzerResult: (input) => ingestAnalyzerResult(pool, schema, input),
    getSnapshot: (context, snapshotId) => getSnapshot(pool, schema, context, snapshotId),
    promoteBranch: unimplementedBranchMethod,
    resolveBranch: unimplementedBranchMethod,
  };
};
