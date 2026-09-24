import {
  IDENTITY_VERSION,
  deriveEndpointIdentity,
  issue,
  parseContractSnapshot,
  type ContractSnapshot,
  type Claim,
  type Endpoint,
  type JsonValue,
  type ValidationIssue,
} from "@api-truth/ir";
import { canonicalJson, canonicalSha256Hex, compareUtf8 } from "./canonical.js";
import { UpdateError, updateValidationError } from "./errors.js";
import {
  parseContractDifferenceSet,
  type ClaimConditionAssignment,
  type ContractCondition,
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
import { buildEndpointOwnershipIndex } from "./planner.js";

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
  const diagnosticKeys = new Set<string>();
  snapshot.diagnostics.forEach((diagnostic, index) => {
    const affectedEndpointIds = canonicalStrings(diagnostic.affected_endpoint_ids);
    const key = canonicalJson([diagnostic.code, affectedEndpointIds]);
    if (diagnosticKeys.has(key)) issues.push(issue(
      `${prefix}/diagnostics/${index}`,
      "semantic.duplicate_comparison_key",
      "duplicate diagnostic comparison key",
    ));
    diagnosticKeys.add(key);
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

const canonicalCondition = (value: ContractCondition): ContractCondition => {
  const condition = structuredClone(value) as any;
  condition.affected_schema_paths = canonicalStrings(condition.affected_schema_paths);
  if (Array.isArray(condition.operands)) {
    condition.operands = condition.operands.map(canonicalCondition);
    if (condition.operator === "and" || condition.operator === "or") {
      condition.operands = uniqueSorted(condition.operands, canonicalJson);
    }
  }
  return JSON.parse(canonicalJson(condition)) as ContractCondition;
};

const canonicalJsonValue = (value: JsonValue): JsonValue =>
  JSON.parse(canonicalJson(value)) as JsonValue;

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

type Parameter = Endpoint["parameters"][number];
type RequestBody = Endpoint["request_bodies"][number];
type Response = Endpoint["responses"][number];

const parameterKey = (parameter: Parameter): string => canonicalJson([parameter.in, parameter.name]);
const parameterProjection = (parameter: Parameter): JsonValue => ({
  name: parameter.name,
  in: parameter.in,
  presence: presenceProjection(parameter.presence),
  schema: canonicalSchema(parameter.schema),
  serialization: structuredClone(parameter.serialization),
});

const bodyProjection = (body: RequestBody): JsonValue => ({
  media_type: body.media_type,
  presence: presenceProjection(body.presence),
  schema: canonicalSchema(body.schema),
  serialization: structuredClone(body.serialization),
});

type ResponseGroup = {
  status: Response["status"];
  content: Array<{ media_type: string; schema: any; serialization: Record<string, unknown> }>;
  headers: Array<{ name: string; schema: any }>;
};

const responseGroups = (endpoint: Endpoint): Map<string, ResponseGroup> => {
  const groups = new Map<string, ResponseGroup>();
  for (const response of endpoint.responses) {
    const key = statusKey(response.status);
    const group = groups.get(key) ?? {
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
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.content.sort((left, right) => compareUtf8(left.media_type, right.media_type));
    group.headers.sort((left, right) => compareUtf8(left.name, right.name));
  }
  return groups;
};

const responseProjection = (group: ResponseGroup): JsonValue => ({
  status: structuredClone(group.status),
  content: group.content,
  ...(group.headers.length === 0 ? {} : { headers: group.headers }),
}) as unknown as JsonValue;

const securityProjection = (endpoint: Endpoint): JsonValue =>
  (endpointProjection(endpoint) as Record<string, JsonValue>).security!;

const presenceState = (fact: Parameter | RequestBody): string => fact.presence.state;

const changedMemberCompatibility = (
  before: Parameter | RequestBody,
  after: Parameter | RequestBody,
): CompatibilityLabel => {
  const beforeState = presenceState(before);
  const afterState = presenceState(after);
  const otherwiseEqual = canonicalJson({
    schema: canonicalSchema(before.schema),
    serialization: before.serialization,
  }) === canonicalJson({
    schema: canonicalSchema(after.schema),
    serialization: after.serialization,
  });
  if (!otherwiseEqual) return "potentially_breaking";
  if (beforeState === "unknown" || afterState === "unknown") return "unknown";
  if (beforeState === "optional" && (afterState === "required" || afterState === "conditional")) {
    return "potentially_breaking";
  }
  if ((beforeState === "required" || beforeState === "conditional") && afterState === "optional") {
    return "non_breaking";
  }
  return "potentially_breaking";
};

const addedMemberCompatibility = (fact: Parameter | RequestBody): CompatibilityLabel => {
  if (fact.presence.state === "optional") return "non_breaking";
  if (fact.presence.state === "unknown") return "unknown";
  return "potentially_breaking";
};

const factSubject = (
  serviceId: string,
  endpointId: string,
  factKind: "parameter" | "request_body" | "response" | "security",
  tail: JsonValue[] = [],
): DifferenceSubject => ({
  service_id: serviceId,
  endpoint_id: endpointId,
  fact_kind: factKind,
  fact_key: canonicalJson([factKind, endpointId, ...tail]),
});

type ClaimMemberProjection = {
  value: JsonValue;
  verification: Claim["verification"];
  condition?: ContractCondition;
};

type ClaimOwner = {
  serviceId: string;
  endpointId: string | null;
  schemaPointer: string | null;
  predicate: string;
};

type ClaimPartition = {
  value: JsonValue;
  verification: Claim["verification"];
  members: Array<ContractCondition | null>;
};

const claimOwnerKey = (claim: Claim): string => canonicalJson([
  claim.subject.service_id,
  claim.subject.endpoint_id ?? null,
  claim.subject.schema_pointer ?? null,
  claim.predicate,
]);

const claimOwner = (claim: Claim): ClaimOwner => ({
  serviceId: claim.subject.service_id,
  endpointId: claim.subject.endpoint_id ?? null,
  schemaPointer: claim.subject.schema_pointer ?? null,
  predicate: claim.predicate,
});

const claimPartitionKey = (claim: Claim): string => canonicalJson({
  value: claim.value,
  verification: claim.verification,
});

const claimMemberProjection = (
  value: JsonValue,
  verification: Claim["verification"],
  claimCondition: ContractCondition | null,
): ClaimMemberProjection => ({
  value: canonicalJsonValue(value),
  verification,
  ...(claimCondition === null ? {} : { condition: canonicalCondition(claimCondition) }),
});

const canonicalClaimMembers = (members: readonly ClaimMemberProjection[]): ClaimMemberProjection[] =>
  uniqueSorted(members, canonicalJson);

const canonicalAssignments = (
  assignments: readonly ClaimConditionAssignment[],
): ClaimConditionAssignment[] => uniqueSorted(assignments, canonicalJson);

const conditionAssignment = (
  partition: ClaimPartition,
  claimCondition: ContractCondition,
): ClaimConditionAssignment => ({
  value: canonicalJsonValue(partition.value),
  verification: partition.verification,
  condition: canonicalCondition(claimCondition),
});

const buildClaimPartitions = (claims: readonly Claim[]): Map<string, ClaimPartition> => {
  const partitions = new Map<string, ClaimPartition>();
  for (const candidate of claims) {
    const key = claimPartitionKey(candidate);
    const partition = partitions.get(key) ?? {
      value: canonicalJsonValue(candidate.value),
      verification: candidate.verification,
      members: [],
    };
    partition.members.push(candidate.condition === undefined ? null : canonicalCondition(candidate.condition));
    partitions.set(key, partition);
  }
  for (const partition of partitions.values()) {
    partition.members.sort((left, right) => compareUtf8(canonicalJson(left), canonicalJson(right)));
  }
  return partitions;
};

const cancelEqualConditions = (
  before: readonly (ContractCondition | null)[],
  after: readonly (ContractCondition | null)[],
): { before: Array<ContractCondition | null>; after: Array<ContractCondition | null> } => {
  const remainingBefore: Array<ContractCondition | null> = [];
  const remainingAfter: Array<ContractCondition | null> = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    const beforeKey = canonicalJson(before[beforeIndex]);
    const afterKey = canonicalJson(after[afterIndex]);
    const compared = compareUtf8(beforeKey, afterKey);
    if (compared === 0) {
      beforeIndex += 1;
      afterIndex += 1;
    } else if (compared < 0) {
      remainingBefore.push(before[beforeIndex]!);
      beforeIndex += 1;
    } else {
      remainingAfter.push(after[afterIndex]!);
      afterIndex += 1;
    }
  }
  remainingBefore.push(...before.slice(beforeIndex));
  remainingAfter.push(...after.slice(afterIndex));
  return { before: remainingBefore, after: remainingAfter };
};

const claimSubject = (owner: ClaimOwner): DifferenceSubject => ({
  service_id: owner.serviceId,
  ...(owner.endpointId === null ? {} : { endpoint_id: owner.endpointId }),
  fact_kind: "claim",
  fact_key: canonicalJson(["claim", owner.endpointId, owner.schemaPointer, owner.predicate]),
});

const conditionSubject = (owner: ClaimOwner): DifferenceSubject => ({
  service_id: owner.serviceId,
  ...(owner.endpointId === null ? {} : { endpoint_id: owner.endpointId }),
  fact_kind: "condition_group",
  fact_key: canonicalJson([
    "condition_group",
    "claim",
    owner.endpointId,
    owner.schemaPointer,
    owner.predicate,
  ]),
});

const projectClaimGroup = (claims: readonly Claim[]): ClaimMemberProjection[] =>
  canonicalClaimMembers(claims.map((candidate) => claimMemberProjection(
    candidate.value,
    candidate.verification,
    candidate.condition === undefined ? null : candidate.condition,
  )));

const changedClaimCompatibility = (
  owner: ClaimOwner,
  before: readonly ClaimMemberProjection[],
  after: readonly ClaimMemberProjection[],
): CompatibilityLabel => {
  if (owner.predicate !== "request.field.presence" || before.length !== 1 || after.length !== 1) {
    return "unknown";
  }
  const oldMember = before[0]!;
  const newMember = after[0]!;
  const otherwiseEqual = oldMember.verification === newMember.verification
    && canonicalJson(oldMember.condition ?? null) === canonicalJson(newMember.condition ?? null);
  if (!otherwiseEqual || typeof oldMember.value !== "string" || typeof newMember.value !== "string") {
    return "unknown";
  }
  if (oldMember.value === "optional"
    && (newMember.value === "required" || newMember.value === "conditional")) {
    return "potentially_breaking";
  }
  if ((oldMember.value === "required" || oldMember.value === "conditional")
    && newMember.value === "optional") {
    return "non_breaking";
  }
  return "unknown";
};

const addClaimDrafts = (
  drafts: DifferenceDraft[],
  base: ContractSnapshot,
  target: ContractSnapshot,
): void => {
  const baseEndpoints = new Map(base.endpoints.map((candidate) => [candidate.endpoint_id, candidate]));
  const targetEndpoints = new Map(target.endpoints.map((candidate) => [candidate.endpoint_id, candidate]));
  const discontinuousEndpointIds = new Set<string>();
  for (const [endpointId, baseEndpoint] of baseEndpoints) {
    const targetEndpoint = targetEndpoints.get(endpointId);
    if (targetEndpoint !== undefined && routeIdentityKey(baseEndpoint) !== routeIdentityKey(targetEndpoint)) {
      discontinuousEndpointIds.add(endpointId);
    }
  }
  const groupClaims = (claims: readonly Claim[], side: "base" | "target"): Map<string, Claim[]> => {
    const groups = new Map<string, Claim[]>();
    for (const candidate of claims) {
      const ownerKey = claimOwnerKey(candidate);
      const key = candidate.subject.endpoint_id !== undefined
        && discontinuousEndpointIds.has(candidate.subject.endpoint_id)
        ? canonicalJson([ownerKey, side])
        : ownerKey;
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    return groups;
  };
  const baseGroups = groupClaims(base.claims, "base");
  const targetGroups = groupClaims(target.claims, "target");
  for (const ownerKey of canonicalStrings([...baseGroups.keys(), ...targetGroups.keys()])) {
    const oldClaims = baseGroups.get(ownerKey) ?? [];
    const newClaims = targetGroups.get(ownerKey) ?? [];
    const sample = oldClaims[0] ?? newClaims[0]!;
    const owner = claimOwner(sample);
    const subject = claimSubject(owner);
    if (oldClaims.length === 0) {
      drafts.push({
        kind: "claim.added",
        compatibility: "unknown",
        subject,
        after: projectClaimGroup(newClaims),
      });
      continue;
    }
    if (newClaims.length === 0) {
      drafts.push({
        kind: target.coverage.status === "incomplete" ? "fact.absence_unconfirmed" : "claim.removed",
        compatibility: "unknown",
        subject,
        before: projectClaimGroup(oldClaims),
      });
      continue;
    }

    const basePartitions = buildClaimPartitions(oldClaims);
    const targetPartitions = buildClaimPartitions(newClaims);
    const addedAssignments: ClaimConditionAssignment[] = [];
    const removedAssignments: ClaimConditionAssignment[] = [];
    const changedBeforeAssignments: ClaimConditionAssignment[] = [];
    const changedAfterAssignments: ClaimConditionAssignment[] = [];
    const remainingBefore: ClaimMemberProjection[] = [];
    const remainingAfter: ClaimMemberProjection[] = [];

    for (const partitionKey of canonicalStrings([...basePartitions.keys(), ...targetPartitions.keys()])) {
      const basePartition = basePartitions.get(partitionKey);
      const targetPartition = targetPartitions.get(partitionKey);
      const partition = basePartition ?? targetPartition!;
      const cancelled = cancelEqualConditions(
        basePartition?.members ?? [],
        targetPartition?.members ?? [],
      );
      const baseNulls = cancelled.before.filter((candidate) => candidate === null);
      const baseConditions = cancelled.before.filter((candidate) => candidate !== null);
      const targetNulls = cancelled.after.filter((candidate) => candidate === null);
      const targetConditions = cancelled.after.filter((candidate) => candidate !== null);

      const addedCount = Math.min(baseNulls.length, targetConditions.length);
      for (let index = 0; index < addedCount; index += 1) {
        addedAssignments.push(conditionAssignment(partition, targetConditions[index]!));
      }
      baseNulls.splice(0, addedCount);
      targetConditions.splice(0, addedCount);

      const removedCount = Math.min(baseConditions.length, targetNulls.length);
      for (let index = 0; index < removedCount; index += 1) {
        removedAssignments.push(conditionAssignment(partition, baseConditions[index]!));
      }
      baseConditions.splice(0, removedCount);
      targetNulls.splice(0, removedCount);

      const changedCount = Math.min(baseConditions.length, targetConditions.length);
      for (let index = 0; index < changedCount; index += 1) {
        changedBeforeAssignments.push(conditionAssignment(partition, baseConditions[index]!));
        changedAfterAssignments.push(conditionAssignment(partition, targetConditions[index]!));
      }
      baseConditions.splice(0, changedCount);
      targetConditions.splice(0, changedCount);

      remainingBefore.push(...baseNulls.map(() => claimMemberProjection(
        partition.value,
        partition.verification,
        null,
      )));
      remainingBefore.push(...baseConditions.map((candidate) => claimMemberProjection(
        partition.value,
        partition.verification,
        candidate,
      )));
      remainingAfter.push(...targetNulls.map(() => claimMemberProjection(
        partition.value,
        partition.verification,
        null,
      )));
      remainingAfter.push(...targetConditions.map((candidate) => claimMemberProjection(
        partition.value,
        partition.verification,
        candidate,
      )));
    }

    const groupedAdded = canonicalAssignments(addedAssignments);
    const groupedRemoved = canonicalAssignments(removedAssignments);
    const groupedChangedBefore = canonicalAssignments(changedBeforeAssignments);
    const groupedChangedAfter = canonicalAssignments(changedAfterAssignments);
    const groupedSubject = conditionSubject(owner);
    if (groupedAdded.length > 0) drafts.push({
      kind: "condition.added",
      compatibility: "potentially_breaking",
      subject: groupedSubject,
      before: [],
      after: groupedAdded,
    });
    if (groupedRemoved.length > 0) drafts.push({
      kind: "condition.removed",
      compatibility: "unknown",
      subject: groupedSubject,
      before: groupedRemoved,
      after: [],
    });
    if (groupedChangedBefore.length > 0) drafts.push({
      kind: "condition.changed",
      compatibility: "potentially_breaking",
      subject: groupedSubject,
      before: groupedChangedBefore,
      after: groupedChangedAfter,
    });

    const oldProjection = canonicalClaimMembers(remainingBefore);
    const newProjection = canonicalClaimMembers(remainingAfter);
    if (oldProjection.length === 0 && newProjection.length > 0) drafts.push({
      kind: "claim.added",
      compatibility: "unknown",
      subject,
      after: newProjection,
    });
    else if (oldProjection.length > 0 && newProjection.length === 0) drafts.push({
      kind: target.coverage.status === "incomplete" ? "fact.absence_unconfirmed" : "claim.removed",
      compatibility: "unknown",
      subject,
      before: oldProjection,
    });
    else if (oldProjection.length > 0 && newProjection.length > 0) drafts.push({
      kind: "claim.changed",
      compatibility: changedClaimCompatibility(owner, oldProjection, newProjection),
      subject,
      before: oldProjection,
      after: newProjection,
    });
  }
};

const coverageProjection = (coverage: ContractSnapshot["coverage"]): JsonValue => coverage.status === "complete"
  ? { status: "complete", analyzed_roots: canonicalStrings(coverage.analyzed_roots) }
  : {
      status: "incomplete",
      analyzed_roots: canonicalStrings(coverage.analyzed_roots),
      unresolved_roots: canonicalStrings(coverage.unresolved_roots),
      reason: coverage.reason,
    };

const diagnosticProjection = (diagnostic: ContractSnapshot["diagnostics"][number]): JsonValue => ({
  code: diagnostic.code,
  severity: diagnostic.severity,
  affected_endpoint_ids: canonicalStrings(diagnostic.affected_endpoint_ids),
});

const diagnosticKey = (diagnostic: ContractSnapshot["diagnostics"][number]): string =>
  canonicalJson([diagnostic.code, canonicalStrings(diagnostic.affected_endpoint_ids)]);

const addEndpointMemberDrafts = (
  drafts: DifferenceDraft[],
  serviceId: string,
  before: Endpoint,
  after: Endpoint,
  targetIncomplete: boolean,
): void => {
  const baseParameters = new Map(before.parameters.map((fact) => [parameterKey(fact), fact]));
  const targetParameters = new Map(after.parameters.map((fact) => [parameterKey(fact), fact]));
  for (const key of canonicalStrings([...baseParameters.keys(), ...targetParameters.keys()])) {
    const oldFact = baseParameters.get(key);
    const newFact = targetParameters.get(key);
    const fact = oldFact ?? newFact!;
    const subject = factSubject(serviceId, before.endpoint_id, "parameter", [fact.in, fact.name]);
    if (oldFact === undefined) drafts.push({ kind: "parameter.added", compatibility: addedMemberCompatibility(newFact!), subject, after: parameterProjection(newFact!) });
    else if (newFact === undefined) drafts.push({ kind: targetIncomplete ? "fact.absence_unconfirmed" : "parameter.removed", compatibility: targetIncomplete ? "unknown" : "potentially_breaking", subject, before: parameterProjection(oldFact) });
    else if (canonicalJson(parameterProjection(oldFact)) !== canonicalJson(parameterProjection(newFact))) drafts.push({ kind: "parameter.changed", compatibility: changedMemberCompatibility(oldFact, newFact), subject, before: parameterProjection(oldFact), after: parameterProjection(newFact) });
  }

  const baseBodies = new Map(before.request_bodies.map((fact) => [fact.media_type, fact]));
  const targetBodies = new Map(after.request_bodies.map((fact) => [fact.media_type, fact]));
  for (const key of canonicalStrings([...baseBodies.keys(), ...targetBodies.keys()])) {
    const oldFact = baseBodies.get(key);
    const newFact = targetBodies.get(key);
    const fact = oldFact ?? newFact!;
    const subject = factSubject(serviceId, before.endpoint_id, "request_body", [fact.media_type]);
    if (oldFact === undefined) drafts.push({ kind: "request_body.added", compatibility: addedMemberCompatibility(newFact!), subject, after: bodyProjection(newFact!) });
    else if (newFact === undefined) drafts.push({ kind: targetIncomplete ? "fact.absence_unconfirmed" : "request_body.removed", compatibility: targetIncomplete ? "unknown" : "potentially_breaking", subject, before: bodyProjection(oldFact) });
    else if (canonicalJson(bodyProjection(oldFact)) !== canonicalJson(bodyProjection(newFact))) drafts.push({ kind: "request_body.changed", compatibility: changedMemberCompatibility(oldFact, newFact), subject, before: bodyProjection(oldFact), after: bodyProjection(newFact) });
  }

  const baseResponses = responseGroups(before);
  const targetResponses = responseGroups(after);
  for (const key of canonicalStrings([...baseResponses.keys(), ...targetResponses.keys()])) {
    const oldFact = baseResponses.get(key);
    const newFact = targetResponses.get(key);
    const subject = factSubject(serviceId, before.endpoint_id, "response", [key]);
    if (oldFact === undefined) drafts.push({ kind: "response.added", compatibility: "potentially_breaking", subject, after: responseProjection(newFact!) });
    else if (newFact === undefined) drafts.push({ kind: targetIncomplete ? "fact.absence_unconfirmed" : "response.removed", compatibility: targetIncomplete ? "unknown" : "potentially_breaking", subject, before: responseProjection(oldFact) });
    else if (canonicalJson(responseProjection(oldFact)) !== canonicalJson(responseProjection(newFact))) drafts.push({ kind: "response.changed", compatibility: "potentially_breaking", subject, before: responseProjection(oldFact), after: responseProjection(newFact) });
  }

  const oldSecurity = securityProjection(before);
  const newSecurity = securityProjection(after);
  if (canonicalJson(oldSecurity) !== canonicalJson(newSecurity)) drafts.push({
    kind: "security.changed",
    compatibility: "potentially_breaking",
    subject: factSubject(serviceId, before.endpoint_id, "security"),
    before: oldSecurity,
    after: newSecurity,
  });
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
      addEndpointMemberDrafts(
        drafts,
        base.service.service_id,
        before,
        after,
        target.coverage.status === "incomplete",
      );
    }
  }

  const baseOwnership = buildEndpointOwnershipIndex(base);
  const targetOwnership = buildEndpointOwnershipIndex(target);
  const schemaIds = canonicalStrings([...Object.keys(base.schemas), ...Object.keys(target.schemas)]);
  for (const schemaId of schemaIds) {
    const before = base.schemas[schemaId];
    const after = target.schemas[schemaId];
    const affectedEndpointIds = canonicalStrings([
      ...(baseOwnership.schemaOwners.get(schemaId) ?? []),
      ...(targetOwnership.schemaOwners.get(schemaId) ?? []),
    ]);
    const subject: DifferenceSubject = {
      service_id: base.service.service_id,
      component_id: schemaId,
      ...(affectedEndpointIds.length === 0 ? {} : { affected_endpoint_ids: affectedEndpointIds }),
      fact_kind: "schema",
      fact_key: canonicalJson(["schema", schemaId]),
    };
    const beforeProjection = before === undefined ? undefined : {
      schema_id: schemaId,
      schema: canonicalSchema(before.schema),
    } as JsonValue;
    const afterProjection = after === undefined ? undefined : {
      schema_id: schemaId,
      schema: canonicalSchema(after.schema),
    } as JsonValue;
    if (before === undefined && afterProjection !== undefined) drafts.push({
      kind: "schema.added",
      compatibility: "non_breaking",
      subject,
      after: afterProjection,
    });
    else if (beforeProjection !== undefined && after === undefined) drafts.push({
      kind: target.coverage.status === "incomplete" ? "fact.absence_unconfirmed" : "schema.removed",
      compatibility: target.coverage.status === "incomplete" ? "unknown" : "potentially_breaking",
      subject,
      before: beforeProjection,
    });
    else if (beforeProjection !== undefined && afterProjection !== undefined
      && canonicalJson(beforeProjection) !== canonicalJson(afterProjection)) drafts.push({
      kind: "schema.changed",
      compatibility: "potentially_breaking",
      subject,
      before: beforeProjection,
      after: afterProjection,
    });
  }

  if (base.identity_version === target.identity_version) {
    addClaimDrafts(drafts, base, target);
  }

  const beforeCoverage = coverageProjection(base.coverage);
  const afterCoverage = coverageProjection(target.coverage);
  if (canonicalJson(beforeCoverage) !== canonicalJson(afterCoverage)) drafts.push({
    kind: "analysis.coverage_changed",
    compatibility: "unknown",
    subject: {
      service_id: base.service.service_id,
      fact_kind: "coverage",
      fact_key: canonicalJson(["coverage"]),
    },
    before: beforeCoverage,
    after: afterCoverage,
  });

  const baseDiagnostics = new Map(base.diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
  const targetDiagnostics = new Map(target.diagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
  for (const key of canonicalStrings([...baseDiagnostics.keys(), ...targetDiagnostics.keys()])) {
    const before = baseDiagnostics.get(key);
    const after = targetDiagnostics.get(key);
    const sample = before ?? after!;
    const affectedEndpointIds = canonicalStrings(sample.affected_endpoint_ids);
    const subject: DifferenceSubject = {
      service_id: base.service.service_id,
      ...(affectedEndpointIds.length === 0 ? {} : { affected_endpoint_ids: affectedEndpointIds }),
      fact_kind: "diagnostic",
      fact_key: canonicalJson(["diagnostic", sample.code, affectedEndpointIds]),
    };
    const beforeProjection = before === undefined ? undefined : diagnosticProjection(before);
    const afterProjection = after === undefined ? undefined : diagnosticProjection(after);
    if (beforeProjection === undefined) drafts.push({
      kind: "analysis.diagnostic_added",
      compatibility: "unknown",
      subject,
      after: afterProjection!,
    });
    else if (afterProjection === undefined) drafts.push({
      kind: "analysis.diagnostic_resolved",
      compatibility: "unknown",
      subject,
      before: beforeProjection,
    });
    else if (canonicalJson(beforeProjection) !== canonicalJson(afterProjection)) {
      drafts.push({
        kind: "analysis.diagnostic_added",
        compatibility: "unknown",
        subject,
        after: afterProjection,
      });
      drafts.push({
        kind: "analysis.diagnostic_resolved",
        compatibility: "unknown",
        subject,
        before: beforeProjection,
      });
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
