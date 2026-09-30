import { parseContractSnapshot, type ApiSchema, type ContractSnapshot, type Endpoint } from "@api-truth/ir";
import { planOpenApiProjection } from "./index.js";

export type OpenApiCompileMode = "draft" | "strict";
export type OpenApiCompileDiagnostic = Readonly<{
  code: string;
  path: string;
  endpointIds: readonly string[];
}>;
export type OpenApiCompileResult = Readonly<{
  ok: boolean;
  document?: Readonly<Record<string, unknown>>;
  diagnostics: readonly OpenApiCompileDiagnostic[];
}>;

const ascii = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((a, b) => ascii(key(a), key(b)));
const pointer = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");
const params = /^(?::([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const qualifying = new Set(["runtime_validator", "deterministic_analysis", "behavioral_verification"]);
const constraintKeys = new Set(["enum", "const", "format", "pattern", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "additionalProperties"]);
const ignoredHeaderParameters = new Set(["authorization", "accept", "content-type"]);
const componentKey = /^[A-Za-z0-9._-]+$/;
const parameterStyles: Record<string, ReadonlySet<string>> = {
  path: new Set(["matrix", "label", "simple"]),
  query: new Set(["form", "spaceDelimited", "pipeDelimited", "deepObject"]),
  header: new Set(["simple"]),
  cookie: new Set(["form"]),
};

const openApiPath = (path: string): { path: string; names: string[] } => {
  const names: string[] = [];
  const segments = path.slice(1).split("/").map((segment) => {
    const match = params.exec(segment);
    if (match === null) return segment;
    const name = match[1] ?? match[2]!;
    names.push(name);
    return `{${name}}`;
  });
  return { path: path === "/" ? "/" : `/${segments.join("/")}`, names };
};

export const compileOpenApiSnapshot = (input: unknown, mode: OpenApiCompileMode): OpenApiCompileResult => {
  if (mode !== "draft" && mode !== "strict") throw new Error("Invalid OpenAPI compile mode");
  const parsed = parseContractSnapshot(input);
  if (!parsed.ok) throw new Error("Invalid contract snapshot");
  const snapshot: ContractSnapshot = parsed.value;
  const plan = planOpenApiProjection(snapshot);
  const diagnostics: OpenApiCompileDiagnostic[] = [];
  const add = (code: string, path: string, endpointIds: readonly string[] = []) => {
    diagnostics.push({ code, path, endpointIds: [...endpointIds].sort(ascii) });
  };
  const evidence = new Map(snapshot.evidence.map((item) => [item.evidence_id, item]));
  const hasQualifyingEvidence = (ids: readonly string[], endpointId?: string, exactEndpoint = false): boolean => ids.some((id) => {
    const fact = evidence.get(id);
    return fact !== undefined && qualifying.has(fact.method) && fact.limitations.length === 0
      && fact.scope.service_id === snapshot.service.service_id && fact.scope.snapshot_id === snapshot.snapshot_id
      && (endpointId === undefined ? fact.scope.endpoint_id === undefined
        : exactEndpoint ? fact.scope.endpoint_id === endpointId
          : fact.scope.endpoint_id === undefined || fact.scope.endpoint_id === endpointId);
  });
  const refs = (value: unknown, names: Set<string>) => {
    if (Array.isArray(value)) { value.forEach((item) => refs(item, names)); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/schemas/")) names.add(item.slice(10));
      else refs(item, names);
    }
  };
  const schemaUsers = new Map<string, Set<string>>();
  for (const endpoint of snapshot.endpoints) {
    const names = new Set<string>();
    refs(endpoint.parameters, names); refs(endpoint.request_bodies, names); refs(endpoint.responses, names);
    names.forEach((name) => {
      if (!schemaUsers.has(name)) schemaUsers.set(name, new Set());
      schemaUsers.get(name)!.add(endpoint.endpoint_id);
    });
  }
  // A component can reference another component; both inherit the endpoint's usage scope.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, fact] of Object.entries(snapshot.schemas)) {
      const users = schemaUsers.get(name);
      if (users === undefined) continue;
      const children = new Set<string>();
      refs(fact.schema, children);
      for (const child of children) {
        const childUsers = schemaUsers.get(child) ?? new Set<string>();
        const before = childUsers.size;
        users.forEach((user) => childUsers.add(user));
        if (childUsers.size !== before) changed = true;
        schemaUsers.set(child, childUsers);
      }
    }
  }
  const eligibleRequired = (endpointIds: readonly string[], fullPointer: string): boolean => {
    if (endpointIds.length !== 1) return false;
    const endpointId = endpointIds[0]!;
    // Only component paths are exact snapshot schema locations in this slice.
    if (!fullPointer.startsWith("/schemas/")) return false;
    return snapshot.export_eligibility.some((eligibility) => {
      if (eligibility.status !== "eligible" || !eligibility.scope.endpoint_ids.includes(endpointId)) return false;
      const claim = snapshot.claims.find((item) => item.claim_id === eligibility.claim_id);
      return claim !== undefined && claim.condition === undefined && claim.subject.endpoint_id === endpointId
        && claim.subject.schema_pointer === fullPointer && claim.predicate === "field_presence"
        && claim.value === "required" && hasQualifyingEvidence(eligibility.basis.evidence_ids, endpointId, true);
    });
  };
  const exportSchema = (schema: ApiSchema, path: string, endpointIds: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of sorted(Object.entries(schema), (entry) => entry[0])) {
      const childPath = `${path}/${pointer(key)}`;
      if (key === "$ref") { out.$ref = `#/components/schemas/${pointer(String(value).slice(10))}`; continue; }
      if (key === "required" && Array.isArray(value)) {
        const accepted = (value as string[]).filter((name) => eligibleRequired(endpointIds, `${path}/properties/${pointer(name)}`));
        if (accepted.length > 0) out.required = [...accepted].sort(ascii);
        if (accepted.length !== value.length) add("UNVERIFIED_SCHEMA_CONSTRAINT", childPath, endpointIds);
        continue;
      }
      if (constraintKeys.has(key)) { add("UNVERIFIED_SCHEMA_CONSTRAINT", childPath, endpointIds); continue; }
      if (key === "properties" && value && typeof value === "object") {
        out.properties = Object.fromEntries(sorted(Object.entries(value), (entry) => entry[0]).map(([name, child]) =>
          [name, exportSchema(child as ApiSchema, `${childPath}/${pointer(name)}`, endpointIds)]));
      } else if (key === "items" || key === "not") {
        out[key] = exportSchema(value as unknown as ApiSchema, childPath, endpointIds);
      } else if (["prefixItems", "oneOf", "anyOf", "allOf"].includes(key) && Array.isArray(value)) {
        out[key] = value.map((child, index) => exportSchema(child as ApiSchema, `${childPath}/${index}`, endpointIds));
      } else out[key] = value;
    }
    return out;
  };

  if (snapshot.coverage.status === "incomplete") add("INCOMPLETE_COVERAGE", "/coverage");
  plan.diagnostics.forEach((item) => add(item.code, "/endpoints", item.endpointIds));
  const reachableSchemas = (endpoint: Endpoint): Set<string> => {
    const names = new Set<string>();
    refs(endpoint.parameters, names); refs(endpoint.request_bodies, names); refs(endpoint.responses, names);
    const queue = [...names];
    while (queue.length > 0) {
      const name = queue.shift()!;
      const children = new Set<string>();
      refs(snapshot.schemas[name]?.schema, children);
      for (const child of children) if (!names.has(child)) { names.add(child); queue.push(child); }
    }
    return names;
  };
  const shapePaths = new Map<string, Set<string>>();
  for (const group of plan.groups) {
    if (group.kind !== "single") continue;
    const endpoint = snapshot.endpoints.find((item) => item.endpoint_id === group.endpointIds[0])!;
    const paths = shapePaths.get(group.pathShape) ?? new Set<string>();
    paths.add(openApiPath(endpoint.application_path).path);
    shapePaths.set(group.pathShape, paths);
  }
  const paths: Record<string, Record<string, unknown>> = {};
  const usedSecurity = new Set<string>();
  const usedSchemas = new Set<string>();
  for (const group of plan.groups) {
    if (group.kind !== "single") {
      add(group.kind === "variant_set" ? "VARIANT_REQUIRES_REPRESENTATION" : "SELECTOR_REQUIRES_REPRESENTATION",
        "/endpoints", group.endpointIds);
      continue;
    }
    const endpoint = snapshot.endpoints.find((item) => item.endpoint_id === group.endpointIds[0])!;
    const endpointPath = `/endpoints/${pointer(endpoint.endpoint_id)}`;
    const rendered = openApiPath(endpoint.application_path);
    if ((shapePaths.get(group.pathShape)?.size ?? 0) > 1) {
      add("CONFLICTING_PATH_PARAMETER_NAMES", `${endpointPath}/application_path`, [endpoint.endpoint_id]);
      continue;
    }
    const endpointSchemas = reachableSchemas(endpoint);
    if ([...endpointSchemas].some((name) => !componentKey.test(name))) {
      for (const name of [...endpointSchemas].filter((item) => !componentKey.test(item)).sort(ascii))
        add("INVALID_SCHEMA_COMPONENT_KEY", `/schemas/${pointer(name)}`, [endpoint.endpoint_id]);
      continue;
    }
    const pathParameters = endpoint.parameters.filter((item) => item.in === "path");
    if (rendered.names.some((name) => !pathParameters.some((item) => item.name === name && item.presence.state === "required"))
      || pathParameters.some((item) => !rendered.names.includes(item.name) || item.presence.state !== "required")) {
      add("UNREPRESENTABLE_PATH_PARAMETER", `${endpointPath}/parameters`, [endpoint.endpoint_id]);
      continue;
    }
    const operation: Record<string, unknown> = {};
    let skipOperation = false;
    const emittedParameters: Record<string, unknown>[] = [];
    const parameterKeys = new Set<string>();
    for (const parameter of sorted(endpoint.parameters, (item) => `${item.in}\0${item.name}`)) {
      const parameterKey = `${parameter.in}\0${parameter.name}`;
      if (parameterKeys.has(parameterKey)) {
        add("DUPLICATE_PARAMETER", `${endpointPath}/parameters/${pointer(parameter.name)}`, [endpoint.endpoint_id]);
        skipOperation = true;
        continue;
      }
      parameterKeys.add(parameterKey);
      if (parameter.in === "header" && ignoredHeaderParameters.has(parameter.name.toLowerCase())) {
        add("IGNORED_OPENAPI_HEADER_PARAMETER", `${endpointPath}/parameters/${pointer(parameter.name)}`, [endpoint.endpoint_id]);
        skipOperation = true;
        continue;
      }
      if (parameter.presence.state !== "required" && parameter.presence.state !== "optional") {
        add("UNKNOWN_PARAMETER_PRESENCE", `${endpointPath}/parameters/${pointer(parameter.name)}`, [endpoint.endpoint_id]);
        skipOperation = true;
        continue;
      }
      if (!hasQualifyingEvidence(parameter.presence.evidence_ids, endpoint.endpoint_id, true)) {
        add("UNVERIFIED_PARAMETER_PRESENCE", `${endpointPath}/parameters/${pointer(parameter.name)}/presence`, [endpoint.endpoint_id]);
        skipOperation = true;
      }
      const value: Record<string, unknown> = { name: parameter.name, in: parameter.in,
        required: parameter.in === "path" ? true : parameter.presence.state === "required",
        schema: exportSchema(parameter.schema, `${endpointPath}/parameters/${pointer(parameter.name)}/schema`, [endpoint.endpoint_id]) };
      if (parameter.serialization.style !== undefined) value.style = parameter.serialization.style;
      if (parameter.serialization.explode !== undefined) value.explode = parameter.serialization.explode;
      if (parameter.serialization.style === undefined || parameter.serialization.explode === undefined) {
        add("UNKNOWN_PARAMETER_SERIALIZATION", `${endpointPath}/parameters/${pointer(parameter.name)}/serialization`,
          [endpoint.endpoint_id]);
        skipOperation = true;
      }
      if (parameter.serialization.style !== undefined
        && !parameterStyles[parameter.in]!.has(parameter.serialization.style)
        || parameter.serialization.style === "deepObject"
          && (parameter.serialization.explode === false || parameter.schema.type !== "object")) {
        add("UNSUPPORTED_PARAMETER_STYLE", `${endpointPath}/parameters/${pointer(parameter.name)}/serialization`, [endpoint.endpoint_id]);
        skipOperation = true;
      }
      if (parameter.serialization.content_encoding !== undefined || parameter.serialization.format !== undefined)
        add("UNREPRESENTABLE_SERIALIZATION", `${endpointPath}/parameters/${pointer(parameter.name)}/serialization`, [endpoint.endpoint_id]);
      emittedParameters.push(value);
    }
    if (emittedParameters.length > 0) operation.parameters = emittedParameters;
    const body: Record<string, unknown> = {};
    const bodyStates = new Set<string>();
    for (const item of sorted(endpoint.request_bodies, (candidate) => candidate.media_type)) {
      if (item.media_type in body) {
        add("DUPLICATE_REQUEST_MEDIA_TYPE", `${endpointPath}/request_bodies/${pointer(item.media_type)}`, [endpoint.endpoint_id]);
        continue;
      }
      bodyStates.add(item.presence.state);
      if ((item.presence.state === "required" || item.presence.state === "optional")
        && !hasQualifyingEvidence(item.presence.evidence_ids, endpoint.endpoint_id, true)) {
        add("UNVERIFIED_REQUEST_BODY_PRESENCE", `${endpointPath}/request_bodies/${pointer(item.media_type)}/presence`,
          [endpoint.endpoint_id]);
        skipOperation = true;
      }
      body[item.media_type] = { schema: exportSchema(item.schema,
        `${endpointPath}/request_bodies/${pointer(item.media_type)}/schema`, [endpoint.endpoint_id]) };
      if (item.serialization.content_encoding !== undefined || item.serialization.style !== undefined
        || item.serialization.explode !== undefined
        || item.serialization.format !== undefined && !(item.serialization.format === "json" && item.media_type === "application/json"))
        add("UNREPRESENTABLE_SERIALIZATION",
        `${endpointPath}/request_bodies/${pointer(item.media_type)}/serialization`, [endpoint.endpoint_id]);
    }
    if (Object.keys(body).length > 0) {
      const requestBody: Record<string, unknown> = { content: body };
      if (bodyStates.size === 1 && bodyStates.has("required")) requestBody.required = true;
      else if (bodyStates.has("unknown") || bodyStates.has("conditional") || bodyStates.size > 1)
        { add("UNKNOWN_REQUEST_BODY_PRESENCE", `${endpointPath}/request_bodies`, [endpoint.endpoint_id]); skipOperation = true; }
      operation.requestBody = requestBody;
    }
    const responses: Record<string, Record<string, unknown>> = {};
    for (const response of endpoint.responses) {
      const status = response.status.kind === "exact" ? String(response.status.code)
        : response.status.kind === "range" ? response.status.range : response.status.kind === "default" ? "default" : undefined;
      if (status === undefined) { add("UNKNOWN_RESPONSE_STATUS", `${endpointPath}/responses`, [endpoint.endpoint_id]); continue; }
      if (responses[status]) { add("DUPLICATE_RESPONSE_STATUS", `${endpointPath}/responses/${status}`, [endpoint.endpoint_id]); continue; }
      const exported: Record<string, unknown> = { description: "" };
      if (response.content.length > 0) {
        const content: Record<string, unknown> = {};
        for (const item of sorted(response.content, (candidate) => candidate.media_type)) {
          const itemPath = `${endpointPath}/responses/${status}/content/${pointer(item.media_type)}`;
          if (item.media_type in content) { add("DUPLICATE_RESPONSE_MEDIA_TYPE", itemPath, [endpoint.endpoint_id]); continue; }
          content[item.media_type] = { schema: exportSchema(item.schema, `${itemPath}/schema`, [endpoint.endpoint_id]) };
          if (item.serialization.content_encoding !== undefined || item.serialization.style !== undefined
            || item.serialization.explode !== undefined
            || item.serialization.format !== undefined && !(item.serialization.format === "json" && item.media_type === "application/json"))
            add("UNREPRESENTABLE_SERIALIZATION", `${itemPath}/serialization`, [endpoint.endpoint_id]);
        }
        exported.content = content;
      }
      if (response.headers?.length) {
        const headers: Record<string, unknown> = {};
        for (const item of sorted(response.headers, (candidate) => candidate.name.toLowerCase())) {
          const itemPath = `${endpointPath}/responses/${status}/headers/${pointer(item.name)}`;
          if (Object.keys(headers).some((name) => name.toLowerCase() === item.name.toLowerCase())) {
            add("DUPLICATE_RESPONSE_HEADER", itemPath, [endpoint.endpoint_id]); continue;
          }
          headers[item.name] = { schema: exportSchema(item.schema, `${itemPath}/schema`, [endpoint.endpoint_id]) };
        }
        exported.headers = headers;
      }
      responses[status] = exported;
    }
    if (Object.keys(responses).length === 0) { add("NO_KNOWN_RESPONSE", `${endpointPath}/responses`, [endpoint.endpoint_id]); continue; }
    if (!hasQualifyingEvidence(endpoint.evidence_ids, endpoint.endpoint_id, true)) {
      add("UNVERIFIED_RESPONSE", `${endpointPath}/responses`, [endpoint.endpoint_id]);
      skipOperation = true;
    }
    operation.responses = Object.fromEntries(sorted(Object.entries(responses), (entry) => entry[0]));
    const security = endpoint.security;
    if (security.state === "anonymous" || security.state === "declared") {
      const schemeNames = security.alternatives.flatMap((alternative) => alternative.requirements.map((item) => item.scheme));
      const securityEvidenceGood = hasQualifyingEvidence(security.evidence_ids ?? [], endpoint.endpoint_id)
        && schemeNames.every((name) => hasQualifyingEvidence(snapshot.security_schemes?.[name]?.evidence_ids ?? []));
      if (!securityEvidenceGood) { add("UNVERIFIED_SECURITY", `${endpointPath}/security`, [endpoint.endpoint_id]); skipOperation = true; }
      else operation.security = security.state === "anonymous" ? [] : security.alternatives.map((alternative) =>
        Object.fromEntries(sorted(alternative.requirements, (item) => item.scheme)
          .map((item) => [item.scheme, [...item.scopes].sort(ascii)]))).sort((a, b) => ascii(JSON.stringify(a), JSON.stringify(b)));
    } else { add("UNKNOWN_SECURITY", `${endpointPath}/security`, [endpoint.endpoint_id]); skipOperation = true; }
    if (!skipOperation) {
      (paths[rendered.path] ??= {})[endpoint.identity.method.toLowerCase()] = operation;
      endpointSchemas.forEach((name) => usedSchemas.add(name));
      if (security.state === "declared") security.alternatives.flatMap((alternative) => alternative.requirements)
        .forEach((requirement) => usedSecurity.add(requirement.scheme));
    }
  }
  const schemas = Object.fromEntries(sorted(Object.entries(snapshot.schemas).filter(([name]) => usedSchemas.has(name)), (entry) => entry[0]).map(([name, fact]) =>
    [name, exportSchema(fact.schema, `/schemas/${pointer(name)}/schema`, [...(schemaUsers.get(name) ?? [])].sort(ascii))]));
  for (const name of [...usedSchemas].sort(ascii)) {
    const users = [...(schemaUsers.get(name) ?? [])].sort(ascii);
    if (!hasQualifyingEvidence(snapshot.schemas[name]!.evidence_ids, users.length === 1 ? users[0] : undefined))
      add("UNVERIFIED_SCHEMA", `/schemas/${pointer(name)}`, users);
  }
  const securitySchemes = Object.fromEntries([...usedSecurity].sort(ascii).map((name) =>
    [name, snapshot.security_schemes![name]!.definition]));
  const components: Record<string, unknown> = {};
  if (Object.keys(schemas).length > 0) components.schemas = schemas;
  if (Object.keys(securitySchemes).length > 0) components.securitySchemes = securitySchemes;
  const document: Record<string, unknown> = { openapi: "3.1.0", info: { title: snapshot.service.label ?? snapshot.service.service_id,
    version: snapshot.source.immutable_revision }, paths: Object.fromEntries(sorted(Object.entries(paths), (entry) => entry[0])) };
  if (Object.keys(components).length > 0) document.components = components;
  diagnostics.sort((a, b) => ascii(a.path, b.path) || ascii(a.code, b.code)
    || ascii(a.endpointIds.join("\0"), b.endpointIds.join("\0")));
  return { ok: mode === "draft" || diagnostics.length === 0,
    ...(mode === "strict" && diagnostics.length > 0 ? {} : { document }), diagnostics };
};
