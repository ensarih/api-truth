import {canonicalJsonStringify} from "../../../packages/ir/src/index.js";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {
  deriveEndpointIdentity, parseAnalyzerRequest, parseAnalyzerResult,
  type AnalyzerRequest, type AnalyzerResult, type ApiSchema, type Claim, type Endpoint,
} from "../../../packages/ir/src/index.js";
import {readSelectedDocument} from "../../nodejs/src/source.js";
import {parseStrictJson, StrictJsonError} from "../../nodejs/src/strict-json.js";
import {parseStrictYaml, StrictYamlError} from "../../nodejs/src/strict-yaml.js";
import {ParsedDocumentCache, isParsedDocumentCache, snapshotParsedDocumentCacheScope,
  type ParsedDocumentCacheScope} from "../../nodejs/src/parsed-document-cache.js";

/** A selected API document declares a contract; no server URL is treated as an in-process route. */
export const ANALYZER = {analyzer_id: "openapi3-document", analyzer_version: "0.2.0"};
export type OpenApiDocumentProfile = "3.0" | "3.1";
export const OPENAPI31_ANALYZER = {analyzer_id: "openapi31-document", analyzer_version: "0.1.0"};
type Obj = Record<string, unknown>;
const obj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const part = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const supportedSchema = new Set(["$ref", "type", "format", "title", "description", "properties", "required", "items",
  "additionalProperties", "enum", "oneOf", "anyOf", "allOf", "not", "pattern", "minimum", "maximum", "minLength",
  "maxLength", "minItems", "maxItems", "nullable", "readOnly", "writeOnly", "deprecated", "example", "default", "externalDocs"]);
const allowedTop = new Set(["openapi", "info", "servers", "paths", "components", "security", "tags", "externalDocs"]);
const allowedPath = new Set(["summary", "description", "servers", "parameters", "$ref", ...methods]);
const allowedOperation = new Set(["tags", "summary", "description", "externalDocs", "operationId", "parameters", "requestBody",
  "responses", "callbacks", "deprecated", "security", "servers"]);
const allowedParameter = new Set(["name", "in", "description", "required", "deprecated", "allowEmptyValue", "style", "explode",
  "allowReserved", "schema", "example", "examples", "content", "$ref"]);
const allowedMedia = new Set(["schema", "example", "examples", "encoding"]);
const isMediaType = (value: string): boolean => /^(?:\*|[A-Za-z0-9!#$&^_.+-]+)\/(?:\*|[A-Za-z0-9!#$&^_.+*-]+)(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/.test(value);

export function createAnalyzer(options: {projectRoot: string; parsedDocumentCache?: ParsedDocumentCache;
  parsedDocumentCacheScope?: ParsedDocumentCacheScope}) {
  return createAnalyzerForDocumentProfile(options, ANALYZER, "3.0");
}

export function createAnalyzerForDocumentProfile(options: {projectRoot: string; parsedDocumentCache?: ParsedDocumentCache;
  parsedDocumentCacheScope?: ParsedDocumentCacheScope}, analyzer: typeof ANALYZER | typeof OPENAPI31_ANALYZER,
  profile: OpenApiDocumentProfile) {
  const parsedDocumentCache = options.parsedDocumentCache;
  const parsedDocumentCacheScope = options.parsedDocumentCacheScope === undefined ? undefined
    : snapshotParsedDocumentCacheScope(options.parsedDocumentCacheScope);
  if ((parsedDocumentCache === undefined) !== (parsedDocumentCacheScope === undefined)
    || parsedDocumentCache !== undefined && !isParsedDocumentCache(parsedDocumentCache))
    throw new Error("Invalid trusted document cache");
  return {async analyze(input: unknown): Promise<AnalyzerResult> {
    const parsed = parseAnalyzerRequest(input);
    if (!parsed.ok) throw new Error("Invalid analyzer request");
    const request = parsed.value;
    if (request.ir_version !== "1.1.0" || request.analyzer.analyzer_id !== analyzer.analyzer_id
      || request.analyzer.analyzer_version !== analyzer.analyzer_version) throw new Error("Unsupported analyzer contract");
    if (request.resolution_inputs.length !== 1 || request.resolution_inputs[0]?.kind !== "type_manifest")
      throw new Error("Exactly one selected document is required");
    const selected = request.resolution_inputs[0];
    if (request.changed_paths.some(path => path !== selected.path)) throw new Error("Unsupported changed paths");
    const started = Date.now();
    const source = await readSelectedDocument(resolve(options.projectRoot), request.source.service_root, selected.path,
      Math.min(request.limits.max_output_bytes, 2_000_000));
    for (const digest of [request.source.source_digest, selected.digest])
      if (/^sha256:[a-f0-9]{64}$/i.test(digest) && digest.toLowerCase() !== source.digest)
        throw new Error("Source digest mismatch");
    const normalized: AnalyzerRequest = {...request, source: {...request.source, source_digest: source.digest},
      resolution_inputs: [{...selected, digest: source.digest}]};
    if (Date.now() - started > request.limits.timeout_ms) throw new Error("Analysis time limit exceeded");
    const parse = () => parsedDocumentCache && parsedDocumentCacheScope
      ? parsedDocumentCache.parse({...parsedDocumentCacheScope, adapterId: analyzer.analyzer_id,
        adapterVersion: analyzer.analyzer_version, irVersion: request.ir_version, documentPath: source.path,
        digest: source.digest}, source.text)
      : parseSelectedDocument(source.text, source.path);
    const result = extractOpenApiDocumentFromParser(normalized, source.path, parse, profile);
    if (Date.now() - started > request.limits.timeout_ms) throw new Error("Analysis time limit exceeded");
    if (Buffer.byteLength(JSON.stringify(result)) > request.limits.max_output_bytes) throw new Error("Analysis output limit exceeded");
    const validated = parseAnalyzerResult(result);
    if (!validated.ok) throw new Error("Analyzer produced invalid result");
    return validated.value;
  }};
}

export async function analyze(request: AnalyzerRequest): Promise<AnalyzerResult> {
  return createAnalyzer({projectRoot: process.cwd()}).analyze(request);
}

export function extractOpenApi3Document(request: AnalyzerRequest, documentPath: string, text: string): AnalyzerResult {
  return extractOpenApiDocumentFromParser(request, documentPath, () => parseSelectedDocument(text, documentPath), "3.0");
}

export function extractOpenApi31Document(request: AnalyzerRequest, documentPath: string, text: string): AnalyzerResult {
  return extractOpenApiDocumentFromParser(request, documentPath, () => parseSelectedDocument(text, documentPath), "3.1");
}

function parseSelectedDocument(text: string, documentPath: string): unknown {
  return /\.ya?ml$/.test(documentPath) ? parseStrictYaml(text) : parseStrictJson(text);
}

function extractOpenApiDocumentFromParser(request: AnalyzerRequest, documentPath: string, parseDocument: () => unknown,
  profile: OpenApiDocumentProfile): AnalyzerResult {
  const fingerprint = hash(canonicalJsonStringify({request, parser: profile === "3.0" ? "openapi3-strict-json-yaml-1" : "openapi31-default-dialect-subset-1", documentPath}));
  const result: AnalyzerResult = {exchange_version: "1.0.0", ir_version: request.ir_version, identity_version: "1.0.0",
    request_id: request.request_id, result_id: `result-${fingerprint}`, snapshot_id: `snapshot-${fingerprint}`,
    analyzer: request.analyzer, source: request.source, status: "success", completed_at: new Date().toISOString(),
    coverage: {status: "complete", analyzed_roots: [documentPath], diagnostic_ids: []}, evidence: [], schemas: {},
    security_schemes: {}, endpoints: [], claims: [], dependencies: [], diagnostics: [],
    reproducibility_fingerprint: `sha256:${fingerprint}`};
  const evidence = (pointer: string, endpointId?: string): string => {
    const id = `ev-${hash(`${documentPath}:${pointer}:${endpointId ?? ""}`).slice(0, 24)}`;
    if (!result.evidence.some(item => item.evidence_id === id)) result.evidence.push({evidence_id: id,
      source: {kind: "api_document", source_id: request.source.repository_id},
      source_version: request.source.immutable_revision, location: {path: documentPath, pointer: pointer || "/"},
      method: "type_declaration", scope: {service_id: request.source.service_id, snapshot_id: result.snapshot_id,
        revision: request.source.immutable_revision, ...(endpointId ? {endpoint_id: endpointId} : {})},
      limitations: ["API document declaration; application runtime binding unverified"], access_label: request.source.access_label});
    return id;
  };
  const diagnostic = (code: string, pointer: string, severity: "warning" | "error" = "warning", endpointId?: string): void => {
    const id = `diag-${hash(`${code}:${pointer}:${endpointId ?? ""}`).slice(0, 24)}`;
    if (!result.diagnostics.some(item => item.diagnostic_id === id)) result.diagnostics.push({diagnostic_id: id, code,
      severity, message: code.replaceAll("_", " "), affected_endpoint_ids: endpointId ? [endpointId] : [],
      evidence_ids: [evidence(pointer, endpointId)]});
  };
  const claim = (predicate: string, value: Claim["value"], pointer: string, endpoint?: Endpoint,
    extraPointers: string[] = [], verification: Claim["verification"] = "declared"): void => {
    const evidenceIds = [...new Set([pointer, ...extraPointers].map(p => evidence(p, endpoint?.endpoint_id)))];
    result.claims.push({claim_id: `claim-${hash(`${endpoint?.endpoint_id ?? "service"}:${predicate}:${pointer}:${JSON.stringify(value)}`).slice(0, 24)}`,
      subject: {service_id: request.source.service_id, ...(endpoint ? {endpoint_id: endpoint.endpoint_id} : {})},
      predicate, value, verification, evidence_ids: evidenceIds});
    if (endpoint) for (const id of evidenceIds) dependency(endpoint, "evidence", id, evidenceIds);
  };
  const dependency = (endpoint: Endpoint, kind: "evidence" | "schema", id: string, ids: string[]): void => {
    if (kind === "evidence" && !endpoint.evidence_ids.includes(id)) endpoint.evidence_ids.push(id);
    if (!result.dependencies.some(d => d.from_endpoint_id === endpoint.endpoint_id && d.to.kind === kind && d.to.id === id))
      result.dependencies.push({from_endpoint_id: endpoint.endpoint_id, to: {kind, id}, evidence_ids: [...new Set(ids)]});
  };
  const finish = (failed = false): AnalyzerResult => {
    if (failed || result.diagnostics.length) {
      result.status = failed ? "failed" : "partial";
      result.coverage = {status: "incomplete", analyzed_roots: [documentPath], unresolved_roots: [documentPath],
        reason: failed ? "Selected document could not be analyzed" : "Selected document has unsupported or unverified facts",
        diagnostic_ids: result.diagnostics.map(d => d.diagnostic_id)};
    }
    return result;
  };
  let raw: unknown;
  try { raw = parseDocument(); }
  catch (error) { diagnostic(error instanceof StrictYamlError || error instanceof StrictJsonError ? error.code : "invalid_document", "", "error"); return finish(true); }
  if (!obj(raw) || typeof raw.openapi !== "string" || !(profile === "3.0" ? /^3\.0\.[0-9]+$/.test(raw.openapi) : /^3\.1\.[01]$/.test(raw.openapi))
    || !obj(raw.info) || typeof raw.info.title !== "string" || typeof raw.info.version !== "string" || !obj(raw.paths)) {
    diagnostic(profile === "3.0" && obj(raw) && typeof raw.openapi === "string" && raw.openapi.startsWith("3.1")
      ? "openapi31_unsupported" : profile === "3.1" ? "invalid_openapi31_document" : "invalid_openapi30_document", "", "error");
    return finish(true);
  }
  const document = raw;
  const noteUnknown = (value: Obj, allowed: Set<string>, pointer: string) => {
    for (const key of Object.keys(value)) if (!allowed.has(key)) diagnostic("unsupported_field", `${pointer}/${part(key)}`);
  };
  // Strict JSON/YAML parsers enforce structure budgets; this pass rejects unsafe keys and remote refs everywhere.
  let nodes = 0;
  const inspect = (value: unknown, pointer: string, depth = 0): void => {
    if (++nodes > 50_000 || depth > 128) throw new Error("document_structure_limit_exceeded");
    if (Array.isArray(value)) {value.forEach((child, i) => inspect(child, `${pointer}/${i}`, depth + 1)); return;}
    if (!obj(value)) return;
    // In OAS 3.0 a Reference Object ignores sibling members. Inspect its target only.
    if (typeof value.$ref === "string") {
      const ref = value.$ref;
      const at = `${pointer}/$ref`;
      if (profile === "3.1" && ref.includes("%")) diagnostic("percent_encoded_reference_unsupported", at, "error");
      else if (!ref.startsWith("#/")) diagnostic("external_ref", at, "error");
      else {
        const segments = ref.slice(2).split("/");
        let target: unknown = document;
        for (const segment of segments) {
          if (/~(?![01])/.test(segment)) {target = undefined; break;}
          const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
          target = obj(target) && Object.hasOwn(target, decoded) ? target[decoded] : undefined;
        }
        if (target === undefined) diagnostic("missing_local_ref", at);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const at = `${pointer}/${part(key)}`;
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("prototype_key_unsupported");
      if (key === "$ref" && typeof child !== "string") diagnostic("invalid_ref", at, "error");
      const literalData = ["example", "examples", "enum", "default", "value", ...(profile === "3.1" ? ["const"] : [])];
      if (!literalData.includes(key) && !key.startsWith("x-"))
        inspect(child, at, depth + 1);
    }
  };
  try { inspect(document, ""); }
  catch { diagnostic("document_structure_limit_exceeded", "", "error"); return finish(true); }
  if (result.diagnostics.some(d => d.severity === "error")) return finish(true);
  noteUnknown(document, profile === "3.1" ? new Set([...allowedTop, "jsonSchemaDialect"]) : allowedTop, "");
  const defaultDialect = "https://spec.openapis.org/oas/3.1/dialect/base";
  const customDialect = profile === "3.1" && document.jsonSchemaDialect !== undefined && document.jsonSchemaDialect !== defaultDialect;
  if (customDialect) diagnostic("custom_json_schema_dialect_unsupported", "/jsonSchemaDialect");
  const components = obj(document.components) ? document.components : {};
  if (document.components !== undefined && !obj(document.components)) diagnostic("components_unsupported", "/components");
  if (obj(document.components)) noteUnknown(document.components,
    new Set(["schemas", "responses", "parameters", "requestBodies", "headers", "securitySchemes", "examples", "links", "callbacks"]), "/components");
  for (const category of ["schemas", "responses", "parameters", "requestBodies", "headers", "securitySchemes"])
    if (components[category] !== undefined && !obj(components[category])) diagnostic("components_map_unsupported", `/components/${category}`);
  const schemaMap = obj(components.schemas) ? components.schemas : {};
  const schemaIds = new Map(Object.keys(schemaMap).sort().map(name => [name, `schema-${hash(name).slice(0, 24)}`]));
  const schemaNames = new Map([...schemaIds].map(([name, id]) => [id, name]));
  const schema31Keys = new Set(["$ref", "type", "format", "title", "description", "properties", "required", "items",
    "additionalProperties", "enum", "oneOf", "anyOf", "allOf", "not", "pattern", "minimum", "maximum", "minLength",
    "maxLength", "minItems", "maxItems", "const", "prefixItems"]);
  let schemaProjectionNodes = 0;
  const schemaCanProject = (input: unknown, pointer: string, active = new Set<string>(), depth = 0): boolean => {
    if (profile === "3.0") return true;
    if (customDialect) return false;
    if (++schemaProjectionNodes > 50_000) {diagnostic("schema_projection_limit_exceeded", pointer); return false;}
    if (!obj(input) || depth > 32) {diagnostic("schema_projection_unsupported", pointer); return false;}
    if (typeof input.$ref === "string") {
      const token = input.$ref.match(/^#\/components\/schemas\/([^/]+)$/)?.[1];
      const name = token && !/~(?![01])/.test(token) ? token.replaceAll("~1", "/").replaceAll("~0", "~") : undefined;
      if (!name || Object.keys(input).some(key => key !== "$ref")) {diagnostic("schema_ref_unsupported", pointer); return false;}
      if (active.has(name)) return true;
      const target = Object.hasOwn(schemaMap, name) ? schemaMap[name] : undefined;
      if (target === undefined) {diagnostic("schema_ref_unsupported", pointer); return false;}
      active.add(name);
      const safe = schemaCanProject(target, `/components/schemas/${part(name)}`, active, depth + 1);
      active.delete(name);
      return safe;
    }
    let safe = true;
    for (const key of Object.keys(input)) {
      if (!schema31Keys.has(key)) {diagnostic(key === "$id" || key === "$anchor" || key === "$dynamicRef" || key === "$dynamicAnchor" || key === "$schema"
        ? "schema_resource_keyword_unsupported" : "schema_keyword_unsupported", `${pointer}/${part(key)}`); safe = false;}
    }
    if (input.type !== undefined && !(typeof input.type === "string" || Array.isArray(input.type))) {
      diagnostic("schema_type_unsupported", `${pointer}/type`); safe = false;
    }
    if (Array.isArray(input.type) && (!input.type.length || input.type.length > 7 || new Set(input.type).size !== input.type.length
      || input.type.some((x: unknown) => typeof x !== "string" || !["null", "boolean", "object", "array", "number", "integer", "string"].includes(x)))) {
      diagnostic("schema_type_unsupported", `${pointer}/type`); safe = false;
    }
    if (typeof input.type === "string" && !["null", "boolean", "object", "array", "number", "integer", "string"].includes(input.type)) {
      diagnostic("schema_type_unsupported", `${pointer}/type`); safe = false;
    }
    if (input.const !== undefined && !jsonValue(input.const)) {diagnostic("schema_const_unsupported", `${pointer}/const`); safe = false;}
    for (const key of ["title", "description", "pattern"] as const)
      if (input[key] !== undefined && typeof input[key] !== "string") {diagnostic("schema_keyword_unsupported", `${pointer}/${key}`); safe = false;}
    if (input.format !== undefined && (typeof input.format !== "string" || !input.format)) {
      diagnostic("schema_keyword_unsupported", `${pointer}/format`); safe = false;
    }
    for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
      const value = input[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value)
        || (!["minimum", "maximum"].includes(key) && (!Number.isInteger(value) || value < 0)))) {
        diagnostic("schema_keyword_unsupported", `${pointer}/${key}`); safe = false;
      }
    }
    if (input.required !== undefined && (!Array.isArray(input.required)
      || input.required.some((x: unknown) => typeof x !== "string" || !x)
      || new Set(input.required).size !== input.required.length)) {
      diagnostic("schema_required_unsupported", `${pointer}/required`); safe = false;
    }
    if (input.enum !== undefined && (!Array.isArray(input.enum) || !input.enum.length
      || input.enum.some((x: unknown) => !jsonValue(x))
      || new Set(input.enum.map((x: unknown) => canonicalJsonStringify(x))).size !== input.enum.length)) {
      diagnostic("schema_enum_unsupported", `${pointer}/enum`); safe = false;
    }
    for (const key of ["properties", "items", "additionalProperties", "prefixItems", "oneOf", "anyOf", "allOf", "not"] as const) {
      const child = input[key];
      if (child === undefined) continue;
      const children: unknown[] = key === "properties" && obj(child) ? Object.entries(child).map(([name, value]) => [name, value])
        : key === "prefixItems" || key === "oneOf" || key === "anyOf" || key === "allOf" ? Array.isArray(child) ? child : [child]
          : [child];
      if (key === "properties" && !obj(child)) {diagnostic("schema_properties_unsupported", `${pointer}/properties`); safe = false;}
      if (["prefixItems", "oneOf", "anyOf", "allOf"].includes(key) && !Array.isArray(child)) {
        diagnostic("schema_composition_unsupported", `${pointer}/${key}`); safe = false;
      }
      if (["oneOf", "anyOf", "allOf"].includes(key) && Array.isArray(child) && (child.length < 1 || child.length > 32)) {
        diagnostic("schema_composition_unsupported", `${pointer}/${key}`); safe = false;
      }
      if (key === "prefixItems" && Array.isArray(child) && child.length > 32) {
        diagnostic("schema_composition_unsupported", `${pointer}/prefixItems`); safe = false;
      }
      for (const entry of children) {
        const value = key === "properties" && Array.isArray(entry) ? entry[1] : entry;
        const suffix = key === "properties" && Array.isArray(entry) ? `/properties/${part(String(entry[0]))}`
          : Array.isArray(child) && children === child ? `/${key}/${children.indexOf(entry)}` : `/${key}`;
        if (key === "additionalProperties" && typeof value === "boolean") {
          if (profile === "3.1") {diagnostic("boolean_schema_unsupported", `${pointer}/additionalProperties`); safe = false;}
          continue;
        }
        if (!schemaCanProject(value, `${pointer}${suffix}`, active, depth + 1)) safe = false;
      }
    }
    return safe;
  };
  const jsonValue = (value: unknown, depth = 0): boolean => {
    if (depth > 64) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 1000 && value.every(x => jsonValue(x, depth + 1));
    return obj(value) && Object.keys(value).length <= 1000 && Object.values(value).every(x => jsonValue(x, depth + 1));
  };
  const local = (value: unknown, category: string, pointer: string): {value: Obj; pointer: string; chain: string[]} | undefined => {
    const seen = new Set<string>();
    const chain: string[] = [];
    while (obj(value) && typeof value.$ref === "string") {
      if (chain.length >= 32) {diagnostic("local_ref_chain_limit_exceeded", pointer); return;}
      if (Object.keys(value).some(key => key !== "$ref")) {
        diagnostic("reference_siblings_unsupported", pointer);
        if (profile === "3.1") return;
      }
      const match = value.$ref.match(new RegExp(`^#/components/${category}/([^/]+)$`));
      const name = match?.[1]?.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!name || /~(?![01])/.test(match![1]!) || seen.has(name)) {diagnostic("local_ref_unsupported", `${pointer}/$ref`); return;}
      seen.add(name);
      pointer = `/components/${category}/${part(name)}`;
      chain.push(pointer);
      const map = components[category];
      value = obj(map) && Object.hasOwn(map, name) ? map[name] : undefined;
    }
    if (!obj(value)) {diagnostic("referenced_object_unresolved", pointer); return;}
    return {value, pointer, chain};
  };
  const schema = (input: unknown, pointer: string, depth = 0): ApiSchema => {
    if (!obj(input) || depth > 32) {diagnostic("schema_unsupported", pointer); return {};}
    if (typeof input.$ref === "string") {
      const match = input.$ref.match(/^#\/components\/schemas\/([^/]+)$/);
      const token = match?.[1];
      const id = token && !/~(?![01])/.test(token) ? schemaIds.get(token.replaceAll("~1", "/").replaceAll("~0", "~")) : undefined;
      if (!id || Object.keys(input).some(key => key !== "$ref")) {diagnostic("schema_ref_unsupported", pointer); return {};}
      return {$ref: `#/schemas/${id}`};
    }
    const output: ApiSchema = {};
    if (profile === "3.1" && Array.isArray(input.type)) output.type = input.type as NonNullable<ApiSchema["type"]>;
    else if (typeof input.type === "string" && (profile === "3.1"
      ? ["null", "string", "integer", "number", "boolean", "object", "array"]
      : ["string", "integer", "number", "boolean", "object", "array"]).includes(input.type)) output.type = input.type as NonNullable<ApiSchema["type"]>;
    else if (input.type !== undefined) diagnostic("schema_type_unsupported", `${pointer}/type`);
    for (const key of ["format", "title", "description", "pattern"] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] === "string" && (key !== "format" || input[key] !== "")) (output as Obj)[key] = input[key];
      else diagnostic("schema_keyword_unsupported", `${pointer}/${key}`);
    }
    for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] === "number" && Number.isFinite(input[key]) && (["minimum", "maximum"].includes(key) || Number.isInteger(input[key]) && input[key] >= 0))
        (output as Obj)[key] = input[key];
      else diagnostic("schema_keyword_unsupported", `${pointer}/${key}`);
    }
    if (input.required !== undefined) {
      if (Array.isArray(input.required) && input.required.every(x => typeof x === "string" && x.length > 0)
        && new Set(input.required).size === input.required.length) output.required = input.required as string[];
      else diagnostic("schema_required_unsupported", `${pointer}/required`);
    }
    if (input.enum !== undefined) {
      if (Array.isArray(input.enum) && input.enum.length) output.enum = input.enum as NonNullable<ApiSchema["enum"]>;
      else diagnostic("schema_enum_unsupported", `${pointer}/enum`);
    }
    if (profile === "3.1" && input.const !== undefined) output.const = input.const as NonNullable<ApiSchema["const"]>;
    if (input.properties !== undefined) {
      if (obj(input.properties)) output.properties = Object.fromEntries(Object.entries(input.properties).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => [name, schema(child, `${pointer}/properties/${part(name)}`, depth + 1)]));
      else diagnostic("schema_properties_unsupported", `${pointer}/properties`);
    }
    if (input.items !== undefined) output.items = schema(input.items, `${pointer}/items`, depth + 1);
    if (profile === "3.1" && input.prefixItems !== undefined && Array.isArray(input.prefixItems))
      output.prefixItems = input.prefixItems.map((item: unknown, i: number) => schema(item, `${pointer}/prefixItems/${i}`, depth + 1));
    if (input.additionalProperties !== undefined) {
      if (typeof input.additionalProperties === "boolean") output.additionalProperties = input.additionalProperties;
      else output.additionalProperties = schema(input.additionalProperties, `${pointer}/additionalProperties`, depth + 1);
    }
    for (const key of ["oneOf", "anyOf", "allOf"] as const) if (input[key] !== undefined) {
      if (Array.isArray(input[key]) && input[key].length > 0 && input[key].length <= 32)
        (output as Obj)[key] = input[key].map((item: unknown, i: number) => schema(item, `${pointer}/${key}/${i}`, depth + 1));
      else diagnostic("schema_composition_unsupported", `${pointer}/${key}`);
    }
    if (input.not !== undefined) output.not = schema(input.not, `${pointer}/not`, depth + 1);
    if (input.nullable === true) {
      if (typeof output.type === "string") output.type = [output.type, "null"] as NonNullable<ApiSchema["type"]>;
      else diagnostic("schema_nullable_unsupported", `${pointer}/nullable`);
    } else if (input.nullable !== undefined && input.nullable !== false) diagnostic("schema_nullable_unsupported", `${pointer}/nullable`);
    for (const key of Object.keys(input)) if (!(profile === "3.1" ? schema31Keys : supportedSchema).has(key)) diagnostic("schema_keyword_unsupported", `${pointer}/${part(key)}`);
    if (input.readOnly !== undefined || input.writeOnly !== undefined) diagnostic("schema_direction_unsupported", pointer);
    return output;
  };
  const projectSchema = (input: unknown, pointer: string): ApiSchema | undefined => {
    if (profile === "3.0") return schema(input, pointer);
    if (!schemaCanProject(input, pointer)) return;
    const before = result.diagnostics.length;
    const projected = schema(input, pointer);
    return result.diagnostics.length === before ? projected : undefined;
  };
  for (const [name, rawSchema] of Object.entries(schemaMap).sort(([a], [b]) => a.localeCompare(b))) {
    const pointer = `/components/schemas/${part(name)}`;
    const id = schemaIds.get(name)!;
    const projected = projectSchema(rawSchema, pointer);
    if (projected) result.schemas[id] = {schema_id: id, schema: projected, evidence_ids: [evidence(pointer)]};
  }
  const schemes = obj(components.securitySchemes) ? components.securitySchemes : {};
  for (const [name, rawScheme] of Object.entries(schemes).sort(([a], [b]) => a.localeCompare(b))) {
    const pointer = `/components/securitySchemes/${part(name)}`;
    if (!obj(rawScheme)) {diagnostic("security_scheme_unsupported", pointer); continue;}
    const accepted = rawScheme.type === "apiKey" ? ["type", "name", "in", "description"]
      : rawScheme.type === "http" ? ["type", "scheme", "bearerFormat", "description"] : [];
    if (Object.keys(rawScheme).some(key => !accepted.includes(key))) {
      diagnostic("security_scheme_unsupported", pointer); continue;
    }
    if (rawScheme.type === "apiKey" && typeof rawScheme.name === "string" && rawScheme.name.length
      && ["header", "query", "cookie"].includes(String(rawScheme.in)))
      result.security_schemes![name] = {definition: {type: "apiKey", name: rawScheme.name,
        in: rawScheme.in as "header" | "query" | "cookie"}, evidence_ids: [evidence(pointer)]};
    else if (rawScheme.type === "http" && typeof rawScheme.scheme === "string" && rawScheme.scheme.length)
      result.security_schemes![name] = {definition: {type: "http", scheme: rawScheme.scheme,
        ...(typeof rawScheme.bearerFormat === "string" && rawScheme.bearerFormat.length ? {bearerFormat: rawScheme.bearerFormat} : {})},
        evidence_ids: [evidence(pointer)]};
    else diagnostic("security_scheme_unsupported", pointer);
  }
  const serverClaim = (value: unknown, pointer: string, endpoint?: Endpoint): void => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some(s => !obj(s) || typeof s.url !== "string" || !s.url.length)) {
      diagnostic("servers_unsupported", pointer, "warning", endpoint?.endpoint_id); return;
    }
    claim("exposure.servers.declaration", value as Claim["value"], pointer, endpoint);
    if (value.some(s => Object.keys(s).some(key => !["url", "description", "variables"].includes(key))))
      diagnostic("server_field_unsupported", pointer, "warning", endpoint?.endpoint_id);
    for (let i = 0; i < value.length; i++) {
      const server = value[i] as Obj;
      if (server.variables !== undefined && (!obj(server.variables) || Object.values(server.variables).some(v =>
        !obj(v) || typeof v.default !== "string" || v.default.length === 0)))
        diagnostic("server_variables_unsupported", `${pointer}/${i}/variables`, "warning", endpoint?.endpoint_id);
    }
  };
  serverClaim(document.servers, "/servers");
  diagnostic("application_runtime_binding_unverified", "");
  for (const [path, pathItem] of Object.entries(document.paths as Obj).sort(([a], [b]) => a.localeCompare(b))) {
    const pathPointer = `/paths/${part(path)}`;
    if (!path.startsWith("/") || !obj(pathItem)) {diagnostic("path_unsupported", pathPointer); continue;}
    noteUnknown(pathItem, allowedPath, pathPointer);
      if (pathItem.$ref !== undefined) {diagnostic("path_item_ref_unsupported", `${pathPointer}/$ref`); continue;}
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      const opPointer = `${pathPointer}/${method}`;
      if (!obj(operation)) {diagnostic("operation_unsupported", opPointer); continue;}
      noteUnknown(operation, allowedOperation, opPointer);
      if (operation.callbacks !== undefined) diagnostic("callbacks_unsupported", `${opPointer}/callbacks`);
      let identity: Endpoint["identity"];
      try {identity = deriveEndpointIdentity({identity_version: "1.0.0", service_id: request.source.service_id,
        method, application_path: path});}
      catch {diagnostic("route_path_unsupported", opPointer); continue;}
      const endpointId = `endpoint-${hash(identity.route_key).slice(0, 24)}`;
      if (result.endpoints.some(e => e.endpoint_id === endpointId)) {diagnostic("conflicting_route_declarations", opPointer); continue;}
      const endpoint: Endpoint = {endpoint_id: endpointId, identity, application_path: path, parameters: [], request_bodies: [],
        responses: [], security: {state: "unknown", alternatives: []}, evidence_ids: [evidence(opPointer, endpointId)]};
      claim("route.declaration", {method: identity.method, path,
        ...(typeof operation.operationId === "string" ? {operationId: operation.operationId} : {})}, opPointer, endpoint);
      for (const field of ["summary", "description"] as const) {
        const value = operation[field];
        if (value === undefined) continue;
        if (typeof value !== "string" || value.length > 2_048) {
          diagnostic("operation_text_unsupported", `${opPointer}/${field}`, "warning", endpointId);
          continue;
        }
        claim(field === "summary" ? "operation.summary" : "operation.description", value,
          `${opPointer}/${field}`, endpoint);
      }
      const effectiveServers = operation.servers !== undefined ? {value: operation.servers, pointer: `${opPointer}/servers`}
        : pathItem.servers !== undefined ? {value: pathItem.servers, pointer: `${pathPointer}/servers`}
          : document.servers !== undefined ? {value: document.servers, pointer: "/servers"} : undefined;
      if (effectiveServers) serverClaim(effectiveServers.value, effectiveServers.pointer, endpoint);
      const parameters = new Map<string, {value: Obj; pointer: string; chain: string[]}>();
      const addParameters = (rawList: unknown, at: string) => {
        if (rawList === undefined) return;
        if (!Array.isArray(rawList)) {diagnostic("parameters_unsupported", at, "warning", endpointId); return;}
        const seen = new Set<string>();
        const collided = new Set<string>();
        rawList.forEach((rawParameter, i) => {
          const pointer = `${at}/${i}`;
          const resolved = local(rawParameter, "parameters", pointer);
          if (!resolved) return;
          const parameter = resolved.value;
          if (typeof parameter.name !== "string" || !parameter.name || typeof parameter.in !== "string") {
            diagnostic("parameter_unsupported", pointer, "warning", endpointId); return;
          }
          const key = `${parameter.in}\0${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;
          if (seen.has(key)) {
            diagnostic("duplicate_parameter", pointer, "warning", endpointId);
            collided.add(key);
            parameters.delete(key);
            return;
          }
          seen.add(key);
          if (collided.has(key)) return;
          parameters.set(key, {...resolved, chain: [pointer, ...resolved.chain]});
        });
      };
      addParameters(pathItem.parameters, `${pathPointer}/parameters`);
      addParameters(operation.parameters, `${opPointer}/parameters`);
      const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map(m => m[1]!);
      for (const item of parameters.values()) {
        const parameter = item.value;
        noteUnknown(parameter, allowedParameter, item.pointer);
        if (!["path", "query", "header", "cookie"].includes(String(parameter.in))) {
          diagnostic("parameter_location_unsupported", `${item.pointer}/in`, "warning", endpointId); continue;
        }
        const location = parameter.in as "path" | "query" | "header" | "cookie";
        const name = parameter.name as string;
        if (location === "header" && ["accept", "content-type", "authorization"].includes(name.toLowerCase())) {
          diagnostic("reserved_header_parameter_unsupported", item.pointer, "warning", endpointId); continue;
        }
        let presence: "required" | "optional" | "unknown";
        if (location === "path") {
          presence = parameter.required === true ? "required" : "unknown";
          if (parameter.required !== true) diagnostic("optional_path_parameter_unsupported", `${item.pointer}/required`, "warning", endpointId);
          if (!placeholders.includes(name)) diagnostic("path_parameter_not_in_template", item.pointer, "warning", endpointId);
        } else if (parameter.required === true) presence = "required";
        else if (parameter.required === false || parameter.required === undefined) presence = "optional";
        else {presence = "unknown"; diagnostic("parameter_required_unsupported", `${item.pointer}/required`, "warning", endpointId);}
        const pEv = evidence(item.pointer, endpointId);
        for (const p of item.chain) dependency(endpoint, "evidence", evidence(p, endpointId), [pEv]);
        let pSchema: ApiSchema = {};
        let schemaRepresentable = false;
        if (parameter.schema !== undefined && parameter.content !== undefined) {
          diagnostic("parameter_schema_content_conflict", item.pointer, "warning", endpointId);
          continue;
        }
        else if (parameter.content !== undefined) {
          if (!obj(parameter.content) || Object.keys(parameter.content).length !== 1) {
            diagnostic("parameter_content_unsupported", `${item.pointer}/content`, "warning", endpointId);
            continue;
          }
          else {
            const [mediaType, media] = Object.entries(parameter.content)[0]!;
            if (!obj(media) || !isMediaType(mediaType)) {
              diagnostic("parameter_content_unsupported", `${item.pointer}/content`, "warning", endpointId);
              continue;
            }
            else {
              if (parameter.style !== undefined || parameter.explode !== undefined || parameter.allowReserved !== undefined)
                diagnostic("parameter_content_serialization_conflict", item.pointer, "warning", endpointId);
              if (media.schema !== undefined && !obj(media.schema)) {
                diagnostic("parameter_content_schema_unsupported", `${item.pointer}/content/${part(mediaType)}/schema`, "warning", endpointId);
                continue;
              }
              const before = result.diagnostics.length;
              const projected = media.schema === undefined ? undefined : projectSchema(media.schema, `${item.pointer}/content/${part(mediaType)}/schema`);
              pSchema = projected ?? {};
              endpoint.parameters.push({name, in: location, presence: {state: presence, evidence_ids: [pEv]}, schema: pSchema,
                serialization: {content_encoding: mediaType}});
              claim("parameter.presence", {name, in: location, state: presence},
                parameter.required === undefined ? item.pointer : `${item.pointer}/required`, endpoint, item.chain,
                parameter.required === undefined ? "inferred" : "declared");
              claim("parameter.content.declaration", {name, in: location, media_type: mediaType,
                ...(media.schema !== undefined && (profile === "3.1" ? projected !== undefined : result.diagnostics.length === before) ? {schema: pSchema} : {})},
              `${item.pointer}/content`, endpoint, item.chain);
              continue;}
          }
        } else if (parameter.schema !== undefined) {
          if (!obj(parameter.schema)) {diagnostic("parameter_schema_unsupported", `${item.pointer}/schema`, "warning", endpointId); continue;}
          const before = result.diagnostics.length;
          const projected = projectSchema(parameter.schema, `${item.pointer}/schema`);
          pSchema = projected ?? {};
          schemaRepresentable = profile === "3.1" ? projected !== undefined : result.diagnostics.length === before;
        } else {diagnostic("parameter_schema_unknown", item.pointer, "warning", endpointId); continue;}
        const defaults: Record<string, string> = {path: "simple", query: "form", header: "simple", cookie: "form"};
        const style = parameter.style === undefined ? defaults[location] : parameter.style;
        const supported: Record<string, string[]> = {path: ["simple", "label", "matrix"], query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
          header: ["simple"], cookie: ["form"]};
        const explode = parameter.explode === undefined ? style === "form" : parameter.explode;
        const serializable = typeof style === "string" && supported[location]!.includes(style) && typeof explode === "boolean"
          && !(location === "cookie" && (style !== "form" || explode !== true))
          && !(style === "deepObject" && (pSchema.type !== "object" || explode !== true))
          && !(["spaceDelimited", "pipeDelimited"].includes(style as string) && (pSchema.type !== "array" || explode !== false))
          && parameter.allowReserved !== true && parameter.allowEmptyValue !== true;
        if (!serializable)
          diagnostic("parameter_serialization_unsupported", item.pointer, "warning", endpointId);
        const serialization = serializable ? {style: style as string, explode: explode as boolean} : {format: "openapi3-unresolved"};
        endpoint.parameters.push({name, in: location, presence: {state: presence, evidence_ids: [pEv]}, schema: pSchema, serialization});
        claim("parameter.presence", {name, in: location, state: presence},
          parameter.required === undefined ? item.pointer : `${item.pointer}/required`, endpoint, item.chain,
          parameter.required === undefined ? "inferred" : "declared");
        if (serializable) claim("parameter.serialization", {name, in: location, ...serialization}, item.pointer, endpoint,
          [...item.chain, ...(parameter.style === undefined ? [] : [`${item.pointer}/style`]),
            ...(parameter.explode === undefined ? [] : [`${item.pointer}/explode`])],
          parameter.style === undefined || parameter.explode === undefined ? "inferred" : "declared");
        if (schemaRepresentable) claim("parameter.schema.declaration", {name, in: location, schema: pSchema}, `${item.pointer}/schema`, endpoint, item.chain);
      }
      for (const name of placeholders) if (!endpoint.parameters.some(p => p.in === "path" && p.name === name))
        diagnostic("path_parameter_missing", `${opPointer}/parameters`, "warning", endpointId);
      if (operation.requestBody !== undefined && !["post", "put", "patch"].includes(method))
        diagnostic("request_body_method_unsupported", `${opPointer}/requestBody`, "warning", endpointId);
      if (operation.requestBody !== undefined && ["post", "put", "patch"].includes(method)) {
        const resolved = local(operation.requestBody, "requestBodies", `${opPointer}/requestBody`);
        if (resolved) {
          const body = resolved.value;
          const bodyPointer = resolved.pointer;
          noteUnknown(body, new Set(["description", "content", "required"]), bodyPointer);
          const required = body.required === true ? "required" : body.required === false || body.required === undefined ? "optional" : "unknown";
          if (required === "unknown") diagnostic("request_body_required_unsupported", `${bodyPointer}/required`, "warning", endpointId);
          if (!obj(body.content)) diagnostic("request_body_content_unsupported", `${bodyPointer}/content`, "warning", endpointId);
          else for (const [mediaType, media] of Object.entries(body.content).sort(([a], [b]) => a.localeCompare(b))) {
            const at = `${bodyPointer}/content/${part(mediaType)}`;
            if (!isMediaType(mediaType) || !obj(media)) {diagnostic("request_body_media_unsupported", at, "warning", endpointId); continue;}
            noteUnknown(media, allowedMedia, at);
            const beforeSchema = result.diagnostics.length;
            const projected = media.schema === undefined ? undefined : projectSchema(media.schema, `${at}/schema`);
            const converted = projected ?? {};
            const schemaRepresentable = media.schema !== undefined && (profile === "3.1" ? projected !== undefined : result.diagnostics.length === beforeSchema);
            if (media.schema === undefined) diagnostic("request_body_schema_unknown", at, "warning", endpointId);
            const encoding: NonNullable<Endpoint["request_bodies"][number]["encoding"]> = {};
            if (media.encoding !== undefined) {
              const formMedia = ["application/x-www-form-urlencoded", "multipart/form-data"].includes(mediaType);
              if (!formMedia)
                diagnostic("encoding_unsupported", `${at}/encoding`, "warning", endpointId);
              if (!obj(media.encoding)) diagnostic("encoding_unsupported", `${at}/encoding`, "warning", endpointId);
              else for (const [field, rawEncoding] of Object.entries(media.encoding).sort(([a], [b]) => a.localeCompare(b))) {
                const p = `${at}/encoding/${part(field)}`;
                claim("request.body.encoding.declaration", {media_type: mediaType, field, encoding: rawEncoding} as Claim["value"], p, endpoint, resolved.chain);
                const styleMode = obj(rawEncoding) && (rawEncoding.style !== undefined || rawEncoding.explode !== undefined);
                const property = converted.properties?.[field];
                if (!obj(rawEncoding) || Object.keys(rawEncoding).some(key => !["style", "explode", "contentType"].includes(key))
                  || rawEncoding.style !== undefined && !["form", "spaceDelimited", "pipeDelimited"].includes(String(rawEncoding.style))
                  || rawEncoding.explode !== undefined && typeof rawEncoding.explode !== "boolean"
                  || rawEncoding.contentType !== undefined && typeof rawEncoding.contentType !== "string"
                  || !formMedia || converted.type !== "object" || !property
                  || styleMode && (rawEncoding.style === undefined || rawEncoding.explode === undefined || rawEncoding.contentType !== undefined)
                  || !styleMode && (typeof rawEncoding.contentType !== "string" || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+$/.test(rawEncoding.contentType))
                  || styleMode && !["array", "string", "integer", "number", "boolean"].includes(String(property.type))
                  || ["spaceDelimited", "pipeDelimited"].includes(String(rawEncoding.style))
                    && (rawEncoding.explode !== false || property.type !== "array")) {
                  diagnostic("encoding_unsupported", p, "warning", endpointId); continue;
                }
                encoding[field] = {...(rawEncoding.style ? {style: rawEncoding.style as "form" | "spaceDelimited" | "pipeDelimited"} : {}),
                  ...(typeof rawEncoding.explode === "boolean" ? {explode: rawEncoding.explode} : {}),
                  ...(typeof rawEncoding.contentType === "string" && rawEncoding.contentType ? {content_type: rawEncoding.contentType} : {}),
                  evidence_ids: [evidence(p, endpointId)]};
              }
            }
            const bodyEv = evidence(bodyPointer, endpointId);
            endpoint.request_bodies.push({media_type: mediaType, schema: converted, serialization: {format: mediaType},
              presence: {state: required, evidence_ids: [bodyEv]}, ...(Object.keys(encoding).length ? {encoding} : {})});
            claim("request.body.presence", {media_type: mediaType, state: required},
              body.required === undefined ? bodyPointer : `${bodyPointer}/required`, endpoint, resolved.chain,
              body.required === undefined ? "inferred" : "declared");
            claim("request.body.declaration", {media_type: mediaType,
              ...(body.required !== undefined ? {required} : {}),
              ...(schemaRepresentable ? {schema: converted} : {})}, at, endpoint,
              [...(body.required !== undefined ? [`${bodyPointer}/required`] : []), ...resolved.chain, `${opPointer}/requestBody`]);
          }
        }
      }
      if (!obj(operation.responses)) diagnostic("responses_unsupported", `${opPointer}/responses`, "warning", endpointId);
      else if (Object.keys(operation.responses).length === 0) diagnostic("responses_empty", `${opPointer}/responses`, "warning", endpointId);
      else for (const [selector, rawResponse] of Object.entries(operation.responses).sort(([a], [b]) => a.localeCompare(b))) {
        const responsePointer = `${opPointer}/responses/${part(selector)}`;
        let status: Endpoint["responses"][number]["status"];
        if (selector === "default") status = {kind: "default"};
        else if (/^[1-5][0-9]{2}$/.test(selector)) status = {kind: "exact", code: Number(selector)};
        else if (/^[1-5]XX$/.test(selector)) status = {kind: "range", range: selector};
        else {diagnostic("response_selector_unsupported", responsePointer, "warning", endpointId); continue;}
        const resolved = local(rawResponse, "responses", responsePointer);
        if (!resolved) {endpoint.responses.push({status, content: []}); continue;}
        const response = resolved.value;
        const rp = resolved.pointer;
        noteUnknown(response, new Set(["description", "headers", "content", "links"]), rp);
        if (typeof response.description !== "string") diagnostic("response_description_missing", `${rp}/description`, "warning", endpointId);
        if (response.links !== undefined) diagnostic("response_links_unsupported", `${rp}/links`, "warning", endpointId);
        const content: Endpoint["responses"][number]["content"] = [];
        const headers: NonNullable<Endpoint["responses"][number]["headers"]> = [];
        if (response.content !== undefined) {
          if (!obj(response.content)) diagnostic("response_content_unsupported", `${rp}/content`, "warning", endpointId);
          else for (const [mediaType, rawMedia] of Object.entries(response.content).sort(([a], [b]) => a.localeCompare(b))) {
            const at = `${rp}/content/${part(mediaType)}`;
            if (!isMediaType(mediaType) || !obj(rawMedia)) {diagnostic("response_media_unsupported", at, "warning", endpointId); continue;}
            noteUnknown(rawMedia, allowedMedia, at);
            if (rawMedia.encoding !== undefined) diagnostic("response_encoding_unsupported", `${at}/encoding`, "warning", endpointId);
            const beforeSchema = result.diagnostics.length;
            const projected = rawMedia.schema === undefined ? undefined : projectSchema(rawMedia.schema, `${at}/schema`);
            const converted = projected ?? {};
            const schemaRepresentable = rawMedia.schema !== undefined && (profile === "3.1" ? projected !== undefined : result.diagnostics.length === beforeSchema);
            if (rawMedia.schema === undefined) diagnostic("response_schema_unknown", at, "warning", endpointId);
            content.push({media_type: mediaType, schema: converted, serialization: {format: mediaType}});
            claim("response.media.declaration", {status, media_type: mediaType}, at, endpoint, [responsePointer, ...resolved.chain]);
            if (schemaRepresentable) claim("response.schema.declaration", {status, media_type: mediaType, schema: converted},
              `${at}/schema`, endpoint, [responsePointer, ...resolved.chain]);
          }
        }
        if (response.headers !== undefined) {
          if (!obj(response.headers)) diagnostic("response_headers_unsupported", `${rp}/headers`, "warning", endpointId);
          else {
            const seenHeaders = new Set<string>();
            for (const [name, rawHeader] of Object.entries(response.headers).sort(([a], [b]) => a.localeCompare(b))) {
            const at = `${rp}/headers/${part(name)}`;
            const resolvedHeader = local(rawHeader, "headers", at);
            if (!resolvedHeader) continue;
            const header = resolvedHeader.value;
            noteUnknown(header, allowedParameter, resolvedHeader.pointer);
            if (!name || !/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name) || name.toLowerCase() === "content-type"
              || seenHeaders.has(name.toLowerCase())
              || header.content !== undefined || header.style !== undefined && header.style !== "simple"
              || header.explode !== undefined && header.explode !== false) {
              diagnostic("response_header_unsupported", at, "warning", endpointId); continue;
            }
            seenHeaders.add(name.toLowerCase());
            if (header.schema === undefined) {diagnostic("response_header_schema_unknown", at, "warning", endpointId); continue;}
            const beforeSchema = result.diagnostics.length;
            const converted = projectSchema(header.schema, `${resolvedHeader.pointer}/schema`);
            if (!converted) continue;
            if (result.diagnostics.length !== beforeSchema) continue;
            headers.push({name, schema: converted});
            claim("response.header.schema", {status, name, schema: converted}, at, endpoint, [responsePointer, ...resolved.chain, ...resolvedHeader.chain]);
          }
          }
        }
        endpoint.responses.push({status, content, ...(headers.length ? {headers} : {})});
        claim("response.status", status, responsePointer, endpoint);
        if (typeof response.description === "string") claim("response.description", {status, description: response.description}, `${rp}/description`, endpoint, resolved.chain);
      }
      if (!endpoint.responses.length) endpoint.responses.push({status: {kind: "unknown", reason: "document response unresolved"}, content: []});
      const securityPointer = operation.security !== undefined ? `${opPointer}/security` : "/security";
      const security = operation.security !== undefined ? operation.security : document.security;
      if (security !== undefined) {
        if (!Array.isArray(security) || security.some(x => !obj(x) || Object.values(x).some(scopes => !Array.isArray(scopes)
          || scopes.some(scope => typeof scope !== "string")))) diagnostic("security_declaration_unsupported", securityPointer, "warning", endpointId);
        else if (security.length === 0) {
          endpoint.security = {state: "anonymous", alternatives: [], evidence_ids: [evidence(securityPointer, endpointId)]};
          claim("security.declaration", [], securityPointer, endpoint);
        } else if (security.some(x => Object.keys(x).length === 0)) {
          diagnostic("optional_security_unsupported", securityPointer, "warning", endpointId);
          claim("security.declaration", security as Claim["value"], securityPointer, endpoint);
        } else {
          const alternatives = security.map(x => ({requirements: Object.entries(x).sort(([a], [b]) => a.localeCompare(b))
            .map(([scheme, scopes]) => ({scheme, scopes: scopes as string[]}))}));
          const representable = alternatives.every(a => a.requirements.every(r => result.security_schemes?.[r.scheme] !== undefined
            && (r.scopes.length === 0 || false)));
          if (representable) endpoint.security = {state: "declared", alternatives,
            evidence_ids: [evidence(securityPointer, endpointId)]};
          else diagnostic("security_mapping_unresolved", securityPointer, "warning", endpointId);
          claim("security.declaration", security as Claim["value"], securityPointer, endpoint,
            alternatives.flatMap(a => a.requirements.filter(r => Object.hasOwn(schemes, r.scheme))
              .map(r => `/components/securitySchemes/${part(r.scheme)}`)));
        }
      }
      const referenced = new Set<string>();
      const addRefs = (converted: ApiSchema) => {
        if (converted.$ref?.startsWith("#/schemas/")) {
          const id = converted.$ref.slice("#/schemas/".length);
          if (referenced.has(id)) return;
          referenced.add(id);
          const name = schemaNames.get(id);
          if (name && result.schemas[id]) {dependency(endpoint, "schema", id, [evidence(`/components/schemas/${part(name)}`)]); addRefs(result.schemas[id].schema);}
        }
        for (const child of Object.values(converted.properties ?? {})) addRefs(child);
        if (converted.items) addRefs(converted.items);
        if (profile === "3.1") for (const child of converted.prefixItems ?? []) addRefs(child);
        if (converted.not) addRefs(converted.not);
        if (obj(converted.additionalProperties)) addRefs(converted.additionalProperties as ApiSchema);
        for (const key of ["oneOf", "anyOf", "allOf"] as const) for (const child of converted[key] ?? []) addRefs(child);
      };
      for (const p of endpoint.parameters) addRefs(p.schema);
      for (const body of endpoint.request_bodies) addRefs(body.schema);
      for (const response of endpoint.responses) {
        for (const c of response.content) addRefs(c.schema);
        for (const h of response.headers ?? []) addRefs(h.schema);
      }
      result.endpoints.push(endpoint);
    }
  }
  return finish();
}
