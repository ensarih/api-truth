import type { Pool, PoolClient } from "pg";

import { CatalogError, catalogStorageError } from "./errors.js";

const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const quoteSchemaIdentifier = (schema: string): string => {
  if (
    typeof schema !== "string"
    || !SQL_IDENTIFIER.test(schema)
    || Buffer.byteLength(schema, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES
  ) {
    throw new CatalogError("INVALID_CATALOG_INPUT");
  }
  return `"${schema.replaceAll('"', '""')}"`;
};

export const setCatalogSearchPath = async (
  client: PoolClient,
  schema: string,
): Promise<void> => {
  const schemaSql = quoteSchemaIdentifier(schema);
  await client.query(`SET LOCAL search_path TO ${schemaSql}, pg_catalog`);
};

export const withCatalogTransaction = async <Value>(
  pool: Pool,
  options: { schema: string },
  operation: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  quoteSchemaIdentifier(options.schema);
  const client = await pool.connect().catch((error: unknown) => {
    throw catalogStorageError(error);
  });
  try {
    await client.query("BEGIN");
    await setCatalogSearchPath(client, options.schema);
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof CatalogError) throw error;
    throw catalogStorageError(error);
  } finally {
    client.release();
  }
};
