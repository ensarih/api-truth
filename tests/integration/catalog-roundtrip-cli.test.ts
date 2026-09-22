import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

import { parseAnalyzerResult, type AnalyzerResult } from "../../packages/ir/src/index.js";
import {
  FIXED_TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "../../scripts/test-environment-lib.js";
import { runCatalogRoundtripCli } from "../../scripts/catalog-roundtrip.js";

const repositoryRoot = resolve(".");
const cliArguments = [
  "--input",
  "INPUT_FILE",
  "--tenant",
  "local-demo",
  "--principal",
  "local-developer",
  "--branch",
  "main",
];
const secretValues = [
  FIXED_TEST_DATABASE_URL,
  "synthetic-only",
  "local-demo",
  "local-developer",
  "local-roundtrip",
  "local-roundtrip-1",
];

let temporaryRoot: string;
let resultFile: string;
let failedResultFile: string;

const runRoundtrip = (input: string, extraArguments: string[] = []) => {
  const argumentsWithInput = cliArguments.map((argument) =>
    argument === "INPUT_FILE" ? input : argument);
  return spawnSync("npm", [
    "run",
    "--silent",
    "catalog:roundtrip",
    "--",
    ...argumentsWithInput,
    ...extraArguments,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
};

const runDocumentedRoundtrip = (input: string) => spawnSync("npm", [
  "run",
  "catalog:roundtrip",
  "--",
  ...cliArguments.map((argument) => argument === "INPUT_FILE" ? input : argument),
], {
  cwd: repositoryRoot,
  encoding: "utf8",
  timeout: 30_000,
});

const catalogSchemas = async (): Promise<string[]> => {
  assertSafeTestDatabaseUrl(FIXED_TEST_DATABASE_URL);
  const pool = new Pool({ connectionString: FIXED_TEST_DATABASE_URL });
  try {
    const selected = await pool.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name LIKE 'api_truth_test\\_roundtrip\\_%' ESCAPE '\\'
       ORDER BY schema_name`,
    );
    return selected.rows.map(({ schema_name: schemaName }) => schemaName);
  } finally {
    await pool.end();
  }
};

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "api-truth-catalog-roundtrip-"));
  resultFile = join(temporaryRoot, "analyzer-result.json");
  failedResultFile = join(temporaryRoot, "failed-analyzer-result.json");

  const extracted = spawnSync(
    "npm",
    [
      "run",
      "--silent",
      "extract",
      "--",
      "--source",
      "fixtures/typescript/orders/baseline/src",
      "--service",
      "orders",
      "--revision",
      "a".repeat(40),
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
  );
  expect(extracted.status).toBe(0);
  const parsed = parseAnalyzerResult(JSON.parse(extracted.stdout));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("invalid baseline analyzer result");
  await writeFile(resultFile, extracted.stdout, "utf8");

  const failed: AnalyzerResult = structuredClone(parsed.value);
  failed.status = "failed";
  await writeFile(failedResultFile, `${JSON.stringify(failed)}\n`, "utf8");
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("the exact documented command round-trips the D05 baseline with JSON-only safe output", async () => {
  const schemasBefore = await catalogSchemas();
  const output = runRoundtrip(resultFile);

  expect(output.status).toBe(0);
  expect(output.stderr).toBe("");
  const summary = JSON.parse(output.stdout);
  expect(summary).toEqual({
    snapshot_id: expect.stringMatching(/^snapshot-.+/),
    branch: "main",
    pointer_version: "1",
    round_trip_valid: true,
  });
  expect(Object.keys(summary)).toEqual([
    "snapshot_id",
    "branch",
    "pointer_version",
    "round_trip_valid",
  ]);
  for (const secret of secretValues) expect(output.stdout).not.toContain(secret);

  const documentedOutput = runDocumentedRoundtrip(resultFile);
  expect(documentedOutput.status).toBe(0);
  expect(documentedOutput.stderr).toBe("");
  expect(JSON.parse(documentedOutput.stdout.trim().split("\n").at(-1)!)).toEqual(summary);
  expect(await catalogSchemas()).toEqual(schemasBefore);
});

test("argument and ineligible-result failures are stable, secret-safe, and leave no schema", async () => {
  const schemasBefore = await catalogSchemas();
  const invalidInvocations = [
    spawnSync("npm", ["run", "--silent", "catalog:roundtrip", "--", "--input", resultFile], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
    }),
    runRoundtrip(resultFile, ["--unknown", "planted-secret-value"]),
    runRoundtrip(failedResultFile),
  ];

  expect(invalidInvocations[0]!.status).not.toBe(0);
  expect(invalidInvocations[0]!.stderr).toContain("[INVALID_CATALOG_INPUT]");
  expect(invalidInvocations[1]!.status).not.toBe(0);
  expect(invalidInvocations[1]!.stderr).toContain("[INVALID_CATALOG_INPUT]");
  expect(invalidInvocations[2]!.status).not.toBe(0);
  expect(invalidInvocations[2]!.stderr).toContain("[SNAPSHOT_INELIGIBLE]");
  for (const output of invalidInvocations) {
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain("planted-secret-value");
    expect(output.stderr).not.toContain(resultFile);
    for (const secret of secretValues) expect(output.stderr).not.toContain(secret);
  }
  expect(await readFile(failedResultFile, "utf8")).not.toBe("");
  expect(await catalogSchemas()).toEqual(schemasBefore);
});

test("a denied principal fails generically and the failure path removes its schema", async () => {
  const schemasBefore = await catalogSchemas();
  let stdout = "";
  let stderr = "";
  const exitCode = await runCatalogRoundtripCli(
    cliArguments.map((argument) => argument === "INPUT_FILE" ? resultFile : argument),
    {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    },
    { readPrincipalId: "principal-without-grants" },
  );

  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe(
    "api-truth catalog error [CATALOG_NOT_FOUND_OR_DENIED]: "
    + "Catalog resource was not found or access was denied\n",
  );
  for (const secret of secretValues) expect(stderr).not.toContain(secret);
  expect(await catalogSchemas()).toEqual(schemasBefore);
});
