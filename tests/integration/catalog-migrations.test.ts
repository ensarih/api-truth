import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ContractSnapshot } from "@api-truth/ir";
import type { Pool, PoolClient } from "pg";
import { expect, test } from "vitest";

import { CatalogError } from "../../packages/catalog/src/errors.js";
import { withCatalogTransaction } from "../../packages/catalog/src/database.js";
import {
  applyCatalogMigrations,
  applyMigrationManifest,
} from "../../packages/catalog/src/migrations.js";
import {
  catalogTestSchemaName,
  createCatalogTestDatabase,
  quoteCatalogTestSchema,
} from "./support/database.js";

const fixturePath = fileURLToPath(new URL("../fixtures/ir/express-snapshot.json", import.meta.url));

const loadSnapshot = async (): Promise<ContractSnapshot> =>
  JSON.parse(await readFile(fixturePath, "utf8")) as ContractSnapshot;

const sqlState = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const insertSnapshot = async (
  client: Pool | PoolClient,
  schema: string,
  snapshot: ContractSnapshot,
  scopes: Array<string | null>,
  tenant = "tenant-a",
): Promise<void> => {
  const schemaSql = quoteCatalogTestSchema(schema);
  await client.query(
    `INSERT INTO ${schemaSql}.catalog_snapshots (
      tenant_id, snapshot_id, repository_id, service_id, immutable_revision,
      analyzer_status, ir_version, identity_version, config_fingerprint,
      identity_sha256, content_sha256, required_scope_ids, document
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      tenant,
      snapshot.snapshot_id,
      snapshot.service.repository_id,
      snapshot.service.service_id,
      snapshot.source.immutable_revision,
      snapshot.coverage.status === "complete" ? "success" : "partial",
      snapshot.ir_version,
      snapshot.identity_version,
      snapshot.config.config_fingerprint,
      `sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
      scopes,
      snapshot,
    ],
  );
};

const seedScopes = async (pool: Pool, schema: string, tenant = "tenant-a"): Promise<void> => {
  const schemaSql = quoteCatalogTestSchema(schema);
  await pool.query(
    `INSERT INTO ${schemaSql}.access_scopes (tenant_id, access_scope_id, active)
     VALUES ($1, 'orders-read', true), ($1, 'shared-types-read', true)`,
    [tenant],
  );
};

test("applies the catalog migration once and verifies its checksum on replay", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyCatalogMigrations(database.pool, { schema: database.schema });
    const rows = await database.pool.query<{ version: string; checksum_sha256: string }>(
      `SELECT version, checksum_sha256 FROM ${schemaSql}.catalog_schema_migrations`,
    );
    expect(rows.rows).toEqual([
      { version: "0001_catalog_core", checksum_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ]);
  } finally {
    await database.cleanup();
  }
});

test("serializes concurrent first-run migration attempts", async () => {
  const database = await createCatalogTestDatabase({ migrate: false });
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await Promise.all([
      applyCatalogMigrations(database.pool, { schema: database.schema }),
      applyCatalogMigrations(database.pool, { schema: database.schema }),
    ]);
    const count = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM ${schemaSql}.catalog_schema_migrations`,
    );
    expect(count.rows).toEqual([{ count: "1" }]);
  } finally {
    await database.cleanup();
  }
});

test("applies an injected migration manifest in lexical version order", async () => {
  const database = await createCatalogTestDatabase({ migrate: false });
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyMigrationManifest(database.pool, { schema: database.schema }, [
      { version: "0002_second", sql: "ALTER TABLE ordered_table ADD COLUMN value text" },
      { version: "0001_first", sql: "CREATE TABLE ordered_table (id text PRIMARY KEY)" },
    ]);
    const rows = await database.pool.query<{ version: string }>(
      `SELECT version FROM ${schemaSql}.catalog_schema_migrations ORDER BY version`,
    );
    expect(rows.rows).toEqual([{ version: "0001_first" }, { version: "0002_second" }]);
  } finally {
    await database.cleanup();
  }
});

test("rejects checksum drift for an applied migration version without exposing SQL", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const secretSql = "SELECT 'provider-secret-reference'";
    const rejection = await applyMigrationManifest(database.pool, { schema: database.schema }, [
      { version: "0001_catalog_core", sql: secretSql },
    ]).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CatalogError);
    expect(rejection).toMatchObject({ code: "CATALOG_STORAGE_ERROR" });
    expect(JSON.stringify(rejection)).not.toContain("provider-secret-reference");
  } finally {
    await database.cleanup();
  }
});

test("rolls back the schema and ledger when a later migration statement fails", async () => {
  const database = await createCatalogTestDatabase({ migrate: false });
  const schema = database.schema;
  try {
    await expect(applyMigrationManifest(database.pool, { schema }, [
      { version: "0001_first", sql: "CREATE TABLE first_table (id text PRIMARY KEY)" },
      { version: "0002_broken", sql: "CREATE TABLE broken syntax" },
    ])).rejects.toMatchObject({ code: "CATALOG_STORAGE_ERROR" });
    const exists = await database.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists",
      [schema],
    );
    expect(exists.rows).toEqual([{ exists: false }]);
  } finally {
    await database.cleanup();
  }
});

test("sets a local catalog search path and rolls back failed work", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    const currentSchema = await withCatalogTransaction(
      database.pool,
      { schema: database.schema },
      async (client) => {
        const result = await client.query<{ current_schema: string }>(
          "SELECT current_schema() AS current_schema",
        );
        return result.rows[0]?.current_schema;
      },
    );
    expect(currentSchema).toBe(database.schema);

    await expect(withCatalogTransaction(
      database.pool,
      { schema: database.schema },
      async (client) => {
        await client.query(
          "INSERT INTO access_scopes (tenant_id, access_scope_id, active) VALUES ('tenant-a', 'rolled-back', true)",
        );
        throw new Error("force rollback");
      },
    )).rejects.toMatchObject({ code: "CATALOG_STORAGE_ERROR" });
    const count = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM ${schemaSql}.access_scopes WHERE access_scope_id = 'rolled-back'`,
    );
    expect(count.rows).toEqual([{ count: "0" }]);
  } finally {
    await database.cleanup();
  }
});

test.each([
  ["empty", []],
  ["null member", ["orders-read", null]],
  ["empty member", [""]],
  ["duplicate", ["orders-read", "orders-read"]],
  ["noncanonical", ["shared-types-read", "orders-read"]],
  ["noncanonical UTF-8 byte order", ["é", "z"]],
] as const)("rejects a %s required-scope array and leaves no snapshot", async (_name, scopes) => {
  const database = await createCatalogTestDatabase();
  const snapshot = await loadSnapshot();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  const client = await database.pool.connect();
  try {
    await seedScopes(database.pool, database.schema);
    await client.query("BEGIN");
    await expect(insertSnapshot(client, database.schema, snapshot, [...scopes])).rejects.toSatisfy(
      (error: unknown) => sqlState(error) === "23514",
    );
    await client.query("ROLLBACK");
    const count = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM ${schemaSql}.catalog_snapshots`,
    );
    expect(count.rows).toEqual([{ count: "0" }]);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await database.cleanup();
  }
});

test.each([
  ["unknown", "tenant-a"],
  ["other tenant only", "tenant-b"],
])("rejects an %s scope at commit and rolls back the direct insert", async (_name, tenant) => {
  const database = await createCatalogTestDatabase();
  const snapshot = await loadSnapshot();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  const client = await database.pool.connect();
  try {
    if (tenant === "tenant-b") await seedScopes(database.pool, database.schema, "tenant-a");
    await client.query("BEGIN");
    await insertSnapshot(client, database.schema, snapshot, ["orders-read"], tenant);
    await expect(client.query("COMMIT")).rejects.toSatisfy(
      (error: unknown) => sqlState(error) === "23503",
    );
    await client.query("ROLLBACK");
    const count = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM ${schemaSql}.catalog_snapshots`,
    );
    expect(count.rows).toEqual([{ count: "0" }]);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await database.cleanup();
  }
});

test("accepts known canonical scopes and rejects snapshot update, scope changes, and deletion", async () => {
  const database = await createCatalogTestDatabase();
  const snapshot = await loadSnapshot();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await seedScopes(database.pool, database.schema);
    await insertSnapshot(database.pool, database.schema, snapshot, ["orders-read", "shared-types-read"]);

    const mutations = [
      `UPDATE ${schemaSql}.catalog_snapshots SET service_id = 'changed' WHERE tenant_id = 'tenant-a'`,
      `UPDATE ${schemaSql}.catalog_snapshots SET required_scope_ids = ARRAY['orders-read'] WHERE tenant_id = 'tenant-a'`,
      `UPDATE ${schemaSql}.catalog_snapshots SET required_scope_ids = ARRAY['orders-read', 'replacement'] WHERE tenant_id = 'tenant-a'`,
      `UPDATE ${schemaSql}.catalog_snapshots SET required_scope_ids = ARRAY['shared-types-read', 'orders-read'] WHERE tenant_id = 'tenant-a'`,
      `DELETE FROM ${schemaSql}.catalog_snapshots WHERE tenant_id = 'tenant-a'`,
    ];
    for (const statement of mutations) {
      const rejection = await database.pool.query(statement).catch((error: unknown) => error);
      expect(sqlState(rejection)).toBe("55000");
      expect(rejection).toMatchObject({ message: "immutable catalog row" });
    }

    const row = await database.pool.query<{ required_scope_ids: string[] }>(
      `SELECT required_scope_ids FROM ${schemaSql}.catalog_snapshots`,
    );
    expect(row.rows).toEqual([{ required_scope_ids: ["orders-read", "shared-types-read"] }]);
  } finally {
    await database.cleanup();
  }
});

test("stores the exact D03 provider reference and unbounded sequence as text", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    const columns = await database.pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'catalog_branch_pointers'
       ORDER BY ordinal_position`,
      [database.schema],
    );
    expect(columns.rows).toEqual(expect.arrayContaining([
      { column_name: "provider_reference", data_type: "text" },
      { column_name: "order_value", data_type: "text" },
    ]));
    expect(columns.rows.some(({ column_name }) =>
      column_name.includes("numeric") || column_name === "providerReference")).toBe(false);

    const snapshot = await loadSnapshot();
    await seedScopes(database.pool, database.schema);
    await insertSnapshot(database.pool, database.schema, snapshot, ["orders-read"]);
    const sequence = "9".repeat(100_000);
    await database.pool.query(
      `INSERT INTO ${schemaSql}.catalog_branch_pointers (
        tenant_id, repository_id, service_id, branch, snapshot_id,
        provider, provider_reference, order_kind, order_value
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'sequence', $8)`,
      ["tenant-a", snapshot.service.repository_id, snapshot.service.service_id, "main",
        snapshot.snapshot_id, "github", "refs/heads/main", sequence],
    );
    const stored = await database.pool.query<{ provider_reference: string; order_value: string }>(
      `SELECT provider_reference, order_value FROM ${schemaSql}.catalog_branch_pointers`,
    );
    expect(stored.rows).toEqual([{ provider_reference: "refs/heads/main", order_value: sequence }]);
  } finally {
    await database.cleanup();
  }
});

test("enforces nonempty domain values and tenant-keyed foreign keys", async () => {
  const database = await createCatalogTestDatabase();
  const snapshot = await loadSnapshot();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await seedScopes(database.pool, database.schema);
    await insertSnapshot(database.pool, database.schema, snapshot, ["orders-read"]);

    const invalidDomainStatements = [
      `INSERT INTO ${schemaSql}.access_scopes (tenant_id, access_scope_id, active)
       VALUES ('', 'scope', true)`,
      `INSERT INTO ${schemaSql}.principal_scope_grants
       (tenant_id, principal_id, access_scope_id, active)
       VALUES ('tenant-a', '', 'orders-read', true)`,
      `INSERT INTO ${schemaSql}.catalog_branch_pointers
       (tenant_id, repository_id, service_id, branch, snapshot_id, provider, provider_reference)
       VALUES ('tenant-a', $1, $2, 'main', $3, 'github', '')`,
    ];
    for (const statement of invalidDomainStatements) {
      await expect(database.pool.query(statement, statement.includes("$1")
        ? [snapshot.service.repository_id, snapshot.service.service_id, snapshot.snapshot_id]
        : [])).rejects.toSatisfy((error: unknown) => sqlState(error) === "23514");
    }

    await database.pool.query(
      `INSERT INTO ${schemaSql}.access_scopes (tenant_id, access_scope_id, active)
       VALUES ('tenant-b', 'tenant-b-only', true)`,
    );
    await expect(database.pool.query(
      `INSERT INTO ${schemaSql}.principal_scope_grants
       (tenant_id, principal_id, access_scope_id, active)
       VALUES ('tenant-a', 'principal', 'tenant-b-only', true)`,
    )).rejects.toSatisfy((error: unknown) => sqlState(error) === "23503");
    await expect(database.pool.query(
      `INSERT INTO ${schemaSql}.catalog_branch_pointers
       (tenant_id, repository_id, service_id, branch, snapshot_id, provider, provider_reference)
       VALUES ('tenant-b', $1, $2, 'main', $3, 'github', 'refs/heads/main')`,
      [snapshot.service.repository_id, snapshot.service.service_id, snapshot.snapshot_id],
    )).rejects.toSatisfy((error: unknown) => sqlState(error) === "23503");
  } finally {
    await database.cleanup();
  }
});

test("keeps the migration ledger as the only table without tenant_id and creates required indexes", async () => {
  const database = await createCatalogTestDatabase();
  try {
    const tables = await database.pool.query<{ table_name: string; has_tenant: boolean }>(
      `SELECT table_name,
        EXISTS (
          SELECT 1 FROM information_schema.columns column_row
          WHERE column_row.table_schema = table_row.table_schema
            AND column_row.table_name = table_row.table_name
            AND column_row.column_name = 'tenant_id'
        ) AS has_tenant
       FROM information_schema.tables table_row
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [database.schema],
    );
    expect(tables.rows).toEqual([
      { table_name: "access_scopes", has_tenant: true },
      { table_name: "catalog_branch_pointers", has_tenant: true },
      { table_name: "catalog_schema_migrations", has_tenant: false },
      { table_name: "catalog_snapshots", has_tenant: true },
      { table_name: "principal_scope_grants", has_tenant: true },
    ]);

    const indexes = await database.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [database.schema],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(expect.arrayContaining([
      "catalog_snapshots_service_revision_idx",
      "principal_scope_grants_active_idx",
    ]));
  } finally {
    await database.cleanup();
  }
});

test("rejects unsafe schema identifiers before executing migration SQL", async () => {
  const database = await createCatalogTestDatabase({ migrate: false });
  const unsafe = `${catalogTestSchemaName()}; DROP SCHEMA public CASCADE`;
  try {
    await expect(applyCatalogMigrations(database.pool, { schema: unsafe }))
      .rejects.toMatchObject({ code: "INVALID_CATALOG_INPUT" });
  } finally {
    await database.cleanup();
  }
});
