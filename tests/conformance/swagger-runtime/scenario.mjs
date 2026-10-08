import {generateKeyPairSync} from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2];
const supported = new Set(["default", "operation-override", "configured-directory", "directory-precedence", "initialization-fallback",
  "single-initialization-failure", "local-import", "local-import-failure", "missing-controller", "missing-export", "mock-mode", "environment-override", "source-environment-override", "create-mock-mode", "create-mock-override", "npm-environment-routing", "npm-environment-mock", "npm-environment-directories", "npm-router-mock", "npm-router-mock-disabled", "runtime-binding", "runtime-binding-missing", "runtime-binding-mock", "runtime-binding-stale", "runtime-binding-precedence", "runtime-binding-response-mismatch", "runtime-binding-response-match", "runtime-binding-response-default", "runtime-binding-body-match", "runtime-binding-body-mismatch", "runtime-binding-body-ref", "runtime-binding-body-required-missing", "runtime-binding-body-required-present", "runtime-binding-body-required-null", "runtime-binding-body-ref-type", "runtime-binding-body-ref-required", "runtime-binding-body-ref-cycle"]);
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
  if (["missing-export", "runtime-binding-missing"].includes(scenario)) operation.operationId = "missingExport";
  if (scenario === "runtime-binding-response-match") operation.responses = {"201": {description: "Created"}};
  if (scenario === "runtime-binding-response-default") operation.responses = {default: {description: "Any status"}};
  if (scenario.startsWith("runtime-binding-body-")) {
    operation.responses = {"201": {description:"Created", schema: (scenario.endsWith("ref") || scenario.startsWith("runtime-binding-body-ref-")) ? {$ref:"#/definitions/Body"}
      : {type:"object", properties:{controller:{type:scenario.endsWith("mismatch") ? "integer" : "string"}}}}};
    if (scenario.startsWith("runtime-binding-body-required-")) {
      operation.responses["201"].schema.required = ["controller", "name"];
      operation.responses["201"].schema.properties.name = {};
    }
    if (scenario.endsWith("ref") || scenario.startsWith("runtime-binding-body-ref-")) doc.definitions = {Body:{type:"object",
      ...(scenario.endsWith("required") ? {required:["name"]} : {}),
      properties:{controller:{type:scenario.endsWith("type") ? "integer" : "string"},
        ...(scenario.endsWith("required") ? {name:{type:"string"}} : {}),
        ...(scenario.endsWith("cycle") ? {child:{$ref:"#/definitions/Body"}} : {})}}};
  }
  await put("api/swagger/swagger.yaml", JSON.stringify(doc));
  await put("api/controllers/orders.js", handler("orders"));
  if (scenario.startsWith("runtime-binding-response-") || scenario.startsWith("runtime-binding-body-")) await put("api/controllers/orders.js",
    'exports.getOrder = function(req, res) { return res.status(201).json({controller:"orders"}); };');
  if (["runtime-binding-body-required-present", "runtime-binding-body-required-null"].includes(scenario))
    await put("api/controllers/orders.js", `exports.getOrder = function(req,res) { return res.status(201).json({controller:"orders",name:${scenario.endsWith("null") ? "null" : '"available"'}}); };`);
  if (scenario === "single-initialization-failure") await put("api/controllers/orders.js",
    'throw new Error("synthetic initialization failure");\n' + handler("orders"));
  if (["local-import", "local-import-failure"].includes(scenario)) {
    await put("api/controllers/orders.js", 'const helper = require("../helpers/reader.cjs"); exports.getOrder = function(req, res) { helper.read(req, res); };');
    await put("api/helpers/reader.cjs", (scenario === "local-import-failure" ? 'throw new Error("synthetic helper failure");\n' : "")
      + handler("local").replace("exports.getOrder", "exports.read"));
  }
  await put("api/controllers/alternate.js", handler("alternate"));
  await put("api/mocks/orders.js", handler("mock"));
  const createOptions = scenario === "create-mock-mode" ? {mockMode: true}
    : ["create-mock-override", "npm-router-mock"].includes(scenario) ? {mockMode: false} : {};
  const sourceOptions = Object.hasOwn(createOptions, "mockMode") ? `, mockMode: ${createOptions.mockMode}` : "";
  await put("app.js", `${scenario === "source-environment-override" ? 'process.env.swagger_mockMode = "true";\n' : ""}const express = require("express");
    const SwaggerExpress = require("swagger-express-mw"); const app = express();
    SwaggerExpress.create({appRoot: __dirname${sourceOptions}}, function(error, middleware) {
      if (error) throw error; middleware.register(app);
    });`);
  const npmEnvironment = ["npm-environment-routing", "npm-environment-mock", "npm-environment-directories", "npm-router-mock", "npm-router-mock-disabled"].includes(scenario);
  await put("package.json", JSON.stringify({type: "commonjs",
    ...(npmEnvironment ? {scripts: {start: "NODE_ENV=production node app.js"}, engines: {node: "22.19.0"}} : {}), dependencies: {"swagger-express-mw": "0.7.0"}}));
  await put("package-lock.json", await readFile(new URL("./package-lock.json", import.meta.url), "utf8"));
  if (["configured-directory", "directory-precedence", "initialization-fallback", "mock-mode", "runtime-binding-precedence"].includes(scenario)) {
    const dirs = scenario === "configured-directory" ? ["custom/controllers"]
      : ["directory-precedence", "initialization-fallback", "runtime-binding-precedence"].includes(scenario) ? ["first/controllers", "second/controllers"] : ["api/controllers"];
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

  if (scenario === "create-mock-override") await put("config/default.json", JSON.stringify({swagger: {mockMode: true}}));

  if (npmEnvironment) {
    await put("config/default.json", JSON.stringify({swagger: {mockMode: true}}));
    await put("config/production.json", JSON.stringify({swagger: {mockMode: scenario === "npm-environment-mock"}}));
    if (scenario === "npm-environment-directories") {
      await put("config/default.json", JSON.stringify({swagger: {swaggerControllerPipe: "controllers", bagpipes: {
        router: {name: "swagger_router", controllersDirs: ["first/controllers", "second/controllers"], mockControllersDirs: [], mockMode: false},
        controllers: ["swagger_params_parser", "express_compatibility", "router"]}}}));
      await put("config/production.json", JSON.stringify({swagger: {bagpipes: {router: {controllersDirs: ["production/controllers"]}}}}));
      await put("first/controllers/orders.js", handler("first"));
      await put("second/controllers/orders.js", handler("second"));
      await put("production/controllers/orders.js", handler("production"));
    }
    if (["npm-router-mock", "npm-router-mock-disabled"].includes(scenario)) {
      await put("config/default.json", JSON.stringify({swagger: {mockMode: false, swaggerControllerPipe: "controllers", bagpipes: {
        router: {name: "swagger_router", controllersDirs: ["api/controllers"], mockControllersDirs: ["api/mocks"],
          mockMode: scenario === "npm-router-mock-disabled"},
        controllers: ["swagger_params_parser", "express_compatibility", "router"]}}}));
      await put("config/production.json", JSON.stringify({swagger: {bagpipes: {router: {
        mockMode: scenario === "npm-router-mock", mockControllersDirs: ["production/mocks"], controllersInterface: "middleware",
      }}}}));
      await put("production/mocks/orders.js", handler("production-mock"));
    }
    process.env.NODE_ENV = "production";
  }

  // Each scenario is a fresh process: config/module caches and environment cannot leak between fixtures.
  process.env.NODE_CONFIG_DIR = join(root, "config");
  if (["environment-override", "source-environment-override"].includes(scenario)) process.env.swagger_mockMode = "true";
  const require = createRequire(new URL("./package.json", import.meta.url));
  const wrapperRequire = createRequire(require.resolve("swagger-express-mw"));
  const runnerRequire = createRequire(wrapperRequire.resolve("swagger-node-runner"));
  const transitiveVersions = Object.fromEntries(["bagpipes", "config", "sway"].map(name => [name, runnerRequire(`${name}/package.json`).version]));
  const versions = {wrapper: require("swagger-express-mw/package.json").version,
    runner: wrapperRequire("swagger-node-runner/package.json").version, express: require("express/package.json").version};
  const run = promisify(execFile);
  const analyzerNode = process.env.API_TRUTH_ANALYZER_NODE;
  if (!analyzerNode) throw new Error("Analyzer runtime missing");
  const captureScenario = scenario.startsWith("runtime-binding");
  const cliArgs = [fileURLToPath(new URL("../../../scripts/extract-swagger2-middleware.mjs", import.meta.url)),
    "--source", root, "--service", "synthetic", "--revision", "a".repeat(40)];
  const cliOptions = {timeout: 10000, maxBuffer: 1_000_000,
    env: {PATH: process.env.PATH, NODE_ENV: "test", SUPPRESS_NO_CONFIG_WARNING: "true"}};
  let capture;
  if (captureScenario) {
    const baseline = JSON.parse((await run(analyzerNode, cliArgs, cliOptions)).stdout);
    const collector = require(fileURLToPath(new URL("../../../analyzers/nodejs/src/runtime-binding-capture.cjs", import.meta.url)));
    capture = collector.installSwaggerRuntimeBindingCapture({serviceRoot: root, repository_id: "local", service_id: "synthetic",
      immutable_revision: "a".repeat(40), source_digest: baseline.source.source_digest, environment: "test", session_id: "runtime-fixture"});
  }
  const express = require("express");
  const wrapper = require("swagger-express-mw");
  const app = express();
  const middleware = await new Promise((accept, reject) => wrapper.create({appRoot: root, ...createOptions, ...(scenario === "runtime-binding-mock" ? {mockMode: true} : {})}, (error, value) => error ? reject(error) : accept(value)));
  middleware.register(app);
  app.use((error, req, res, next) => { res.status(500).json({error: "synthetic-routing-failure"}); });
  server = await new Promise(accept => { const listener = app.listen(0, "127.0.0.1", () => accept(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/v1/orders/42`, {signal: AbortSignal.timeout(5000)});
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = {nonJson: true}; }
  const withoutPrefix = await fetch(`${base}/orders/42`, {signal: AbortSignal.timeout(5000)});
  await withoutPrefix.arrayBuffer();
  const {stdout: analyzerVersion} = await run(analyzerNode, ["--version"]);
  let keyDirectory;
  if (capture) {
    const payload = capture.receipt(); capture.stop();
    const keys = generateKeyPairSync("ed25519");
    keyDirectory = await mkdtemp(join(tmpdir(), "api-truth-runtime-key-"));
    const keyPath = join(keyDirectory, "public.pem");
    await writeFile(keyPath, keys.publicKey.export({format: "pem", type: "spki"}));
    const privatePath = join(keyDirectory, "private.pem"), capturePath = join(keyDirectory, "capture.json");
    await writeFile(privatePath, keys.privateKey.export({format: "pem", type: "pkcs8"}), {mode: 0o600});
    await writeFile(capturePath, JSON.stringify(payload));
    await run(analyzerNode, [fileURLToPath(new URL("../../../scripts/sign-runtime-binding.mjs", import.meta.url)),
      "--capture", capturePath, "--private-key", privatePath, "--output", join(root, "api-truth.runtime-binding.json")], cliOptions);
    if (scenario === "runtime-binding-stale") await put("api/controllers/orders.js", 'exports.getOrder = function() { return "private-stale-marker"; };');
    cliArgs.push("--binding-receipt", "api-truth.runtime-binding.json", "--binding-public-key", keyPath);
  }
  let stdout;
  try { ({stdout} = await run(analyzerNode, cliArgs, cliOptions)); }
  finally { if (keyDirectory) await rm(keyDirectory, {recursive: true, force: true}); }
  const analysis = JSON.parse(stdout);
  process.stdout.write(JSON.stringify({versions, transitiveVersions, runtimeNode: process.version, analyzerNode: analyzerVersion.trim(), status: response.status, body, withoutPrefixStatus: withoutPrefix.status,
    analysis: {status: analysis.status,
      bodyDeclaration: analysis.claims.find(item => item.predicate === "handler.response.body.declaration"),
      definitionDependencyPaths: [...new Set(analysis.dependencies.filter(item => item.to.kind === "evidence")
        .map(item => analysis.evidence.find(evidence => evidence.evidence_id === item.to.id)?.location.pointer)
        .filter(pointer => pointer?.startsWith("/definitions/")))].sort(),
      requiredDiscrepancy: analysis.claims.find(item => item.predicate === "handler.response.body.required.discrepancy"),
      bodyDiscrepancy: analysis.claims.find(item => item.predicate === "handler.response.body.type.discrepancy"),
      statusDeclaration: analysis.claims.find(item => item.predicate === "handler.response.status.declaration"),
      documentedStatuses: analysis.endpoints[0]?.responses.map(item => item.status),
      candidatePath: analysis.claims.find(item => item.predicate === "handler.candidate")?.value.path,
      initializationSources: analysis.claims.find(item => item.predicate === "handler.candidate")?.value.initialization_sources?.map(item => item.path),
      bindingClaim: analysis.claims.some(item => item.predicate === "handler.binding"),
      binding: analysis.claims.find(item => item.predicate === "handler.binding"), diagnostics: analysis.diagnostics.map(item => item.code)}}));
} finally {
  if (server) { server.closeAllConnections(); await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); }
  await rm(root, {recursive: true, force: true});
}
