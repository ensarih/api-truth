import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import { quoteOrchestrationSchemaIdentifier, setOrchestrationSearchPath } from "./database.js";
import { OrchestrationError, orchestrationStorageError } from "./errors.js";

export type OrchestrationMigration = Readonly<{ version: string; sql: string }>;

const MIGRATION_VERSION = /^[0-9]{4}_[a-z][a-z0-9_]*$/;
const checksum = (sql: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`;

const validateManifest = (manifest: readonly OrchestrationMigration[]): OrchestrationMigration[] => {
  const ordered = [...manifest].sort((left, right) => left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
  const versions = new Set<string>();
  for (const migration of ordered) {
    if (!MIGRATION_VERSION.test(migration.version) || migration.sql.length === 0 || versions.has(migration.version)) {
      throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    }
    versions.add(migration.version);
  }
  return ordered;
};

const verifyCatalogPrerequisite = async (pool: Pool, schema: string): Promise<void> => {
  const schemaSql = quoteOrchestrationSchemaIdentifier(schema);
  const catalogSql = await readFile(new URL("../../catalog/migrations/0001_catalog_core.sql", import.meta.url), "utf8");
  try {
    const result = await pool.query<{ checksum_sha256: string; snapshot_table: string | null; pointer_table: string | null }>(
      `SELECT migration.checksum_sha256,
              to_regclass($1) AS snapshot_table,
              to_regclass($2) AS pointer_table
       FROM ${schemaSql}.catalog_schema_migrations migration
       WHERE migration.version = '0001_catalog_core'`,
      [`${schema}.catalog_snapshots`, `${schema}.catalog_branch_pointers`],
    );
    const row = result.rows[0];
    if (row?.checksum_sha256 !== checksum(catalogSql) || row.snapshot_table === null || row.pointer_table === null) {
      throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
    }
    const constraints = await pool.query<{
      constraint_name: string;
      constraint_type: string;
      table_name: string;
      columns: string[];
      referenced_table: string | null;
      referenced_schema: string | null;
      referenced_columns: string[] | null;
      delete_action: string;
      update_action: string;
      match_type: string;
      validated: boolean;
      deferrable: boolean;
      initially_deferred: boolean;
    }>(
      `SELECT constraint_row.conname AS constraint_name,
              constraint_row.contype::text AS constraint_type,
              table_row.relname AS table_name,
              ARRAY(
                SELECT attribute.attname::text
                FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attribute_number, position)
                JOIN pg_catalog.pg_attribute attribute
                  ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key_column.attribute_number
                ORDER BY key_column.position
              ) AS columns,
              referenced_table.relname AS referenced_table,
              referenced_namespace.nspname AS referenced_schema,
              CASE WHEN constraint_row.contype = 'f' THEN ARRAY(
                SELECT attribute.attname::text
                FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attribute_number, position)
                JOIN pg_catalog.pg_attribute attribute
                  ON attribute.attrelid = constraint_row.confrelid AND attribute.attnum = key_column.attribute_number
                ORDER BY key_column.position
              ) ELSE NULL END AS referenced_columns,
              constraint_row.confdeltype::text AS delete_action,
              constraint_row.confupdtype::text AS update_action,
              constraint_row.confmatchtype::text AS match_type,
              constraint_row.convalidated AS validated,
              constraint_row.condeferrable AS deferrable,
              constraint_row.condeferred AS initially_deferred
       FROM pg_catalog.pg_constraint constraint_row
       JOIN pg_catalog.pg_class table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       LEFT JOIN pg_catalog.pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
       LEFT JOIN pg_catalog.pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_table.relnamespace
       WHERE namespace_row.nspname = $1
         AND table_row.relname IN ('catalog_snapshots', 'catalog_branch_pointers')
         AND constraint_row.contype IN ('p', 'u', 'f')`,
      [schema],
    );
    const exactConstraint = (
      tableName: string,
      type: string,
      columns: readonly string[],
      referencedTable?: string,
      referencedColumns?: readonly string[],
      foreignKeyOptions?: Readonly<{ deleteAction: string; updateAction: string; matchType: string }>,
    ): boolean => constraints.rows.some((candidate) =>
      candidate.table_name === tableName
      && candidate.constraint_type === type
      && candidate.constraint_name.startsWith(`${tableName}_`)
      && candidate.validated === true
      && candidate.deferrable === false
      && candidate.initially_deferred === false
      && candidate.columns.join("\u0000") === columns.join("\u0000")
      && (referencedTable === undefined
        || candidate.referenced_table === referencedTable && candidate.referenced_schema === schema)
      && (referencedColumns === undefined
        || candidate.referenced_columns?.join("\u0000") === referencedColumns.join("\u0000"))
      && (foreignKeyOptions === undefined
        || candidate.delete_action === foreignKeyOptions.deleteAction
          && candidate.update_action === foreignKeyOptions.updateAction
          && candidate.match_type === foreignKeyOptions.matchType));
    if (!exactConstraint("catalog_snapshots", "p", ["tenant_id", "snapshot_id"])
      || !exactConstraint("catalog_snapshots", "u", ["tenant_id", "repository_id", "service_id", "snapshot_id"])
      || !exactConstraint("catalog_branch_pointers", "p", ["tenant_id", "repository_id", "service_id", "branch"])
      || !exactConstraint(
        "catalog_branch_pointers", "f", ["tenant_id", "repository_id", "service_id", "snapshot_id"],
        "catalog_snapshots", ["tenant_id", "repository_id", "service_id", "snapshot_id"],
        { deleteAction: "r", updateAction: "a", matchType: "s" },
      )) {
      throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
    }
  } catch (error) {
    if (error instanceof OrchestrationError) throw error;
    throw orchestrationStorageError(error);
  }
};

export const applyOrchestrationMigrationManifest = async (
  pool: Pool,
  options: { schema: string },
  manifest: readonly OrchestrationMigration[],
): Promise<void> => {
  const schemaSql = quoteOrchestrationSchemaIdentifier(options.schema);
  const migrations = validateManifest(manifest);
  await verifyCatalogPrerequisite(pool, options.schema);
  const client = await pool.connect().catch((error: unknown) => { throw orchestrationStorageError(error); });
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_catalog");
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
      `api-truth:orchestration-migrations:${options.schema}`,
    ]);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schemaSql}.orchestration_schema_migrations (
      version text PRIMARY KEY,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await setOrchestrationSearchPath(client, options.schema);
    for (const migration of migrations) {
      const migrationChecksum = checksum(migration.sql);
      const applied = await client.query<{ checksum_sha256: string }>(
        "SELECT checksum_sha256 FROM orchestration_schema_migrations WHERE version = $1", [migration.version],
      );
      if (applied.rows[0] !== undefined) {
        if (applied.rows[0].checksum_sha256 !== migrationChecksum) {
          throw new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: false });
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO orchestration_schema_migrations (version, checksum_sha256) VALUES ($1, $2)",
        [migration.version, migrationChecksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof OrchestrationError) throw error;
    throw orchestrationStorageError(error);
  } finally {
    client.release();
  }
};

const orchestrationMigrationManifest = async (): Promise<OrchestrationMigration[]> => Promise.all([
  "0001_orchestration_core",
  "0002_ordered_scheduling",
  "0003_durable_workers",
  "0004_atomic_execution",
].map(async (version) => ({
  version,
  sql: await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), "utf8"),
})));

export const applyOrchestrationMigrations = async (pool: Pool, options: { schema: string }): Promise<void> =>
  applyOrchestrationMigrationManifest(pool, options, await orchestrationMigrationManifest());
