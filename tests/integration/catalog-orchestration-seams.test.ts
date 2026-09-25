import { resolve } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { PoolClient } from "pg";

import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import type { AnalyzerRequest, AnalyzerResult } from "../../packages/ir/src/index.js";
import {
  acquireCatalogBranchAdvisoryLock,
  catalogBranchAdvisoryKey,
  createAccessPolicyStore,
  createCatalogOrchestrationReader,
  createCatalogStore,
  createCatalogTransactionStore,
  contractSnapshotFromAnalyzerResult,
  type AccessPolicyStore,
  type CatalogStore,
  type PromoteBranchInput,
} from "../../packages/catalog/src/index.js";
import {
  createCatalogTestDatabase,
  quoteCatalogTestSchema,
  type CatalogTestDatabase,
} from "./support/database.js";

const tenantId = "tenant-orchestration-seams";
const repositoryId = "orders-repository";
const serviceId = "orders-service";
const branch = "main";
let result: AnalyzerResult;
let database: CatalogTestDatabase;
let catalog: CatalogStore;
let access: AccessPolicyStore;

const request: AnalyzerRequest = {
  exchange_version: "1.0.0",
  ir_version: "1.0.0",
  request_id: "catalog-orchestration-seams",
  analyzer: ANALYZER,
  source: {
    repository_id: repositoryId,
    service_id: serviceId,
    service_root: ".",
    immutable_revision: "a".repeat(40),
    source_digest: "pending",
    access_label: "orders-read",
  },
  resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
  prior_dependencies: [],
  changed_paths: [],
  extraction_mode: "baseline",
  limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
  execution_policy: { network_access: false, side_effects: "none" },
};

const promotion = (tenant = tenantId): PromoteBranchInput => ({
  tenantId: tenant,
  repositoryId,
  serviceId,
  branch,
  snapshotId: result.snapshot_id,
  provider: {
    provider: "test-provider",
    provider_reference: "delivery-1",
    order: { kind: "sequence", value: "1" },
  },
});

const configureScopes = async (): Promise<void> => {
  const converted = contractSnapshotFromAnalyzerResult(result, "config-orchestration");
  for (const scopeId of converted.requiredScopeIds) {
    await access.putScope({ tenantId }, { scopeId, active: true });
  }
};

beforeAll(async () => {
  result = await createAnalyzer({
    projectRoot: resolve("fixtures/typescript/orders/baseline/src"),
  }).analyze(request);
  expect(["success", "partial"]).toContain(result.status);
});

beforeEach(async () => {
  database = await createCatalogTestDatabase();
  catalog = createCatalogStore(database.pool, { schema: database.schema });
  access = createAccessPolicyStore(database.pool, { schema: database.schema });
  await configureScopes();
});

afterEach(async () => {
  await database.cleanup();
});

describe("trusted catalog orchestration seams", () => {
  test("keeps transaction control and release with the caller and rolls back both mutations", async () => {
    const client = await database.pool.connect();
    const statements: string[] = [];
    let releaseCalls = 0;
    const wrapped = new Proxy(client, {
      get(target, property) {
        if (property === "query") {
          return (text: unknown, values?: unknown[]) => {
            statements.push(typeof text === "string" ? text : "query-config");
            return target.query(text as string, values);
          };
        }
        if (property === "release") return () => { releaseCalls += 1; };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolClient;

    try {
      await client.query("BEGIN");
      const transaction = createCatalogTransactionStore(wrapped, { schema: database.schema });
      await transaction.ingestAnalyzerResult({
        tenantId,
        result,
        configFingerprint: "config-orchestration",
      });
      expect(statements.some((statement) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(statement))).toBe(false);
      expect(releaseCalls).toBe(0);
      await acquireCatalogBranchAdvisoryLock(wrapped, promotion());
      statements.length = 0;
      await transaction.promoteBranch(promotion());

      expect(statements.some((statement) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(statement))).toBe(false);
      expect(statements.some((statement) => /pg_advisory_xact_lock\s*\(/i.test(statement))).toBe(false);
      expect(releaseCalls).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const reader = createCatalogOrchestrationReader(database.pool, { schema: database.schema });
    await expect(reader.readStoredSnapshot({
      tenantId,
      repositoryId,
      serviceId,
      snapshotId: result.snapshot_id,
    })).rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
    await expect(reader.readBranch({ tenantId, repositoryId, serviceId, branch }))
      .resolves.toEqual({ state: "absent" });
  });

  test("matches ordinary-store results after caller commit", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = createCatalogTransactionStore(client, { schema: database.schema });
      const write = await transaction.ingestAnalyzerResult({
        tenantId,
        result,
        configFingerprint: "config-orchestration",
      });
      await acquireCatalogBranchAdvisoryLock(client, promotion());
      const promoted = await transaction.promoteBranch(promotion());
      await client.query("COMMIT");

      expect(write).toMatchObject({ outcome: "inserted", snapshotId: result.snapshot_id });
      expect(promoted).toMatchObject({ outcome: "promoted", pointer: { pointerVersion: "1" } });
    } finally {
      client.release();
    }

    await expect(catalog.ingestAnalyzerResult({
      tenantId,
      result,
      configFingerprint: "config-orchestration",
    })).resolves.toMatchObject({ outcome: "existing", snapshotId: result.snapshot_id });
    await expect(catalog.promoteBranch(promotion())).resolves.toMatchObject({
      outcome: "existing",
      pointer: { snapshotId: result.snapshot_id, pointerVersion: "1" },
    });
  });

  test("requires the exported branch lock before transaction promotion", async () => {
    await catalog.ingestAnalyzerResult({ tenantId, result, configFingerprint: "config-orchestration" });
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = createCatalogTransactionStore(client, { schema: database.schema });
      await expect(transaction.promoteBranch(promotion()))
        .rejects.toMatchObject({ code: "CATALOG_BRANCH_LOCK_REQUIRED", retryable: false });
      expect(catalogBranchAdvisoryKey(promotion())).toBe(
        catalogBranchAdvisoryKey({ tenantId, repositoryId, serviceId, branch }),
      );
      await acquireCatalogBranchAdvisoryLock(client, promotion());
      await expect(transaction.promoteBranch(promotion())).resolves.toMatchObject({ outcome: "promoted" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  test("reads exact trusted keys, reports absent branches, and rejects scope mismatches", async () => {
    await catalog.ingestAnalyzerResult({ tenantId, result, configFingerprint: "config-orchestration" });
    await catalog.promoteBranch(promotion());
    const reader = createCatalogOrchestrationReader(database.pool, { schema: database.schema });

    await expect(reader.readStoredSnapshot({ tenantId, repositoryId, serviceId, snapshotId: result.snapshot_id }))
      .resolves.toMatchObject({ tenantId, snapshotId: result.snapshot_id });
    await expect(reader.readBranch({ tenantId, repositoryId, serviceId, branch }))
      .resolves.toMatchObject({ pointer: { snapshotId: result.snapshot_id } });
    await expect(reader.readBranch({ tenantId, repositoryId, serviceId, branch: "missing" }))
      .resolves.toEqual({ state: "absent" });

    for (const key of [
      { tenantId: "other-tenant", repositoryId, serviceId, snapshotId: result.snapshot_id },
      { tenantId, repositoryId, serviceId: "other-service", snapshotId: result.snapshot_id },
    ]) {
      await expect(reader.readStoredSnapshot(key))
        .rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
    }
  });

  test("rejects corrupt rows through the shared stored-row verifier", async () => {
    await catalog.ingestAnalyzerResult({ tenantId, result, configFingerprint: "config-orchestration" });
    const schema = quoteCatalogTestSchema(database.schema);
    const corruptSnapshotId = "orchestration-corrupt-snapshot";
    await database.pool.query(
      `INSERT INTO ${schema}.catalog_snapshots (
         tenant_id, snapshot_id, repository_id, service_id, immutable_revision,
         analyzer_status, ir_version, identity_version, config_fingerprint,
         identity_sha256, content_sha256, required_scope_ids, document
       )
       SELECT tenant_id, $1, repository_id, service_id, immutable_revision,
              analyzer_status, ir_version, identity_version, config_fingerprint,
              identity_sha256, content_sha256, required_scope_ids, document
       FROM ${schema}.catalog_snapshots
       WHERE tenant_id = $2 AND snapshot_id = $3`,
      [corruptSnapshotId, tenantId, result.snapshot_id],
    );
    await database.pool.query(
      `INSERT INTO ${schema}.catalog_branch_pointers (
         tenant_id, repository_id, service_id, branch, snapshot_id,
         provider, provider_reference, order_kind, order_value
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        tenantId, repositoryId, serviceId, "corrupt", corruptSnapshotId,
        "provider", "reference", "sequence", "1",
      ],
    );
    const reader = createCatalogOrchestrationReader(database.pool, { schema: database.schema });
    await expect(reader.readStoredSnapshot({ tenantId, repositoryId, serviceId, snapshotId: corruptSnapshotId }))
      .rejects.toMatchObject({ code: "CATALOG_STORAGE_ERROR" });
    await expect(reader.readBranch({ tenantId, repositoryId, serviceId, branch: "corrupt" }))
      .rejects.toMatchObject({ code: "CATALOG_STORAGE_ERROR" });
  });
});
