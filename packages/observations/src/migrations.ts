import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import type {Pool} from "pg";
import {quoteEnvironmentSchema} from "../../environment/src/migrations.js";

const version = "0001_metadata_imports";

export class ObservationStorageError extends Error {
  readonly code: "OBSERVATION_STORAGE_ERROR";
  constructor() {super("OBSERVATION_STORAGE_ERROR"); this.name = "ObservationStorageError";
    this.code = "OBSERVATION_STORAGE_ERROR";}
}

export const applyObservationMigrations = async (pool: Pool, options: {schema: string}): Promise<void> => {
  let schema: string;
  try {schema = quoteEnvironmentSchema(options.schema);} catch {throw new ObservationStorageError();}
  const body = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), "utf8")
    .catch(() => {throw new ObservationStorageError();});
  const checksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const client = await pool.connect().catch(() => {throw new ObservationStorageError();});
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      [`api-truth:observations-migrations:${options.schema}`]);
    const prerequisites = await client.query<{environment: string; catalog: string}>(
      `SELECT (SELECT count(*)::text FROM environment_schema_migrations
         WHERE version='0006_environment_requests') AS environment,
        (SELECT count(*)::text FROM catalog_schema_migrations
         WHERE version='0001_catalog_core') AS catalog`);
    if (prerequisites.rows[0]?.environment !== "1" || prerequisites.rows[0]?.catalog !== "1")
      throw new ObservationStorageError();
    await client.query(`CREATE TABLE IF NOT EXISTS observation_schema_migrations (
      version text PRIMARY KEY, checksum_sha256 text NOT NULL
        CHECK (checksum_sha256 ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const stored = await client.query<{checksum_sha256: string}>(
      "SELECT checksum_sha256 FROM observation_schema_migrations WHERE version=$1", [version]);
    if (!stored.rows.length) {
      await client.query(body);
      await client.query("INSERT INTO observation_schema_migrations(version,checksum_sha256) VALUES($1,$2)",
        [version, checksum]);
    } else if (stored.rows[0]?.checksum_sha256 !== checksum) throw new ObservationStorageError();
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new ObservationStorageError();
  } finally {client.release();}
};
