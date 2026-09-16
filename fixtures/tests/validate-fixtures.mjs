import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = resolve(process.env.FIXTURES_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const text = (path) => readFileSync(join(fixturesRoot, path), "utf8");
const exists = (path) => existsSync(join(fixturesRoot, path));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function jsonFiles(directory = fixturesRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}
function functionSegment(source, marker, close = "\n}") {
  const start = source.indexOf(marker);
  return start < 0 ? "" : source.slice(start, source.indexOf(close, start) + close.length);
}

for (const file of jsonFiles()) {
  try { JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { failures.push(`${relative(fixturesRoot, file)} is not valid JSON: ${error.message}`); }
}

function validateDeclaration(schema, source) {
  check(schema.kind === "interface" && source.includes(`export interface ${schema.symbol}`), `typescript: declaration kind/symbol mismatch: ${schema.symbol}`);
  if (schema.symbol === "CreateOrderBody") {
    const customer = schema.fields.customer;
    check(customer.presence === "declared_required" && source.includes(`customer: { id: ${customer.shape.id}; address: { city: ${customer.shape.address.city} } };`), "typescript: nested customer declaration mismatch");
    const items = schema.fields.items;
    check(items.presence === "declared_required" && source.includes(`items: ${items.shape};`), "typescript: array-item declaration mismatch");
    const priority = schema.fields.priority.presence === "declared_optional" ? `priority?: ${schema.fields.priority.shape};` : `priority: ${schema.fields.priority.shape};`;
    check(source.includes(priority), `typescript: priority declaration mismatch for ${schema.symbol}`);
  }
  if (schema.symbol === "OrderView") {
    check(schema.fields.id.presence === "declared_required" && source.includes(`id: ${schema.fields.id.shape};`), "typescript: response id declaration mismatch");
    const states = schema.fields.state.shape.split(" | ").map((state) => `"${state}"`).join(" | ");
    check(schema.fields.state.presence === "declared_required" && source.includes(`state: ${states};`), "typescript: response enum declaration mismatch");
  }
}

function validateTypeScriptSnapshot(variant) {
  const expected = JSON.parse(text(`typescript/orders/${variant}/expected.json`));
  const catalog = JSON.parse(text(expected.declaration_schema_catalog));
  const routesSource = text(`typescript/orders/${variant}/src/orders-routes.ts`);
  const typeSource = text(`typescript/orders/${variant}/src/types.ts`);
  check(exists(expected.declaration_schema_catalog), `${variant}: declaration catalog missing`);

  for (const mount of expected.mounts) check(exists(mount.source) && text(mount.source).includes(`app.use("${mount.prefix}", ${mount.router_symbol})`), `${variant}: mount evidence mismatch`);
  for (const declaration of expected.security_declarations) check(exists(declaration.source) && text(declaration.source).includes(`${declaration.scope}.use(${declaration.middleware_symbol})`), `${variant}: security declaration mismatch`);

  const validators = new Map(expected.shared_validators.map((validator) => [validator.symbol, validator]));
  for (const validator of validators.values()) {
    const source = text(validator.source);
    check(source.includes(".status(400)"), `${variant}: ${validator.symbol} 400 response evidence missing`);
    check(source.includes("!body?.customer?.id") && source.includes("!body.customer?.address?.city") && source.includes("!Array.isArray(body.items)"), `${variant}: ${validator.symbol} runtime required-field evidence missing`);
    const priorityEvidence = validator.runtime_presence.priority === "required" ? "!body.priority" : "body.priority !== undefined";
    check(source.includes(priorityEvidence), `${variant}: ${validator.symbol} priority runtime presence mismatch`);
  }

  for (const route of expected.routes) {
    const registration = routesSource.split("\n").find((line) => line.startsWith(`ordersRouter.${route.method.toLowerCase()}("${route.source_path}"`));
    check(Boolean(registration), `${variant}: registration missing for ${route.id}`);
    check(registration?.includes(`, ${route.handler_symbol});`), `${variant}: registration/handler mismatch for ${route.id}`);
    check(route.application_path === `/api${route.source_path}`, `${variant}: application path mismatch for ${route.id}`);
    const handler = functionSegment(text(route.handler_source), `export async function ${route.handler_symbol}`);
    check(Boolean(handler), `${variant}: handler symbol missing for ${route.id}`);
    for (const status of route.response.handler.statuses) check(handler.includes(`.status(${status})`), `${variant}: handler status ${status} missing for ${route.id}`);
    for (const mediaType of route.response.handler.media_types) check(handler.includes(`.type("${mediaType}")`), `${variant}: handler media type ${mediaType} missing for ${route.id}`);
    const responseSchema = catalog.schemas[route.response.handler.declaration_schema_ref];
    check(Boolean(responseSchema), `${variant}: response schema reference missing for ${route.id}`);
    if (responseSchema) { check(responseSchema.source === `typescript/orders/${variant}/src/types.ts`, `${variant}: response declaration source mismatch for ${route.id}`); validateDeclaration(responseSchema, typeSource); check(handler.includes(responseSchema.symbol), `${variant}: response declaration not referenced by ${route.handler_symbol}`); }
    if (route.request.declaration_schema_ref) {
      const requestSchema = catalog.schemas[route.request.declaration_schema_ref];
      check(Boolean(requestSchema), `${variant}: request schema reference missing for ${route.id}`);
      if (requestSchema) { check(requestSchema.source === `typescript/orders/${variant}/src/types.ts`, `${variant}: request declaration source mismatch for ${route.id}`); validateDeclaration(requestSchema, typeSource); check(handler.includes(requestSchema.symbol), `${variant}: request declaration not referenced by ${route.handler_symbol}`); }
    }
    for (const middleware of route.response.middleware ?? []) {
      const validator = validators.get(middleware);
      check(route.request.runtime_validator === middleware && Boolean(validator), `${variant}: middleware response not linked to ${route.id}`);
      if (validator) for (const status of validator.response.statuses) check(text(validator.source).includes(`.status(${status})`), `${variant}: middleware status ${status} missing for ${route.id}`);
    }
  }
  for (const validator of validators.values()) {
    const dependent = expected.routes.filter((route) => route.request.runtime_validator === validator.symbol).map((route) => route.id).sort().join(",");
    check(dependent === [...validator.dependent_endpoint_ids].sort().join(","), `${variant}: validator dependents mismatch`);
    if (validator.expected_affected_endpoint_ids) check(dependent === [...validator.expected_affected_endpoint_ids].sort().join(","), `${variant}: shared-validator affected endpoint set is incomplete`);
  }
  for (const gap of expected.unresolved) check(exists(gap.source) && text(gap.source).includes("legacySuffix") && gap.diagnostic === "computed_route_path_unresolved" && gap.preserve, `${variant}: unresolved route gap mismatch`);
}

validateTypeScriptSnapshot("baseline");
validateTypeScriptSnapshot("changed");

const javaExpected = JSON.parse(text("java/orders/expected.json"));
const javaSource = text("java/orders/src/OrdersController.java");
const javaCatalog = JSON.parse(text(javaExpected.declaration_schema_catalog));
for (const importedType of javaExpected.imports_evidence) check(javaSource.includes(`import ${importedType};`), `java: import evidence missing for ${importedType}`);
check(javaSource.includes(`@RequestMapping(value = "${javaExpected.controller.prefix}", produces = MediaType.APPLICATION_JSON_VALUE)`), "java: controller mapping mismatch");
check(javaCatalog.source === "java/orders/src/OrdersController.java", "java: declaration catalog source mismatch");
const javaSchemas = javaCatalog.schemas;
for (const [symbol, schema] of Object.entries(javaSchemas)) check(schema.kind === "record" && javaSource.includes(`record ${symbol}(`), `java: declaration kind/symbol mismatch: ${symbol}`);
const javaPresenceAnnotation = (presence) => ({ "required_by_@NotBlank": "@NotBlank", "required_by_@NotEmpty": "@NotEmpty" }[presence] ?? "");
const createFields = javaSchemas.CreateOrderRequest.fields;
const customerFields = javaSchemas.Customer.fields;
const addressFields = javaSchemas.Address.fields;
const lineItemFields = javaSchemas.LineItem.fields;
const responseFields = javaSchemas.OrderResponse.fields;
const javaItemElement = createFields.items.shape.slice("List<".length, -1);
check(createFields.customer.parent_presence === "unknown_no_NotNull" && createFields.customer.cascade === "@Valid" && createFields.items.parent_presence === "required_by_@NotEmpty" && createFields.items.cascade === "@Valid_element" && javaSource.includes(`record CreateOrderRequest(@Valid ${createFields.customer.shape} customer, @NotEmpty List<@Valid ${javaItemElement}> items)`), "java: CreateOrderRequest catalog facts mismatch");
check(javaSource.includes(`record Customer(${javaPresenceAnnotation(customerFields.id.presence)} ${customerFields.id.shape} id, ${customerFields.address.cascade} ${customerFields.address.shape} address)`) && customerFields.address.parent_presence === "unknown_no_NotNull", "java: Customer catalog facts mismatch");
check(javaSource.includes(`record Address(${javaPresenceAnnotation(addressFields.city.presence)} ${addressFields.city.shape} city)`), "java: Address catalog facts mismatch");
check(lineItemFields.quantity.request_presence === "unknown_no_binding_evidence" && javaSource.includes(`record LineItem(${javaPresenceAnnotation(lineItemFields.sku.presence)} ${lineItemFields.sku.shape} sku, ${lineItemFields.quantity.numeric_constraint} ${lineItemFields.quantity.shape} quantity)`), "java: LineItem catalog facts mismatch");
check(javaSource.includes(`record OrderResponse(${responseFields.id.shape} id, ${responseFields.state.shape} state)`) && responseFields.id.presence === "declaration_only" && responseFields.state.presence === "declaration_only", "java: OrderResponse catalog facts mismatch");
for (const route of javaExpected.routes) {
  check(javaSource.includes(route.mapping_annotation), `java: mapping selector mismatch for ${route.id}`);
  const handler = functionSegment(javaSource, `public OrderResponse ${route.handler_symbol}`);
  check(Boolean(handler) && handler.includes("new OrderResponse"), `java: response handler mismatch for ${route.id}`);
  check(route.application_path.startsWith(javaExpected.controller.prefix), `java: application path mismatch for ${route.id}`);
  check(Boolean(javaCatalog.schemas[route.response.declaration_schema_ref]), `java: response schema reference missing for ${route.id}`);
  if (route.request.declaration_schema_ref) check(Boolean(javaCatalog.schemas[route.request.declaration_schema_ref]), `java: request schema reference missing for ${route.id}`);
  for (const header of route.selectors.headers ?? []) check(route.mapping_annotation.includes(`headers = "${header}"`), `java: header selector mismatch for ${route.id}`);
  for (const mediaType of route.selectors.produces ?? []) check(route.mapping_annotation.includes(`produces = "${mediaType}"`), `java: produces selector mismatch for ${route.id}`);
  for (const mediaType of route.selectors.consumes ?? []) check(route.mapping_annotation.includes("MediaType.APPLICATION_JSON_VALUE") && mediaType === "application/json", `java: consumes selector mismatch for ${route.id}`);
  if (!route.selectors.produces) check(route.response.media_types[0] === javaExpected.controller.response_media_type, `java: inherited response media type mismatch for ${route.id}`);
}
const javaCreate = javaExpected.routes.find((route) => route.id === "create-java-order");
for (const [path, annotation] of Object.entries(javaCreate.request.runtime_validation)) check(javaSource.includes(`${annotation}`), `java: runtime annotation missing for ${path}`);
check(javaCreate.request.runtime_validation["customer.id"] === javaPresenceAnnotation(customerFields.id.presence), "java: customer runtime validation catalog mismatch");
check(javaCreate.request.runtime_validation["customer.address.city"] === javaPresenceAnnotation(addressFields.city.presence), "java: address runtime validation catalog mismatch");
check(javaCreate.request.runtime_validation.items === javaPresenceAnnotation(createFields.items.parent_presence), "java: items runtime validation catalog mismatch");
check(javaCreate.request.runtime_validation["items[].sku"] === javaPresenceAnnotation(lineItemFields.sku.presence), "java: item sku runtime validation catalog mismatch");
check(javaCreate.request.runtime_numeric_constraints["items[].quantity"] === lineItemFields.quantity.numeric_constraint, "java: item quantity numeric constraint mismatch");
check(javaCreate.request.request_presence["items[].quantity"] === lineItemFields.quantity.request_presence, "java: item quantity request presence mismatch");
check(javaSource.includes("@Valid Customer customer") && !javaSource.includes("@NotNull Customer customer"), "java: customer nullable/cascade boundary mismatch");
check(javaSource.includes("@Valid Address address") && !javaSource.includes("@NotNull Address address"), "java: address nullable/cascade boundary mismatch");
check(javaSource.includes("@NotEmpty List<@Valid LineItem> items"), "java: items presence/cascade boundary mismatch");

const lifecycle = JSON.parse(text("lifecycle/cases.json"));
check(!lifecycle.revision_aliases.some((alias) => alias.startsWith("artifact-")) && lifecycle.artifact_aliases.includes("artifact-b"), "lifecycle: artifact/revision aliases are conflated");
const resolutionFromServing = (activeRevisionSet) => {
  if (activeRevisionSet === "unknown") return "unknown; pending artifact-to-revision analysis";
  if (activeRevisionSet.length === 1) return activeRevisionSet[0];
  return `mixed ${activeRevisionSet.join(" and ")}; no universal contract`;
};
for (const lifecycleCase of lifecycle.cases) {
  const initial = lifecycleCase.initial_authoritative_observation;
  check(initial?.serving_observation_id && Number.isInteger(initial?.serving_effective_order) && initial.active_revision_set !== undefined && initial.completeness, `lifecycle: initial authoritative observation missing for ${lifecycleCase.id}`);
  for (const step of lifecycleCase.steps) {
    check(step.expected?.branch && step.expected?.serving && step.expected?.contract_resolution && step.expected?.exposure, `lifecycle: state subjects missing for ${lifecycleCase.id}/${step.event}`);
    if (["deployment_succeeded", "deployment_failed"].includes(step.event)) check(Number.isInteger(step.attempt_effective_order) && !JSON.stringify(step.expected.serving).includes("active_revision_set"), `lifecycle: attempt improperly resolves serving for ${lifecycleCase.id}`);
    if (["serving_observed", "reconciliation_completed"].includes(step.event)) {
      const environment = step.environment ?? initial.environment;
      const expectedServing = step.expected.serving[environment];
      check(step.serving_observation_id && Number.isInteger(step.serving_effective_order) && step.active_revision_set !== undefined, `lifecycle: serving observation data missing for ${lifecycleCase.id}`);
      check(same(expectedServing?.active_revision_set, step.active_revision_set) && expectedServing?.completeness === step.completeness, `lifecycle: serving input/expected mismatch for ${lifecycleCase.id}`);
      check(step.expected.contract_resolution[environment] === resolutionFromServing(step.active_revision_set), `lifecycle: contract resolution mismatch for ${lifecycleCase.id}`);
    }
  }
}
const duplicateCase = lifecycle.cases.find((item) => item.id === "stale-and-duplicate-events");
const originalDelivery = duplicateCase.steps.find((step) => step.delivery === "original");
const duplicateDelivery = duplicateCase.steps.find((step) => step.delivery === "duplicate");
check(Boolean(originalDelivery) && Boolean(duplicateDelivery) && duplicateDelivery.event_id === originalDelivery.event_id && duplicateDelivery.attempt_effective_order === originalDelivery.attempt_effective_order && duplicateDelivery.provider_sequence_or_cursor === originalDelivery.provider_sequence_or_cursor, "lifecycle: duplicate delivery lacks matching original identity/order/cursor");
const uatObserved = lifecycle.cases.find((item) => item.id === "uat-only-deployment").steps.find((step) => step.event === "serving_observed");
check(uatObserved.expected.exposure.uat.application_path === "/api/orders", "lifecycle: UAT application path must match source route");
check(new Set(lifecycle.sample_completeness_examples.map((item) => item.sample_completeness)).size === 4, "lifecycle: completeness examples must distinguish omitted, redacted, truncated, and complete/absent");

if (failures.length) { console.error(`Fixture validation failed (${failures.length}):`); for (const failure of failures) console.error(`- ${failure}`); process.exitCode = 1; }
else console.log("Fixture validation passed: JSON, bounded route/handler evidence, declaration schemas, Java selectors/validation, and lifecycle authority separation.");
