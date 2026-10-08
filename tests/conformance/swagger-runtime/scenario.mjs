import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2];
const supported = new Set(["default", "operation-override", "configured-directory", "directory-precedence", "initialization-fallback",
  "missing-controller", "missing-export", "mock-mode", "environment-override", "source-environment-override"]);
if (!supported.has(scenario)) throw new Error("Unknown synthetic scenario");
const root = await mkdtemp(join(tmpdir(), "api-truth-swagger-conformance-"));
let server;
try {
  const put = async (path, value) => {
    const target = join(root, path); await mkdir(dirname(target), {recursive: true});
    await writeFile(target, value);
  };
  const handler = marker => `exports.getOrder = function(req, res) {
    res.json({controller: ${JSON.stringify(marker)}, id: req.swagger.params.id.value});
  };`;
  const doc = {swagger: "2.0", info: {title: "Synthetic routing conformance", version: "1"}, basePath: "/api/v1",
    produces: ["application/json"], paths: {"/orders/{id}": {
      "x-swagger-router-controller": "orders", get: {operationId: "getOrder",
        parameters: [{name: "id", in: "path", required: true, type: "string"}],
        responses: {"200": {description: "Synthetic marker"}}}}}};
  const operation = doc.paths["/orders/{id}"].get;
  if (scenario === "operation-override") operation["x-swagger-router-controller"] = "alternate";
  if (scenario === "missing-controller") operation["x-swagger-router-controller"] = "missing";
  if (scenario === "missing-export") operation.operationId = "missingExport";
  await put("api/swagger/swagger.yaml", JSON.stringify(doc));
  await put("api/controllers/orders.js", handler("orders"));
  await put("api/controllers/alternate.js", handler("alternate"));
  await put("api/mocks/orders.js", handler("mock"));
  await put("app.js", `${scenario === "source-environment-override" ? 'process.env.swagger_mockMode = "true";\n' : ""}const express = require("express");
    const SwaggerExpress = require("swagger-express-mw"); const app = express();
    SwaggerExpress.create({appRoot: __dirname}, function(error, middleware) {
      if (error) throw error; middleware.register(app);
    });`);
  await put("package.json", JSON.stringify({type: "commonjs", dependencies: {"swagger-express-mw": "0.7.0"}}));
  await put("package-lock.json", await readFile(new URL("./package-lock.json", import.meta.url), "utf8"));
  if (["configured-directory", "directory-precedence", "initialization-fallback", "mock-mode"].includes(scenario)) {
    const dirs = scenario === "configured-directory" ? ["custom/controllers"]
      : ["directory-precedence", "initialization-fallback"].includes(scenario) ? ["first/controllers", "second/controllers"] : ["api/controllers"];
    const config = {swagger: {swaggerControllerPipe: "controllers", fittingsDirs: ["api/fittings"], bagpipes: {
      router: {name: "swagger_router", controllersDirs: dirs, mockControllersDirs: ["api/mocks"],
        controllersInterface: "middleware", mockMode: scenario === "mock-mode"},
      controllers: ["swagger_params_parser", "express_compatibility", "router"]}}};
    await put("config/default.json", JSON.stringify(config));
    await put("custom/controllers/orders.js", handler("custom"));
    await put("first/controllers/orders.js", scenario === "initialization-fallback"
      ? 'throw new Error("synthetic initialization failure");' : handler("first"));
    await put("second/controllers/orders.js", handler("second"));
  } else await mkdir(join(root, "config"), {recursive: true});

  // Each scenario is a fresh process: config/module caches and environment cannot leak between fixtures.
  process.env.NODE_CONFIG_DIR = join(root, "config");
  if (["environment-override", "source-environment-override"].includes(scenario)) process.env.swagger_mockMode = "true";
  const require = createRequire(new URL("./package.json", import.meta.url));
  const wrapperRequire = createRequire(require.resolve("swagger-express-mw"));
  const runnerRequire = createRequire(wrapperRequire.resolve("swagger-node-runner"));
  const transitiveVersions = Object.fromEntries(["bagpipes", "config", "sway"].map(name => [name, runnerRequire(`${name}/package.json`).version]));
  const versions = {wrapper: require("swagger-express-mw/package.json").version,
    runner: wrapperRequire("swagger-node-runner/package.json").version, express: require("express/package.json").version};
  const express = require("express");
  const wrapper = require("swagger-express-mw");
  const app = express();
  const middleware = await new Promise((accept, reject) => wrapper.create({appRoot: root}, (error, value) => error ? reject(error) : accept(value)));
  middleware.register(app);
  app.use((error, req, res, next) => { res.status(500).json({error: "synthetic-routing-failure"}); });
  server = await new Promise(accept => { const listener = app.listen(0, "127.0.0.1", () => accept(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/v1/orders/42`, {signal: AbortSignal.timeout(5000)});
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = {nonJson: true}; }
  const withoutPrefix = await fetch(`${base}/orders/42`, {signal: AbortSignal.timeout(5000)});
  await withoutPrefix.arrayBuffer();
  const run = promisify(execFile);
  // Static analysis runs as a separate process and never imports this synthetic service's handlers.
  const analyzerNode = process.env.API_TRUTH_ANALYZER_NODE;
  if (!analyzerNode) throw new Error("Analyzer runtime missing");
  const {stdout: analyzerVersion} = await run(analyzerNode, ["--version"]);
  const {stdout} = await run(analyzerNode, [fileURLToPath(new URL("../../../scripts/extract-swagger2-middleware.mjs", import.meta.url)),
    "--source", root, "--service", "synthetic", "--revision", "a".repeat(40)], {
      timeout: 10000, maxBuffer: 1_000_000,
      env: {PATH: process.env.PATH, NODE_ENV: "test", SUPPRESS_NO_CONFIG_WARNING: "true"},
    });
  const analysis = JSON.parse(stdout);
  process.stdout.write(JSON.stringify({versions, transitiveVersions, runtimeNode: process.version, analyzerNode: analyzerVersion.trim(), status: response.status, body, withoutPrefixStatus: withoutPrefix.status,
    analysis: {status: analysis.status, candidatePath: analysis.claims.find(item => item.predicate === "handler.candidate")?.value.path,
      bindingClaim: analysis.claims.some(item => item.predicate === "handler.binding"), diagnostics: analysis.diagnostics.map(item => item.code)}}));
} finally {
  if (server) { server.closeAllConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); }
  await rm(root, {recursive: true, force: true});
}
