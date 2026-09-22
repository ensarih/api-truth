import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  FIXED_TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "./test-environment-lib.ts";

const sourceRoots = [
  new URL("../packages/ir/src/", import.meta.url).href,
  new URL("../packages/catalog/src/", import.meta.url).href,
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".")
      && specifier.endsWith(".js")
      && sourceRoots.some((root) => context.parentURL?.startsWith(root))
    ) {
      const target = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (sourceRoots.some((root) => target.href.startsWith(root))) {
        return nextResolve(target.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const [{ parseAnalyzerResult, parseContractSnapshot }, catalogModule] = await Promise.all([
  import("../packages/ir/src/index.ts"),
  import("../packages/catalog/src/index.ts"),
]);

const {
  CatalogError,
  applyCatalogMigrations,
  contractSnapshotFromAnalyzerResult,
  createAccessPolicyStore,
  createCatalogStore,
} = catalogModule;

const requiredArguments = ["--input", "--tenant", "--principal", "--branch"] as const;
const allowedArguments = new Set<string>(requiredArguments);
const testSchema = /^api_truth_test_[A-Za-z0-9_]+$/;

type Arguments = {
  input: string;
  tenantId: string;
  principalId: string;
  branch: string;
};

type Summary = {
  snapshot_id: string;
  branch: string;
  pointer_version: string;
  round_trip_valid: true;
};

type Output = {
  stdout(value: string): void;
  stderr(value: string): void;
};

type RoundtripTestOptions = {
  readPrincipalId?: string;
};

const invalidInput = (): never => {
  throw new CatalogError("INVALID_CATALOG_INPUT");
};

const parseArguments = (args: readonly string[]): Arguments => {
  if (args.length !== requiredArguments.length * 2) return invalidInput();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined
      || value === undefined
      || !allowedArguments.has(name)
      || values.has(name)
      || value.length === 0
      || value.startsWith("--")
    ) return invalidInput();
    values.set(name, value);
  }
  if (!requiredArguments.every((name) => values.has(name))) return invalidInput();
  return {
    input: values.get("--input")!,
    tenantId: values.get("--tenant")!,
    principalId: values.get("--principal")!,
    branch: values.get("--branch")!,
  };
};

const readAnalyzerResult = async (path: string) => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new CatalogError("INVALID_SNAPSHOT");
  }
  const parsed = parseAnalyzerResult(candidate);
  if (!parsed.ok) {
    throw new CatalogError("INVALID_SNAPSHOT", {
      issues: parsed.error.issues.map(({ path: issuePath, code }) => ({
        path: issuePath,
        code,
      })),
    });
  }
  return parsed.value;
};

const schemaName = (): string => `api_truth_test_roundtrip_${randomUUID().replaceAll("-", "")}`;

const quotedTestSchema = (schema: string): string => {
  if (!testSchema.test(schema) || Buffer.byteLength(schema, "utf8") > 63) {
    throw new CatalogError("INVALID_CATALOG_INPUT");
  }
  return `"${schema}"`;
};

const exactStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const executeCatalogRoundtrip = async (
  rawArguments: readonly string[],
  testOptions: RoundtripTestOptions = {},
): Promise<Summary> => {
  const args = parseArguments(rawArguments);
  const analyzerResult = await readAnalyzerResult(args.input);
  const converted = contractSnapshotFromAnalyzerResult(
    analyzerResult,
    analyzerResult.reproducibility_fingerprint,
  );

  assertSafeTestDatabaseUrl(FIXED_TEST_DATABASE_URL);
  const schema = schemaName();
  const schemaSql = quotedTestSchema(schema);
  const pool = new Pool({ connectionString: FIXED_TEST_DATABASE_URL, max: 6 });
  let operationFailed = false;

  try {
    await applyCatalogMigrations(pool, { schema });
    const access = createAccessPolicyStore(pool, { schema });
    const catalog = createCatalogStore(pool, { schema });
    const tenant = { tenantId: args.tenantId };

    for (const scopeId of converted.requiredScopeIds) {
      await access.putScope(tenant, { scopeId, active: true });
      await access.putGrant(tenant, {
        principalId: args.principalId,
        scopeId,
        active: true,
      });
    }

    const write = await catalog.ingestAnalyzerResult({
      ...tenant,
      result: analyzerResult,
      configFingerprint: analyzerResult.reproducibility_fingerprint,
    });
    const promotion = await catalog.promoteBranch({
      ...tenant,
      repositoryId: analyzerResult.source.repository_id,
      serviceId: analyzerResult.source.service_id,
      branch: args.branch,
      snapshotId: write.snapshotId,
      provider: {
        provider: "local-roundtrip",
        provider_reference: "local-roundtrip-1",
        order: { kind: "sequence", value: "1" },
      },
    });
    const principal = {
      ...tenant,
      principalId: testOptions.readPrincipalId ?? args.principalId,
    };
    const resolution = await catalog.resolveBranch(principal, {
      repositoryId: analyzerResult.source.repository_id,
      serviceId: analyzerResult.source.service_id,
      branch: args.branch,
    });
    const directRead = await catalog.getSnapshot(principal, write.snapshotId);
    const resolvedParsed = parseContractSnapshot(resolution.stored.snapshot);
    const directParsed = parseContractSnapshot(directRead.snapshot);
    if (
      !resolvedParsed.ok
      || !directParsed.ok
      || resolution.pointer.snapshotId !== write.snapshotId
      || resolution.pointer.branch !== args.branch
      || resolution.pointer.pointerVersion !== promotion.pointer.pointerVersion
      || resolution.stored.snapshotId !== directRead.snapshotId
      || resolution.stored.contentSha256 !== directRead.contentSha256
      || !exactStrings(write.requiredScopeIds, converted.requiredScopeIds)
      || !exactStrings(resolution.stored.requiredScopeIds, converted.requiredScopeIds)
      || !exactStrings(directRead.requiredScopeIds, converted.requiredScopeIds)
    ) {
      throw new CatalogError("CATALOG_STORAGE_ERROR", { retryable: false });
    }

    return {
      snapshot_id: write.snapshotId,
      branch: args.branch,
      pointer_version: promotion.pointer.pointerVersion,
      round_trip_valid: true,
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
    } catch (error) {
      if (!operationFailed) throw new CatalogError("CATALOG_STORAGE_ERROR", { retryable: true });
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
};

export const runCatalogRoundtripCli = async (
  args: readonly string[],
  output: Output,
  testOptions: RoundtripTestOptions = {},
): Promise<number> => {
  try {
    const summary = await executeCatalogRoundtrip(args, testOptions);
    output.stdout(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    let catalogError: InstanceType<typeof CatalogError>;
    try {
      catalogError = error instanceof CatalogError
        ? error
        : new CatalogError("CATALOG_STORAGE_ERROR");
    } catch {
      catalogError = new CatalogError("CATALOG_STORAGE_ERROR");
    }
    output.stderr(`api-truth catalog error [${catalogError.code}]: ${catalogError.message}\n`);
    return 1;
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCatalogRoundtripCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  });
}
