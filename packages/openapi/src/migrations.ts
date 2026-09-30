import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const quoteOpenApiSchema = (schema: string): string => {
  if (!identifier.test(schema) || Buffer.byteLength(schema) > 63) throw new Error("Invalid OpenAPI schema");
  return `"${schema}"`;
};

export const applyOpenApiMigrations = async (pool: Pool, options: { schema: string }): Promise<void> => {
  const schema = quoteOpenApiSchema(options.schema);
  const sql = await readFile(new URL("../migrations/0001_publications.sql", import.meta.url), "utf8");
  const version = "0001_publications";
  const checksum = `sha256:${createHash("sha256").update(sql).digest("hex")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO pg_catalog");
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [`api-truth:openapi-migrations:${options.schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.openapi_schema_migrations (
      version text PRIMARY KEY, checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    const applied = await client.query<{ checksum_sha256: string }>(
      "SELECT checksum_sha256 FROM openapi_schema_migrations WHERE version = $1", [version]);
    if (applied.rows.length) {
      if (applied.rows[0]!.checksum_sha256 !== checksum) throw new Error("OpenAPI migration checksum mismatch");
    } else {
      await client.query(sql);
      await client.query("INSERT INTO openapi_schema_migrations(version, checksum_sha256) VALUES ($1, $2)", [version, checksum]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
};
