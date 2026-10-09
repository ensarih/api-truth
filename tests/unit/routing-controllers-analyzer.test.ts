import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/routing-controllers/src/index.js";
import { parseAnalyzerResult, type AnalyzerRequest } from "../../packages/ir/src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function service(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-routing-controllers-")); roots.push(root);
  await mkdir(join(root, "service"));
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, "service", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
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
function profileRequest(): AnalyzerRequest {
  const input = request();
  input.resolution_inputs.push({ kind: "type_manifest", path: "service/api-truth.routing.json", digest: "host-supplied-digest" });
  return input;
}

test("opt-in declaration profile extracts wrapper decorators without asserting runtime mounting", async () => {
  const files = {
    "controller.ts": `import { JsonController as Route, Get, Param } from "@example/route-kit";
      @Route("/orders") export class Orders {
        @Get("/:id") read(@Param("id") id: string): string { return id; }
      }`,
    "api-truth.routing.json": JSON.stringify({ profile_version: "1.0.0", decorator_modules: ["@example/route-kit"],
      binding: "declarations_only", route_prefix: "/api" }),
  };
  const { root, adapter } = await service(files);
  const withoutProfile = await adapter.analyze(request());
  expect(withoutProfile.endpoints).toEqual([]);
  const result = await adapter.analyze(profileRequest());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints).toMatchObject([{ application_path: "/api/orders/:id", identity: { method: "GET" } }]);
  expect(result.status).toBe("partial");
  expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
    "controller_registration_unverified", "startup_entrypoint_unverified", "framework_semantics_owner_asserted",
  ]));
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "route.declaration", verification: "owner_asserted" }));
  expect(result.evidence).toContainEqual(expect.objectContaining({ method: "owner_assertion",
    location: expect.objectContaining({ path: "api-truth.routing.json" }) }));
  await writeFile(join(root, "service", "api-truth.routing.json"), JSON.stringify({
    profile_version: "1.0.0", decorator_modules: ["@example/route-kit"],
    binding: "declarations_only", route_prefix: "/v2",
  }));
  const changed = await adapter.analyze(profileRequest());
  expect(changed.endpoints[0]?.application_path).toBe("/v2/orders/:id");
  expect(changed.reproducibility_fingerprint).not.toBe(result.reproducibility_fingerprint);
});

test("declaration profile rejects unsupported fields and digest mismatches", async () => {
  const { root, adapter } = await service({ "controller.ts": `import { Controller, Get } from "routing-controllers";
    @Controller() class Orders { @Get() read(): string { return "ok"; } }`,
  "api-truth.routing.json": JSON.stringify({ profile_version: "1.0.0", decorator_modules: [],
    binding: "declarations_only", route_prefix: "", extra: true }) });
  await expect(adapter.analyze(profileRequest())).rejects.toThrow("Invalid routing profile");
  await writeFile(join(root, "service", "api-truth.routing.json"),
    '{"profile_version":"1.0.0","decorator_modules":[],"binding":"declarations_only","route_prefix":"","route_prefix":"/v2"}');
  await expect(adapter.analyze(profileRequest())).rejects.toThrow("Invalid routing profile");
  await writeFile(join(root, "service", "api-truth.routing.json"), JSON.stringify({
    profile_version: "1.0.0", decorator_modules: [], binding: "declarations_only", route_prefix: "",
  }));
  const input = profileRequest();
  input.resolution_inputs[1]!.digest = `sha256:${"0".repeat(64)}`;
  await expect(adapter.analyze(input)).rejects.toThrow("Source digest mismatch");
});

test("a contained controller glob selects only matching source files through imported static config", async () => {
  const { adapter } = await service({
    "loader.ts": `import { createExpressServer } from "routing-controllers";
      import { env } from "./env";
      createExpressServer({ routePrefix: "/api", controllers: env.app.dirs.controllers });`,
    "env.ts": `import path from "node:path";
      export const env = { app: { dirs: { controllers: [path.join(__dirname, "api/controllers/**/*Controller{.js,.ts}")] } } };`,
    "api/controllers/PetController.ts": `import { JsonController, Get, Param } from "routing-controllers";
      @JsonController("/pets") export class PetController {
        @Get("/:id") one(@Param("id") id: string): string { return id; }
      }`,
    "other/DeadController.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/dead") export class DeadController { @Get() list(): string { return "dead"; } }`,
  });
  const result = await adapter.analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/api/pets/:id"]);
  expect(result.diagnostics.map(item => item.code)).toContain("controller_glob_source_projection_unverified");
  expect(result.diagnostics.map(item => item.code)).not.toContain("controller_list_unresolved");
});

test("a dynamic route prefix needs an explicit profile before glob-selected routes get an identity", async () => {
  const { adapter } = await service({
    "loader.ts": `import { createExpressServer } from "routing-controllers";
      import { env } from "./env";
      createExpressServer({ routePrefix: env.app.routePrefix, controllers: env.app.dirs.controllers });`,
    "env.ts": `import path from "node:path";
      export const env = { app: { routePrefix: process.env.API_ROUTE_PREFIX,
        dirs: { controllers: [path.join(__dirname, "api/controllers/**/*Controller{.js,.ts}")] } } };`,
    "api/controllers/PetController.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/pets") export class PetController { @Get() list(): string { return "ok"; } }`,
    "other/DeadController.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/dead") export class DeadController { @Get() list(): string { return "dead"; } }`,
    "api-truth.routing.json": JSON.stringify({ profile_version: "1.0.0", decorator_modules: [],
      binding: "declarations_only", route_prefix: "/v1" }),
  });
  const unconfigured = await adapter.analyze(request());
  expect(unconfigured.endpoints).toEqual([]);
  expect(unconfigured.diagnostics.map(item => item.code)).toContain("route_prefix_unresolved");
  const result = await adapter.analyze(profileRequest());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/v1/pets"]);
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "route.declaration", verification: "owner_asserted" }));
  expect(result.diagnostics.map(item => item.code)).toContain("configured_route_prefix_unverified");
});

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

test("selected production entrypoint follows bounded runtime imports and only its registrations", async () => {
  const { root, adapter } = await service({
    "app.ts": `import "./bootstrap";`,
    "bootstrap.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live";
      createExpressServer({ controllers: [Live] });`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") export class Live { @Get() list(): string { return "ok"; } }`,
    "dead.ts": `import { createExpressServer } from "routing-controllers";
      import { Dead } from "./dead-controller";
      createExpressServer({ controllers: [Dead] });`,
    "dead-controller.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/dead") export class Dead { @Get() list(): string { return "no"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" })
    .analyze(request());
  expect(parseAnalyzerResult(result).ok).toBe(true);
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/live"]);
  expect(result.diagnostics.map(item => item.code)).not.toContain("startup_entrypoint_unverified");
  expect(result.diagnostics.map(item => item.code)).toContain("production_entrypoint_deployment_unverified");
  expect(result.coverage.status).toBe("incomplete");
  expect(result.reproducibility_fingerprint).not.toBe((await adapter.analyze(request())).reproducibility_fingerprint);
});

test("selected production entrypoint treats dynamic imports and nested startup as unresolved", async () => {
  const { root } = await service({
    "app.ts": `async function start() { await import("./bootstrap"); } start();`,
    "bootstrap.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; createExpressServer({ controllers: [Live] });`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") export class Live { @Get() list(): string { return "ok"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
    "dynamic_import_unresolved",
  ]));
  expect(result.coverage.status).toBe("incomplete");
});

test("selected production entrypoint does not accept a registration nested in a function", async () => {
  const { root } = await service({
    "app.ts": `import "./bootstrap";`,
    "bootstrap.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; function start() { createExpressServer({ controllers: [Live] }); } start();`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") class Live { @Get() list(): string { return "ok"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("conditional_registration_unresolved");
  expect(result.coverage.status).toBe("incomplete");
});

test("selected production entrypoint path must exist inside the selected source tree", async () => {
  const { root } = await service({ "app.ts": `export {};` });
  await expect(createAnalyzer({ projectRoot: root, productionEntrypoint: "service/missing.ts" }).analyze(request()))
    .rejects.toThrow("Production entrypoint rejected");
  await expect(createAnalyzer({ projectRoot: root, productionEntrypoint: "../outside.ts" }).analyze(request()))
    .rejects.toThrow("Production entrypoint rejected");
  await expect(createAnalyzer({ projectRoot: root, productionEntrypoint: join(root, "service/app.ts") }).analyze(request()))
    .rejects.toThrow("Production entrypoint rejected");
  await expect(createAnalyzer({ projectRoot: root, productionEntrypoint: "service/./app.ts" }).analyze(request()))
    .rejects.toThrow("Production entrypoint rejected");
});

test("selected production graph follows top-level CommonJS requires but ignores type-only imports", async () => {
  const { root } = await service({
    "app.ts": `require("./bootstrap"); import type { TypesOnly } from "./types";`,
    "bootstrap.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; createExpressServer({ controllers: [Live] });`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") export class Live { @Get() list(): string { return "ok"; } }`,
    "types.ts": `export interface TypesOnly {}`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/live"]);
  expect(result.diagnostics.map(item => item.code)).not.toContain("production_import_unresolved");
});

test("selected production graph reports nested requires and rejects symlinked source trees", async () => {
  const { root } = await service({ "app.ts": `function unused() { require("./bootstrap"); }` });
  const unresolved = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(unresolved.diagnostics.map(item => item.code)).toContain("conditional_import_unresolved");
  await symlink(join(root, "service", "app.ts"), join(root, "service", "link.ts"));
  await expect(createAnalyzer({ projectRoot: root, productionEntrypoint: "service/link.ts" }).analyze(request()))
    .rejects.toThrow("Source boundary or input limit rejected");
});

test("selected production graph does not follow a shadowed require binding", async () => {
  const { root } = await service({
    "app.cjs": `const require = (name) => { throw new Error(name); }; require("./bootstrap");`,
    "bootstrap.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; createExpressServer({ controllers: [Live] });`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") class Live { @Get() list(): string { return "ok"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.cjs" }).analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("production_import_unresolved");
});

test.each([
  `const { require } = fake; require("./bootstrap");`,
  `const { x: { require } } = fake; require("./bootstrap");`,
  `function start({ x: [require] }) { require("./bootstrap"); }`,
  `({ require } = fake); require("./bootstrap");`,
  `([require] = [fake]); require("./bootstrap");`,
])("selected production graph rejects destructured require shadowing: %s", async source => {
  const { root } = await service({
    "app.ts": source,
    "bootstrap.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; createExpressServer({ controllers: [Live] });`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") export class Live { @Get() list(): string { return "ok"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("production_import_unresolved");
});

test.each([
  `try { require("./bootstrap"); } catch {}`,
  `try {} catch { require("./bootstrap"); }`,
])("selected production graph leaves try/catch require unresolved: %s", async source => {
  const { root } = await service({
    "app.ts": source,
    "bootstrap.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; createExpressServer({ controllers: [Live] });`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") export class Live { @Get() list(): string { return "ok"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("conditional_import_unresolved");
});

test("selected production graph diagnoses unknown bare runtime imports but recognizes adapter frameworks", async () => {
  const { root } = await service({
    "app.ts": `import "@vendor/bootstrap"; import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; createExpressServer({ controllers: [Live] });`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") export class Live { @Get() list(): string { return "ok"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.endpoints.map(endpoint => endpoint.application_path)).toEqual(["/live"]);
  expect(result.diagnostics.map(item => item.code)).toContain("external_runtime_import_unresolved");
});

test("selected production graph stops at its global import-edge budget", async () => {
  const imports = Array.from({ length: 4100 }, () => `import "./dep";`).join("\n");
  const { root } = await service({ "app.ts": imports, "dep.ts": `export {};` });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.diagnostics.filter(item => item.code === "production_import_limit_exceeded")).toHaveLength(1);
  expect(result.diagnostics.map(item => item.code)).not.toContain("production_import_unresolved");
});

test("selected production entrypoint accepts only direct source-level registration statements", async () => {
  const { root } = await service({
    "app.ts": `import { createExpressServer } from "routing-controllers";
      import { Live } from "./live"; { createExpressServer({ controllers: [Live] }); }`,
    "live.ts": `import { JsonController, Get } from "routing-controllers";
      @JsonController("/live") class Live { @Get() list(): string { return "ok"; } }`,
  });
  const result = await createAnalyzer({ projectRoot: root, productionEntrypoint: "service/app.ts" }).analyze(request());
  expect(result.endpoints).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("conditional_registration_unresolved");
});

test("literal Body required options establish request body presence", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { JsonController, Post, Body, createExpressServer } from "routing-controllers";
    const dynamic = { required: true };
    @JsonController("/orders") class Orders {
      @Post("/required") required(@Body({ required: true }) input: { title: string }): string { return input.title; }
      @Post("/optional") optional(@Body({ required: false }) input: { title: string }): string { return input.title; }
      @Post("/unknown") unknown(@Body(dynamic) input: { title: string }): string { return input.title; }
    }
    createExpressServer({ controllers: [Orders] });
  ` });
  const result = await adapter.analyze(request());
  const body = (path: string) => result.endpoints.find(endpoint => endpoint.application_path === path)?.request_bodies[0];
  expect(body("/orders/required")?.presence.state).toBe("required");
  expect(body("/orders/optional")?.presence.state).toBe("optional");
  expect(body("/orders/unknown")?.presence.state).toBe("unknown");
  expect(result.diagnostics.map(item => item.code)).toContain("body_options_unresolved");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("whole-object QueryParams expands literal fields without inferring runtime requiredness", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { JsonController, Get, QueryParams, QueryParam, createExpressServer } from "routing-controllers";
    @JsonController("/orders") class Orders {
      @Get() list(@QueryParams() search: { q: string; limit?: number },
        @QueryParam("sort") sort?: string): string { return search.q; }
    }
    createExpressServer({ controllers: [Orders] });
  ` });
  const result = await adapter.analyze(request());
  const endpoint = result.endpoints[0];
  expect(endpoint?.parameters).toMatchObject([
    { in: "query", name: "limit", presence: { state: "unknown" }, schema: { type: "number" } },
    { in: "query", name: "q", presence: { state: "unknown" }, schema: { type: "string" } },
    { in: "query", name: "sort", presence: { state: "unknown" }, schema: { type: "string" } },
  ]);
  expect(result.diagnostics.map(item => item.code)).not.toContain("parameter_binding_unsupported");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("named and whole-object query bindings with the same key stay unresolved", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { JsonController, Get, QueryParams, QueryParam, createExpressServer } from "routing-controllers";
    @JsonController() class Orders {
      @Get("/items") list(@QueryParam("q", { required: true }) q: string,
        @QueryParams() all: { q: number }): string { return q; }
    }
    createExpressServer({ controllers: [Orders] });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints[0]?.parameters).toMatchObject([
    { in: "query", name: "q", presence: { state: "unknown" }, schema: {} },
  ]);
  expect(result.diagnostics.map(item => item.code)).toContain("whole_query_parameter_collision");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("whole-object HeaderParams expands inline fields without inferring requiredness", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { JsonController, Get, HeaderParams, HeaderParam, createExpressServer } from "routing-controllers";
    @JsonController("/orders") class Orders {
      @Get() list(@HeaderParams() headers: { "x-trace-id": string; "x-client-version"?: number },
        @HeaderParam("x-region") region?: string): string { return headers["x-trace-id"]; }
    }
    createExpressServer({ controllers: [Orders] });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints[0]?.parameters).toMatchObject([
    { in: "header", name: "x-client-version", presence: { state: "unknown" }, schema: { type: "number" }, serialization: { style: "simple" } },
    { in: "header", name: "x-region", presence: { state: "unknown" }, schema: { type: "string" } },
    { in: "header", name: "x-trace-id", presence: { state: "unknown" }, schema: { type: "string" }, serialization: { style: "simple" } },
  ]);
  expect(result.claims).toContainEqual(expect.objectContaining({ predicate: "parameter.declaration",
    value: { name: "x-trace-id", in: "header", binding: "whole_header_object" } }));
  expect(result.diagnostics.map(item => item.code)).not.toContain("parameter_binding_unsupported");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("named and whole-object header bindings collide case-insensitively", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { JsonController, Get, HeaderParams, HeaderParam, createExpressServer } from "routing-controllers";
    @JsonController() class Orders {
      @Get("/items") list(@HeaderParam("X-Trace-ID", { required: true }) id: string,
        @HeaderParams() headers: { "x-trace-id": number }): string { return id; }
    }
    createExpressServer({ controllers: [Orders] });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints[0]?.parameters).toMatchObject([
    { in: "header", name: "X-Trace-ID", presence: { state: "unknown" }, schema: {} },
  ]);
  expect(result.diagnostics.map(item => item.code)).toContain("whole_header_parameter_collision");
  expect(parseAnalyzerResult(result).ok).toBe(true);
});

test("unsupported whole-header DTOs do not invent fields", async () => {
  const { adapter } = await service({ "controller.ts": `
    import { JsonController, Get, HeaderParams, createExpressServer } from "routing-controllers";
    interface Headers { "x-trace-id": string }
    @JsonController() class Orders {
      @Get("/items") list(@HeaderParams() headers: Headers): string { return headers["x-trace-id"]; }
    }
    createExpressServer({ controllers: [Orders] });
  ` });
  const result = await adapter.analyze(request());
  expect(result.endpoints[0]?.parameters).toEqual([]);
  expect(result.diagnostics.map(item => item.code)).toContain("whole_header_type_unresolved");
  expect(result.coverage.status).toBe("incomplete");
  expect(parseAnalyzerResult(result).ok).toBe(true);
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
    "conditional_registration_unresolved", "registration_options_unresolved", "controller_glob_unsupported",
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
    "dynamic_route_path_unresolved", "whole_query_type_unresolved", "response_or_request_passthrough_unresolved",
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


test("unsupported profile IR version fails before filesystem access", async () => {
  const adapter = createAnalyzer({ projectRoot: "/missing/profile-version-check" });
  await expect(adapter.analyze({ ...request(), ir_version: "1.1.0" }))
    .rejects.toThrow("Analyzer profile requires IR 1.0.0");
});
