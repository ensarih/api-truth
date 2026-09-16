import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  FIXED_TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "../../scripts/test-environment-lib.js";

let pool: Pool;

const schemaName = (): string => {
  const worker = (process.env.VITEST_POOL_ID ?? "0").replaceAll(/[^a-zA-Z0-9]/g, "_");
  return `api_truth_test_${worker}_${randomUUID().replaceAll("-", "")}`;
};

const identifier = (schema: string): string => {
  if (!/^api_truth_test_[A-Za-z0-9_]+$/.test(schema)) {
    throw new Error("refusing to use a schema outside the api_truth_test_ namespace");
  }
  return `"${schema}"`;
};

beforeAll(async () => {
  assertSafeTestDatabaseUrl(FIXED_TEST_DATABASE_URL);
  pool = new Pool({ connectionString: FIXED_TEST_DATABASE_URL, max: 4 });
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool?.end();
});

test.concurrent("isolates rows in two independently created test schemas", async () => {
  const first = schemaName();
  const second = schemaName();
  const firstSql = identifier(first);
  const secondSql = identifier(second);

  try {
    await pool.query(`CREATE SCHEMA ${firstSql}`);
    await pool.query(`CREATE SCHEMA ${secondSql}`);
    await pool.query(`CREATE TABLE ${firstSql}.observations (value text NOT NULL)`);
    await pool.query(`CREATE TABLE ${secondSql}.observations (value text NOT NULL)`);
    await pool.query(`INSERT INTO ${firstSql}.observations (value) VALUES ($1)`, ["first-only"]);
    await pool.query(`INSERT INTO ${secondSql}.observations (value) VALUES ($1)`, ["second-only"]);

    const firstRows = await pool.query<{ value: string }>(`SELECT value FROM ${firstSql}.observations`);
    const secondRows = await pool.query<{ value: string }>(`SELECT value FROM ${secondSql}.observations`);

    expect(firstRows.rows).toEqual([{ value: "first-only" }]);
    expect(secondRows.rows).toEqual([{ value: "second-only" }]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${firstSql} CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS ${secondSql} CASCADE`);
  }
});

test.concurrent("rolls back changes inside an isolated test schema", async () => {
  const schema = schemaName();
  const schemaSql = identifier(schema);
  const client = await pool.connect();

  try {
    await client.query(`CREATE SCHEMA ${schemaSql}`);
    await client.query(`CREATE TABLE ${schemaSql}.observations (value text NOT NULL)`);
    await client.query("BEGIN");
    await client.query(`INSERT INTO ${schemaSql}.observations (value) VALUES ($1)`, ["rolled-back"]);
    await client.query("ROLLBACK");

    const result = await client.query<{ count: string }>(`SELECT count(*) FROM ${schemaSql}.observations`);
    expect(result.rows).toEqual([{ count: "0" }]);
  } finally {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
    client.release();
  }
});
