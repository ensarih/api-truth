import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = resolve(process.env.FIXTURES_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const text = (relativePath) => readFileSync(join(fixturesRoot, relativePath), "utf8");
const exists = (relativePath) => existsSync(join(fixturesRoot, relativePath));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function jsonFiles(directory = fixturesRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

for (const file of jsonFiles()) {
  try { JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { failures.push(`${relative(fixturesRoot, file)} is not valid JSON: ${error.message}`); }
}

function validateTypeScriptSnapshot(variant) {
  const expectedPath = `typescript/orders/${variant}/expected.json`;
  const expected = JSON.parse(text(expectedPath));
  const routesSource = text(`typescript/orders/${variant}/src/orders-routes.ts`);

  for (const mount of expected.mounts) {
    check(exists(mount.source), `${variant}: mount source does not exist: ${mount.source}`);
    check(text(mount.source).includes(`app.use("${mount.prefix}", ${mount.router_symbol})`), `${variant}: mount evidence is inconsistent`);
  }
  for (const declaration of expected.security_declarations) {
    check(exists(declaration.source), `${variant}: security source does not exist: ${declaration.source}`);
    check(text(declaration.source).includes(`${declaration.scope}.use(${declaration.middleware_symbol})`), `${variant}: security declaration is inconsistent`);
  }
  for (const route of expected.routes) {
    check(exists(route.source) && exists(route.handler_source), `${variant}: missing route evidence for ${route.id}`);
    const registration = new RegExp(`ordersRouter\\.${route.method.toLowerCase()}\\("${escapeRegExp(route.source_path)}"[\\s\\S]*?${route.handler_symbol}\\)`);
    check(registration.test(routesSource), `${variant}: registration/handler mismatch for ${route.id}`);
    check(text(route.handler_source).includes(`function ${route.handler_symbol}(`), `${variant}: handler symbol missing for ${route.id}`);
    check(route.application_path === `/api${route.source_path}`, `${variant}: application path mismatch for ${route.id}`);
    for (const status of route.response.statuses) {
      check(text(route.handler_source).includes(`.status(${status})`), `${variant}: response status ${status} is not declared by ${route.handler_symbol}`);
    }
    for (const mediaType of route.response.media_types) {
      check(text(route.handler_source).includes(`.type("${mediaType}")`), `${variant}: response media type ${mediaType} is not declared by ${route.handler_symbol}`);
    }
  }
  const routeIds = new Set(expected.routes.map((route) => route.id));
  for (const validator of expected.shared_validators) {
    check(exists(validator.source), `${variant}: validator source does not exist`);
    for (const routeId of validator.dependent_endpoint_ids) {
      const route = expected.routes.find((candidate) => candidate.id === routeId);
      check(route?.request.runtime_validator === validator.symbol, `${variant}: ${routeId} is not linked to ${validator.symbol}`);
    }
    if (validator.expected_affected_endpoint_ids) {
      const expectedAffected = [...validator.expected_affected_endpoint_ids].sort().join(",");
      const dependencies = [...validator.dependent_endpoint_ids].sort().join(",");
      check(expectedAffected === dependencies && validator.expected_affected_endpoint_ids.every((id) => routeIds.has(id)), `${variant}: shared-validator affected endpoint set is incomplete`);
    }
  }
  for (const gap of expected.unresolved) {
    check(exists(gap.source) && text(gap.source).includes("legacySuffix"), `${variant}: unresolved computed route was lost`);
    check(gap.diagnostic === "computed_route_path_unresolved" && gap.preserve === true, `${variant}: unresolved route lacks preservation diagnostic`);
  }
}

validateTypeScriptSnapshot("baseline");
validateTypeScriptSnapshot("changed");

const javaExpected = JSON.parse(text("java/orders/expected.json"));
const javaSource = text("java/orders/src/OrdersController.java");
check(exists(javaExpected.controller.source), "java: controller source does not exist");
for (const importedType of javaExpected.imports_evidence) check(javaSource.includes(`import ${importedType};`), `java: import evidence missing for ${importedType}`);
for (const route of javaExpected.routes) {
  check(javaSource.includes(` ${route.handler_symbol}(`), `java: handler symbol missing for ${route.id}`);
  check(route.application_path.startsWith(javaExpected.controller.prefix), `java: controller prefix missing from ${route.id}`);
}
check(javaExpected.routes.filter((route) => route.method === "GET" && route.application_path === "/api/orders/{orderId}").length === 2, "java: selector variants must share GET path");
check(javaSource.includes("@Valid @RequestBody CreateOrderRequest"), "java: nested DTO validation entry point missing");

const lifecycle = JSON.parse(text("lifecycle/cases.json"));
const requiredCases = ["baseline", "pr-preview-api-and-validator-change", "merge-without-deployment", "uat-only-deployment", "promotion-of-same-artifact", "failure-before-rollout", "failure-after-partial-rollout", "stale-and-duplicate-events", "missed-event-repaired-by-reconciliation", "rollback-request-and-confirmation", "exposure-configuration-change", "unknown-deployed-revision-pending-analysis"];
const lifecycleIds = new Set(lifecycle.cases.map((item) => item.id));
for (const id of requiredCases) check(lifecycleIds.has(id), `lifecycle: missing required case ${id}`);
for (const lifecycleCase of lifecycle.cases) for (const step of lifecycleCase.steps) {
  check(step.expected?.branch && step.expected?.serving && step.expected?.contract_resolution && step.expected?.exposure, `lifecycle: ${lifecycleCase.id}/${step.event} does not separate state subjects`);
}
check(new Set(lifecycle.sample_completeness_examples.map((item) => item.sample_completeness)).size === 4, "lifecycle: completeness examples must distinguish omitted, redacted, truncated, and complete/absent");

if (failures.length) {
  console.error(`Fixture validation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Fixture validation passed: JSON, evidence paths, routes, shared-validator impact, Java selectors, and lifecycle state separation.");
}
