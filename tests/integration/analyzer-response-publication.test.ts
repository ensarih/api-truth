import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import { createAccessPolicyStore, createCatalogStore } from "../../packages/catalog/src/index.js";
import { applyOrchestrationMigrations } from "../../packages/orchestration/src/index.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { createCatalogTestDatabase } from "./support/database.js";

const guarded = `import express from "express";
  const app = express();
  function requireApiKey(req, res, next) {
    if (req.get("X-API-Key") !== "synthetic-private-key") return res.status(401).end();
    next();
  }
  app.get("/orders", requireApiKey,
    (_request, response) => response.status(200).type("application/json").json({}));`;

const analyzeSource = async (source: string, extraFiles: Record<string, string> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-security-publication-"));
  await writeFile(join(root, "app.ts"), source);
  for (const [name, content] of Object.entries(extraFiles)) await writeFile(join(root, name), content);
  const result = await createAnalyzer({ projectRoot: root }).analyze({
    exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "security-publication", analyzer: ANALYZER,
    source: { repository_id: "commerce", service_id: "orders", service_root: ".",
      immutable_revision: "b".repeat(40), source_digest: "pending", access_label: "read" },
    resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
    execution_policy: { network_access: false, side_effects: "none" },
  });
  return {root, result};
};

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

test("a single direct Express guard publishes from analyzed source through catalog and D10", async () => {
  const {root, result} = await analyzeSource(guarded);
  const database = await createCatalogTestDatabase();
  try {
    expect(result.status).toBe("success");
    expect(result.coverage.status).toBe("complete");
    const endpoint = result.endpoints[0]!;
    expect(endpoint.security).toEqual({state: "declared", evidence_ids: expect.any(Array),
      alternatives: [{requirements: [{scheme: "apiKey", scopes: []}]}]});
    expect(result.security_schemes?.apiKey?.definition).toEqual({type: "apiKey", name: "x-api-key", in: "header"});
    expect(result.evidence.filter(item => endpoint.security.evidence_ids?.includes(item.evidence_id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({method: "runtime_validator",
        scope: expect.objectContaining({endpoint_id: endpoint.endpoint_id}), limitations: []})]));
    expect(endpoint.responses.map(item => item.status)).toEqual([{kind: "exact", code: 401}, {kind: "exact", code: 200}]);
    expect(endpoint.responses[0]?.content).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
    await applyOrchestrationMigrations(database.pool, {schema: database.schema});
    await applyOpenApiMigrations(database.pool, {schema: database.schema});
    const access = createAccessPolicyStore(database.pool, {schema: database.schema});
    await access.putScope({tenantId: "guard-tenant"}, {scopeId: "read", active: true});
    await access.putGrant({tenantId: "guard-tenant"}, {principalId: "reader", scopeId: "read", active: true});
    await createCatalogStore(database.pool, {schema: database.schema}).ingestAnalyzerResult({
      tenantId: "guard-tenant", result, configFingerprint: "guard-config"});
    const prepared = await createOpenApiPublicationStore(database.pool, {schema: database.schema})
      .prepareRevision({tenantId: "guard-tenant", principalId: "reader"},
        {kind: "revision", repositoryId: "commerce", serviceId: "orders", snapshotId: result.snapshot_id,
          revision: "b".repeat(40), configFingerprint: "guard-config"});
    expect(prepared.diagnostics).toEqual([]);
    expect(prepared.publishable).toBe(true);
  } finally { await database.cleanup(); await rm(root, {recursive: true, force: true}); }
});

test.each([
  ["a no-op named guard", guarded.replace(`if (req.get("X-API-Key") !== "synthetic-private-key") return res.status(401).end();`, "")],
  ["an earlier middleware", guarded.replace(`app.get("/orders"`, `app.use((_req, _res, next) => next()); app.get("/orders"`)],
  ["an earlier route", guarded.replace(`app.get("/orders"`, `app.get("/earlier", (_req, res) => res.status(200).end()); app.get("/orders"`)],
  ["receiver mutation", guarded.replace(`app.get("/orders"`, `app.get = other; app.get("/orders"`)],
  ["a side-effect import", guarded.replace(`import express from "express";`, `import express from "express"; import "./side-effect";`)],
  ["guard after handler", guarded.replace(`app.get("/orders", requireApiKey,\n    (_request, response) => response.status(200).type("application/json").json({}))`,
    `app.get("/orders", (_request, response) => response.status(200).type("application/json").json({}), requireApiKey)`)],
] as const)("keeps security unknown for %s", async (_reason, source) => {
  const {root, result} = await analyzeSource(source);
  try {
    expect(result.endpoints.find(endpoint => endpoint.application_path === "/orders")?.security)
      .toEqual({alternatives: []});
    expect(result.security_schemes?.apiKey).toBeUndefined();
  } finally { await rm(root, {recursive: true, force: true}); }
});

test.each([
  ["local const arrow", guarded.replace(`function requireApiKey(req, res, next) {`,
    `const requireApiKey = (req, res, next) => {`).replace(`    next();\n  }`, `    next();\n  };`)],
  ["inline first guard", guarded.replace(`  function requireApiKey(req, res, next) {\n    if (req.get("X-API-Key") !== "synthetic-private-key") return res.status(401).end();\n    next();\n  }\n`, "")
    .replace(`app.get("/orders", requireApiKey,`, `app.get("/orders", (req, res, next) => {\n    if (req.get("X-API-Key") !== "synthetic-private-key") return res.status(401).end();\n    next();\n  },`)],
] as const)("proves %s when the module is otherwise exact", async (_form, source) => {
  const {root, result} = await analyzeSource(source);
  try {
    expect(result.status).toBe("success");
    expect(result.endpoints[0]?.security.state).toBe("declared");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("an imported guard remains unknown even when its implementation resembles the proven shape", async () => {
  const source = guarded.replace(`  function requireApiKey(req, res, next) {\n    if (req.get("X-API-Key") !== "synthetic-private-key") return res.status(401).end();\n    next();\n  }`,
    `  import {requireApiKey} from "./guard.js";`);
  const {root, result} = await analyzeSource(source, {
    "guard.ts": `export function requireApiKey(req, res, next) {
      if (req.get("X-API-Key") !== "synthetic-private-key") return res.status(401).end();
      next();
    }`,
  });
  try {
    expect(result.endpoints[0]?.security).toEqual({alternatives: []});
    expect(result.security_schemes?.apiKey).toBeUndefined();
  } finally { await rm(root, {recursive: true, force: true}); }
});
