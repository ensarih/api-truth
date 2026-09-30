import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

import { EnvironmentError } from "./errors.js";

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const quoteEnvironmentSchema = (schema: unknown): string => {
  if (typeof schema !== "string" || !SQL_IDENTIFIER.test(schema)
    || Buffer.byteLength(schema, "utf8") > 63) throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
  return `"${schema}"`;
};

const migrationVersions = ["0001_deployment_attempts", "0002_serving_observations",
  "0003_deployment_inbox"] as const;
const checksum = (body: string): string => `sha256:${createHash("sha256").update(body).digest("hex")}`;

export const applyEnvironmentMigrations = async (pool: Pool, options: { schema: string }): Promise<void> => {
  const schema = quoteEnvironmentSchema(options.schema);
  const migrations = await Promise.all(migrationVersions.map(async (version) => ({ version,
    body: await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), "utf8")
      .catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); }),
  })));
  const client = await pool.connect().catch(() => { throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); });
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
      `api-truth:environment-migrations:${options.schema}`,
    ]);
    const prerequisite = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orchestration_schema_migrations
       WHERE version='0005_revision_target_uniqueness'`,
    );
    if (prerequisite.rows[0]?.count !== "1") throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
    await client.query(`CREATE TABLE IF NOT EXISTS environment_schema_migrations (
      version text PRIMARY KEY,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    for (const migration of migrations) {
      const stored = await client.query<{ checksum_sha256: string }>(
        "SELECT checksum_sha256 FROM environment_schema_migrations WHERE version=$1", [migration.version],
      );
      const expected = checksum(migration.body);
      if (stored.rows[0] === undefined) {
        await client.query(migration.body);
        await client.query("INSERT INTO environment_schema_migrations (version,checksum_sha256) VALUES ($1,$2)",
          [migration.version, expected]);
      } else if (stored.rows[0].checksum_sha256 !== expected) {
        throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
  } finally { client.release(); }
};
