import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import {
  parseContractSnapshot,
  type AnalyzerRequest,
  type AnalyzerResult,
} from "../../packages/ir/src/index.js";
import {
  createAccessPolicyStore,
  createCatalogStore,
  contractSnapshotFromAnalyzerResult,
  type AccessPolicyStore,
  type CatalogStore,
} from "../../packages/catalog/src/index.js";
import { createCatalogTestDatabase, type CatalogTestDatabase } from "./support/database.js";

const revision = "a".repeat(40);
let fixtureRoot: string;
let successResult: AnalyzerResult;
let partialResult: AnalyzerResult;
let database: CatalogTestDatabase;
let catalog: CatalogStore;
let access: AccessPolicyStore;

const request = (accessLabel = "orders-read"): AnalyzerRequest => ({
  exchange_version: "1.0.0",
  ir_version: "1.0.0",
  request_id: "catalog-integration-request",
  analyzer: ANALYZER,
  source: {
    repository_id: "orders-repository",
    service_id: "orders-service",
    service_root: ".",
    immutable_revision: revision,
    source_digest: "pending",
    access_label: accessLabel,
  },
  resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
  prior_dependencies: [],
  changed_paths: [],
  extraction_mode: "baseline",
  limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
  execution_policy: { network_access: false, side_effects: "none" },
});

const configure = async (
  tenantId: string,
  principalId: string,
  result: AnalyzerResult,
  grant = true,
): Promise<string[]> => {
  const { requiredScopeIds } = contractSnapshotFromAnalyzerResult(
    result,
    result.reproducibility_fingerprint,
  );
  for (const scopeId of requiredScopeIds) {
    await access.putScope({ tenantId }, { scopeId, active: true });
    if (grant) await access.putGrant({ tenantId }, { principalId, scopeId, active: true });
  }
  return requiredScopeIds;
};

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "api-truth-catalog-"));
  await writeFile(
    join(fixtureRoot, "service.ts"),
    "import express from 'express'; const app = express(); app.get('/health', (_req, res) => res.status(204).type('application/json').end());\n",
  );
  successResult = await createAnalyzer({ projectRoot: fixtureRoot }).analyze(request());
  partialResult = await createAnalyzer({
    projectRoot: resolve("fixtures/typescript/orders/baseline/src"),
  }).analyze(request());
  expect(successResult.status, JSON.stringify(successResult.diagnostics)).toBe("success");
  expect(partialResult.status).toBe("partial");
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  database = await createCatalogTestDatabase();
  catalog = createCatalogStore(database.pool, { schema: database.schema });
  access = createAccessPolicyStore(database.pool, { schema: database.schema });
});

afterEach(async () => {
  vi.useRealTimers();
  await database.cleanup();
});

describe("catalog snapshot persistence", () => {
  test("round-trips a real successful D05 result through a D03-valid stored document", async () => {
    const tenantId = "tenant-round-trip";
    const principalId = "reader-round-trip";
    const requiredScopeIds = await configure(tenantId, principalId, successResult);
    const expected = contractSnapshotFromAnalyzerResult(
      successResult,
      successResult.reproducibility_fingerprint,
    ).snapshot;

    const write = await catalog.ingestAnalyzerResult({
      tenantId,
      result: successResult,
      configFingerprint: successResult.reproducibility_fingerprint,
    });
    const stored = await catalog.getSnapshot({ tenantId, principalId }, successResult.snapshot_id);

    expect(write).toMatchObject({ outcome: "inserted", snapshotId: successResult.snapshot_id, requiredScopeIds });
    expect(stored.snapshot).toEqual(expected);
    expect(stored.requiredScopeIds).toEqual(requiredScopeIds);
    expect(stored.analyzerStatus).toBe("success");
    expect(parseContractSnapshot(stored.snapshot).ok).toBe(true);
  });

  test("preserves incomplete coverage and diagnostics for a real partial D05 result", async () => {
    const tenantId = "tenant-partial";
    const principalId = "reader-partial";
    await configure(tenantId, principalId, partialResult);
    await catalog.ingestAnalyzerResult({
      tenantId,
      result: partialResult,
      configFingerprint: partialResult.reproducibility_fingerprint,
    });

    const stored = await catalog.getSnapshot({ tenantId, principalId }, partialResult.snapshot_id);
    expect(stored.analyzerStatus).toBe("partial");
    expect(stored.snapshot.coverage).toEqual(partialResult.coverage);
    expect(stored.snapshot.diagnostics).toEqual(partialResult.diagnostics);
  });

  test("keeps the first full document when two real D05 runs differ only in completed_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T10:00:00.000Z"));
    const first = await createAnalyzer({ projectRoot: fixtureRoot }).analyze(request());
    vi.setSystemTime(new Date("2026-09-20T11:00:00.000Z"));
    const second = await createAnalyzer({ projectRoot: fixtureRoot }).analyze(request());
    vi.useRealTimers();

    expect(second.snapshot_id).toBe(first.snapshot_id);
    expect(second.completed_at).not.toBe(first.completed_at);

    const tenantId = "tenant-repeat-analysis";
    const principalId = "reader-repeat-analysis";
    await configure(tenantId, principalId, first);
    const inserted = await catalog.ingestAnalyzerResult({
      tenantId,
      result: first,
      configFingerprint: first.reproducibility_fingerprint,
    });
    const existing = await catalog.ingestAnalyzerResult({
      tenantId,
      result: second,
      configFingerprint: second.reproducibility_fingerprint,
    });

    expect(inserted.outcome).toBe("inserted");
    expect(existing).toEqual({ ...inserted, outcome: "existing" });
    const stored = await catalog.getSnapshot({ tenantId, principalId }, first.snapshot_id);
    expect(stored.snapshot.created_at).toBe(first.completed_at);
    const count = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM "${database.schema}".catalog_snapshots WHERE tenant_id = $1 AND snapshot_id = $2`,
      [tenantId, first.snapshot_id],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  test("rejects every replay change outside top-level created_at and preserves the first document", async () => {
    const tenantId = "tenant-conflicts";
    const principalId = "reader-conflicts";
    await configure(tenantId, principalId, partialResult);
    await catalog.ingestAnalyzerResult({
      tenantId,
      result: partialResult,
      configFingerprint: "config-original",
    });

    const changedIdentity = structuredClone(partialResult);
    changedIdentity.source.immutable_revision = "c".repeat(40);
    changedIdentity.evidence = changedIdentity.evidence.map((evidence) => ({
      ...evidence,
      source_version: changedIdentity.source.immutable_revision,
      scope: { ...evidence.scope, revision: changedIdentity.source.immutable_revision },
    }));
    const changedAnalyzer = structuredClone(partialResult);
    changedAnalyzer.analyzer.analyzer_version = "0.1.1";
    const changedSourceDigest = structuredClone(partialResult);
    changedSourceDigest.source.source_digest = "sha256:changed-source-digest";
    const changedCoverage = structuredClone(partialResult);
    if (changedCoverage.coverage.status !== "incomplete") throw new Error("expected partial fixture");
    changedCoverage.coverage.reason = "changed coverage reason";
    const changedEvidence = structuredClone(partialResult);
    changedEvidence.evidence[0]!.limitations = [
      ...changedEvidence.evidence[0]!.limitations,
      "changed evidence limitation",
    ];
    const changedSchemas = structuredClone(partialResult);
    const schema = Object.values(changedSchemas.schemas)[0];
    if (schema === undefined) throw new Error("expected schema fixture");
    schema.schema = { ...schema.schema, description: "changed schema description" };
    const changedEndpoints = structuredClone(partialResult);
    const responseContent = changedEndpoints.endpoints
      .flatMap((endpoint) => endpoint.responses)
      .flatMap((response) => response.content)[0];
    if (responseContent === undefined) throw new Error("expected response content fixture");
    responseContent.schema = { ...responseContent.schema, title: "changed response schema" };
    const changedClaims = structuredClone(partialResult);
    changedClaims.claims[0]!.value = { catalog_test: "changed claim value" };
    const changedDependencies = structuredClone(partialResult);
    const dependency = changedDependencies.dependencies[0]!;
    const extraEvidence = changedDependencies.evidence.find((candidate) =>
      !dependency.evidence_ids.includes(candidate.evidence_id));
    if (extraEvidence === undefined) throw new Error("expected extra evidence fixture");
    dependency.evidence_ids.push(extraEvidence.evidence_id);
    const changedDiagnostics = structuredClone(partialResult);
    changedDiagnostics.diagnostics[0] = {
      ...changedDiagnostics.diagnostics[0]!,
      message: "changed diagnostic message",
    };

    const cases: Array<[string, AnalyzerResult, string]> = [
      ["identity metadata", changedIdentity, "config-original"],
      ["source digest", changedSourceDigest, "config-original"],
      ["analyzer identity", changedAnalyzer, "config-original"],
      ["config fingerprint", structuredClone(partialResult), "config-changed"],
      ["coverage", changedCoverage, "config-original"],
      ["evidence", changedEvidence, "config-original"],
      ["schemas", changedSchemas, "config-original"],
      ["endpoints", changedEndpoints, "config-original"],
      ["claims", changedClaims, "config-original"],
      ["dependencies", changedDependencies, "config-original"],
      ["diagnostics", changedDiagnostics, "config-original"],
    ];

    for (const [label, result, configFingerprint] of cases) {
      await expect(catalog.ingestAnalyzerResult({ tenantId, result, configFingerprint }), label)
        .rejects.toMatchObject({ code: "SNAPSHOT_IDENTITY_CONFLICT" });
    }

    const changedStatus = structuredClone(partialResult);
    changedStatus.status = "success";
    changedStatus.coverage = {
      status: "complete",
      analyzed_roots: partialResult.coverage.analyzed_roots,
      diagnostic_ids: [],
    };
    await expect(catalog.ingestAnalyzerResult({
      tenantId,
      result: changedStatus,
      configFingerprint: "config-original",
    })).rejects.toMatchObject({ code: "SNAPSHOT_IDENTITY_CONFLICT" });

    const changedScopes = structuredClone(partialResult);
    changedScopes.evidence[0]!.access_label = "new-required-scope";
    await access.putScope({ tenantId }, { scopeId: "new-required-scope", active: true });
    await expect(catalog.ingestAnalyzerResult({
      tenantId,
      result: changedScopes,
      configFingerprint: "config-original",
    })).rejects.toMatchObject({ code: "SNAPSHOT_IDENTITY_CONFLICT" });

    const onlyCreatedAt = structuredClone(partialResult);
    onlyCreatedAt.completed_at = "2026-09-21T01:02:03.000Z";
    await expect(catalog.ingestAnalyzerResult({
      tenantId,
      result: onlyCreatedAt,
      configFingerprint: "config-original",
    })).resolves.toMatchObject({ outcome: "existing" });

    const stored = await catalog.getSnapshot({ tenantId, principalId }, partialResult.snapshot_id);
    expect(stored.snapshot.created_at).toBe(partialResult.completed_at);
    expect(stored.snapshot.analyzer).toEqual(partialResult.analyzer);
  });

  test("serializes concurrent identical and conflicting ingests without replacing the winner", async () => {
    const tenantId = "tenant-concurrent";
    const principalId = "reader-concurrent";
    await configure(tenantId, principalId, partialResult);
    const input = { tenantId, result: partialResult, configFingerprint: "config-concurrent" };
    const identical = await Promise.all([
      catalog.ingestAnalyzerResult(input),
      catalog.ingestAnalyzerResult(structuredClone(input)),
    ]);
    expect(identical.map((value) => value.outcome).sort()).toEqual(["existing", "inserted"]);

    const changed = structuredClone(partialResult);
    changed.diagnostics[0] = { ...changed.diagnostics[0]!, message: "concurrent different content" };
    const replay = await Promise.allSettled([
      catalog.ingestAnalyzerResult(input),
      catalog.ingestAnalyzerResult({ ...input, result: changed }),
    ]);
    expect(replay.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(replay.filter((value) => value.status === "rejected")[0]).toMatchObject({
      reason: expect.objectContaining({ code: "SNAPSHOT_IDENTITY_CONFLICT" }),
    });
    const stored = await catalog.getSnapshot({ tenantId, principalId }, partialResult.snapshot_id);
    expect(stored.snapshot.diagnostics).toEqual(partialResult.diagnostics);

    const raceTenantId = "tenant-concurrent-different";
    await configure(raceTenantId, principalId, partialResult);
    const differentRace = await Promise.allSettled([
      catalog.ingestAnalyzerResult({ ...input, tenantId: raceTenantId }),
      catalog.ingestAnalyzerResult({ ...input, tenantId: raceTenantId, result: changed }),
    ]);
    expect(differentRace.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(differentRace.filter((value) => value.status === "rejected")).toMatchObject([
      { reason: expect.objectContaining({ code: "SNAPSHOT_IDENTITY_CONFLICT" }) },
    ]);
    const raceStored = await catalog.getSnapshot(
      { tenantId: raceTenantId, principalId },
      partialResult.snapshot_id,
    );
    expect([
      partialResult.diagnostics[0]?.message,
      changed.diagnostics[0]?.message,
    ]).toContain(raceStored.snapshot.diagnostics[0]?.message);
  });

  test("rolls back unknown and inactive scopes and rejects failed results before connecting", async () => {
    const tenantId = "tenant-scope-rollback";
    await expect(catalog.ingestAnalyzerResult({
      tenantId,
      result: successResult,
      configFingerprint: "config",
    })).rejects.toMatchObject({ code: "UNKNOWN_ACCESS_SCOPE" });

    await access.putScope({ tenantId }, { scopeId: "orders-read", active: false });
    await expect(catalog.ingestAnalyzerResult({
      tenantId,
      result: successResult,
      configFingerprint: "config",
    })).rejects.toMatchObject({ code: "UNKNOWN_ACCESS_SCOPE" });

    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM "${database.schema}".catalog_snapshots WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows.rows[0]?.count).toBe("0");

    const failed = structuredClone(partialResult);
    failed.status = "failed";
    const disconnected = createCatalogStore(database.pool, { schema: database.schema });
    await expect(disconnected.ingestAnalyzerResult({
      tenantId: "tenant-failed",
      result: failed,
      configFingerprint: "config",
    })).rejects.toMatchObject({ code: "SNAPSHOT_INELIGIBLE" });
  });

  test("isolates identical IDs, principals, and scopes between tenants", async () => {
    const principalId = "same-reader";
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      await configure(tenantId, principalId, successResult, tenantId === "tenant-a");
      await catalog.ingestAnalyzerResult({
        tenantId,
        result: successResult,
        configFingerprint: tenantId,
      });
    }

    const first = await catalog.getSnapshot({ tenantId: "tenant-a", principalId }, successResult.snapshot_id);
    expect(first.snapshot.config.config_fingerprint).toBe("tenant-a");
    await expect(catalog.getSnapshot(
      { tenantId: "tenant-b", principalId },
      successResult.snapshot_id,
    )).rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
  });

  test("database immutability rejects direct snapshot update and delete", async () => {
    const tenantId = "tenant-immutable";
    await configure(tenantId, "reader", successResult);
    await catalog.ingestAnalyzerResult({ tenantId, result: successResult, configFingerprint: "config" });

    for (const sql of [
      `UPDATE "${database.schema}".catalog_snapshots SET required_scope_ids = ARRAY['other'] WHERE tenant_id = $1`,
      `DELETE FROM "${database.schema}".catalog_snapshots WHERE tenant_id = $1`,
    ]) {
      await expect(database.pool.query(sql, [tenantId])).rejects.toMatchObject({ code: "55000" });
    }
  });
});
