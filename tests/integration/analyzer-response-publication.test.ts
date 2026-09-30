import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import { createAccessPolicyStore, createCatalogStore } from "../../packages/catalog/src/index.js";
import { applyOrchestrationMigrations } from "../../packages/orchestration/src/index.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { createCatalogTestDatabase } from "./support/database.js";

test("real analyzed GET clears D10 response proof diagnostic but leaves security unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-response-publication-"));
  const database = await createCatalogTestDatabase();
  try {
    await writeFile(join(root, "app.ts"), `import express from "express";
      const app = express();
      app.get("/orders", (_request, response) => response.status(200).type("application/json").json({}));`);
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyOpenApiMigrations(database.pool, { schema: database.schema });
    const revision = "a".repeat(40);
    const result = await createAnalyzer({ projectRoot: root }).analyze({
      exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "response-publication", analyzer: ANALYZER,
      source: { repository_id: "commerce", service_id: "orders", service_root: ".",
        immutable_revision: revision, source_digest: "pending", access_label: "read" },
      resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
      prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
      limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
      execution_policy: { network_access: false, side_effects: "none" },
    });
    expect(result.status).toBe("success");
    expect(result.coverage.status).toBe("complete");
    const access = createAccessPolicyStore(database.pool, { schema: database.schema });
    await access.putScope({ tenantId: "response-tenant" }, { scopeId: "read", active: true });
    await access.putGrant({ tenantId: "response-tenant" }, { principalId: "reader", scopeId: "read", active: true });
    await createCatalogStore(database.pool, { schema: database.schema }).ingestAnalyzerResult({
      tenantId: "response-tenant", result, configFingerprint: "response-config" });
    const prepared = await createOpenApiPublicationStore(database.pool, { schema: database.schema })
      .prepareRevision({ tenantId: "response-tenant", principalId: "reader" },
        { kind: "revision", repositoryId: "commerce", serviceId: "orders",
          snapshotId: result.snapshot_id, revision, configFingerprint: "response-config" });
    expect(prepared.publishable).toBe(false);
    expect(prepared.diagnostics.map((item) => item.code)).toEqual(["UNKNOWN_SECURITY"]);
  } finally { await database.cleanup(); await rm(root, { recursive: true, force: true }); }
});
