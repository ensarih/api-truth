import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(new URL("./package.json", import.meta.url));
const runtimeNode = require.resolve("node/bin/node");

const run = promisify(execFile);
const isolated = async (binary, scenario) => {
  const sandbox = await mkdtemp(join(tmpdir(), "api-truth-swagger-test-"));
  try {
    return await run(binary, [fileURLToPath(new URL("./scenario.mjs", import.meta.url)), scenario], {
      timeout: 18000, maxBuffer: 1_000_000,
      env: {PATH: process.env.PATH, NODE_ENV: "test", SUPPRESS_NO_CONFIG_WARNING: "true",
        API_TRUTH_ANALYZER_NODE: process.execPath, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox},
    });
  } finally { await rm(sandbox, {recursive: true, force: true}); }
};
const cases = [
  ["default", 200, "orders"],
  ["operation-override", 200, "alternate"],
  ["configured-directory", 200, "custom"],
  ["directory-precedence", 200, "first"],
  ["initialization-fallback", 200, "second"],
  ["single-initialization-failure", 500, undefined],
  ["local-import", 200, "local"],
  ["local-import-failure", 500, undefined],
  ["missing-controller", 500, undefined],
  ["missing-export", 500, undefined],
  ["mock-mode", 200, "mock"],
  ["environment-override", 200, "mock"],
  ["source-environment-override", 200, "mock"],
  ["create-mock-mode", 200, "mock"],
  ["create-mock-override", 200, "orders"],
  ["npm-environment-routing", 200, "orders"],
  ["npm-environment-mock", 200, "mock"],
  ["npm-environment-directories", 200, "production"],
  ["npm-router-mock", 200, "production-mock"],
  ["npm-router-mock-disabled", 200, "orders"],
];
for (const [scenario, status, marker] of cases) {
  test(`pinned routing behavior: ${scenario}`, {timeout: 20000}, async () => {
    const {stdout} = await isolated(runtimeNode, scenario);
    const result = JSON.parse(stdout);
    assert.equal(result.runtimeNode, "v22.19.0");
    assert.equal(result.analyzerNode, "v24.6.0");
    assert.deepEqual(result.transitiveVersions, {bagpipes: "0.1.2", config: "1.31.0", sway: "1.0.0"});
    assert.deepEqual(result.versions, {wrapper: "0.7.0", runner: "0.7.0", express: "4.13.3"});
    assert.equal(result.status, status);
    if (marker) assert.equal(result.body.controller, marker);
    if (scenario === "default") {
      assert.equal(result.body.id, "42");
      assert.equal(result.withoutPrefixStatus, 404);
      assert.equal(result.analysis.candidatePath, "api/controllers/orders.js");
    }
    if (scenario === "operation-override") assert.equal(result.analysis.candidatePath, "api/controllers/alternate.js");
    if (scenario === "configured-directory") assert.equal(result.analysis.candidatePath, "custom/controllers/orders.js");
    if (scenario === "npm-environment-directories") assert.equal(result.analysis.candidatePath, "production/controllers/orders.js");
    if (scenario === "local-import") {
      assert.equal(result.analysis.candidatePath, "api/controllers/orders.js");
      assert.deepEqual(result.analysis.initializationSources, ["api/helpers/reader.cjs"]);
    }
    if (["single-initialization-failure", "local-import-failure"].includes(scenario)) {
      assert.equal(result.analysis.candidatePath, undefined);
      assert.ok(result.analysis.diagnostics.includes("handler_initialization_unverified"));
    }
    if (["directory-precedence", "initialization-fallback"].includes(scenario)) {
      assert.equal(result.analysis.candidatePath, undefined);
      assert.ok(result.analysis.diagnostics.includes("handler_source_ambiguous"));
    }
    if (["create-mock-override", "npm-environment-routing", "npm-router-mock-disabled"].includes(scenario)) assert.equal(result.analysis.candidatePath, "api/controllers/orders.js");
    if (["mock-mode", "create-mock-mode", "npm-environment-mock", "npm-router-mock"].includes(scenario)) assert.ok(result.analysis.diagnostics.includes("handler_configuration_unverified"));
    if (scenario === "environment-override") {
      assert.equal(result.analysis.candidatePath, "api/controllers/orders.js");
      assert.notEqual(result.body.controller, "orders");
    }
    if (scenario === "source-environment-override") {
      assert.equal(result.analysis.candidatePath, undefined);
      assert.ok(result.analysis.diagnostics.includes("handler_environment_unverified"));
    }
    assert.equal(result.analysis.status, "partial");
    assert.equal(result.analysis.bindingClaim, false);
    assert.ok(result.analysis.diagnostics.includes("handler_binding_unverified"));
  });
}


test("the pinned legacy config stack cannot be certified on Node 24 without modification", {timeout: 20000}, async () => {
  await assert.rejects(isolated(process.execPath, "default"), error => error.code === 1 && error.stderr.includes("TypeError: Utils.isRegExp is not a function"));
});
