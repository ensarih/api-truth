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
  ["runtime-binding", 200, "orders"],
  ["protected-capture", 200, "orders"],
  ["runtime-binding-missing", 500, undefined],
  ["runtime-binding-mock", 200, "mock"],
  ["runtime-binding-stale", 200, "orders"],
  ["runtime-binding-precedence", 200, "first"],
  ["runtime-binding-response-mismatch", 201, "orders"],
  ["runtime-binding-response-match", 201, "orders"],
  ["runtime-binding-response-default", 201, "orders"],
  ["runtime-binding-body-match", 201, "orders"],
  ["runtime-binding-body-mismatch", 201, "orders"],
  ["runtime-binding-body-ref", 201, "orders"],
  ["runtime-binding-body-required-missing", 201, "orders"],
  ["runtime-binding-body-required-present", 201, "orders"],
  ["runtime-binding-body-required-null", 201, "orders"],
  ["runtime-binding-body-ref-type", 201, "orders"],
  ["runtime-binding-body-ref-required", 201, "orders"],
  ["runtime-binding-body-ref-cycle", 201, "orders"],
  ["runtime-binding-body-object-match", 201, "orders"],
  ["runtime-binding-body-object-type", 201, "orders"],
  ["runtime-binding-body-object-default-required", 201, "orders"],
  ["runtime-binding-body-allof-match", 201, "orders"],
  ["runtime-binding-body-allof-type", 201, "orders"],
  ["runtime-binding-body-allof-required", 201, "orders"],
  ["runtime-binding-body-local-match", 201, "orders"],
  ["runtime-binding-body-local-type", 201, "orders"],
  ["runtime-binding-body-local-required", 201, "orders"],
  ["runtime-binding-body-linear-match", 201, "orders"],
  ["runtime-binding-body-additional-match", 201, "orders"],
  ["runtime-binding-body-additional-extra", 201, "orders"],
  ["runtime-binding-body-additional-reference", 201, "orders"],
  ["runtime-binding-body-shorthand-match", 201, "orders"],
  ["runtime-binding-body-shorthand-type", 201, "orders"],
  ["runtime-binding-body-shorthand-required", 201, "orders"],
  ["runtime-binding-body-schema-missing", 201, "orders"],
  ["runtime-binding-body-schema-missing-default", 201, "orders"],
  ["runtime-binding-body-schema-missing-precedence", 201, "orders"],
  ["runtime-binding-body-schema-missing-example", 201, "orders"],
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
    if (scenario === "runtime-binding-stale") assert.ok(result.analysis.diagnostics.includes("runtime_binding_receipt_unverified"));
    if (scenario.startsWith("runtime-binding-body-")) {
      const schemaMissing = ["runtime-binding-body-schema-missing", "runtime-binding-body-schema-missing-default", "runtime-binding-body-schema-missing-example"].includes(scenario);
      assert.equal(result.analysis.diagnostics.includes("handler_response_body_schema_missing"), schemaMissing);
      if (schemaMissing) {
        assert.equal(result.analysis.responseSchemaDeclaration, undefined);
        assert.equal(result.analysis.responseMediaDeclaration, undefined);
        assert.equal(result.analysis.schemaMissingBody.verification, "inferred");
        assert.equal(result.analysis.schemaMissingBody.value.examples_present, scenario.endsWith("example"));
        assert.equal(result.analysis.schemaMissingBody.value.response_key, scenario.endsWith("default") ? "default" : "201");
        assert.ok(result.analysis.schemaMissingBodyPointers.includes(scenario.endsWith("default") ? "/responses/Shared" : "/paths/~1orders~1{id}/get/responses/201"));
        assert.equal(result.analysis.diagnostics.includes("handler_response_body_presence_unresolved"), false);
      } else {
        assert.equal(result.analysis.responseSchemaDeclaration.verification, "declared");
        assert.equal(result.analysis.responseMediaDeclaration.verification, "declared");
        assert.deepEqual(result.analysis.responseMediaDeclaration.value.media_types, ["application/json"]);
        assert.equal(result.analysis.responseMediaPointer, "/produces");
      }
      if (scenario.startsWith("runtime-binding-body-additional-")) {
        const discrepancy = !scenario.endsWith("match");
        assert.equal(result.analysis.diagnostics.includes("handler_response_body_additional_discrepancy"), discrepancy);
        assert.equal(result.analysis.diagnostics.includes("handler_response_body_additional_unresolved"), false);
        if (discrepancy) {
          assert.equal(result.analysis.additionalDiscrepancy.verification,"inferred");
          assert.deepEqual(result.analysis.additionalDiscrepancy.value.paths,["/controller"]);
          assert.ok(result.analysis.additionalEvidencePaths.includes("/paths/~1orders~1{id}/get/responses/201/schema"));
          if (scenario.endsWith("reference")) assert.ok(result.analysis.additionalEvidencePaths.includes("/definitions/Closed"));
        } else assert.equal(result.analysis.additionalDiscrepancy,undefined);
      }
      assert.equal(result.analysis.bodyDeclaration.verification, "inferred");
      if (scenario.startsWith("runtime-binding-body-shorthand-")) assert.deepEqual(result.analysis.bodyConstantSources,
        [{line:2, path:"api/controllers/orders.js", linked:true, dependency:true}]);
      const properties = {controller:{type:"string"}};
      if (scenario.endsWith("present")) properties.name = {type:"string"};
      if (scenario.endsWith("null")) properties.name = {type:"null"};
      assert.deepEqual(result.analysis.bodyDeclaration.value.schema, {type:"object", properties});
      assert.equal(result.analysis.diagnostics.includes("handler_response_body_required_discrepancy"), ["runtime-binding-body-required-missing", "runtime-binding-body-ref-required", "runtime-binding-body-object-default-required", "runtime-binding-body-allof-required", "runtime-binding-body-local-required", "runtime-binding-body-shorthand-required"].includes(scenario));
      if (["runtime-binding-body-required-missing", "runtime-binding-body-ref-required", "runtime-binding-body-object-default-required", "runtime-binding-body-allof-required", "runtime-binding-body-local-required", "runtime-binding-body-shorthand-required"].includes(scenario)) {
        assert.equal(result.analysis.requiredDiscrepancy.verification, "inferred");
        assert.deepEqual(result.analysis.requiredDiscrepancy.value.paths, ["/name"]);
      }
      assert.equal(result.analysis.diagnostics.includes("handler_response_body_type_discrepancy"), (scenario.endsWith("mismatch") || ["runtime-binding-body-ref-type", "runtime-binding-body-object-type", "runtime-binding-body-allof-type", "runtime-binding-body-local-type", "runtime-binding-body-shorthand-type"].includes(scenario)));
      assert.equal(result.analysis.diagnostics.includes("handler_response_body_comparison_unresolved"), scenario.endsWith("cycle"));
      if (scenario.startsWith("runtime-binding-body-allof-")) {
        assert.deepEqual(result.analysis.definitionDependencyPaths, ["/definitions/Base", "/definitions/Body", "/definitions/Fields"]);
      }
      if (scenario.startsWith("runtime-binding-body-object-")) {
        assert.equal(result.analysis.responseSchemaPointer, "/responses/Shared/schema");
        assert.equal(result.analysis.catalogResponseContentCount, 1);
        assert.deepEqual(result.analysis.catalogResponseHeaders, [{name:"X-Count", schema:{type:"integer"}}]);
        assert.equal(result.analysis.catalogHeaderClaim.verification, "declared");
        assert.deepEqual(result.analysis.responseDependencyPaths, ["/responses/Alias", "/responses/Shared"]);
        assert.deepEqual(result.analysis.definitionDependencyPaths, ["/definitions/Body"]);
      }
      if (scenario.endsWith("ref") || scenario.startsWith("runtime-binding-body-ref-"))
        assert.deepEqual(result.analysis.definitionDependencyPaths, scenario.endsWith("cycle") ? [] : ["/definitions/Body"]);
      if ((scenario.endsWith("mismatch") || ["runtime-binding-body-ref-type", "runtime-binding-body-object-type", "runtime-binding-body-allof-type", "runtime-binding-body-local-type", "runtime-binding-body-shorthand-type"].includes(scenario))) assert.deepEqual(result.analysis.bodyDiscrepancy.value.paths, ["/controller"]);
    }
    if (scenario.startsWith("runtime-binding-response-")) {
      assert.equal(result.analysis.statusDeclaration.value.code, 201);
      assert.equal(result.analysis.statusDeclaration.verification, "inferred");
      assert.equal(result.analysis.diagnostics.includes("handler_response_status_discrepancy"), scenario.endsWith("mismatch"));
      assert.deepEqual(result.analysis.documentedStatuses, scenario.endsWith("default") ? [{kind:"default"}]
        : [{kind:"exact", code: scenario.endsWith("match") && !scenario.endsWith("mismatch") ? 201 : 200}]);
    }
    if (["runtime-binding", "runtime-binding-response-match"].includes(scenario)) {
      assert.equal(result.analysis.securityState, "anonymous");
      assert.equal(result.analysis.securityDeclaration.verification, "declared");
      assert.deepEqual(result.analysis.securityDeclaration.value, []);
      assert.deepEqual(result.analysis.securityDeclarationPointers, [scenario === "runtime-binding" ? "/security" : "/paths/~1orders~1{id}/get/security"]);
    } else {
      assert.equal(result.analysis.securityState, "unknown");
      assert.equal(result.analysis.securityDeclaration, undefined);
    }
    if (scenario === "protected-capture") {
      assert.match(result.protectedCapture.revision, /^[a-f0-9]{40}$/);
      assert.notEqual(result.protectedCapture.revision, "a".repeat(40));
      assert.equal(result.protectedCapture.revision, result.protectedCapture.scope.immutableRevision);
      assert.equal(result.protectedCapture.sourceDigest, result.protectedCapture.scope.sourceDigest);
      assert.equal(result.protectedCapture.captureIdentityDigest, result.protectedCapture.expectedCaptureIdentityDigest);
      assert.deepEqual(result.protectedCapture.handlers, [{method:"GET", applicationPath:"/api/v1/orders/{id}",
        controller:"orders", operationId:"getOrder", handlerPath:"api/controllers/orders.js",
        handlerDigest:result.protectedCapture.expectedHandlerDigest, exportName:"getOrder"}]);
      assert.equal(result.protectedCapture.externalArtifactNotCommitted, true);
      assert.equal(result.protectedCapture.ownedTempCleaned, true);
      assert.equal(result.protectedCapture.executionMarkerBefore, "x");
      assert.equal(result.protectedCapture.executionMarkerAfter, "x");
      assert.deepEqual(result.protectedCapture.limitations,
        ["Document operation correspondence and deployment are unverified"]);
      assert.equal(result.protectedCapture.correspondence.kind, "protected_swagger_document_value_correspondence");
      assert.equal(result.protectedCapture.correspondence.profileVersion, "swagger-document-value-1");
      assert.equal(result.protectedCapture.correspondence.captureIdentityDigest,
        result.protectedCapture.captureIdentityDigest);
      assert.equal(result.protectedCapture.correspondence.sourceDigest, result.protectedCapture.sourceDigest);
      assert.deepEqual(result.protectedCapture.correspondence.matches,
        [{bindingIndex:0,documentPointer:"/paths/~1orders~1{id}/get",handlerPath:"api/controllers/orders.js"}]);
      assert.deepEqual(result.protectedCapture.correspondence.diagnostics, []);
      assert.match(result.protectedCapture.correspondence.document.digest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(result.protectedCapture.correspondence.document.rawSha256,
        result.protectedCapture.expectedRawDocumentSha256);
      assert.equal(result.protectedCapture.correspondence.limitations[0],
        "Actual runtime document loading and deployment are unverified");
      assert.equal("snapshot_id" in result.protectedCapture, false);
      assert.equal("claims" in result.protectedCapture, false);
    }
    assert.equal(result.analysis.status, "partial");
    if (["runtime-binding", "runtime-binding-precedence"].includes(scenario) || scenario.startsWith("runtime-binding-response-") || scenario.startsWith("runtime-binding-body-")) {
      assert.equal(result.analysis.bindingClaim, true);
      assert.equal(result.analysis.binding.verification, "observed");
      assert.equal(result.analysis.binding.value.path, scenario === "runtime-binding-precedence" ? "first/controllers/orders.js" : "api/controllers/orders.js");
      assert.equal(result.analysis.binding.value.environment, "test");
      assert.equal(result.analysis.binding.value.session_id, "runtime-fixture");
      assert.ok(result.analysis.diagnostics.includes("runtime_binding_scope_limited"));
    } else {
      assert.equal(result.analysis.bindingClaim, false);
      assert.ok(result.analysis.diagnostics.includes("handler_binding_unverified"));
    }
  });
}


test("the pinned legacy config stack cannot be certified on Node 24 without modification", {timeout: 20000}, async () => {
  await assert.rejects(isolated(process.execPath, "default"), error => error.code === 1 && error.stderr.includes("TypeError: Utils.isRegExp is not a function"));
});

test("pinned Express header guard rejects before handler and accepts case-insensitive header names", async () => {
  const express = require("express");
  const app = express();
  let handled = 0;
  function requireApiKey(req, res, next) {
    if (req.get("X-API-Key") !== "synthetic-test-token") return res.status(401).end();
    next();
  }
  app.get("/orders", requireApiKey, (_req, res) => {
    handled++;
    res.status(200).type("application/json").json({});
  });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/orders`;
    for (const headers of [{}, {"x-api-key": "wrong-test-token"}]) {
      const response = await fetch(url, {headers});
      assert.equal(response.status, 401);
      assert.equal(await response.text(), "");
      assert.equal(handled, 0);
    }
    const response = await fetch(url, {headers: {"x-aPi-kEy": "synthetic-test-token"}});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
    assert.equal(handled, 1);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
