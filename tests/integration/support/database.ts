import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  FIXED_TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "../../../scripts/test-environment-lib.js";
import { applyCatalogMigrations } from "../../../packages/catalog/src/migrations.js";

const TEST_SCHEMA = /^api_truth_test_[A-Za-z0-9_]+$/;

export const catalogTestSchemaName = (): string => {
  const worker = (process.env.VITEST_POOL_ID ?? "0").replaceAll(/[^A-Za-z0-9]/g, "_");
  return `api_truth_test_${worker}_${randomUUID().replaceAll("-", "")}`;
};

export const quoteCatalogTestSchema = (schema: string): string => {
  if (!TEST_SCHEMA.test(schema)) {
    throw new Error("refusing to use a schema outside the api_truth_test_ namespace");
  }
  return `"${schema}"`;
};

export type CatalogTestDatabase = {
  pool: Pool;
  schema: string;
  cleanup(): Promise<void>;
};

export const createCatalogTestDatabase = async (
  options: { migrate?: boolean } = {},
): Promise<CatalogTestDatabase> => {
  assertSafeTestDatabaseUrl(FIXED_TEST_DATABASE_URL);
  const pool = new Pool({ connectionString: FIXED_TEST_DATABASE_URL, max: 6 });
  const schema = catalogTestSchemaName();
  const schemaSql = quoteCatalogTestSchema(schema);
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
    } finally {
      await pool.end();
    }
  };

  try {
    await pool.query("SELECT 1");
    if (options.migrate ?? true) await applyCatalogMigrations(pool, { schema });
    return { pool, schema, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
