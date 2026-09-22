import { parseContractSnapshot, type AnalyzerResult } from "@api-truth/ir";
import type { Pool, PoolClient } from "pg";

import {
  canonicalScopeIds,
  compareProviderOrder,
  snapshotContentSha256,
  snapshotIdentitySha256,
} from "./canonical.js";
import { quoteSchemaIdentifier, withCatalogTransaction } from "./database.js";
import { CatalogError, catalogStorageError } from "./errors.js";
import { invalidCatalogInput, nonEmptyString, withCatalogInputBoundary } from "./input.js";
import { contractSnapshotFromAnalyzerResult } from "./snapshot.js";
import type {
  BranchKey,
  BranchPointer,
  BranchPromotionResult,
  BranchResolution,
  CatalogStore,
  ExpectedPointer,
  IngestAnalyzerResultInput,
  PrincipalContext,
  PromoteBranchInput,
  ProviderOrder,
  ProviderReference,
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

type PointerRow = {
  tenant_id: unknown;
  repository_id: unknown;
  service_id: unknown;
  branch: unknown;
  snapshot_id: unknown;
  pointer_version: unknown;
  provider: unknown;
  provider_reference: unknown;
  order_kind: unknown;
  order_value: unknown;
  promoted_at: unknown;
};

type ResolvedRow = SnapshotRow & {
  pointer_tenant_id: unknown;
  pointer_repository_id: unknown;
  pointer_service_id: unknown;
  pointer_branch: unknown;
  pointer_snapshot_id: unknown;
  pointer_version: unknown;
  pointer_provider: unknown;
  pointer_provider_reference: unknown;
  pointer_order_kind: unknown;
  pointer_order_value: unknown;
  pointer_promoted_at: unknown;
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

const pointerVersionPattern = /^[1-9][0-9]*$/;
const providerOrderKinds = new Set<ProviderOrder["kind"]>([
  "sequence",
  "cursor",
  "effective_version",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
};

const pointerFromRow = (row: PointerRow): BranchPointer => {
  try {
    if (
      typeof row.tenant_id !== "string"
      || typeof row.repository_id !== "string"
      || typeof row.service_id !== "string"
      || typeof row.branch !== "string"
      || typeof row.snapshot_id !== "string"
      || typeof row.pointer_version !== "string"
      || !pointerVersionPattern.test(row.pointer_version)
      || typeof row.provider !== "string"
      || typeof row.provider_reference !== "string"
      || typeof row.promoted_at !== "string"
    ) return invalidStoredRow();

    let order: ProviderOrder | undefined;
    if (row.order_kind === null && row.order_value === null) {
      order = undefined;
    } else if (
      typeof row.order_kind === "string"
      && providerOrderKinds.has(row.order_kind as ProviderOrder["kind"])
      && typeof row.order_value === "string"
      && row.order_value.length > 0
    ) {
      order = {
        kind: row.order_kind as ProviderOrder["kind"],
        value: row.order_value,
      };
    } else {
      return invalidStoredRow();
    }

    return {
      tenantId: row.tenant_id,
      repositoryId: row.repository_id,
      serviceId: row.service_id,
      branch: row.branch,
      snapshotId: row.snapshot_id,
      pointerVersion: row.pointer_version,
      provider: {
        provider: row.provider,
        provider_reference: row.provider_reference,
        ...(order === undefined ? {} : { order }),
      },
      promotedAt: row.promoted_at,
    };
  } catch (error) {
    if (error instanceof CatalogError && error.code === "CATALOG_STORAGE_ERROR") throw error;
    throw catalogStorageError(error);
  }
};

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

const providerInput = (value: unknown): ProviderReference => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["provider", "provider_reference", "order"])) {
    return invalidCatalogInput();
  }
  const provider = nonEmptyString(value.provider);
  const providerReference = nonEmptyString(value.provider_reference);
  if (value.order === undefined) return { provider, provider_reference: providerReference };
  if (!isRecord(value.order) || !hasOnlyKeys(value.order, ["kind", "value"])) {
    return invalidCatalogInput();
  }
  const kind = value.order.kind;
  if (typeof kind !== "string" || !providerOrderKinds.has(kind as ProviderOrder["kind"])) {
    return invalidCatalogInput();
  }
  return {
    provider,
    provider_reference: providerReference,
    order: {
      kind: kind as ProviderOrder["kind"],
      value: nonEmptyString(value.order.value),
    },
  };
};

const expectedPointerInput = (value: unknown): ExpectedPointer | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return invalidCatalogInput();
  if (value.state === "absent" && hasOnlyKeys(value, ["state"])) return { state: "absent" };
  if (
    value.state === "present"
    && hasOnlyKeys(value, ["state", "pointerVersion"])
    && typeof value.pointerVersion === "string"
    && pointerVersionPattern.test(value.pointerVersion)
  ) {
    return { state: "present", pointerVersion: value.pointerVersion };
  }
  return invalidCatalogInput();
};

const promoteInput = (rawInput: PromoteBranchInput): PromoteBranchInput =>
  withCatalogInputBoundary(() => ({
    tenantId: nonEmptyString(rawInput.tenantId),
    repositoryId: nonEmptyString(rawInput.repositoryId),
    serviceId: nonEmptyString(rawInput.serviceId),
    branch: nonEmptyString(rawInput.branch),
    snapshotId: nonEmptyString(rawInput.snapshotId),
    provider: providerInput(rawInput.provider),
    ...(() => {
      const expected = expectedPointerInput(rawInput.expected);
      return expected === undefined ? {} : { expected };
    })(),
  }));

const resolveInput = (
  context: PrincipalContext,
  key: Omit<BranchKey, "tenantId">,
): PrincipalContext & Omit<BranchKey, "tenantId"> => withCatalogInputBoundary(() => ({
  tenantId: nonEmptyString(context.tenantId),
  principalId: nonEmptyString(context.principalId),
  repositoryId: nonEmptyString(key.repositoryId),
  serviceId: nonEmptyString(key.serviceId),
  branch: nonEmptyString(key.branch),
}));

const branchLockKey = (input: BranchKey): string => [
  input.tenantId,
  input.repositoryId,
  input.serviceId,
  input.branch,
].map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("");

const pointerSelectColumns = `
  tenant_id, repository_id, service_id, branch, snapshot_id,
  pointer_version::text AS pointer_version, provider, provider_reference,
  order_kind, order_value, promoted_at::text AS promoted_at`;

const selectPointerForUpdate = async (
  client: PoolClient,
  input: BranchKey,
): Promise<PointerRow | undefined> => {
  const selected = await client.query<PointerRow>(
    `SELECT ${pointerSelectColumns}
     FROM catalog_branch_pointers
     WHERE tenant_id = $1 AND repository_id = $2 AND service_id = $3 AND branch = $4
     FOR UPDATE`,
    [input.tenantId, input.repositoryId, input.serviceId, input.branch],
  );
  return selected.rows[0];
};

const exactProviderReplay = (
  current: BranchPointer,
  input: PromoteBranchInput,
): boolean => current.snapshotId === input.snapshotId
  && current.provider.provider === input.provider.provider
  && current.provider.provider_reference === input.provider.provider_reference
  && current.provider.order?.kind === input.provider.order?.kind
  && current.provider.order?.value === input.provider.order?.value;

const expectedMatches = (
  expected: ExpectedPointer,
  current: BranchPointer | undefined,
): boolean => expected.state === "absent"
  ? current === undefined
  : current !== undefined && current.pointerVersion === expected.pointerVersion;

const canonicalSequence = (order: ProviderOrder | undefined): boolean =>
  order?.kind === "sequence" && /^(0|[1-9][0-9]*)$/.test(order.value);

const assertPromotionOrder = (
  current: BranchPointer | undefined,
  input: PromoteBranchInput,
): void => {
  if (input.expected !== undefined && !expectedMatches(input.expected, current)) {
    throw new CatalogError("BRANCH_POINTER_CONFLICT", { retryable: false });
  }

  if (current === undefined) {
    if (!canonicalSequence(input.provider.order) && input.expected === undefined) {
      throw new CatalogError("BRANCH_POINTER_CONFLICT", { retryable: false });
    }
    return;
  }

  const comparable = current.provider.provider === input.provider.provider
    && canonicalSequence(current.provider.order)
    && canonicalSequence(input.provider.order);
  if (!comparable) {
    if (input.expected === undefined) {
      throw new CatalogError("BRANCH_POINTER_CONFLICT", { retryable: false });
    }
    return;
  }

  const order = compareProviderOrder(current.provider.order, input.provider.order);
  if (order === "older") throw new CatalogError("BRANCH_POINTER_STALE", { retryable: false });
  if (order === "equal") throw new CatalogError("BRANCH_POINTER_CONFLICT", { retryable: false });
  if (order !== "newer") throw new CatalogError("BRANCH_POINTER_CONFLICT", { retryable: false });
};

const promoteBranch = async (
  pool: Pool,
  schema: string,
  rawInput: PromoteBranchInput,
): Promise<BranchPromotionResult> => {
  const input = promoteInput(rawInput);
  return withCatalogTransaction(pool, { schema }, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [branchLockKey(input)],
    );
    const currentRow = await selectPointerForUpdate(client, input);
    const current = currentRow === undefined ? undefined : pointerFromRow(currentRow);

    const target = await client.query<{ snapshot_id: string }>(
      `SELECT snapshot_id
       FROM catalog_snapshots
       WHERE tenant_id = $1
         AND repository_id = $2
         AND service_id = $3
         AND snapshot_id = $4
         AND analyzer_status IN ('success', 'partial')`,
      [input.tenantId, input.repositoryId, input.serviceId, input.snapshotId],
    );
    if (target.rows[0] === undefined) {
      throw new CatalogError("BRANCH_TARGET_INELIGIBLE", { retryable: false });
    }

    if (current !== undefined && exactProviderReplay(current, input)) {
      return { outcome: "existing", pointer: current };
    }
    assertPromotionOrder(current, input);

    if (current === undefined) {
      await client.query(
        `INSERT INTO catalog_branch_pointers (
           tenant_id, repository_id, service_id, branch, snapshot_id,
           provider, provider_reference, order_kind, order_value
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.tenantId,
          input.repositoryId,
          input.serviceId,
          input.branch,
          input.snapshotId,
          input.provider.provider,
          input.provider.provider_reference,
          input.provider.order?.kind ?? null,
          input.provider.order?.value ?? null,
        ],
      );
    } else {
      await client.query(
        `UPDATE catalog_branch_pointers
         SET snapshot_id = $5,
             provider = $6,
             provider_reference = $7,
             order_kind = $8,
             order_value = $9,
             pointer_version = pointer_version + 1,
             promoted_at = clock_timestamp()
         WHERE tenant_id = $1 AND repository_id = $2 AND service_id = $3 AND branch = $4`,
        [
          input.tenantId,
          input.repositoryId,
          input.serviceId,
          input.branch,
          input.snapshotId,
          input.provider.provider,
          input.provider.provider_reference,
          input.provider.order?.kind ?? null,
          input.provider.order?.value ?? null,
        ],
      );
    }

    const promotedRow = await selectPointerForUpdate(client, input);
    if (promotedRow === undefined) return invalidStoredRow();
    return { outcome: "promoted", pointer: pointerFromRow(promotedRow) };
  });
};

const resolveBranch = async (
  pool: Pool,
  schema: string,
  rawContext: PrincipalContext,
  rawKey: Omit<BranchKey, "tenantId">,
): Promise<BranchResolution> => {
  const input = resolveInput(rawContext, rawKey);
  return withCatalogTransaction(pool, { schema }, async (client) => {
    const selected = await client.query<ResolvedRow>(
      `SELECT
         pointer.tenant_id AS pointer_tenant_id,
         pointer.repository_id AS pointer_repository_id,
         pointer.service_id AS pointer_service_id,
         pointer.branch AS pointer_branch,
         pointer.snapshot_id AS pointer_snapshot_id,
         pointer.pointer_version::text AS pointer_version,
         pointer.provider AS pointer_provider,
         pointer.provider_reference AS pointer_provider_reference,
         pointer.order_kind AS pointer_order_kind,
         pointer.order_value AS pointer_order_value,
         pointer.promoted_at::text AS pointer_promoted_at,
         ${snapshotColumns.replaceAll(/\b([a-z][a-z0-9_]*)\b/g, "snapshot.$1")}
       FROM catalog_branch_pointers AS pointer
       JOIN catalog_snapshots AS snapshot
         ON snapshot.tenant_id = pointer.tenant_id
        AND snapshot.repository_id = pointer.repository_id
        AND snapshot.service_id = pointer.service_id
        AND snapshot.snapshot_id = pointer.snapshot_id
       WHERE pointer.tenant_id = $1
         AND pointer.repository_id = $2
         AND pointer.service_id = $3
         AND pointer.branch = $4
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
            AND grant_row.principal_id = $5
            AND grant_row.active
           WHERE scope.access_scope_id IS NULL OR grant_row.access_scope_id IS NULL
         )`,
      [input.tenantId, input.repositoryId, input.serviceId, input.branch, input.principalId],
    );
    const row = selected.rows[0];
    if (row === undefined) {
      throw new CatalogError("CATALOG_NOT_FOUND_OR_DENIED", { retryable: false });
    }
    const pointer = pointerFromRow({
      tenant_id: row.pointer_tenant_id,
      repository_id: row.pointer_repository_id,
      service_id: row.pointer_service_id,
      branch: row.pointer_branch,
      snapshot_id: row.pointer_snapshot_id,
      pointer_version: row.pointer_version,
      provider: row.pointer_provider,
      provider_reference: row.pointer_provider_reference,
      order_kind: row.pointer_order_kind,
      order_value: row.pointer_order_value,
      promoted_at: row.pointer_promoted_at,
    });
    const stored = verifyStoredSnapshotRow(row);
    if (
      pointer.tenantId !== stored.tenantId
      || pointer.snapshotId !== stored.snapshotId
      || pointer.repositoryId !== stored.snapshot.service.repository_id
      || pointer.serviceId !== stored.snapshot.service.service_id
    ) return invalidStoredRow();
    return { pointer, stored };
  });
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
    promoteBranch: (input) => promoteBranch(pool, schema, input),
    resolveBranch: (context, key) => resolveBranch(pool, schema, context, key),
  };
};
