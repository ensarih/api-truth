import type { Pool, PoolClient } from "pg";

import { OrchestrationError, orchestrationStorageError } from "./errors.js";

const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const quoteOrchestrationSchemaIdentifier = (schema: string): string => {
  if (typeof schema !== "string" || !SQL_IDENTIFIER.test(schema)
    || Buffer.byteLength(schema, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  return `"${schema.replaceAll('"', '""')}"`;
};

export const setOrchestrationSearchPath = async (client: PoolClient, schema: string): Promise<void> => {
  await client.query(`SET LOCAL search_path TO ${quoteOrchestrationSchemaIdentifier(schema)}, pg_catalog`);
};

export const withOrchestrationTransaction = async <Value>(
  pool: Pool,
  options: { schema: string },
  operation: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  quoteOrchestrationSchemaIdentifier(options.schema);
  const client = await pool.connect().catch((error: unknown) => {
    throw orchestrationStorageError(error);
  });
  try {
    await client.query("BEGIN");
    await setOrchestrationSearchPath(client, options.schema);
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof OrchestrationError) throw error;
    throw orchestrationStorageError(error);
  } finally {
    client.release();
  }
};
