import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  deriveEndpointIdentity, parseAnalyzerRequest, parseAnalyzerResult,
  type AnalyzerRequest, type AnalyzerResult, type ApiSchema, type Claim, type Endpoint, type Evidence,
} from "../../../packages/ir/src/index.js";
import type {RuntimeBindingResolution, RuntimeBinding} from "./runtime-binding.js";
import {resolveResponseSchema, resolveResponseObject} from "./response-schema-resolution.js";
import {compareResponseBodyTypes, compareResponseBodyPresence} from "./response-body-comparison.js";
import { declaredSchemaBounds, schemaBoundFields } from "./schema-bounds.js";
import { declaredSchemaConstraints } from "./schema-constraints.js";
import { readSelectedDocument } from "./source.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";
import { parseStrictYaml, StrictYamlError } from "./strict-yaml.js";
import { parseSwagger2Document, type Swagger2Diagnostic, type Swagger2Operation } from "./swagger2-document.js";
import { declaredPresence, parameterSerialization, supportedFormField, formFieldEncoding } from "./swagger2-serialization.js";
import type { StartupResolution } from "./startup.js";
import type { MiddlewareBinding } from "./middleware-binding.js";
import type { RoutingConfiguration } from "./routing-config.js";
import type { FrameworkLockResolution } from "./framework-lock.js";
import type { HandlerCandidateResolver, HandlerResponseStatus } from "./handler-candidates.js";

export type MiddlewareContext = {
  runtimeBinding?: RuntimeBindingResolution;
  responseStatusResolver?: (binding: RuntimeBinding) => HandlerResponseStatus;
  kind: "verified"; binding: MiddlewareBinding; routingConfiguration?: RoutingConfiguration;
  handlerResolver?: HandlerCandidateResolver; frameworkLock?: FrameworkLockResolution; startup?: StartupResolution;
} | { kind: "unverified" };

/** Document facts only. Middleware mounting and handler binding require a separate profile. */
export const ANALYZER = { analyzer_id: "nodejs-swagger2-document", analyzer_version: "0.10.0" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const pointerPart = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const safePointer = (pointer: string) => pointer || "/";

export function createAnalyzer(options: { projectRoot: string }) {
  return { async analyze(input: unknown): Promise<AnalyzerResult> {
    const parsed = parseAnalyzerRequest(input);
    if (!parsed.ok) throw new Error("Invalid analyzer request");
    const request = parsed.value;
    if (request.ir_version !== "1.1.0") throw new Error("Swagger profile requires IR 1.1.0");
    if (request.analyzer.analyzer_id !== ANALYZER.analyzer_id || request.analyzer.analyzer_version !== ANALYZER.analyzer_version)
      throw new Error("Unsupported analyzer version");
    if (request.resolution_inputs.length !== 1 || request.resolution_inputs[0]?.kind !== "type_manifest")
      throw new Error("Unsupported resolution inputs");
    const selected = request.resolution_inputs[0];
    if (request.changed_paths.some(path => path !== selected.path)) throw new Error("Unsupported changed paths");
    const started = Date.now();
    const source = await readSelectedDocument(resolve(options.projectRoot), request.source.service_root, selected.path,
      Math.min(request.limits.max_output_bytes, 2_000_000));
    if (Date.now() - started > request.limits.timeout_ms) throw new Error("Analysis time limit exceeded");
    for (const digest of [request.source.source_digest, selected.digest]) {
      if (/^sha256:[a-f0-9]{64}$/i.test(digest) && digest.toLowerCase() !== source.digest)
        throw new Error("Source digest mismatch");
    }
    const normalized: AnalyzerRequest = {
      ...request, source: { ...request.source, source_digest: source.digest },
      resolution_inputs: [{ ...selected, digest: source.digest }],
    };
    const result = extractSwagger2Document(normalized, source.path, source.text);
    if (Date.now() - started > request.limits.timeout_ms) throw new Error("Analysis time limit exceeded");
    if (Buffer.byteLength(JSON.stringify(result)) > request.limits.max_output_bytes) throw new Error("Analysis output limit exceeded");
    const validated = parseAnalyzerResult(result);
    if (!validated.ok) throw new Error("Analyzer produced invalid result");
    return validated.value;
  } };
}

export async function analyze(request: AnalyzerRequest): Promise<AnalyzerResult> {
  return createAnalyzer({ projectRoot: process.cwd() }).analyze(request);
}

export function extractSwagger2Document(request: AnalyzerRequest, documentPath: string, text: string,
  middleware?: MiddlewareContext): AnalyzerResult {
  const fingerprint = middleware === undefined
    ? hash(JSON.stringify({ request, analyzer: ANALYZER, parser: "swagger2-json-yaml-8", documentPath }))
    : hash(JSON.stringify({ request, analyzer: request.analyzer, parser: "swagger2-bound-26", documentPath,
      middleware, handlerPolicy: middleware.kind === "verified" && middleware.handlerResolver
        ? "static-routing-source-candidates-2" : "none" }));
  const result: AnalyzerResult = {
    exchange_version: "1.0.0", ir_version: request.ir_version, identity_version: "1.0.0", request_id: request.request_id,
    result_id: `result-${fingerprint}`, snapshot_id: `snapshot-${fingerprint}`, analyzer: request.analyzer, source: request.source,
    status: "success", completed_at: new Date().toISOString(),
    coverage: { status: "complete", analyzed_roots: [documentPath], diagnostic_ids: [] },
    evidence: [], schemas: {}, endpoints: [], claims: [], dependencies: [], diagnostics: [],
    reproducibility_fingerprint: `sha256:${fingerprint}`,
  };
  const evidence = (pointer: string, endpointId?: string): string => {
    const id = `ev-${hash(`${documentPath}:${pointer}:${endpointId ?? ""}`).slice(0, 24)}`;
    if (!result.evidence.some(item => item.evidence_id === id)) result.evidence.push({
      evidence_id: id, source: { kind: "api_document", source_id: request.source.repository_id },
      source_version: request.source.immutable_revision, location: { path: documentPath, pointer: safePointer(pointer) },
      method: "type_declaration", scope: { service_id: request.source.service_id, snapshot_id: result.snapshot_id,
        revision: request.source.immutable_revision, ...(endpointId ? { endpoint_id: endpointId } : {}) },
      limitations: ["document declaration; middleware binding not verified"], access_label: request.source.access_label,
    });
    return id;
  };
  const middlewareEvidence = (endpointId?: string): string => {
    if (middleware?.kind !== "verified") throw new Error("Missing middleware binding");
    const binding = middleware.binding;
    const id = `ev-${hash(`${binding.path}:${binding.span}:${endpointId ?? ""}:registration`).slice(0, 24)}`;
    if (!result.evidence.some(item => item.evidence_id === id)) result.evidence.push({
      evidence_id: id, source: { kind: "source_code", source_id: request.source.repository_id },
      source_version: request.source.immutable_revision,
      location: { path: binding.path, line: binding.line, pointer: binding.span },
      method: "deterministic_analysis", scope: { service_id: request.source.service_id, snapshot_id: result.snapshot_id,
        revision: request.source.immutable_revision, ...(endpointId ? { endpoint_id: endpointId } : {}) },
      limitations: ["startup entrypoint and controller handler binding unverified",
        "runner defaults are analyzer-policy assumptions; effective routing configuration unverified"], access_label: request.source.access_label,
    });
    return id;
  };
  const frameworkEvidence = (endpointId?: string, routing = false): string[] => {
    if (middleware?.kind !== "verified") return [];
    const lock = middleware.frameworkLock;
    const locations = routing ? lock?.kind === "locked" ? lock.routing_dependencies.evidence_locations : []
      : lock?.evidence_locations ?? [];
    return locations.map(location => {
      const id = `ev-${hash(`${location.path}:${location.pointer}:${endpointId ?? ""}:framework-lock`).slice(0, 24)}`;
      if (!result.evidence.some(item => item.evidence_id === id)) result.evidence.push({
        evidence_id: id, source: {kind: "configuration", source_id: request.source.repository_id},
        source_version: request.source.immutable_revision, location, method: "deterministic_analysis",
        scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
          revision: request.source.immutable_revision, ...(endpointId ? {endpoint_id: endpointId} : {})},
        limitations: ["lockfile declaration only; installed modules, runtime resolution and framework behavior unverified"],
        access_label: request.source.access_label,
      });
      return id;
    });
  };
  const startupEvidence = (endpointId?: string, environmentOnly = false): string[] => {
    if (middleware?.kind !== "verified") return [];
    const locations = environmentOnly
      ? (middleware.startup?.environment_inputs ?? []).map(input => input.location)
      : middleware.startup?.evidence_locations ?? [];
    return locations.map(location => {
      const id = `ev-${hash(`${location.path}:${location.pointer}:${endpointId ?? ""}:startup`).slice(0, 24)}`;
      if (!result.evidence.some(item => item.evidence_id === id)) result.evidence.push({
        evidence_id: id, source: {kind: "line" in location ? "source_code" : "configuration", source_id: request.source.repository_id},
        source_version: request.source.immutable_revision, location, method: "deterministic_analysis",
        scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
          revision: request.source.immutable_revision, ...(endpointId ? {endpoint_id: endpointId} : {})},
        limitations: ["syntactic startup/environment declaration only; reachability, effective values and production invocation unverified"],
        access_label: request.source.access_label,
      });
      return id;
    });
  };
  const configurationEvidence = (endpointId?: string): string[] => {
    if (middleware?.kind !== "verified") return [];
    return [...new Set((middleware.routingConfiguration?.evidence_locations ?? []).map(location => {
      const id = `ev-${hash(`${location.path}:${location.pointer}:${endpointId ?? ""}:routing-configuration`).slice(0, 24)}`;
      if (!result.evidence.some(item => item.evidence_id === id)) result.evidence.push({
        evidence_id: id, source: {kind: location.pointer.startsWith("span:") ? "source_code" : "configuration", source_id: request.source.repository_id},
        source_version: request.source.immutable_revision, location,
        method: "deterministic_analysis",
        scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
          revision: request.source.immutable_revision, ...(endpointId ? {endpoint_id: endpointId} : {})},
        limitations: ["static declaration only; environment overrides, framework version and startup unverified"],
        access_label: request.source.access_label,
      });
      return id;
    }))];
  };
  const diagnostic = (code: string, pointer: string, severity: "warning" | "error" = "warning",
    endpointId?: string, extraEvidence: string[] = []) => {
    const ev = evidence(pointer, endpointId);
    const id = `diag-${hash(`${code}:${pointer}:${endpointId ?? ""}`).slice(0, 24)}`;
    if (!result.diagnostics.some(item => item.diagnostic_id === id)) result.diagnostics.push({
      diagnostic_id: id, code, severity, message: code.replaceAll("_", " "),
      affected_endpoint_ids: endpointId ? [endpointId] : [], evidence_ids: [...new Set([ev, ...extraEvidence])],
    });
  };
  const claim = (endpoint: Endpoint, predicate: string, value: Claim["value"], pointer: string) => {
    const ev = evidence(pointer, endpoint.endpoint_id);
    result.claims.push({ claim_id: `claim-${hash(`${endpoint.endpoint_id}:${predicate}:${pointer}:${JSON.stringify(value)}`).slice(0, 24)}`,
      subject: { service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id }, predicate, value,
      verification: "declared", evidence_ids: [ev] });
  };
  if (middleware?.kind === "unverified") {
    diagnostic("middleware_registration_unverified", "", "error");
    return failed(result, documentPath);
  }
  let document: unknown;
  try { document = /\.ya?ml$/.test(documentPath) ? parseStrictYaml(text) : parseStrictJson(text); }
  catch (error) {
    diagnostic(error instanceof StrictJsonError || error instanceof StrictYamlError ? error.code : "invalid_document", "", "error");
    return failed(result, documentPath);
  }
  let parsed: ReturnType<typeof parseSwagger2Document>;
  try { parsed = parseSwagger2Document(document); }
  catch { diagnostic("document_structure_limit_exceeded", "", "error"); return failed(result, documentPath); }
  for (const item of parsed.diagnostics) {
    if (middleware?.kind === "verified" && item.code === "unsupported_construct" && item.pointer === "/basePath") continue;
    diagnostic(item.code, item.pointer, item.severity);
  }
  if (parsed.status === "failed") return failed(result, documentPath);

  const raw = document as Record<string, unknown>;
  let basePath = "";
  if (middleware?.kind === "verified" && raw.basePath !== undefined) {
    if (typeof raw.basePath !== "string" || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/.test(raw.basePath)
      || raw.basePath.split("/").some(segment => segment === "." || segment === "..")) {
      diagnostic("base_path_unresolved", "/basePath", "error");
      return failed(result, documentPath);
    }
    basePath = raw.basePath === "/" ? "" : raw.basePath.replace(/\/$/, "");
  }
  if (raw.basePath !== undefined) {
    if (!middleware) diagnostic("base_path_requires_middleware_profile", "/basePath");
    if (typeof raw.basePath === "string" && raw.basePath.startsWith("/")) {
      const ev = evidence("/basePath");
      result.claims.push({ claim_id: `claim-${hash(`basePath:${ev}:${raw.basePath}`).slice(0, 24)}`,
        subject: { service_id: request.source.service_id }, predicate: "exposure.base_path.declaration",
        value: raw.basePath, verification: "declared", evidence_ids: [ev] });
    } else diagnostic("base_path_invalid", "/basePath");
  }
  if (raw.host !== undefined || raw.schemes !== undefined) diagnostic("server_exposure_not_analyzed", "/host");
  if (!middleware) diagnostic("middleware_binding_unverified", "");
  else {
    diagnostic(middleware.runtimeBinding?.kind === "verified" && middleware.runtimeBinding.bindings.length
      ? "runtime_binding_scope_limited" : "handler_binding_unverified", "");
    if (middleware.runtimeBinding?.kind === "unresolved") diagnostic("runtime_binding_receipt_unverified", "");
    diagnostic("startup_entrypoint_unverified", "");
    const framework = middleware.frameworkLock;
    const frameworkIds = frameworkEvidence();
    if (framework?.kind === "locked") {
      const value = {wrapper: "swagger-express-mw", wrapper_version: framework.wrapper_version,
        runner: "swagger-node-runner", runner_version: framework.runner_version,
        conformance_target: framework.conformance_target, policy: "npm-lock-declaration-1"};
      result.claims.push({claim_id: `claim-${hash(`framework.lock:${JSON.stringify(value)}`).slice(0, 24)}`,
        subject: {service_id: request.source.service_id}, predicate: "framework.lock.declaration", value,
        verification: "declared", evidence_ids: frameworkIds});
      diagnostic(framework.conformance_target ? "framework_runtime_unverified" : "framework_version_unsupported",
        "", "warning", undefined, frameworkIds);
    } else diagnostic("framework_version_unverified", "", "warning", undefined, frameworkIds);
    if (framework?.kind === "locked") {
      const routing = framework.routing_dependencies;
      const ids = frameworkEvidence(undefined, true);
      if (routing.kind === "locked") {
        const value = {versions: routing.versions, conformance_target: framework.conformance_target && routing.conformance_target,
          policy: "npm-routing-dependencies-declaration-1"};
        result.claims.push({claim_id: `claim-${hash(`framework.routing:${JSON.stringify(value)}`).slice(0, 24)}`,
          subject: {service_id: request.source.service_id}, predicate: "framework.routing_dependencies.declaration", value,
          verification: "declared", evidence_ids: ids});
        diagnostic(value.conformance_target ? "framework_routing_dependencies_runtime_unverified" : "framework_routing_dependencies_unsupported",
          "", "warning", undefined, ids);
      } else diagnostic("framework_routing_dependencies_unverified", "", "warning", undefined, ids);
    }
    const startup = middleware.startup;
    const startupIds = startupEvidence();
    if (startup?.kind === "declared") {
      const value = {entrypoint: startup.entrypoint, node_version: startup.node_version, ...(startup.environment_name ? {environment_name: startup.environment_name} : {}), policy: "npm-start-declaration-1"};
      result.claims.push({claim_id: `claim-${hash(`startup.entrypoint:${JSON.stringify(value)}`).slice(0, 24)}`,
        subject: {service_id: request.source.service_id}, predicate: "startup.entrypoint.declaration", value,
        verification: "declared", evidence_ids: startupIds});
    }
    if (startup?.environment_inputs.length) {
      const value = startup.environment_inputs.map(input => ({variable: input.variable, operation: input.operation, location: input.location}));
      result.claims.push({claim_id: `claim-${hash(`startup.environment:${JSON.stringify(value)}`).slice(0, 24)}`,
        subject: {service_id: request.source.service_id}, predicate: "environment.access.declaration", value,
        verification: "declared", evidence_ids: startupEvidence(undefined, true)});
      diagnostic("startup_environment_unverified", "", "warning", undefined, startupEvidence(undefined, true));
    }
    const registration = middlewareEvidence();
    const configuration = middleware.routingConfiguration;
    const configEvidence = configurationEvidence();
    if (configuration?.kind === "supported") {
      const value = {origin: configuration.origin, policy: "static-routing-source-candidates-1",
        controller_dirs: configuration.controller_dirs,
        pipeline: configuration.pipeline, router_fitting: configuration.router_fitting};
      result.claims.push({claim_id: `claim-${hash(`routing.configuration:${JSON.stringify(value)}`).slice(0, 24)}`,
        subject: {service_id: request.source.service_id}, predicate: "routing.configuration.declaration",
        value, verification: configuration.origin === "configured" ? "declared" : "inferred",
        evidence_ids: configEvidence.length ? configEvidence : [registration]});
      diagnostic("routing_runtime_overrides_unverified", "", "warning", undefined, configEvidence);
    } else if (configuration?.kind === "unresolved") {
      diagnostic(configuration.code, "", "warning", undefined, configEvidence);
    }
  }

  // Swagger 2 basic and apiKey map exactly to the D03 security vocabulary.
  // OAuth 2 needs a richer IR definition; retaining an unknown operation is
  // safer than dropping its scopes or claiming that it is anonymous.
  const securityDefinitions = parsed.securityDefinitions;
  result.security_schemes = {};
  for (const [name, value] of Object.entries(securityDefinitions).sort(([a], [b]) => a.localeCompare(b))) {
    const pointer = `/securityDefinitions/${pointerPart(name)}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      diagnostic("security_scheme_unsupported", pointer);
      continue;
    }
    const definition = value as Record<string, unknown>;
    const allowed = definition.type === "basic" ? ["type", "description"]
      : definition.type === "apiKey" ? ["type", "name", "in", "description"] : [];
    if (allowed.length === 0 || Object.keys(definition).some(key => !allowed.includes(key))) {
      diagnostic("security_scheme_unsupported", pointer);
      continue;
    }
    if (definition.type === "basic") {
      result.security_schemes[name] = { definition: { type: "http", scheme: "basic" }, evidence_ids: [evidence(pointer)] };
    } else if (typeof definition.name === "string" && definition.name.length > 0
      && (definition.in === "header" || definition.in === "query")) {
      result.security_schemes[name] = { definition: { type: "apiKey", name: definition.name, in: definition.in },
        evidence_ids: [evidence(pointer)] };
    } else diagnostic("security_scheme_unsupported", pointer);
  }

  const referenceIds = new Map(Object.keys(parsed.definitions).sort().map(name => [name, `schema-${hash(name).slice(0, 24)}`]));
  const convertSchema = (value: unknown, pointer: string, depth = 0): ApiSchema => {
    if (depth > 32 || !value || typeof value !== "object" || Array.isArray(value)) {
      diagnostic("schema_unsupported", pointer); return {};
    }
    const input = value as Record<string, unknown>;
    if (typeof input.$ref === "string") {
      const token = input.$ref.startsWith("#/definitions/") ? input.$ref.slice("#/definitions/".length) : undefined;
      // This profile supports one JSON Pointer token, not nested paths or URI-fragment decoding.
      const name = token !== undefined && /^[A-Za-z0-9._~!$&'()*+,;=:@?-]+$/.test(token) && !/~(?:[^01]|$)/.test(token)
        ? token.replaceAll("~1", "/").replaceAll("~0", "~") : undefined;
      const id = name && referenceIds.get(name);
      if (!id) { diagnostic("schema_ref_unsupported", `${pointer}/$ref`); return {}; }
      return { $ref: `#/schemas/${id}` };
    }
    const output: ApiSchema = {...declaredSchemaBounds(input, pointer, diagnostic),
      ...declaredSchemaConstraints(input, pointer, diagnostic)};
    if (typeof input.type === "string" && ["string", "integer", "number", "boolean", "object", "array", "null"].includes(input.type))
      output.type = input.type as NonNullable<ApiSchema["type"]>;
    else if (input.type !== undefined) diagnostic("schema_type_unsupported", `${pointer}/type`);
    if (typeof input.format === "string" && input.format.length) output.format = input.format;
    else if (input.format !== undefined) diagnostic("schema_format_unsupported", `${pointer}/format`);
    if (typeof input.title === "string") output.title = input.title;
    if (typeof input.description === "string") output.description = input.description;
    if (input.required !== undefined) {
      if (Array.isArray(input.required) && input.required.every(item => typeof item === "string" && item.length > 0)
        && new Set(input.required).size === input.required.length) output.required = input.required as string[];
      else diagnostic("schema_required_unsupported", `${pointer}/required`);
    }
    if (input.properties && typeof input.properties === "object" && !Array.isArray(input.properties))
      output.properties = Object.fromEntries(Object.entries(input.properties).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => [name, convertSchema(child, `${pointer}/properties/${pointerPart(name)}`, depth + 1)]));
    if (input.items !== undefined) output.items = convertSchema(input.items, `${pointer}/items`, depth + 1);
    if (input.allOf !== undefined) {
      if (Array.isArray(input.allOf) && input.allOf.length > 0 && input.allOf.length <= 32
        && input.allOf.every(item => item !== null && typeof item === "object" && !Array.isArray(item)))
        output.allOf = input.allOf.map((item, index) => convertSchema(item, `${pointer}/allOf/${index}`, depth + 1));
      else diagnostic("schema_all_of_unsupported", `${pointer}/allOf`);
    }
    if (input.additionalProperties !== undefined) {
      if (typeof input.additionalProperties === "boolean") output.additionalProperties = input.additionalProperties;
      else if (input.additionalProperties !== null && typeof input.additionalProperties === "object" && !Array.isArray(input.additionalProperties))
        output.additionalProperties = convertSchema(input.additionalProperties, `${pointer}/additionalProperties`, depth + 1);
      else diagnostic("schema_additional_properties_unsupported", `${pointer}/additionalProperties`);
    }
    for (const key of Object.keys(input)) if (!["type", "format", "description", "required", "enum", "pattern", "properties", "items", "title", "allOf", "additionalProperties", ...schemaBoundFields].includes(key))
      diagnostic("schema_keyword_unsupported", `${pointer}/${pointerPart(key)}`);
    return output;
  };
  for (const [name, schema] of Object.entries(parsed.definitions).sort(([a], [b]) => a.localeCompare(b))) {
    const id = referenceIds.get(name)!;
    const pointer = `/definitions/${pointerPart(name)}`;
    result.schemas[id] = { schema_id: id, schema: convertSchema(schema, pointer), evidence_ids: [evidence(pointer)] };
  }
  const definitionNames = new Map([...referenceIds].map(([name, id]) => [id, name]));
  for (const operation of parsed.operations) addOperation(operation);
  if (parsed.status === "partial" || result.diagnostics.length) {
    result.status = "partial";
    result.coverage = { status: "incomplete", analyzed_roots: [documentPath], unresolved_roots: [documentPath],
      reason: "Selected document contains unsupported or unverified facts", diagnostic_ids: result.diagnostics.map(item => item.diagnostic_id) };
  }
  return result;

  function addOperation(operation: Swagger2Operation) {
    let identity: Endpoint["identity"];
    const applicationPath = middleware?.kind === "verified"
      ? `${basePath}${operation.path}` : operation.path;
    try { identity = deriveEndpointIdentity({ identity_version: "1.0.0", service_id: request.source.service_id,
      method: operation.method, application_path: applicationPath }); }
    catch { diagnostic("route_path_unsupported", operation.pointer); return; }
    const endpointId = `endpoint-${hash(identity.route_key).slice(0, 24)}`;
    if (result.endpoints.some(item => item.endpoint_id === endpointId)) {
      diagnostic("conflicting_route_declarations", operation.pointer);
      return;
    }
    const ev = evidence(operation.pointer, endpointId);
    const bindingEv = middleware?.kind === "verified" ? middlewareEvidence(endpointId) : undefined;
    const endpoint: Endpoint = {
      endpoint_id: endpointId, identity, application_path: applicationPath, parameters: [], request_bodies: [],
      responses: [], security: { state: "unknown", alternatives: [] },
      evidence_ids: [ev, ...(bindingEv ? [bindingEv] : []),
        ...(bindingEv && raw.basePath !== undefined ? [evidence("/basePath", endpointId)] : [])],
    };
    claim(endpoint, "route.declaration", { method: identity.method, path: operation.path,
      ...(operation.operationId ? { operationId: operation.operationId } : {}) }, operation.pointer);
    if (bindingEv) result.claims.push({
      claim_id: `claim-${hash(`${endpointId}:route.binding:${bindingEv}:${applicationPath}`).slice(0, 24)}`,
      subject: { service_id: request.source.service_id, endpoint_id: endpointId }, predicate: "route.binding",
      value: { path: applicationPath, middleware: "swagger-express-mw" }, verification: "inferred",
      evidence_ids: [ev, bindingEv, ...(raw.basePath === undefined ? [] : [evidence("/basePath", endpointId)])],
    });
    if (bindingEv) result.dependencies.push({ from_endpoint_id: endpointId,
      to: { kind: "evidence", id: bindingEv }, evidence_ids: [bindingEv] });
    if (middleware?.kind === "verified" && !addRuntimeBinding(endpoint, operation) && middleware.handlerResolver) addHandlerCandidate(endpoint, operation);
    for (const parameter of operation.parameters) {
      if (!["path", "query", "header"].includes(parameter.in)) { diagnostic("parameter_location_unsupported", parameter.pointer, "warning", endpointId); continue; }
      const paramEv = evidence(parameter.pointer, endpointId);
      const presence = declaredPresence(parameter);
      if (presence === "unknown") diagnostic("parameter_presence_unresolved", `${parameter.pointer}/required`, "warning", endpointId);
      const parameterSchema = parameter.schema ?? Object.fromEntries(["type", "format", "description", "items", "enum", "pattern", ...schemaBoundFields]
        .filter(key => parameter[key] !== undefined).map(key => [key, parameter[key]]));
      for (const key of Object.keys(parameter)) if (!["name", "in", "pointer", "required", "schema", "type", "format", "description", "items", "enum", "pattern", "collectionFormat", "allowEmptyValue", ...schemaBoundFields].includes(key))
        diagnostic("parameter_keyword_unsupported", `${parameter.pointer}/${pointerPart(key)}`, "warning", endpointId);
      const serialization = parameterSerialization(parameter);
      if (!serialization) diagnostic("parameter_serialization_unresolved", parameter.pointer, "warning", endpointId);
      else claim(endpoint, "parameter.serialization", serialization, parameter.pointer);
      endpoint.parameters.push({ name: parameter.name, in: parameter.in as "path" | "query" | "header",
        presence: { state: presence, evidence_ids: [paramEv] },
        schema: convertSchema(parameterSchema, parameter.pointer), serialization: serialization ?? {format: "swagger2-unresolved"} });
      claim(endpoint, "parameter.presence", presence, parameter.pointer);
    }
    addFormBodies(endpoint, operation);
    if (operation.requestBodyConflict) diagnostic("request_body_declarations_conflict", `${operation.pointer}/parameters`, "warning", endpointId);
    if (operation.requestBodyUnresolved) diagnostic("request_body_declarations_unresolved", `${operation.pointer}/parameters`, "warning", endpointId);
    for (const body of operation.requestBodyConflict || operation.requestBodyUnresolved
      ? [] : operation.requestBodies.filter(item => item.in === "body")) {
      if (body.in !== "body" || body.media.state !== "known" || body.media.values.length === 0) {
        diagnostic("request_body_media_or_form_unresolved", body.pointer, "warning", endpointId); continue;
      }
      const bodyEv = evidence(body.pointer, endpointId);
      if (declaredPresence(body) === "unknown")
        diagnostic("request_body_presence_unresolved", `${body.pointer}/required`, "warning", endpointId);
      for (const mediaType of body.media.values) endpoint.request_bodies.push({ media_type: mediaType,
        schema: convertSchema(body.schema, `${body.pointer}/schema`), serialization: { format: mediaType },
        presence: { state: declaredPresence(body), evidence_ids: [bodyEv] } });
    }
    for (const response of operation.responses) {
      const declarationPointer = response.declarationPointer ?? response.pointer;
      const responseIds = [...new Set([response.pointer, ...(response.referencePointers ?? [])])]
        .map(pointer => evidence(pointer, endpointId));
      for (const id of responseIds) {
        if (!endpoint.evidence_ids.includes(id)) endpoint.evidence_ids.push(id);
        if (!result.dependencies.some(item => item.from_endpoint_id === endpointId && item.to.kind === "evidence" && item.to.id === id))
          result.dependencies.push({from_endpoint_id:endpointId,to:{kind:"evidence",id},evidence_ids:responseIds});
      }
      const headers: NonNullable<Endpoint["responses"][number]["headers"]> = [];
      const rawHeaderEntries = Object.entries(response.headers ?? {});
      if (rawHeaderEntries.length > 128) diagnostic("response_header_limit_exceeded", `${declarationPointer}/headers`, "warning", endpointId);
      const headerEntries = rawHeaderEntries.length > 128 ? [] : rawHeaderEntries.sort(([a],[b]) => a.localeCompare(b));
      const counts = new Map<string,number>();
      for (const [name] of headerEntries) counts.set(name.toLowerCase(),(counts.get(name.toLowerCase()) ?? 0)+1);
      const duplicated = new Set([...counts].filter(([,count]) => count > 1).map(([name]) => name));
      for (const [name, header] of headerEntries) {
        const pointer = `${declarationPointer}/headers/${pointerPart(name)}`;
        if (!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || duplicated.has(name.toLowerCase()) || name.toLowerCase() === "content-type") {
          diagnostic("response_header_name_unsupported", pointer, "warning", endpointId); continue;
        }
        if (!header || typeof header !== "object" || Array.isArray(header)
          || !["string","integer","number","boolean"].includes(String((header as Record<string,unknown>).type))
          || Object.keys(header).some(key => !["type","format","description","enum","pattern",...schemaBoundFields].includes(key))) {
          diagnostic("response_header_schema_unsupported", pointer, "warning", endpointId); continue;
        }
        const schema = convertSchema(header, pointer);
        headers.push({name,schema});
        claim(endpoint,"response.header.schema",{name,schema,status:response.selector},pointer);
        const id = evidence(pointer,endpointId);
        if (!endpoint.evidence_ids.includes(id)) endpoint.evidence_ids.push(id);
        if (!result.dependencies.some(item => item.from_endpoint_id === endpointId && item.to.kind === "evidence" && item.to.id === id))
          result.dependencies.push({from_endpoint_id:endpointId,to:{kind:"evidence",id},evidence_ids:[...new Set([id,...responseIds])]});
      }
      const content = response.schema !== undefined && response.media.state === "known"
        ? response.media.values.map(mediaType => ({ media_type: mediaType,
          schema: convertSchema(response.schema, `${declarationPointer}/schema`), serialization: { format: mediaType } })) : [];
      if (response.schema !== undefined && response.media.state === "unknown")
        diagnostic("response_media_unknown", response.pointer, "warning", endpointId);
      endpoint.responses.push({ status: response.selector, content, ...(headers.length ? {headers} : {}) });
      if (response.description !== undefined) claim(endpoint,"response.description",{status:response.selector,description:response.description},`${declarationPointer}/description`);
      claim(endpoint, "response.status", response.selector, response.pointer);
    }
    if (!endpoint.responses.length) endpoint.responses.push({ status: { kind: "unknown", reason: "document response unresolved" }, content: [] });
    const securityPointer = (raw.paths as Record<string, Record<string, Record<string, unknown>>>)[operation.path]?.[operation.method]?.security !== undefined
      ? `${operation.pointer}/security` : "/security";
    if (operation.security.state === "anonymous") {
      const secEv = evidence(securityPointer, endpointId);
      endpoint.security = { state: "anonymous", alternatives: [], evidence_ids: [secEv] };
    } else if (operation.security.state === "declared") {
      const alternatives = operation.security.alternatives.map(alternative => Object.entries(alternative)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([scheme, scopes]) => ({ scheme, scopes })));
      const representable = alternatives.every(requirements => requirements.length > 0 && requirements.every(requirement =>
        result.security_schemes?.[requirement.scheme] !== undefined && requirement.scopes.length === 0));
      if (representable) {
        endpoint.security = { state: "declared", alternatives: alternatives.map(requirements => ({ requirements })),
          evidence_ids: [evidence(securityPointer, endpointId)] };
      } else diagnostic("security_mapping_unresolved", securityPointer, "warning", endpointId);
      claim(endpoint, "security.declaration", operation.security.alternatives, securityPointer);
    }
    const seenSchemas = new Set<string>();
    const addSchemaDependencies = (schema: ApiSchema) => {
      if (schema.$ref?.startsWith("#/schemas/")) {
        const id = schema.$ref.slice("#/schemas/".length);
        if (seenSchemas.has(id)) return;
        seenSchemas.add(id);
        const name = definitionNames.get(id);
        if (name) {
          const ev = evidence(`/definitions/${pointerPart(name)}`);
          result.dependencies.push({ from_endpoint_id: endpointId, to: { kind: "schema", id }, evidence_ids: [ev] });
          addSchemaDependencies(result.schemas[id]!.schema);
        }
      }
      for (const child of Object.values(schema.properties ?? {})) addSchemaDependencies(child);
      if (schema.items) addSchemaDependencies(schema.items);
      for (const branch of schema.allOf ?? []) addSchemaDependencies(branch);
      if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        addSchemaDependencies(schema.additionalProperties);
    };
    for (const parameter of endpoint.parameters) addSchemaDependencies(parameter.schema);
    for (const body of endpoint.request_bodies) addSchemaDependencies(body.schema);
    for (const response of endpoint.responses) for (const content of response.content) addSchemaDependencies(content.schema);
    result.endpoints.push(endpoint);
  }

  function addFormBodies(endpoint: Endpoint, operation: Swagger2Operation): void {
    const forms = operation.requestBodies.filter(item => item.in === "formData");
    if (!forms.length) return;
    for (const field of forms) {
      claim(endpoint, "request.form.field.declaration", {name: field.name,
        ...(typeof field.type === "string" ? {type: field.type} : {}),
        ...(typeof field.collectionFormat === "string" ? {collectionFormat: field.collectionFormat} : {})}, field.pointer);
    }
    if (operation.requestBodyConflict || operation.requestBodyUnresolved) return;
    const pathItem = (raw.paths as Record<string, Record<string, unknown>>)[operation.path]!;
    const rawOperation = pathItem[operation.method] as Record<string, unknown>;
    const consumesPointer = rawOperation.consumes !== undefined ? `${operation.pointer}/consumes` : "/consumes";
    if (operation.consumes.state !== "known" || !operation.consumes.values.length) {
      diagnostic("form_media_unresolved", consumesPointer, "warning", endpoint.endpoint_id);
      return;
    }
    const unresolved = forms.filter(field => !supportedFormField(field));
    for (const field of unresolved) diagnostic("form_field_unresolved", field.pointer, "warning", endpoint.endpoint_id);
    if (unresolved.length) return;
    for (const field of forms) claim(endpoint, "request.form.field.presence",
      {name: field.name, state: declaredPresence(field)}, field.pointer);
    const mediaEv = evidence(consumesPointer, endpoint.endpoint_id);
    const fieldEvidence = forms.map(field => evidence(field.pointer, endpoint.endpoint_id));
    const properties = Object.fromEntries([...forms].sort((a, b) => a.name.localeCompare(b.name)).map(field =>
      [field.name, field.type === "file"
        ? {type: "string", format: "binary", ...(typeof field.description === "string" ? {description: field.description} : {})} as ApiSchema
        : convertSchema(Object.fromEntries(["type", "format", "description", "enum", "items"].filter(key => field[key] !== undefined)
          .map(key => [key, field[key]])), field.pointer)]));
    const required = forms.filter(field => field.required === true).map(field => field.name).sort();
    for (const mediaType of operation.consumes.values) {
      if (!["application/x-www-form-urlencoded", "multipart/form-data"].includes(mediaType)) {
        diagnostic("form_media_unresolved", consumesPointer, "warning", endpoint.endpoint_id);
        continue;
      }
      if (mediaType !== "multipart/form-data" && forms.some(field => field.type === "file")) {
        diagnostic("form_file_media_unresolved", consumesPointer, "warning", endpoint.endpoint_id);
        continue;
      }
      const encoding = Object.fromEntries(forms.map(field => [field.name, {...formFieldEncoding(field),
        evidence_ids: [evidence(field.pointer, endpoint.endpoint_id), mediaEv]}]));
      for (const field of forms) claim(endpoint, "request.form.field.encoding",
        {name: field.name, media_type: mediaType, ...formFieldEncoding(field)}, field.pointer);
      endpoint.request_bodies.push({media_type: mediaType, encoding,
        schema: {type: "object", properties, ...(required.length ? {required} : {})},
        serialization: {format: mediaType === "multipart/form-data" ? "multipart" : "urlencoded"},
        presence: {state: required.length ? "required" : "optional", evidence_ids: [mediaEv, ...fieldEvidence]}});
      claim(endpoint, "request.form.declaration", {media_type: mediaType, fields: forms.map(field => field.name)}, consumesPointer);
    }
  }

  function addRuntimeBinding(endpoint: Endpoint, operation: Swagger2Operation): boolean {
    if (middleware?.kind !== "verified" || middleware.runtimeBinding?.kind !== "verified") return false;
    const receipt = middleware.runtimeBinding;
    const binding = receipt.bindings.find(item => item.method === endpoint.identity.method && item.application_path === endpoint.application_path);
    if (!binding) return false;
    const pathItem = (raw.paths as Record<string, Record<string, unknown>>)[operation.path]!;
    const rawOperation = pathItem[operation.method] as Record<string, unknown>;
    const controller = rawOperation["x-swagger-router-controller"] ?? pathItem["x-swagger-router-controller"];
    if (binding.operation_id !== operation.operationId || binding.controller !== controller) {
      diagnostic("runtime_binding_document_mismatch", operation.pointer, "warning", endpoint.endpoint_id);
      return false;
    }
    const evId = `ev-${hash(`${receipt.receipt_digest}:${receipt.signer_digest}:${endpoint.endpoint_id}:runtime-binding`).slice(0, 24)}`;
    const handlerId = `ev-${hash(`${binding.handler_path}:${binding.handler_digest}:${endpoint.endpoint_id}:bound-handler`).slice(0, 24)}`;
    for (const [id, location, kind, method] of [
      [evId, {path: receipt.path, pointer: "/payload", symbol: `decoded.bindings[${receipt.bindings.indexOf(binding)}]`}, "runtime_capture", "observation"],
      [handlerId, {path: binding.handler_path, symbol: binding.export_name}, "source_code", "deterministic_analysis"],
    ] as const) result.evidence.push({evidence_id: id, source: {kind, source_id: request.source.repository_id},
      source_version: request.source.immutable_revision, location, method,
      scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
        revision: request.source.immutable_revision, endpoint_id: endpoint.endpoint_id},
      limitations: ["binding observed only for the signed runtime session and environment; future dispatch and deployment availability unverified",
        "trusted signer attests the source snapshot; handler bytes matched to captured compilation"], access_label: request.source.access_label});
    const ids = [evId, handlerId, evidence(operation.pointer, endpoint.endpoint_id), middlewareEvidence(endpoint.endpoint_id)];
    endpoint.evidence_ids.push(...ids.filter(id => !endpoint.evidence_ids.includes(id)));
    result.claims.push({claim_id: `claim-${hash(`${endpoint.endpoint_id}:handler.binding:${evId}`).slice(0, 24)}`,
      subject: {service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id}, predicate: "handler.binding",
      verification: "observed", evidence_ids: ids, value: {path: binding.handler_path, export_name: binding.export_name,
        controller: binding.controller, operationId: binding.operation_id, environment: receipt.environment,
        session_id: receipt.session_id, captured_at: receipt.captured_at, runtime_fingerprint: receipt.runtime_fingerprint,
        signer_digest: receipt.signer_digest, policy: "signed-runtime-binding-1"}});
    result.dependencies.push({from_endpoint_id: endpoint.endpoint_id, to: {kind: "evidence", id: handlerId}, evidence_ids: [evId, handlerId]});
    result.dependencies.push({from_endpoint_id: endpoint.endpoint_id, to: {kind: "evidence", id: evId}, evidence_ids: [evId]});
    addHandlerResponseStatus(endpoint, operation, binding, ids);
    return true;
  }

  function addHandlerResponseStatus(endpoint: Endpoint, operation: Swagger2Operation, binding: RuntimeBinding, bindingIds: string[]): void {
    if (middleware?.kind !== "verified" || !middleware.responseStatusResolver) return;
    const declaration = middleware.responseStatusResolver(binding);
    if (declaration.kind !== "declared") {
      diagnostic("handler_response_status_unresolved", operation.pointer, "warning", endpoint.endpoint_id);
      return;
    }
    const sourceId = `ev-${hash(`${binding.handler_path}:${declaration.span}:${endpoint.endpoint_id}:response-status`).slice(0, 24)}`;
    result.evidence.push({evidence_id: sourceId, source: {kind: "source_code", source_id: request.source.repository_id},
      source_version: request.source.immutable_revision, location: {path: binding.handler_path, line: declaration.line, symbol: declaration.span},
      method: "deterministic_analysis", scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
        revision: request.source.immutable_revision, endpoint_id: endpoint.endpoint_id}, access_label: request.source.access_label,
      limitations: ["literal handler status declaration only; actual response behavior and Express method integrity unverified"]});
    const evidenceIds = [...bindingIds, sourceId];
    endpoint.evidence_ids.push(sourceId);
    result.claims.push({claim_id: `claim-${hash(`${endpoint.endpoint_id}:handler.response.status.declaration:${sourceId}`).slice(0, 24)}`,
      subject: {service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id},
      predicate: "handler.response.status.declaration", verification: "inferred", evidence_ids: evidenceIds,
      value: {code: declaration.code, path: binding.handler_path, export_name: binding.export_name, policy: "literal-response-status-1"}});
    result.dependencies.push({from_endpoint_id: endpoint.endpoint_id, to: {kind: "evidence", id: sourceId}, evidence_ids: evidenceIds});
    const pathItem = (raw.paths as Record<string, Record<string, unknown>>)[operation.path]!;
    const operationDefinition = pathItem[operation.method] as Record<string, unknown>;
    const responses = operationDefinition.responses as Record<string, unknown> | undefined;
    if (declaration.body) {
      const body = declaration.body;
      const bodyId = `ev-${hash(`${binding.handler_path}:${body.span}:${endpoint.endpoint_id}:response-body`).slice(0, 24)}`;
      result.evidence.push({evidence_id: bodyId, source: {kind: "source_code", source_id: request.source.repository_id},
        source_version: request.source.immutable_revision, location: {path: binding.handler_path, line: body.line, symbol: body.span},
        method: "deterministic_analysis", scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
          revision: request.source.immutable_revision, endpoint_id: endpoint.endpoint_id}, access_label: request.source.access_label,
        limitations: ["literal JSON argument shape only; values omitted, requiredness and runtime serialization unverified"]});
      const bodyIds = [...evidenceIds, bodyId];
      endpoint.evidence_ids.push(bodyId);
      result.claims.push({claim_id: `claim-${hash(`${endpoint.endpoint_id}:handler.response.body.declaration:${bodyId}`).slice(0, 24)}`,
        subject: {service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id},
        predicate: "handler.response.body.declaration", verification: "inferred", evidence_ids: bodyIds,
        value: {status_code: declaration.code, schema: body.schema, path: binding.handler_path,
          export_name: binding.export_name, policy: "literal-json-body-1"}});
      result.dependencies.push({from_endpoint_id: endpoint.endpoint_id, to: {kind: "evidence", id: bodyId}, evidence_ids: bodyIds});
      const selectedKey = responses && Object.hasOwn(responses, String(declaration.code)) ? String(declaration.code) : "default";
      const selectedResponse = responses?.[selectedKey];
      const responseResolution = resolveResponseObject(selectedResponse, raw.responses);
      const selectedSchema = responseResolution.kind === "resolved" ? responseResolution.response.schema : undefined;
      const resolvedSchema = resolveResponseSchema(selectedSchema, raw.definitions);
      const comparisonSchema = resolvedSchema.kind === "resolved" ? resolvedSchema.schema : undefined;
      const referencePointers = [...new Set([
        ...(responseResolution.kind === "resolved" ? responseResolution.pointers : []),
        ...(resolvedSchema.kind === "resolved" ? resolvedSchema.pointers : [])])];
      const referenceIds = referencePointers.map(pointer => evidence(pointer, endpoint.endpoint_id));
      if (responseResolution.kind === "resolved" && responseResolution.pointers.length)
        referenceIds.push(evidence(`${operation.pointer}/responses/${selectedKey}`, endpoint.endpoint_id));
      for (const id of referenceIds) {
        if (!endpoint.evidence_ids.includes(id)) endpoint.evidence_ids.push(id);
        result.dependencies.push({from_endpoint_id: endpoint.endpoint_id, to: {kind:"evidence", id}, evidence_ids:[bodyId,id]});
      }
      const comparison = compareResponseBodyTypes(body.schema, comparisonSchema);
      const documentPointer = responseResolution.kind === "resolved" && responseResolution.terminalPointer
        ? `${responseResolution.terminalPointer}${selectedSchema !== undefined ? "/schema" : ""}`
        : responses && Object.hasOwn(responses, selectedKey)
          ? `${operation.pointer}/responses/${selectedKey}${selectedSchema !== undefined ? "/schema" : ""}` : `${operation.pointer}/responses`;
      const schemaEvidence = evidence(documentPointer, endpoint.endpoint_id);
      if (comparison.kind === "compared" && comparison.mismatches.length) result.claims.push({
        claim_id: `claim-${hash(`${endpoint.endpoint_id}:body-type-discrepancy:${bodyId}`).slice(0, 24)}`,
        subject: {service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id},
        predicate: "handler.response.body.type.discrepancy", verification: "inferred", evidence_ids: [...new Set([...bodyIds, schemaEvidence, ...referenceIds])],
        value: {paths: comparison.mismatches, policy: "literal-json-body-types-4"}});
      if (comparison.kind === "compared") {
        const presence = compareResponseBodyPresence(body.schema, comparisonSchema);
        if (presence.kind === "compared" && presence.missing.length) result.claims.push({
          claim_id: `claim-${hash(`${endpoint.endpoint_id}:body-required-discrepancy:${bodyId}`).slice(0, 24)}`,
          subject: {service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id},
          predicate: "handler.response.body.required.discrepancy", verification: "inferred", evidence_ids: [...new Set([...bodyIds, schemaEvidence, ...referenceIds])],
          value: {paths: presence.missing, policy: "literal-json-body-required-4"}});
        if (presence.kind === "unresolved" || presence.missing.length) result.diagnostics.push({
          diagnostic_id: `diag-${hash(`${endpoint.endpoint_id}:body-required:${bodyId}:${presence.kind}`).slice(0, 24)}`,
          code: presence.kind === "unresolved" ? "handler_response_body_presence_unresolved" : "handler_response_body_required_discrepancy",
          severity: "warning", affected_endpoint_ids: [endpoint.endpoint_id], evidence_ids: [...new Set([...bodyIds, schemaEvidence, ...referenceIds])],
          message: presence.kind === "unresolved" ? "Documented required fields could not be compared under the bounded literal-body policy."
            : "The literal JSON argument omits documented required fields; runtime serialization remains unverified."});
      }
      if (comparison.kind === "unresolved" || comparison.mismatches.length) result.diagnostics.push({
        diagnostic_id: `diag-${hash(`${endpoint.endpoint_id}:response-body:${bodyId}:${comparison.kind}`).slice(0, 24)}`,
        code: comparison.kind === "unresolved" ? "handler_response_body_comparison_unresolved" : "handler_response_body_type_discrepancy",
        severity: "warning", affected_endpoint_ids: [endpoint.endpoint_id], evidence_ids: [...new Set([...bodyIds, schemaEvidence, ...referenceIds])],
        message: comparison.kind === "unresolved" ? "Literal JSON source shape could not be compared under the bounded schema policy."
          : "Literal JSON source types differ from explicit documented response types; runtime serialization remains unverified."});
    }
    if (responses && !Object.hasOwn(responses, String(declaration.code)) && !Object.hasOwn(responses, "default")) {
      const documentEvidence = evidence(`${operation.pointer}/responses`, endpoint.endpoint_id);
      const diagnosticId = `diag-${hash(`${endpoint.endpoint_id}:handler_response_status_discrepancy:${sourceId}`).slice(0, 24)}`;
      result.diagnostics.push({diagnostic_id: diagnosticId, code: "handler_response_status_discrepancy", severity: "warning",
        message: "The bound handler declares a literal status absent from documented responses; runtime response behavior remains unverified.",
        affected_endpoint_ids: [endpoint.endpoint_id], evidence_ids: [...evidenceIds, documentEvidence]});
    }
  }

  function addHandlerCandidate(endpoint: Endpoint, operation: Swagger2Operation): void {
    if (middleware?.kind !== "verified" || !middleware.handlerResolver) return;
    const pathItem = (raw.paths as Record<string, Record<string, unknown>>)[operation.path]!;
    const rawOperation = pathItem[operation.method] as Record<string, unknown>;
    const mappingAt = rawOperation["x-swagger-router-controller"] !== undefined
      ? `${operation.pointer}/x-swagger-router-controller`
      : `/paths/${pointerPart(operation.path)}/x-swagger-router-controller`;
    const controller = rawOperation["x-swagger-router-controller"] !== undefined
      ? rawOperation["x-swagger-router-controller"] : pathItem["x-swagger-router-controller"];
    if (typeof controller !== "string" || !controller.length) {
      diagnostic("handler_controller_unresolved", mappingAt, "warning", endpoint.endpoint_id);
      return;
    }
    claim(endpoint, "handler.controller.declaration", controller, mappingAt);
    if (rawOperation["x-swagger-pipe"] !== undefined || pathItem["x-swagger-pipe"] !== undefined) {
      diagnostic("handler_pipe_unverified", rawOperation["x-swagger-pipe"] !== undefined
        ? `${operation.pointer}/x-swagger-pipe` : `/paths/${pointerPart(operation.path)}/x-swagger-pipe`,
      "warning", endpoint.endpoint_id);
      return;
    }
    const interfaceDeclarations = [
      {value: rawOperation["x-controller-interface"], pointer: `${operation.pointer}/x-controller-interface`},
      {value: pathItem["x-controller-interface"], pointer: `/paths/${pointerPart(operation.path)}/x-controller-interface`},
      {value: raw["x-controller-interface"], pointer: "/x-controller-interface"},
    ];
    const selectedInterface = interfaceDeclarations.find(item => item.value !== undefined);
    if (selectedInterface && selectedInterface.value !== "middleware") {
      diagnostic("handler_interface_unverified", selectedInterface.pointer, "warning", endpoint.endpoint_id);
      return;
    }
    if (!operation.operationId) {
      diagnostic("handler_operation_id_unresolved", `${operation.pointer}/operationId`, "warning", endpoint.endpoint_id);
      return;
    }
    if (middleware.startup?.environment_inputs.length) {
      const ids = startupEvidence(endpoint.endpoint_id, true);
      endpoint.evidence_ids.push(...ids);
      diagnostic("handler_environment_unverified", mappingAt, "warning", endpoint.endpoint_id, ids);
      return;
    }
    const candidate = middleware.handlerResolver(controller, operation.operationId);
    if (candidate.kind === "unresolved") {
      diagnostic(candidate.code, mappingAt, "warning", endpoint.endpoint_id, configurationEvidence(endpoint.endpoint_id));
      return;
    }
    const id = `ev-${hash(`${candidate.path}:${candidate.span}:${endpoint.endpoint_id}:handler-candidate`).slice(0, 24)}`;
    result.evidence.push({ evidence_id: id,
      source: { kind: "source_code", source_id: request.source.repository_id }, source_version: request.source.immutable_revision,
      location: { path: candidate.path, line: candidate.line, pointer: candidate.span }, method: "deterministic_analysis",
      scope: { service_id: request.source.service_id, snapshot_id: result.snapshot_id,
        revision: request.source.immutable_revision, endpoint_id: endpoint.endpoint_id },
      limitations: ["candidate only; runtime routing configuration and module initialization unverified",
        "framework version and production startup unverified; no handler-derived contract facts"],
      access_label: request.source.access_label });
    endpoint.evidence_ids.push(id);
    let scopeId: string | undefined;
    if (candidate.package_scope) {
      scopeId = `ev-${hash(`${candidate.package_scope}:${endpoint.endpoint_id}:handler-module-scope`).slice(0, 24)}`;
      result.evidence.push({ evidence_id: scopeId,
        source: {kind: "configuration", source_id: request.source.repository_id}, source_version: request.source.immutable_revision,
        location: {path: candidate.package_scope, pointer: "/"}, method: "deterministic_analysis",
        scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
          revision: request.source.immutable_revision, endpoint_id: endpoint.endpoint_id},
        limitations: ["contained package scope only; runtime flags and module initialization unverified"],
        access_label: request.source.access_label });
      endpoint.evidence_ids.push(scopeId);
    }
    const initializationIds: string[] = [];
    for (const source of candidate.initialization_sources ?? []) {
      for (const location of [{path: source.path, kind: "source_code" as const},
        ...(source.package_scope ? [{path: source.package_scope, kind: "configuration" as const}] : [])]) {
        const dependencyId = `ev-${hash(`${location.path}:${endpoint.endpoint_id}:handler-initialization-source`).slice(0, 24)}`;
        if (!result.evidence.some(item => item.evidence_id === dependencyId)) result.evidence.push({evidence_id: dependencyId,
          source: {kind: location.kind, source_id: request.source.repository_id}, source_version: request.source.immutable_revision,
          location: {path: location.path, pointer: "/"}, method: "deterministic_analysis",
          scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
            revision: request.source.immutable_revision, endpoint_id: endpoint.endpoint_id},
          limitations: ["bounded local initialization syntax only; module execution and runtime binding unverified"],
          access_label: request.source.access_label});
        if (!initializationIds.includes(dependencyId)) initializationIds.push(dependencyId);
      }
    }
    endpoint.evidence_ids.push(...initializationIds);
    const configEvidence = configurationEvidence(endpoint.endpoint_id);
    endpoint.evidence_ids.push(...configEvidence);
    const frameworkIds = frameworkEvidence(endpoint.endpoint_id);
    endpoint.evidence_ids.push(...frameworkIds);
    const startupIds = startupEvidence(endpoint.endpoint_id);
    endpoint.evidence_ids.push(...startupIds);
    const routingIds = frameworkEvidence(endpoint.endpoint_id, true);
    endpoint.evidence_ids.push(...routingIds);
    const evidenceIds = [...initializationIds, ...routingIds, ...startupIds, ...frameworkIds, ...configEvidence, evidence(mappingAt, endpoint.endpoint_id),
      evidence(`${operation.pointer}/operationId`, endpoint.endpoint_id), id, ...(scopeId ? [scopeId] : [])];
    result.claims.push({ claim_id: `claim-${hash(`${endpoint.endpoint_id}:handler.candidate:${id}`).slice(0, 24)}`,
      subject: { service_id: request.source.service_id, endpoint_id: endpoint.endpoint_id }, predicate: "handler.candidate",
      value: { controller, operationId: operation.operationId, path: candidate.path, export_name: candidate.export_name,
        controller_directory: candidate.controller_directory,
        ...(candidate.package_scope ? {package_scope: candidate.package_scope} : {}),
        ...(candidate.initialization_sources ? {initialization_sources: candidate.initialization_sources} : {}),
        policy: "static-routing-source-candidates-2" }, verification: "inferred", evidence_ids: evidenceIds });
    result.diagnostics.push({ diagnostic_id: `diag-${hash(`${endpoint.endpoint_id}:handler_candidate_unverified:${id}`).slice(0, 24)}`,
      code: "handler_candidate_unverified", severity: "warning", message: "Handler source candidate; runtime binding unverified",
      affected_endpoint_ids: [endpoint.endpoint_id], evidence_ids: evidenceIds });
  }
}

function failed(result: AnalyzerResult, path: string): AnalyzerResult {
  result.status = "failed";
  result.coverage = { status: "incomplete", analyzed_roots: [path], unresolved_roots: [path],
    reason: "Selected document cannot be analyzed", diagnostic_ids: result.diagnostics.map(item => item.diagnostic_id) };
  return result;
}
