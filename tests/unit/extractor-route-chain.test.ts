import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import { parseAnalyzerResult } from "../../packages/ir/src/index.js";

async function analyze(source: string) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-express-chain-"));
  try {
    await writeFile(join(root, "app.ts"), source);
    return await createAnalyzer({ projectRoot: root }).analyze({
      exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "route-chain", analyzer: ANALYZER,
      source: { repository_id: "local", service_id: "orders", service_root: ".", immutable_revision: "a".repeat(40), source_digest: "pending", access_label: "test" },
      resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
      prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
      limits: { timeout_ms: 30000, max_files: 100, max_output_bytes: 1000000 },
      execution_policy: { network_access: false, side_effects: "none" },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("mounted Express route chains retain each method, handler, and path parameter", async () => {
  const result = await analyze(`import express, { Router } from "express";
    const app = express(); const router = Router();
    function read(_req, res) { res.status(200).type("application/json").json({ kind: "read" }); }
    router.route("/orders/:id").get(read).put((_req, res) => res.status(204).end());
    app.use("/api", router);`);
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map(item => [item.identity.method, item.application_path])).toEqual([
    ["GET", "/api/orders/:id"], ["PUT", "/api/orders/:id"],
  ]);
  expect(result.endpoints[0]?.responses[0]?.status).toEqual({ kind: "exact", code: 200 });
  expect(result.endpoints[1]?.responses[0]?.status).toEqual({ kind: "exact", code: 204 });
  expect(result.endpoints.every(item => item.parameters.some(param => param.name === "id" && param.presence.state === "required"))).toBe(true);
  for (const endpoint of result.endpoints) {
    const locations = endpoint.evidence_ids.map(id => result.evidence.find(item => item.evidence_id === id)?.location.pointer);
    expect(new Set(locations).size).toBeGreaterThanOrEqual(2);
    expect(result.dependencies.filter(item => item.from_endpoint_id === endpoint.endpoint_id && item.to.kind === "evidence").length).toBeGreaterThanOrEqual(3);
  }
  expect(result.diagnostics.map(item => item.code)).not.toContain("route_receiver_unsupported");
});

test("computed and conditional route chains remain unresolved", async () => {
  const result = await analyze(`import express from "express";
    const app = express();
    app.route(process.env.ROUTE).get((_req, res) => res.status(200).end());
    if (process.env.ENABLED) app.route("/conditional").post((_req, res) => res.status(201).end());`);
  expect(result.endpoints).toEqual([]);
  expect(result.status).toBe("partial");
  expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
    "computed_route_path_unresolved", "routing_predicate_unsupported",
  ]));
});

test("stored route builders and unrelated fluent APIs are not treated as Express routes", async () => {
  const result = await analyze(`import express from "express";
    const app = express();
    const stored = app.route("/stored"); stored.get((_req, res) => res.status(200).end());
    const unrelated = { route: () => ({ get: () => {} }) };
    unrelated.route("/fake").get(() => {});`);
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("route_receiver_unsupported");
});

test("ordinary get and post calls do not degrade Express coverage", async () => {
  const result = await analyze(`import express from "express"; import { trace } from "observability-package";
    const app = express();
    trace("request");
    const values = new Map<string, string>();
    values.get("key");
    const client = { post: (_value: string) => true, route: (_path: string) => ({ get: () => true }) };
    client.post("payload"); client.route("/not-an-express-route").get();
    app.get("/real", (_req, res) => res.status(200).end());`);
  expect(result.endpoints.map(item => item.application_path)).toEqual(["/real"]);
  expect(result.diagnostics.map(item => item.code)).not.toContain("route_receiver_unsupported");
  expect(result.diagnostics.map(item => item.code)).not.toContain("import_unresolved");
});
