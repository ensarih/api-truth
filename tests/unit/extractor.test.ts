import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAnalyzer, ANALYZER } from "../../analyzers/typescript/src/index.js";
import { parseAnalyzerResult, type AnalyzerRequest } from "../../packages/ir/src/index.js";

const roots: string[] = [];
async function service(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-extractor-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return { root, adapter: createAnalyzer({ projectRoot: root }) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function request(): AnalyzerRequest {
  return {
    exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "test-request", analyzer: ANALYZER,
    source: { repository_id: "inventory", service_id: "stock", service_root: ".", immutable_revision: "a".repeat(40), source_digest: "host-supplied-digest", access_label: "test" },
    resolution_inputs: [{ kind: "source_tree", path: ".", digest: "host-supplied-digest" }],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 100, max_output_bytes: 1000000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
}

test("invalid versions and out-of-service paths fail before filesystem access without leaking inputs", async () => {
  const adapter = createAnalyzer({ projectRoot: "/missing/private-secret" });
  await expect(adapter.analyze({ ...request(), ir_version: "bad-secret" })).rejects.toThrow("Invalid analyzer request");
  const req = request(); req.source.service_root = "service";
  await expect(adapter.analyze(req)).rejects.toThrow("Source boundary rejected");
});

test("baseline extracts DTOs, query unknowns, runtime validators, shared security and middleware errors", async () => {
  const result = await createAnalyzer({ projectRoot: resolve("fixtures/typescript/orders/baseline/src") }).analyze(request());
  expect(result.endpoints.map(e => e.application_path)).toEqual(["/api/orders/:orderId", "/api/orders", "/api/orders/:orderId"]);
  const get = result.endpoints.find(e => e.identity.method === "GET")!;
  const post = result.endpoints.find(e => e.identity.method === "POST")!;
  expect(get.parameters).toContainEqual(expect.objectContaining({ name: "includeItems", in: "query", presence: expect.objectContaining({ state: "unknown" }) }));
  expect(post.responses.map(r => r.status)).toContainEqual({ kind: "exact", code: 400 });
  expect(post.responses.find(r => r.status.kind === "exact" && r.status.code === 400)?.content).toEqual([]);
  const claims = result.claims.filter(c => c.subject.endpoint_id === post.endpoint_id);
  expect(claims).toContainEqual(expect.objectContaining({ predicate: "request.field.presence", value: "required", subject: expect.objectContaining({ schema_pointer: "/request/body/customer/address/city" }) }));
  expect(claims).toContainEqual(expect.objectContaining({ predicate: "request.field.presence", value: "optional", subject: expect.objectContaining({ schema_pointer: "/request/body/priority" }) }));
  expect(claims).toContainEqual(expect.objectContaining({ predicate: "request.field.enum", value: ["standard", "expedited"] }));
  expect(claims).toContainEqual(expect.objectContaining({ predicate: "security.middleware", value: expect.objectContaining({ symbol: "requireApiToken", guarantee: "unknown" }) }));
  expect(Object.values(result.schemas).map(s => s.schema)).toContainEqual(expect.objectContaining({ type: "object", properties: expect.objectContaining({ customer: expect.objectContaining({ type: "object" }), items: expect.objectContaining({ type: "array" }) }), required: ["customer", "items"] }));
  const shape = get.responses.find(r => r.status.kind === "exact" && r.status.code === 200)?.content[0]?.schema;
  expect(shape?.properties).toHaveProperty("includeItems");
  expect(result.diagnostics.map(d => d.code)).toContain("computed_route_path_unresolved");
  expect(result.status).toBe("partial");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("shared validator changes reach both dependents while endpoint identities survive revisions", async () => {
  const before = await createAnalyzer({ projectRoot: resolve("fixtures/typescript/orders/baseline/src") }).analyze(request());
  const req = request(); req.source.immutable_revision = "b".repeat(40);
  const after = await createAnalyzer({ projectRoot: resolve("fixtures/typescript/orders/changed/src") }).analyze(req);
  expect(after.endpoints).toHaveLength(4);
  for (const method of ["POST", "PUT"]) {
    const endpoint = after.endpoints.find(e => e.identity.method === method)!;
    expect(endpoint.endpoint_id).toBe(before.endpoints.find(e => e.identity.method === method)?.endpoint_id);
    expect(after.claims).toContainEqual(expect.objectContaining({ subject: { service_id: "stock", endpoint_id: endpoint.endpoint_id, schema_pointer: "/request/body/priority" }, predicate: "request.field.presence", value: "required" }));
    const evidenceIds = after.dependencies.filter(d => d.from_endpoint_id === endpoint.endpoint_id).map(d => d.to.id);
    expect(after.evidence.filter(e => evidenceIds.includes(e.evidence_id)).map(e => e.location.path)).toContain("validation.ts");
  }
});

test("independent recursive DTOs retain nullable enums, arrays and declared optionality", async () => {
  const { adapter } = await service({
    "models.ts": 'export interface Branch { label: "oak" | "pine" | null; children?: Branch[]; flags: {active: boolean}; opaque: unknown; }',
    "app.ts": 'import express from "express"; import type { Request, Response } from "express"; import type { Branch } from "./models"; const app = express(); function add(req: Request<{}, Branch, Branch>, res: Response) { res.status(202).type("application/json").json({ accepted: true }); } app.post("/forest", add);',
  });
  const result = await adapter.analyze(request());
  const branch = Object.values(result.schemas).find(s => s.schema.properties?.children)!;
  expect(branch.schema.required).toEqual(["label", "flags", "opaque"]);
  expect(branch.schema.properties?.children?.items?.$ref).toBe(`#/schemas/${branch.schema_id}`);
  expect(branch.schema.properties?.label).toEqual({ enum: ["oak", "pine", null] });
  expect(branch.schema.properties?.opaque).toEqual({});
  expect(result.diagnostics.map(d => d.code)).toContain("type_unknown");
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "response.declaration", verification: "declared" }));
  expect(result.endpoints[0]?.responses[0]?.content[0]?.schema.properties).toHaveProperty("accepted");
});

test("discovers aliased Express receivers through imported mounted routers without executing source", async () => {
  const { adapter } = await service({
    "app.ts": 'import server from "express"; import { router as inventory } from "./routes"; throw new Error("DO NOT EXECUTE"); const app = server(); app.use("/v2", inventory);',
    "routes.ts": 'import { Router as makeRouter } from "express"; export const router = makeRouter(); router.get("/stock/:sku", (req, res) => res.status(200).type("application/json").json({ok: true}));',
  });
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map(e => [e.identity.method, e.application_path])).toEqual([["GET", "/v2/stock/:sku"]]);
  expect(result.endpoints[0]?.parameters).toContainEqual(expect.objectContaining({ name: "sku", in: "path", presence: expect.objectContaining({ state: "required" }) }));
  expect(result.endpoints[0]?.responses).toContainEqual(expect.objectContaining({ status: { kind: "exact", code: 200 } }));
});

test("unsupported routing remains visible with source spans and never claims unconditional routes", async () => {
  const { adapter } = await service({ "app.ts": `import express, { Router } from "express";
    const app = express(); const a = Router(); const b = Router(); a.use(b); b.use(a);
    if (process.env.ENABLED) app.get("/conditional", (req,res) => res.json({}));
    app.get(process.env.PATH, (req,res) => res.json({}));
    app.use(process.env.PREFIX, a); app.route("/chain").get(handler);
    import(process.env.MODULE); unknownRouter.get("/unknown", handler);
    app.get("/same/:id", handler); app.get("/same/:key", otherHandler);` });
  const result = await adapter.analyze(request());
  expect(result.endpoints.some(e => e.application_path === "/conditional")).toBe(false);
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(["routing_predicate_unsupported", "computed_route_path_unresolved", "computed_mount_path_unresolved", "mount_cycle_unresolved", "dynamic_import_unresolved", "route_receiver_unsupported", "conflicting_route_handlers"]));
  for (const diag of result.diagnostics) expect(result.evidence.find(e => e.evidence_id === diag.evidence_ids[0])?.location.pointer).toMatch(/^span:/);
  expect(result.coverage.status).toBe("incomplete");
});

test("unsupported validator logic does not promote constraints or pretend security schemes", async () => {
  const { adapter } = await service({ "app.ts": `import express from "express"; const app = express();
    function validate(req,res,next) { const body = req.body;
      if (!body.secret) { return next(); }
      if (body.flag && !body.name) { res.status(400).json({error: true}); return; }
      next(); }
    app.post("/gates", validate, (req,res) => res.status(200).json({ok:true}));` });
  const result = await adapter.analyze(request());
  expect(result.claims.filter(c => c.predicate === "request.field.presence")).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toContain("validator_condition_unsupported");
  expect(result.endpoints[0]?.security).toEqual({ alternatives: [] });
});

test("enforces file/output limits, declared roots and symlink containment", async () => {
  const { adapter, root } = await service({ "a.ts": "export const a = 1", "b.ts": "export const b = 2" });
  const maxFiles = request(); maxFiles.limits.max_files = 1;
  await expect(adapter.analyze(maxFiles)).rejects.toThrow("input limit");
  const maxOutput = request(); maxOutput.limits.max_output_bytes = 10;
  await expect(adapter.analyze(maxOutput)).rejects.toThrow("output limit");
  const scope = request(); scope.resolution_inputs = [{ kind: "source_tree", path: "subdir", digest: "digest" }];
  await expect(adapter.analyze(scope)).rejects.toThrow("Unsupported resolution inputs");
  await symlink("/etc/passwd", join(root, "outside.ts"));
  await expect(adapter.analyze(request())).rejects.toThrow("Source boundary");
});

test("empty or unresolved imports cannot report complete coverage", async () => {
  const { adapter } = await service({ "app.ts": 'import { router } from "./missing"; export { router };' });
  const result = await adapter.analyze(request());
  expect(result.status).toBe("partial");
  expect(result.diagnostics.map(d => d.code)).toContain("import_unresolved");
});

test("dynamic mount prefixes do not leak guessed application paths", async () => {
  const { adapter } = await service({ "app.ts": 'import express, {Router} from "express"; const app=express(); const r=Router(); r.get("/hidden", (req,res)=>res.json({})); app.use(process.env.PREFIX,r);' });
  const result = await adapter.analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toContain("computed_mount_path_unresolved");
});

test("transitive DTO evidence remains attached to every consumer even when schemas are reused", async () => {
  const { adapter } = await service({
    "leaf.ts": 'export interface Leaf { value: string }',
    "dto.ts": 'import {Leaf} from "./leaf"; export interface Input { leaf: Leaf }',
    "app.ts": 'import express from "express"; import {Request} from "express"; import {Input} from "./dto"; const app=express(); function a(req:Request<{}, {}, Input>,res) { res.status(200).json({}); } app.post("/a",a); app.put("/b",a);',
  });
  const result = await adapter.analyze(request());
  for (const endpoint of result.endpoints) {
    const ids = result.dependencies.filter(d => d.from_endpoint_id === endpoint.endpoint_id).map(d => d.to.id);
    expect(result.evidence.filter(e => ids.includes(e.evidence_id)).map(e => e.location.path)).toContain("leaf.ts");
  }
});

test("reports explicit compiler/configuration identities and falls back for incremental requests", async () => {
  const { adapter } = await service({ "app.ts": 'import express from "express"; const app=express(); app.get("/x",(req,res)=>res.status(204).end());' });
  const req = request(); req.extraction_mode = "incremental";
  const result = await adapter.analyze(req);
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "analyzer.toolchain", value: { compiler: "typescript", compiler_version: "5.9.3", config_version: "1.0.0", extraction_mode: "fallback_full_service" } }));
});

test("mount-local and prefix-scoped middleware contributes errors only to matching paths", async () => {
  const { adapter } = await service({ "app.ts": `import express from "express";
    const app = express(); const r = express.Router();
    function guard(req,res,next) { if (!req.body.code) { res.status(403).json({denied:true}); return; } next(); }
    app.use("/private", guard); r.get("/item", (req,res)=>res.status(200).json({ok:true}));
    app.use("/private", guard, r); app.get("/public", (req,res)=>res.status(200).json({ok:true}));` });
  const result = await adapter.analyze(request());
  const privateEndpoint = result.endpoints.find(e => e.application_path === "/private/item");
  expect(privateEndpoint).toBeDefined();
  expect(privateEndpoint!.responses.map(r => r.status)).toContainEqual({ kind: "exact", code: 403 });
  expect(result.endpoints.find(e => e.application_path === "/public")?.responses.map(r => r.status)).not.toContainEqual({ kind: "exact", code: 403 });
});

test("declared query fields and Response generic preserve types but do not imply runtime presence", async () => {
  const { adapter } = await service({ "app.ts": `import express from "express"; import {Request, Response} from "express";
    interface Query { count: number; mode?: "tiny" | "full" } interface Reply { count: number }
    const app=express(); app.get("/query",(req:Request<{}, {}, {}, Query>,res:Response<Reply>)=>res.status(200).type("application/json").json({count:2}));` });
  const result = await adapter.analyze(request());
  expect(result.endpoints[0]?.parameters).toContainEqual(expect.objectContaining({ name: "count", schema: { type: "number" }, presence: expect.objectContaining({ state: "unknown" }) }));
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "response.declaration", verification: "declared" }));
});

test("malformed source, conditional expressions and invalid statuses produce diagnostics", async () => {
  const { adapter } = await service({
    "app.ts": 'import express from "express"; const app=express(); process.env.ON && app.get("/guarded", handler); app.get("/bad-status", (req,res)=>res.status(999).json({}));',
    "broken.ts": 'export interface Broken { x: ;',
  });
  const result = await adapter.analyze(request());
  expect(result.endpoints.some(e => e.application_path === "/guarded")).toBe(false);
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(["source_syntax_unsupported", "response_status_unknown", "routing_predicate_unsupported"]));
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("claimed SHA-256 digest mismatch fails instead of mislabeling a changed source snapshot", async () => {
  const { adapter } = await service({ "app.ts": 'import express from "express"; const app=express();' });
  const req = request(); req.source.source_digest = `sha256:${"0".repeat(64)}`;
  await expect(adapter.analyze(req)).rejects.toThrow("Source digest mismatch");
});
