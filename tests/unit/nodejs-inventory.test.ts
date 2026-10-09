import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { inventoryNodeService } from "../../analyzers/nodejs/src/inventory.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

async function service(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-node-inventory-")); roots.push(root);
  const dir = join(root, "service"); await mkdir(dir, {recursive: true});
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path); await mkdir(join(target, ".."), {recursive: true}); await writeFile(target, content);
  }
  return root;
}

test("counts only exact framework registrations reachable from configured production entrypoints", async () => {
  const root = await service({
    "main.ts": `import express from "express"; import { boot } from "./server"; const app = express(); boot(app);`,
    "server.ts": `import express from "express"; const app = express(); app.get("/live", () => {}); export { app };`,
    "dead.ts": `import { Controller } from "routing-controllers"; @Controller() class Dead {}`,
    "test/spec.test.ts": `import { Controller } from "routing-controllers"; @Controller() class Fixture {}`,
    "package.json": JSON.stringify({dependencies: {express: "*", "routing-controllers": "*"}}),
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.classification).toBe("supported");
  expect(result.signals.map(signal => signal.family)).toEqual(["express"]);
  expect(result.signals[0]?.evidence.some(item => item.path === "server.ts")).toBe(true);
  expect(result.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect((await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]})).fingerprint)
    .toBe(result.fingerprint);
  await writeFile(join(root, "service/dead.ts"), `export const unrelated = 2;`);
  expect((await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]})).fingerprint)
    .not.toBe(result.fingerprint);
});

test("reports mixed production framework patterns without choosing a profile or emitting routes", async () => {
  const root = await service({
    "main.ts": `import express from "express"; import { JsonController, useExpressServer } from "routing-controllers"; const app = express(); app.get("/x", handler); @JsonController("/y") class Y {} useExpressServer(app, {controllers: [Y]});`,
    "api/openapi.yaml": "openapi: 3.0.3\ninfo: {title: Example, version: '1'}\npaths: {}\n",
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
    authoritativeDocumentPaths: ["api/openapi.yaml"]});
  expect(result.classification).toBe("mixed");
  expect("selectedProfile" in result).toBe(false);
  expect(result.signals.map(signal => signal.family)).toEqual(["express", "routing-controllers", "openapi3"]);
  expect(result).not.toHaveProperty("routes");
});

test("marks a selected OpenAPI 3 document unsupported and an invalid selected document unresolved", async () => {
  const root = await service({"main.ts": `export {};`, "api/oas.json": JSON.stringify({openapi: "3.0.3", info: {title: "API", version: "1"}, paths: {}})});
  const supported = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
    authoritativeDocumentPaths: ["api/oas.json"]});
  expect(supported.signals.find(signal => signal.family === "openapi3")?.classification).toBe("supported");
  await writeFile(join(root, "service/api/oas.json"), JSON.stringify({openapi: "3.1.0", info: {title: "API", version: "1"}, paths: {}}));
  const outsideScope = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
    authoritativeDocumentPaths: ["api/oas.json"]});
  expect(outsideScope.signals.find(signal => signal.family === "openapi3")?.classification).toBe("unsupported");
  await writeFile(join(root, "service/api/oas.json"), "{");
  const unresolved = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
    authoritativeDocumentPaths: ["api/oas.json"]});
  expect(unresolved.classification).toBe("unresolved");
  expect(unresolved.signals.some(signal => signal.classification === "unresolved")).toBe(true);
});

test("allows an owner-selected authoritative document to be inventoried without a source entrypoint", async () => {
  const root = await service({"api/swagger.json": JSON.stringify({swagger: "2.0", info: {title: "API", version: "1"}, paths: {}})});
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: [],
    authoritativeDocumentPaths: ["api/swagger.json"]});
  expect(result.classification).toBe("supported");
  expect(result.signals.map(signal => signal.family)).toEqual(["swagger2"]);
});

test("does not treat imported decorators with unrelated names or dependency declarations as framework evidence", async () => {
  const root = await service({
    "main.ts": `import { Controller } from "./decorators"; @Controller() class Local {}`,
    "decorators.ts": `export const Controller = () => (target: unknown) => target;`,
    "package.json": JSON.stringify({dependencies: {"routing-controllers": "0.0.0", "swagger-express-mw": "0.0.0"}}),
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.classification).toBe("unresolved");
  expect(result.signals).toEqual([]);
});

test("does not count an imported but unregistered routing-controllers class", async () => {
  const root = await service({
    "main.ts": `import "./controllers"; export {};`,
    "controllers.ts": `import { JsonController, Get } from "routing-controllers"; @JsonController("/unused") class Unused { @Get() list() {} } export { Unused };`,
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.signals).toEqual([]);
  expect(result.classification).toBe("unresolved");
});

test("does not connect type-only imports to production framework signals", async () => {
  const root = await service({
    "main.ts": `import type { Dead } from "./controllers"; export type Active = Dead;`,
    "controllers.ts": `import { JsonController } from "routing-controllers"; @JsonController() export class Dead {}`,
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.signals).toEqual([]);
  expect(result.scanned_source_files).toBe(1);
});

test("counts a routing-controllers class only when the production entrypoint registers that imported class", async () => {
  const root = await service({
    "main.ts": `import { useExpressServer } from "routing-controllers"; import { Items } from "./items"; useExpressServer(app, {controllers: [Items]});`,
    "items.ts": `import { JsonController, Get } from "routing-controllers"; @JsonController("/items") export class Items { @Get() list() {} }`,
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.classification).toBe("supported");
  expect(result.signals.map(signal => signal.family)).toEqual(["routing-controllers"]);
  expect(result.signals[0]?.evidence.map(item => item.path).sort()).toEqual(["items.ts", "main.ts"]);
});

test("does not bind a registered identifier to an unrelated same-named decorated class", async () => {
  const root = await service({
    "main.ts": `import { Items } from "./plain"; import "./decorated"; import { useExpressServer } from "routing-controllers"; useExpressServer(app, {controllers: [Items]});`,
    "plain.ts": `export class Items {}`,
    "decorated.ts": `import { JsonController } from "routing-controllers"; @JsonController() export class Items {}`,
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.signals.map(signal => signal.family)).not.toContain("routing-controllers");
  expect(result.classification).toBe("unresolved");
  expect(result.diagnostics).toContain("routing_controllers_selection_unresolved");
});

test("keeps dynamic and unresolved identifiers in controller arrays incomplete", async () => {
  const root = await service({
    "main.ts": `import { Active as Items } from "./items"; import { useExpressServer } from "routing-controllers"; const dynamicControllers = []; useExpressServer(app, {controllers: [Items, ...dynamicControllers]});`,
    "items.ts": `import { JsonController } from "routing-controllers"; export { Items as Active } from "./inner";`,
    "inner.ts": `import { JsonController } from "routing-controllers"; @JsonController() export class Items {}`,
  });
  const mixedSelection = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(mixedSelection.signals.map(signal => signal.family)).toContain("routing-controllers");
  expect(mixedSelection.classification).toBe("unresolved");
  expect(mixedSelection.diagnostics).toContain("routing_controllers_selection_unresolved");

  await writeFile(join(root, "service/main.ts"), `import { useExpressServer } from "routing-controllers"; import { Items } from "./items"; useExpressServer(app, {controllers: [Unknown]});`);
  const unknown = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(unknown.signals.map(signal => signal.family)).not.toContain("routing-controllers");
  expect(unknown.classification).toBe("unresolved");
});

test("ignores dead function Express and swagger-express-mw registrations and shadowed imports", async () => {
  const root = await service({
    "main.ts": `import express from "express"; import swagger from "swagger-express-mw"; function dormant(express: any) { const app = express(); app.get("/dead", handler); swagger.create({appRoot: __dirname}, (err, m) => { if (err) throw err; m.register(app); }); }`,
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.signals.map(signal => signal.family)).not.toContain("express");
  expect(result.signals.map(signal => signal.family)).not.toContain("swagger-express-mw");
  expect(result.classification).toBe("unresolved");
});

test("uses imported symbol provenance and does not resolve requires inside dead functions or branches", async () => {
  const root = await service({
    "main.ts": `import { fake as express } from "express"; import { Get as JsonController, useExpressServer } from "routing-controllers"; @JsonController("/fake") class Fake {} function dormant() { require("./controllers"); } if (false) require("./fixtures"); const app = express(); app.get("/fake", handler); useExpressServer(app, {controllers: [Fake]});`,
    "controllers.ts": `import { JsonController } from "routing-controllers"; @JsonController("/dead") export class Dead {}`,
    "fixtures.ts": `import { JsonController } from "routing-controllers"; @JsonController("/fixture") export class Fixture {}`,
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.signals.some(signal => signal.family === "express")).toBe(false);
  expect(result.signals.some(signal => signal.family === "routing-controllers")).toBe(false);
  expect(result.classification).toBe("unresolved");
  expect(result.scanned_source_files).toBe(1);
});

test("rejects test and fixture files as configured production entrypoints", async () => {
  const root = await service({"tests/app.test.ts": `import express from "express"; const app = express(); app.get("/x", handler);`});
  for (const path of ["tests/app.test.ts", "fixtures/example.ts"]) {
    await expect(inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: [path]}))
      .rejects.toThrow("Inventory selection rejected");
  }
});

test("keeps valid source registration unresolved when an authoritative document is missing or invalid", async () => {
  const root = await service({
    "main.ts": `import express from "express"; const app = express(); app.get("/x", handler);`,
    "api/broken.json": "{",
  });
  for (const path of ["api/broken.json", "api/missing.yaml"]) {
    const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
      authoritativeDocumentPaths: [path]});
    expect(result.signals.some(signal => signal.family === "express" && signal.classification === "supported")).toBe(true);
    expect(result.classification).toBe("unresolved");
    expect(result.diagnostics.some(code => code.startsWith("selected_api_document_") )).toBe(true);
  }
});

test("marks unresolved local and dynamic imports explicitly", async () => {
  const root = await service({
    "main.ts": `import "./missing"; const name = "./late"; void import(name);`,
  });
  const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]});
  expect(result.classification).toBe("unresolved");
  expect(result.diagnostics).toContain("production_import_unresolved");
  expect(result.diagnostics).toContain("dynamic_import_unresolved");
});

test("reports file, graph, traversal and symlink boundary failures safely", async () => {
  const root = await service({"main.ts": `import "./next"; export {};`, "next.ts": `export {};`});
  await expect(inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
    limits: {maxFiles: 1}})).rejects.toThrow("Source boundary or input limit rejected");
  await expect(inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
    limits: {maxImportEdges: 0}})).rejects.toThrow("Inventory selection rejected");
  const limited = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"],
    limits: {maxGraphFiles: 1}});
  expect(limited.classification).toBe("unresolved");
  expect(limited.diagnostics).toContain("production_import_graph_limit_exceeded");
  await expect(inventoryNodeService({projectRoot: root, serviceRoot: "../outside", entrypoints: ["main.ts"]}))
    .rejects.toThrow("Inventory selection rejected");
  await symlink(join(root, "service/main.ts"), join(root, "service/linked.ts"));
  await expect(inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"]}))
    .rejects.toThrow("Source boundary or input limit rejected");
});

test("stops graph traversal after the import-edge budget and rejects malformed dialect lookalikes", async () => {
  const root = await service({
    "main.ts": `import "./a"; import "./b"; export {};`, "a.ts": `import "./c";`, "b.ts": `export {};`, "c.ts": `export {};`,
    "api/malformed.json": JSON.stringify({swagger: "2.0"}),
    "api/fake.json": JSON.stringify({openapi: "3.evil", info: {title: "x", version: "1"}, paths: {}}),
  });
  const limited = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: ["main.ts"], limits: {maxImportEdges: 1}});
  expect(limited.diagnostics).toContain("production_import_edge_limit_exceeded");
  expect(limited.scanned_source_files).toBe(1);
  for (const path of ["api/malformed.json", "api/fake.json"]) {
    const result = await inventoryNodeService({projectRoot: root, serviceRoot: "service", entrypoints: [], authoritativeDocumentPaths: [path]});
    expect(result.classification).toBe("unresolved");
    expect(result.signals[0]?.classification).toBe("unresolved");
  }
});
