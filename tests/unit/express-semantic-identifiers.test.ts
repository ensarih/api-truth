import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, test} from "vitest";
import {ANALYZER, createAnalyzer} from "../../analyzers/typescript/src/index.js";
import type {AnalyzerRequest} from "../../packages/ir/src/index.js";

const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});

const analyze = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-express-identifiers-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), {recursive: true});
    await writeFile(join(root, path), source);
  }
  const request: AnalyzerRequest = {
    exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "semantic-identifiers",
    analyzer: ANALYZER,
    source: {repository_id: "repo-a", service_id: "service-a", service_root: ".",
      immutable_revision: "a".repeat(40), source_digest: "pending", access_label: "scope-a"},
    resolution_inputs: [{kind: "source_tree", path: ".", digest: "pending"}],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: {timeout_ms: 30_000, max_files: 20, max_output_bytes: 1_000_000},
    execution_policy: {network_access: false, side_effects: "none"},
  };
  return createAnalyzer({projectRoot: root}).analyze(request);
};

test("direct local named handler yields only endpoint-scoped route and symbol identifiers", async () => {
  const result = await analyze({"app.ts": `import express from "express";
    const app = express();
    function readOrder(req, res) { return res.status(200).json({ secret: "CANARY_SECRET_123" }); }
    app.get("/orders/:orderId", readOrder);`});
  const endpoint = result.endpoints[0]!;
  const route = result.claims.find(claim => claim.predicate === "route.registration")!;
  const handler = result.claims.find(claim => claim.predicate === "handler.symbol")!;
  expect(route).toMatchObject({subject: {service_id: "service-a", endpoint_id: endpoint.endpoint_id},
    value: {method: "GET", path: "/orders/:orderId"}, verification: "established_by_analysis"});
  expect(handler).toMatchObject({subject: {service_id: "service-a", endpoint_id: endpoint.endpoint_id},
    value: {symbol: "readOrder"}, verification: "established_by_analysis"});
  for (const claim of [route, handler]) {
    expect(claim.evidence_ids).toHaveLength(1);
    expect(result.evidence.find(item => item.evidence_id === claim.evidence_ids[0])).toMatchObject({
      source: {kind: "source_code", source_id: "repo-a"}, source_version: "a".repeat(40),
      method: "deterministic_analysis", scope: {service_id: "service-a", snapshot_id: result.snapshot_id,
        endpoint_id: endpoint.endpoint_id, revision: "a".repeat(40)},
      location: {path: "app.ts", pointer: expect.stringMatching(/^span:\d+:\d+$/)},
    });
  }
  expect(JSON.stringify([route, handler])).not.toContain("CANARY_SECRET_123");
});

test("aliases, imports, anonymous callbacks and anonymous arrow bindings have no handler symbol", async () => {
  const result = await analyze({
    "other.ts": "export function importedHandler(req, res) { return res.json({}); }",
    "app.ts": `import express from "express";
      import {importedHandler} from "./other";
      const app = express();
      function named(req, res) { return res.json({}); }
      const alias = named;
      const arrow = (req, res) => res.json({});
      app.get("/alias", alias);
      app.get("/imported", importedHandler);
      app.get("/arrow", arrow);
      app.get("/inline", (req, res) => res.json({}));
      app.get("/direct", named);`,
  });
  const byPath = new Map(result.endpoints.map(endpoint => [endpoint.application_path, endpoint.endpoint_id]));
  const symbols = result.claims.filter(claim => claim.predicate === "handler.symbol");
  expect(symbols).toEqual([expect.objectContaining({subject: expect.objectContaining({
    endpoint_id: byPath.get("/direct")}), value: {symbol: "named"}})]);
  expect(result.claims.filter(claim => claim.predicate === "route.registration")).toHaveLength(5);
});

test.each([
  "readOrder = alternate; app.get(\"/orders\", readOrder);",
  "app.get(\"/orders\", readOrder); readOrder = alternate;",
  "[readOrder] = [alternate]; app.get(\"/orders\", readOrder);",
  "({handler: readOrder} = {handler: alternate}); app.get(\"/orders\", readOrder);",
  "({readOrder} = {readOrder: alternate}); app.get(\"/orders\", readOrder);",
  "readOrder ||= alternate; app.get(\"/orders\", readOrder);",
  "for (readOrder of [alternate]) {} app.get(\"/orders\", readOrder);",
  "eval('readOrder = alternate'); app.get(\"/orders\", readOrder);",
])("withholds a named handler symbol if its binding is written anywhere: %s", async route => {
  const result = await analyze({"app.ts": `import express from "express";
    const app = express();
    function readOrder(req, res) { return res.json({}); }
    function alternate(req, res) { return res.json({}); }
    ${route}`});
  expect(result.claims.some(claim => claim.predicate === "handler.symbol")).toBe(false);
  expect(result.claims.find(claim => claim.predicate === "route.registration")?.value)
    .toEqual({method: "GET", path: "/orders"});
});

test("a write to a shadowed name does not invalidate a distinct handler binding", async () => {
  const result = await analyze({"app.ts": `import express from "express";
    const app = express();
    function readOrder(req, res) { return res.json({}); }
    function unrelated() { let readOrder = 1; readOrder = 2; return readOrder; }
    app.get("/orders", readOrder);`});
  expect(result.claims.find(claim => claim.predicate === "handler.symbol")?.value)
    .toEqual({symbol: "readOrder"});
});

test("mounted route registration records the composed application path with mount evidence", async () => {
  const result = await analyze({"app.ts": `import express from "express";
    const app = express();
    const router = express.Router();
    function readOrder(req, res) { return res.json({}); }
    router.get("/orders/:orderId", readOrder);
    app.use("/v2", router);`});
  const endpoint = result.endpoints[0]!;
  expect(endpoint.application_path).toBe("/v2/orders/:orderId");
  const route = result.claims.find(claim => claim.predicate === "route.registration")!;
  expect(route.value).toEqual({method: "GET", path: "/v2/orders/:orderId"});
  expect(route.evidence_ids.length).toBeGreaterThanOrEqual(2);
  expect(route.evidence_ids.every(id => result.evidence.some(item => item.evidence_id === id
    && item.scope.endpoint_id === endpoint.endpoint_id && item.source.kind === "source_code"))).toBe(true);
});
