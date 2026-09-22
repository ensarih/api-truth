import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import { quoteSchemaIdentifier, setCatalogSearchPath } from "./database.js";
import { CatalogError, catalogStorageError } from "./errors.js";

export type CatalogMigration = Readonly<{
  version: string;
  sql: string;
}>;

const MIGRATION_VERSION = /^[0-9]{4}_[a-z][a-z0-9_]*$/;

const checksum = (sql: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`;

const validateManifest = (manifest: readonly CatalogMigration[]): CatalogMigration[] => {
  const ordered = [...manifest].sort((left, right) =>
    left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
  const versions = new Set<string>();
  for (const migration of ordered) {
    if (
      !MIGRATION_VERSION.test(migration.version)
      || typeof migration.sql !== "string"
      || migration.sql.length === 0
      || versions.has(migration.version)
    ) {
      throw new CatalogError("INVALID_CATALOG_INPUT");
    }
    versions.add(migration.version);
  }
  return ordered;
};

export const applyMigrationManifest = async (
  pool: Pool,
  options: { schema: string },
  manifest: readonly CatalogMigration[],
): Promise<void> => {
  const schemaSql = quoteSchemaIdentifier(options.schema);
  const migrations = validateManifest(manifest);
  const client = await pool.connect().catch((error: unknown) => {
    throw catalogStorageError(error);
  });

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_catalog");
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
      `api-truth:catalog-migrations:${options.schema}`,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaSql}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schemaSql}.catalog_schema_migrations (
      version text PRIMARY KEY,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await setCatalogSearchPath(client, options.schema);

    for (const migration of migrations) {
      const migrationChecksum = checksum(migration.sql);
      const applied = await client.query<{ checksum_sha256: string }>(
        "SELECT checksum_sha256 FROM catalog_schema_migrations WHERE version = $1",
        [migration.version],
      );
      const storedChecksum = applied.rows[0]?.checksum_sha256;
      if (storedChecksum !== undefined) {
        if (storedChecksum !== migrationChecksum) {
          throw new CatalogError("CATALOG_STORAGE_ERROR", { retryable: false });
        }
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        `INSERT INTO catalog_schema_migrations (version, checksum_sha256, applied_at)
         VALUES ($1, $2, clock_timestamp())`,
        [migration.version, migrationChecksum],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof CatalogError) throw error;
    throw catalogStorageError(error);
  } finally {
    client.release();
  }
};

const catalogMigrationManifest = async (): Promise<CatalogMigration[]> => [{
  version: "0001_catalog_core",
  sql: await readFile(new URL("../migrations/0001_catalog_core.sql", import.meta.url), "utf8"),
}];

export const applyCatalogMigrations = async (
  pool: Pool,
  options: { schema: string },
): Promise<void> => applyMigrationManifest(pool, options, await catalogMigrationManifest());
