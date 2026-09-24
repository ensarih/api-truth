import {
  IDENTITY_VERSION,
  deriveEndpointIdentity,
  issue,
  parseContractSnapshot,
  type ContractSnapshot,
  type Endpoint,
  type JsonValue,
  type ValidationIssue,
} from "@api-truth/ir";
import { canonicalJson, canonicalSha256Hex, compareUtf8 } from "./canonical.js";
import { UpdateError, updateValidationError } from "./errors.js";
import {
  parseContractDifferenceSet,
  type ContractDifference,
  type ContractDifferenceSet,
  type DifferenceSubject,
} from "./schema.js";
import {
  CONTRACT_DIFFERENCE_VERSION,
  DIFFERENCE_KINDS,
  type CompatibilityLabel,
  type DifferenceIncompleteReason,
  type DifferenceKind,
} from "./types.js";

type ComparisonInput = {
  base_snapshot: ContractSnapshot;
  target_snapshot: ContractSnapshot;
};

type DifferenceDraft = {
  kind: DifferenceKind;
  compatibility: CompatibilityLabel;
  subject: DifferenceSubject;
  before?: JsonValue;
  after?: JsonValue;
};

const immutableRevision = /^[a-fA-F0-9]{12,128}$/;

const prefixedIssues = (prefix: string, issues: readonly ValidationIssue[]): ValidationIssue[] =>
  issues.map((candidate) => issue(
    `${prefix}${candidate.path === "/" ? "" : candidate.path}`,
    candidate.code,
    "nested snapshot is invalid",
  ));

const incompatible = (issues: ValidationIssue[]): never => {
  throw updateValidationError("UPDATE_COMPARISON_INCOMPATIBLE", {
    kind: "validation_error",
    issues,
  });
};

const plainComparisonInput = (value: unknown): ComparisonInput => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(canonicalJson(value));
  } catch {
    throw new UpdateError("UPDATE_COMPARISON_INCOMPATIBLE", {
      issues: [{ path: "/", code: "shape.invalid_json_value" }],
    });
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return incompatible([issue("/", "shape.type", "comparison input must be an object")]);
  }
  const record = candidate as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("base_snapshot") || !keys.includes("target_snapshot")) {
    return incompatible([issue("/", "shape.additionalProperties", "comparison input has an unsupported shape")]);
  }
  return record as ComparisonInput;
};

const validateFutureIdentitySnapshot = (
  candidate: Record<string, unknown>,
  prefix: string,
): ContractSnapshot => {
  const declaredVersion = candidate.identity_version;
  if (typeof declaredVersion !== "string" || declaredVersion.length === 0 || !Array.isArray(candidate.endpoints)) {
    return incompatible([issue(`${prefix}/identity_version`, "shape.type", "identity version must be nonempty")]);
  }
  const normalized = structuredClone(candidate) as Record<string, any>;
  normalized.identity_version = IDENTITY_VERSION;
  const identityIssues: ValidationIssue[] = [];
  normalized.endpoints = candidate.endpoints.map((rawEndpoint, index) => {
    if (rawEndpoint === null || typeof rawEndpoint !== "object" || Array.isArray(rawEndpoint)) return rawEndpoint;
    const endpoint = rawEndpoint as Record<string, any>;
    const identity = endpoint.identity;
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)
      || identity.identity_version !== declaredVersion) {
      identityIssues.push(issue(
        `${prefix}/endpoints/${index}/identity/identity_version`,
        "semantic.identity_mismatch",
        "endpoint identity version differs from snapshot identity version",
      ));
      return rawEndpoint;
    }
    try {
      const derived = deriveEndpointIdentity({
        identity_version: IDENTITY_VERSION,
        service_id: identity.service_id,
        method: identity.method,
        application_path: endpoint.application_path,
        selectors: identity.selectors,
      });
      const expectedFutureRouteKey = `${declaredVersion}${derived.route_key.slice(IDENTITY_VERSION.length)}`;
      if (identity.route_key !== expectedFutureRouteKey
        || identity.normalized_path_shape !== derived.normalized_path_shape
        || canonicalJson(identity.selectors) !== canonicalJson(derived.selectors)) {
        identityIssues.push(issue(
          `${prefix}/endpoints/${index}/identity`,
          "semantic.identity_mismatch",
          "future endpoint route identity is inconsistent",
        ));
      }
      return { ...endpoint, identity: derived };
    } catch {
      identityIssues.push(issue(
        `${prefix}/endpoints/${index}/identity`,
        "semantic.identity_mismatch",
        "future endpoint route identity is invalid",
      ));
      return rawEndpoint;
    }
  });
  if (identityIssues.length > 0) return incompatible(identityIssues);
  const parsed = parseContractSnapshot(normalized);
  if (!parsed.ok) return incompatible(prefixedIssues(prefix, parsed.error.issues));
  return candidate as unknown as ContractSnapshot;
};

const validateSnapshot = (value: unknown, prefix: "/base_snapshot" | "/target_snapshot"): ContractSnapshot => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.identity_version !== IDENTITY_VERSION) {
      return validateFutureIdentitySnapshot(candidate, prefix);
    }
  }
  const parsed = parseContractSnapshot(value);
  if (!parsed.ok) return incompatible(prefixedIssues(prefix, parsed.error.issues));
  return parsed.value;
};

const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());

const statusKey = (status: Endpoint["responses"][number]["status"]): string => {
  if (status.kind === "exact") return canonicalJson(["exact", status.code]);
  if (status.kind === "range") return canonicalJson(["range", status.range]);
  if (status.kind === "default") return canonicalJson(["default"]);
  return canonicalJson(["unknown", status.reason]);
};

const duplicateComparisonKeyIssues = (snapshot: ContractSnapshot, prefix: string): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  snapshot.endpoints.forEach((endpoint, endpointIndex) => {
    const parameterKeys = new Set<string>();
    endpoint.parameters.forEach((parameter, index) => {
      const key = canonicalJson([parameter.in, parameter.name]);
      if (parameterKeys.has(key)) issues.push(issue(
        `${prefix}/endpoints/${endpointIndex}/parameters/${index}`,
        "semantic.duplicate_comparison_key",
        "duplicate parameter comparison key",
      ));
      parameterKeys.add(key);
    });
    const bodyKeys = new Set<string>();
    endpoint.request_bodies.forEach((body, index) => {
      if (bodyKeys.has(body.media_type)) issues.push(issue(
        `${prefix}/endpoints/${endpointIndex}/request_bodies/${index}`,
        "semantic.duplicate_comparison_key",
        "duplicate request body comparison key",
      ));
      bodyKeys.add(body.media_type);
    });
    const contentByStatus = new Map<string, Set<string>>();
    const headersByStatus = new Map<string, Set<string>>();
    endpoint.responses.forEach((response, responseIndex) => {
      const key = statusKey(response.status);
      const contentKeys = contentByStatus.get(key) ?? new Set<string>();
      response.content.forEach((content, index) => {
        if (contentKeys.has(content.media_type)) issues.push(issue(
          `${prefix}/endpoints/${endpointIndex}/responses/${responseIndex}/content/${index}`,
          "semantic.duplicate_comparison_key",
          "duplicate response content comparison key",
        ));
        contentKeys.add(content.media_type);
      });
      contentByStatus.set(key, contentKeys);
      const headerKeys = headersByStatus.get(key) ?? new Set<string>();
      (response.headers ?? []).forEach((header, index) => {
        const headerKey = asciiLower(header.name);
        if (headerKeys.has(headerKey)) issues.push(issue(
          `${prefix}/endpoints/${endpointIndex}/responses/${responseIndex}/headers/${index}`,
          "semantic.duplicate_comparison_key",
          "duplicate response header comparison key",
        ));
        headerKeys.add(headerKey);
      });
      headersByStatus.set(key, headerKeys);
    });
  });
  return issues;
};

const uniqueSorted = <Value>(values: readonly Value[], key: (value: Value) => string): Value[] => {
  const byKey = new Map(values.map((value) => [key(value), value]));
  return [...byKey.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([, value]) => value);
};

const canonicalStrings = (values: readonly string[]): string[] =>
  uniqueSorted(values, (value) => value);

const canonicalSchema = (value: unknown): any => {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (value === null || typeof value !== "object") return value;
  const schema = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, canonicalSchema(child)]));
  if (Array.isArray(schema.type)) schema.type = canonicalStrings(schema.type);
  if (Array.isArray(schema.required)) schema.required = canonicalStrings(schema.required);
  if (Array.isArray(schema.enum)) schema.enum = uniqueSorted(schema.enum, canonicalJson);
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[keyword])) schema[keyword] = uniqueSorted(schema[keyword], canonicalJson);
  }
  return schema;
};

const canonicalCondition = (value: any): any => {
  const condition = structuredClone(value);
  condition.affected_schema_paths = canonicalStrings(condition.affected_schema_paths);
  if (Array.isArray(condition.operands)) {
    condition.operands = condition.operands.map(canonicalCondition);
    if (condition.operator === "and" || condition.operator === "or") {
      condition.operands = uniqueSorted(condition.operands, canonicalJson);
    }
  }
  return condition;
};

const presenceProjection = (presence: Endpoint["parameters"][number]["presence"]): any =>
  presence.state === "conditional"
    ? { state: presence.state, condition: canonicalCondition(presence.condition) }
    : { state: presence.state };

const endpointProjection = (endpoint: Endpoint): JsonValue => {
  const parameters = endpoint.parameters.map((parameter) => ({
    name: parameter.name,
    in: parameter.in,
    presence: presenceProjection(parameter.presence),
    schema: canonicalSchema(parameter.schema),
    serialization: structuredClone(parameter.serialization),
  })).sort((left, right) => compareUtf8(
    canonicalJson([left.in, left.name]),
    canonicalJson([right.in, right.name]),
  ));
  const requestBodies = endpoint.request_bodies.map((body) => ({
    media_type: body.media_type,
    presence: presenceProjection(body.presence),
    schema: canonicalSchema(body.schema),
    serialization: structuredClone(body.serialization),
  })).sort((left, right) => compareUtf8(left.media_type, right.media_type));
  const responsesByStatus = new Map<string, {
    status: Endpoint["responses"][number]["status"];
    content: Array<Record<string, unknown>>;
    headers: Array<Record<string, unknown>>;
  }>();
  endpoint.responses.forEach((response) => {
    const key = statusKey(response.status);
    const group = responsesByStatus.get(key) ?? {
      status: structuredClone(response.status),
      content: [],
      headers: [],
    };
    group.content.push(...response.content.map((content) => ({
      media_type: content.media_type,
      schema: canonicalSchema(content.schema),
      serialization: structuredClone(content.serialization),
    })));
    group.headers.push(...(response.headers ?? []).map((header) => ({
      name: asciiLower(header.name),
      schema: canonicalSchema(header.schema),
    })));
    responsesByStatus.set(key, group);
  });
  const responses = [...responsesByStatus.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([, group]) => ({
      status: group.status,
      content: group.content.sort((left, right) =>
        compareUtf8(String(left.media_type), String(right.media_type))),
      ...(group.headers.length === 0 ? {} : {
        headers: group.headers.sort((left, right) =>
          compareUtf8(String(left.name), String(right.name))),
      }),
    }));
  const alternatives = uniqueSorted(endpoint.security.alternatives.map((alternative) => {
    const scopesByScheme = new Map<string, string[]>();
    alternative.requirements.forEach((requirement) => {
      scopesByScheme.set(requirement.scheme, [
        ...(scopesByScheme.get(requirement.scheme) ?? []),
        ...requirement.scopes,
      ]);
    });
    return {
      requirements: [...scopesByScheme.entries()]
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([scheme, scopes]) => ({ scheme, scopes: canonicalStrings(scopes) })),
    };
  }), canonicalJson);
  return {
    endpoint_id: endpoint.endpoint_id,
    identity: structuredClone(endpoint.identity),
    method: endpoint.identity.method,
    application_path: endpoint.application_path,
    parameters,
    request_bodies: requestBodies,
    responses,
    security: { alternatives },
  } as JsonValue;
};

const routeIdentityKey = (endpoint: Endpoint): string => canonicalJson({
  route_key: endpoint.identity.route_key,
  service_id: endpoint.identity.service_id,
  method: endpoint.identity.method,
  normalized_path_shape: endpoint.identity.normalized_path_shape,
  selectors: endpoint.identity.selectors,
});

const pathParameterNames = (path: string): string[] => {
  const names: string[] = [];
  let index = 0;
  while (index < path.length) {
    if (path[index] === "{") {
      const end = path.indexOf("}", index + 1);
      const body = path.slice(index + 1, end);
      names.push(body.split(":", 1)[0]!);
      index = end + 1;
    } else if (path[index] === ":") {
      const match = path.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (match !== null) {
        names.push(match[0]);
        index += match[0].length + 1;
      } else index += 1;
    } else index += 1;
  }
  return canonicalStrings(names);
};

const endpointSubject = (serviceId: string, endpointId: string): DifferenceSubject => ({
  service_id: serviceId,
  endpoint_id: endpointId,
  fact_kind: "endpoint",
  fact_key: canonicalJson(["endpoint", endpointId]),
});

const difference = (
  base: ContractSnapshot,
  target: ContractSnapshot,
  draft: DifferenceDraft,
): ContractDifference => {
  const identityContent = {
    version: CONTRACT_DIFFERENCE_VERSION,
    service_id: base.service.service_id,
    base_snapshot_id: base.snapshot_id,
    target_snapshot_id: target.snapshot_id,
    kind: draft.kind,
    subject: draft.subject,
    ...(draft.before === undefined ? {} : { before: draft.before }),
    ...(draft.after === undefined ? {} : { after: draft.after }),
  };
  return {
    difference_id: `difference-${canonicalSha256Hex(identityContent)}`,
    ...draft,
  } as ContractDifference;
};

const sortDifferences = (differences: ContractDifference[]): ContractDifference[] =>
  differences.sort((left, right) => {
    const keys = (candidate: ContractDifference): string[] => [
      candidate.subject.endpoint_id ?? "",
      candidate.subject.component_id ?? "",
      canonicalJson(candidate.subject.affected_endpoint_ids ?? []),
      candidate.subject.fact_kind ?? "",
      candidate.subject.fact_key ?? "",
      String(DIFFERENCE_KINDS.indexOf(candidate.kind)).padStart(3, "0"),
      candidate.difference_id,
    ];
    const leftKeys = keys(left);
    const rightKeys = keys(right);
    for (let index = 0; index < leftKeys.length; index += 1) {
      const compared = compareUtf8(leftKeys[index]!, rightKeys[index]!);
      if (compared !== 0) return compared;
    }
    return 0;
  });

const scopeIssues = (base: ContractSnapshot, target: ContractSnapshot): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  if (base.service.repository_id !== target.service.repository_id) {
    issues.push(issue("/target_snapshot/service/repository_id", "semantic.scope_mismatch", "repository differs"));
  }
  if (base.service.service_id !== target.service.service_id) {
    issues.push(issue("/target_snapshot/service/service_id", "semantic.scope_mismatch", "service differs"));
  }
  if (base.service.root !== target.service.root) {
    issues.push(issue("/target_snapshot/service/root", "semantic.scope_mismatch", "service root differs"));
  }
  return issues;
};

export const compareContractSnapshots = (value: unknown): ContractDifferenceSet => {
  const input = plainComparisonInput(value);
  const base = validateSnapshot(input.base_snapshot, "/base_snapshot");
  const target = validateSnapshot(input.target_snapshot, "/target_snapshot");
  const incompatibilities = [
    ...scopeIssues(base, target),
    ...duplicateComparisonKeyIssues(base, "/base_snapshot"),
    ...duplicateComparisonKeyIssues(target, "/target_snapshot"),
  ];
  if (!immutableRevision.test(base.source.immutable_revision)) {
    incompatibilities.push(issue("/base_snapshot/source/immutable_revision", "shape.pattern", "revision cannot be represented"));
  }
  if (!immutableRevision.test(target.source.immutable_revision)) {
    incompatibilities.push(issue("/target_snapshot/source/immutable_revision", "shape.pattern", "revision cannot be represented"));
  }
  if (incompatibilities.length > 0) return incompatible(incompatibilities);

  const incompleteReasons: DifferenceIncompleteReason[] = [];
  if (base.coverage.status === "incomplete") incompleteReasons.push("base_coverage_incomplete");
  if (target.coverage.status === "incomplete") incompleteReasons.push("target_coverage_incomplete");
  const drafts: DifferenceDraft[] = [];

  if (base.identity_version !== target.identity_version) {
    incompleteReasons.push("identity_version_changed");
    drafts.push({
      kind: "analysis.identity_changed",
      compatibility: "unknown",
      subject: {
        service_id: base.service.service_id,
        fact_kind: "identity",
        fact_key: canonicalJson(["identity"]),
      },
    });
  } else {
    const baseById = new Map(base.endpoints.map((endpoint) => [endpoint.endpoint_id, endpoint]));
    const targetById = new Map(target.endpoints.map((endpoint) => [endpoint.endpoint_id, endpoint]));
    const endpointIds = canonicalStrings([...baseById.keys(), ...targetById.keys()]);
    for (const endpointId of endpointIds) {
      const before = baseById.get(endpointId);
      const after = targetById.get(endpointId);
      const subject = endpointSubject(base.service.service_id, endpointId);
      if (before === undefined && after !== undefined) {
        drafts.push({
          kind: "endpoint.added",
          compatibility: "non_breaking",
          subject,
          after: endpointProjection(after),
        });
        continue;
      }
      if (before !== undefined && after === undefined) {
        drafts.push({
          kind: target.coverage.status === "complete" ? "endpoint.removed" : "endpoint.absence_unconfirmed",
          compatibility: target.coverage.status === "complete" ? "potentially_breaking" : "unknown",
          subject,
          before: endpointProjection(before),
        });
        continue;
      }
      if (before === undefined || after === undefined) continue;
      if (routeIdentityKey(before) !== routeIdentityKey(after)) {
        drafts.push({
          kind: "endpoint.added",
          compatibility: "non_breaking",
          subject,
          after: endpointProjection(after),
        });
        drafts.push({
          kind: target.coverage.status === "complete" ? "endpoint.removed" : "endpoint.absence_unconfirmed",
          compatibility: target.coverage.status === "complete" ? "potentially_breaking" : "unknown",
          subject,
          before: endpointProjection(before),
        });
        continue;
      }
      const beforeNames = pathParameterNames(before.application_path);
      const afterNames = pathParameterNames(after.application_path);
      if (canonicalJson(beforeNames) !== canonicalJson(afterNames)) {
        drafts.push({
          kind: "endpoint.path_parameter_names_changed",
          compatibility: "potentially_breaking",
          subject,
          before: beforeNames,
          after: afterNames,
        });
      }
    }
  }

  const differences = sortDifferences(drafts.map((draft) => difference(base, target, draft)));
  const content = {
    contract_difference_version: CONTRACT_DIFFERENCE_VERSION,
    service_id: base.service.service_id,
    base: { snapshot_id: base.snapshot_id, immutable_revision: base.source.immutable_revision },
    target: { snapshot_id: target.snapshot_id, immutable_revision: target.source.immutable_revision },
    comparison_status: incompleteReasons.length === 0 ? "complete" as const : "incomplete" as const,
    incomplete_reason_codes: incompleteReasons,
    differences,
  };
  const result: ContractDifferenceSet = {
    difference_set_id: `difference-set-${canonicalSha256Hex(content)}`,
    ...content,
  };
  const parsed = parseContractDifferenceSet(result);
  if (!parsed.ok) return incompatible(parsed.error.issues);
  return parsed.value;
};
