import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/routing-controllers/src/index.js";
import { parseAnalyzerResult, type AnalyzerRequest } from "../../packages/ir/src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function service(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-routing-controllers-")); roots.push(root);
  await mkdir(join(root, "service"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, "service", name), text);
  return { root, adapter: createAnalyzer({ projectRoot: root }) };
}
function request(): AnalyzerRequest {
  return {
    exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "decorator-test", analyzer: ANALYZER,
    source: { repository_id: "sample-repo", service_id: "sample", service_root: "service",
      immutable_revision: "a".repeat(40), source_digest: "host-supplied-digest", access_label: "test" },
    resolution_inputs: [{ kind: "source_tree", path: "service", digest: "host-supplied-digest" }],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 30, max_output_bytes: 1000000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
}

test("import aliases and namespace decorators produce D03-valid declared routes", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { JsonController as JC, Get as Read, Param as RouteParam, QueryParam as Query, HttpCode, ContentType } from "routing-controllers";
    import * as RC from "routing-controllers";
    @JC("/api") export class Orders {
      @Read("/orders/:id") @HttpCode(202) @ContentType("application/vnd.order+json")
      get(@RouteParam("id") id: string, @Query("verbose", { required: false }) verbose?: boolean): { ok: boolean } {
        return { ok: true };
      }
      @RC.Post("/orders") create(@RC.Body() input: { title: string }): string { return input.title; }
    }
  `, "app.ts": `import { createExpressServer } from "routing-controllers";
    import { Orders } from "./controller";
    createExpressServer({ controllers: [Orders] });` });
  const first = await adapter.analyze(request());
  const second = await adapter.analyze(request());
  expect(parseAnalyzerResult(first).ok).toBe(true);
  expect(first.endpoints).toHaveLength(2);
  const post = first.endpoints.find(endpoint => endpoint.identity.method === "POST");
  const get = first.endpoints.find(endpoint => endpoint.identity.method === "GET");
  expect(post).toMatchObject({ application_path: "/api/orders", identity: { method: "POST" },
    request_bodies: [{ media_type: "application/json", presence: { state: "unknown" } }],
    responses: [{ status: { kind: "unknown" }, content: [{ media_type: "application/json" }] }],
    security: { state: "unknown" } });
  expect(get).toMatchObject({ application_path: "/api/orders/:id", identity: { method: "GET" },
    parameters: [
      { in: "path", name: "id", presence: { state: "required" }, schema: { type: "string" } },
      { in: "query", name: "verbose", presence: { state: "optional" }, schema: { type: "boolean" } },
    ], responses: [{ status: { kind: "exact", code: 202 }, content: [{ media_type: "application/vnd.order+json" }] }] });
  expect(first.claims.map(claim => claim.predicate)).toEqual(expect.arrayContaining(["route.declaration", "response.status", "response.media_type"]));
  expect(first.status).toBe("partial");
  expect(first.diagnostics.map(d => d.code)).not.toContain("controller_registration_unverified");
  expect(first.reproducibility_fingerprint).toBe(second.reproducibility_fingerprint);
  expect(first.endpoints).toEqual(second.endpoints);
});

test("unrelated same-named decorators emit no routes", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { Controller, Get } from "unrelated";
    @Controller("/private") class Example { @Get("/hidden") index() { return 1; } }
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toContain("no_supported_controller");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("a local declaration that conflicts with an imported decorator cannot establish provenance", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { Controller, Get } from "routing-controllers";
    const Get = (_path: string) => (_target: unknown, _name: string) => {};
    @Controller("/api") class Example { @Get("/hidden") index() { return 1; } }
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("only directly registered classes emit routes, including relative imports and routePrefix", async () => {
  const { adapter } = await service({
    "z-app.ts": `import { createExpressServer as boot } from "routing-controllers";
      import { Active as Renamed } from "./a-controller";
      boot({ routePrefix: "/v1", controllers: [Renamed] });`,
    "a-controller.ts": `import { JsonController, Get, HttpCode } from "routing-controllers";
      @JsonController("/items") export class Active { @Get(":id") @HttpCode(200) read(): string { return "ok"; } }
      @JsonController("/dead") export class Dead { @Get("/") @HttpCode(200) read(): string { return "dead"; } }`,
  });
  const result = await adapter.analyze(request());
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/v1/items/:id"]);
  expect(result.diagnostics.map(d => d.code)).not.toContain("controller_registration_unverified");
  expect(result.diagnostics.map(d => d.code)).not.toContain("no_supported_controller");
  expect(result.diagnostics.map(d => d.code)).toContain("startup_entrypoint_unverified");
  const startup = result.diagnostics.find(d => d.code === "startup_entrypoint_unverified")!;
  expect(result.evidence.find(item => item.evidence_id === startup.evidence_ids[0])?.location.path).toBe("z-app.ts");
  expect(result.status).toBe("partial");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("dynamic registration cannot expose a controller, while a literal sibling remains", async () => {
  const { adapter } = await service({ "app.ts": `
    import { useExpressServer, Controller, Get, HttpCode } from "routing-controllers";
    @Controller("/known") class Known { @Get() @HttpCode(200) read(): string { return "ok"; } }
    @Controller("/unknown") class Unknown { @Get() read(): string { return "no"; } }
    const selected = Unknown;
    useExpressServer({}, { controllers: [Known, selected] });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/known"]);
  expect(result.diagnostics.map(d => d.code)).toContain("controller_reference_unresolved");
  expect(result.coverage.status).toBe("incomplete");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("conditional setup, option spreads, and glob selections remain incomplete", async () => {
  const { adapter } = await service({ "app.ts": `
    import { createExpressServer, Controller, Get, HttpCode } from "routing-controllers";
    @Controller("/items") class Items { @Get() @HttpCode(200) read(): string { return "ok"; } }
    if (process.env.ENABLE) createExpressServer({ controllers: [Items] });
    createExpressServer({ controllers: [Items], ...{ routePrefix: "/overridden" } });
    createExpressServer({ controllers: ["controllers/*.js"] });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining([
    "conditional_registration_unresolved", "registration_options_unresolved", "controller_reference_unresolved",
  ]));
  expect(result.status).toBe("partial");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("other runtime options remain visible beside an established route", async () => {
  const { adapter } = await service({ "app.ts": `
    import { createKoaServer, Controller, Get, HttpCode } from "routing-controllers";
    @Controller("/items") class Items { @Get() @HttpCode(200) read(): string { return "ok"; } }
    createKoaServer({ controllers: [Items], defaults: { nullResultCode: 404 } });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/items"]);
  expect(result.diagnostics.map(d => d.code)).toContain("registration_option_unsupported");
  expect(result.status).toBe("partial");
});

test("unsupported local constructs are diagnosed without dropping a literal sibling", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { Controller, Get, QueryParams, Res, createExpressServer } from "routing-controllers";
    const computed = "/dynamic";
    @Controller() class Example {
      @Get("/") root() { return "ok"; }
      @Get(computed) dynamic() { return "hidden"; }
      @Get("/passthrough") passthrough(@QueryParams() query: unknown, @Res() response: unknown): string { return "manual"; }
    }
    createExpressServer({ controllers: [Example] });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints.map(e => e.application_path)).toEqual(["/", "/passthrough"]);
  expect(result.endpoints.find(e => e.application_path === "/passthrough")?.responses).toEqual([
    { status: { kind: "unknown", reason: "No supported status declaration" }, content: [] },
  ]);
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining([
    "dynamic_route_path_unresolved", "parameter_binding_unsupported", "response_or_request_passthrough_unresolved",
  ]));
  expect(result.coverage.status).toBe("incomplete");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("source digest includes adjacent config and source collection rejects symlinks", async () => {
  const { root, adapter } = await service({ "controller.ts": `import { Controller, Get } from "routing-controllers";
    @Controller() class Example { @Get() index(): string { return "ok"; } }`, "routing.json": "{}" });
  const first = await adapter.analyze(request());
  await writeFile(join(root, "service", "routing.json"), '{"prefix":"/api"}');
  const second = await adapter.analyze(request());
  expect(first.source.source_digest).not.toBe(second.source.source_digest);
  expect(first.reproducibility_fingerprint).not.toBe(second.reproducibility_fingerprint);
  const req = request(); req.source.source_digest = `sha256:${"0".repeat(64)}`;
  await expect(adapter.analyze(req)).rejects.toThrow("Source digest mismatch");
  await symlink(join(root, "service", "controller.ts"), join(root, "service", "linked.ts"));
  await expect(adapter.analyze(request())).rejects.toThrow("Source boundary or input limit rejected");
});
