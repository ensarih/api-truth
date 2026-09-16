import { Client } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  FIXED_TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "../../scripts/test-environment-lib.js";

let client: Client;

beforeAll(async () => {
  assertSafeTestDatabaseUrl(FIXED_TEST_DATABASE_URL);
  client = new Client({ connectionString: FIXED_TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

test("connects to the designated synthetic database identity", async () => {
  const result = await client.query<{ database: string; username: string }>(
    "SELECT current_database() AS database, current_user AS username",
  );

  expect(result.rows).toEqual([
    { database: "api_truth_test", username: "api_truth_test" },
  ]);
});
