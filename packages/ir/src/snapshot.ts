import { type Static, Type } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ApiSchemaSchema, SchemaComponentSchema } from "./api-schema.js";
import {
  ClaimSchema, ConditionSchema, EditorialReviewSchema, EvidenceSchema, ExportEligibilitySchema,
  PresenceFactSchema, type Claim, type Evidence,
} from "./evidence.js";
import { EndpointSchema, type Endpoint } from "./endpoints.js";
import { deriveEndpointIdentity, EndpointIdentitySchema } from "./identity.js";
import { JsonValueSchema } from "./json-value.js";
import { issue, parserFor, type ValidationIssue } from "./validation.js";
import { ConfigVersionSchema, IdentityVersionSchema, IrVersionSchema } from "./versions.js";

const NonEmptyString = () => Type.String({ minLength: 1 });

export const SourceRevisionSchema = Type.Object({
  repository_id: NonEmptyString(),
  immutable_revision: NonEmptyString(),
  source_digest: NonEmptyString(),
}, { additionalProperties: false });

export const AnalyzerIdentitySchema = Type.Object({
  analyzer_id: NonEmptyString(),
  analyzer_version: NonEmptyString(),
}, { additionalProperties: false });

export const DiagnosticSchema = Type.Object({
  diagnostic_id: NonEmptyString(),
  code: NonEmptyString(),
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  message: NonEmptyString(),
  affected_endpoint_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
  evidence_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
}, { additionalProperties: false });

export const CoverageSchema = Type.Union([
  Type.Object({
    status: Type.Literal("complete"),
    analyzed_roots: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
    diagnostic_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("incomplete"),
    analyzed_roots: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
    unresolved_roots: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
    reason: NonEmptyString(),
    diagnostic_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
  }, { additionalProperties: false }),
]);

export const DependencySchema = Type.Object({
  from_endpoint_id: NonEmptyString(),
  to: Type.Object({
    kind: Type.Union([Type.Literal("endpoint"), Type.Literal("schema"), Type.Literal("evidence")]),
    id: NonEmptyString(),
  }, { additionalProperties: false }),
  evidence_ids: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
}, { additionalProperties: false });

export const ContractSnapshotSchema = Type.Object({
  ir_version: IrVersionSchema,
  identity_version: IdentityVersionSchema,
  snapshot_id: NonEmptyString(),
  service: Type.Object({
    service_id: NonEmptyString(), repository_id: NonEmptyString(), root: NonEmptyString(), label: Type.Optional(NonEmptyString()),
  }, { additionalProperties: false }),
  source: SourceRevisionSchema,
  analyzer: AnalyzerIdentitySchema,
  config: Type.Object({ config_version: ConfigVersionSchema, config_fingerprint: NonEmptyString() }, { additionalProperties: false }),
  created_at: Type.String({ format: "date-time" }),
  coverage: CoverageSchema,
  evidence: Type.Array(Type.Ref(EvidenceSchema)),
  schemas: Type.Record(Type.String({ minLength: 1 }), Type.Ref(SchemaComponentSchema)),
  endpoints: Type.Array(Type.Ref(EndpointSchema)),
  claims: Type.Array(Type.Ref(ClaimSchema)),
  editorial_reviews: Type.Array(Type.Ref(EditorialReviewSchema)),
  export_eligibility: Type.Array(Type.Ref(ExportEligibilitySchema)),
  dependencies: Type.Array(DependencySchema),
  diagnostics: Type.Array(DiagnosticSchema),
}, { $id: "https://api-truth.dev/schemas/contract-snapshot-1.0.0.json", additionalProperties: false });

export type ContractSnapshot = Static<typeof ContractSnapshotSchema>;

const duplicateIssues = (values: string[], path: string): ValidationIssue[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) seen.has(value) ? duplicates.add(value) : seen.add(value);
  return [...duplicates].map(() => issue(path, "semantic.duplicate_id", "duplicate ID"));
};

const evidenceReference = (
  ids: string[], evidenceIds: Set<string>, path: string, issues: ValidationIssue[],
) => ids.forEach((id, index) => {
  if (!evidenceIds.has(id)) issues.push(issue(`${path}/${index}`, "semantic.dangling_reference", "unknown evidence reference"));
});

const collectSchemaRefs = (value: unknown, path: string, refs: Array<{ ref: string; path: string }>) => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectSchemaRefs(child, `${path}/${index}`, refs));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") refs.push({ ref: child, path: `${path}/$ref` });
    else collectSchemaRefs(child, `${path}/${key}`, refs);
  }
};

const jsonPointerSegment = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");

const translateComponentRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(translateComponentRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/schemas/")) {
      return [key, `#/$defs/${jsonPointerSegment(child.slice("#/schemas/".length))}`];
    }
    return [key, translateComponentRefs(child)];
  }));
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const conditionKey = (condition: Claim["condition"]): string =>
  condition === undefined ? "<unconditional>" : canonicalJson(condition);

const containsDuplicateEnum = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsDuplicateEnum);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    const members = record.enum.map(canonicalJson);
    if (new Set(members).size !== members.length) return true;
  }
  return Object.values(record).some(containsDuplicateEnum);
};

const embeddedSchemaIssues = (snapshot: ContractSnapshot): ValidationIssue[] => {
  const definitions = Object.fromEntries(Object.entries(snapshot.schemas).map(([id, component]) => [id, translateComponentRefs(component.schema)]));
  const candidates: unknown[] = [
    ...Object.keys(snapshot.schemas).map((id) => ({ $ref: `#/$defs/${jsonPointerSegment(id)}` })),
    ...snapshot.endpoints.flatMap((endpoint) => [
      ...endpoint.parameters.map((parameter) => parameter.schema),
      ...endpoint.request_bodies.map((body) => body.schema),
      ...endpoint.responses.flatMap((response) => [
        ...response.content.map((content) => content.schema),
        ...(response.headers ?? []).map((header) => header.schema),
      ]),
    ]).map(translateComponentRefs),
  ];
  const graph = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: definitions,
    ...(candidates.length > 0 ? { anyOf: candidates } : {}),
  };
  if (containsDuplicateEnum(graph)) {
    return [issue("/schemas", "semantic.invalid_api_schema", "embedded schema enum values must be unique")];
  }
  try {
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    if (!ajv.validateSchema(graph)) {
      return [issue("/schemas", "semantic.invalid_api_schema", "embedded schema graph is invalid")];
    }
    ajv.compile(graph);
    return [];
  } catch {
    return [issue("/schemas", "semantic.invalid_api_schema", "embedded schema graph cannot be compiled")];
  }
};

export const validateContractSnapshotSemantics = (snapshot: ContractSnapshot): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const endpointIds = new Set(snapshot.endpoints.map((endpoint) => endpoint.endpoint_id));
  const evidenceIds = new Set(snapshot.evidence.map((evidence) => evidence.evidence_id));
  const claimIds = new Set(snapshot.claims.map((claim) => claim.claim_id));
  const diagnosticIds = new Set(snapshot.diagnostics.map((diagnostic) => diagnostic.diagnostic_id));
  const schemaIds = new Set(Object.keys(snapshot.schemas));
  issues.push(...duplicateIssues(snapshot.endpoints.map((endpoint) => endpoint.endpoint_id), "/endpoints"));
  issues.push(...duplicateIssues(snapshot.evidence.map((evidence) => evidence.evidence_id), "/evidence"));
  issues.push(...duplicateIssues(snapshot.claims.map((claim) => claim.claim_id), "/claims"));
  issues.push(...duplicateIssues(snapshot.diagnostics.map((diagnostic) => diagnostic.diagnostic_id), "/diagnostics"));
  issues.push(...duplicateIssues(snapshot.editorial_reviews.map((review) => review.review_id), "/editorial_reviews"));
  issues.push(...duplicateIssues(snapshot.export_eligibility.map((eligibility) => eligibility.eligibility_id), "/export_eligibility"));
  const routeKeyCounts = new Map<string, number>();
  snapshot.endpoints.forEach((endpoint) => routeKeyCounts.set(endpoint.identity.route_key, (routeKeyCounts.get(endpoint.identity.route_key) ?? 0) + 1));
  if ([...routeKeyCounts.values()].some((count) => count > 1)) {
    issues.push(issue("/endpoints", "semantic.route_identity_collision", "multiple endpoints have the same route identity"));
  }

  if (snapshot.source.repository_id !== snapshot.service.repository_id) {
    issues.push(issue("/source/repository_id", "semantic.cross_repository_reference", "source repository differs from service repository"));
  }

  snapshot.evidence.forEach((evidence, index) => {
    if (evidence.scope.service_id !== snapshot.service.service_id) {
      issues.push(issue(`/evidence/${index}/scope/service_id`, "semantic.cross_service_reference", "evidence belongs to another service"));
    }
    if (evidence.scope.snapshot_id !== undefined && evidence.scope.snapshot_id !== snapshot.snapshot_id) {
      issues.push(issue(`/evidence/${index}/scope/snapshot_id`, "semantic.dangling_reference", "evidence references another snapshot"));
    }
    if (evidence.scope.endpoint_id !== undefined && !endpointIds.has(evidence.scope.endpoint_id)) {
      issues.push(issue(`/evidence/${index}/scope/endpoint_id`, "semantic.dangling_reference", "unknown endpoint reference"));
    }
  });

  snapshot.endpoints.forEach((endpoint, index) => {
    if (endpoint.identity.service_id !== snapshot.service.service_id) {
      issues.push(issue(`/endpoints/${index}/identity/service_id`, "semantic.cross_service_reference", "endpoint belongs to another service"));
    }
    let identityMatches = false;
    let applicationPathIsValid = true;
    try {
      const expected = deriveEndpointIdentity({
        identity_version: endpoint.identity.identity_version,
        service_id: endpoint.identity.service_id,
        method: endpoint.identity.method,
        application_path: endpoint.application_path,
        selectors: endpoint.identity.selectors,
      });
      identityMatches = expected.route_key === endpoint.identity.route_key
        && expected.normalized_path_shape === endpoint.identity.normalized_path_shape
        && canonicalJson(expected.selectors) === canonicalJson(endpoint.identity.selectors);
    } catch {
      applicationPathIsValid = false;
      issues.push(issue(`/endpoints/${index}/application_path`, "semantic.invalid_path_syntax", "application path contains malformed or unsupported placeholder syntax"));
    }
    if (applicationPathIsValid && !identityMatches) {
      issues.push(issue(`/endpoints/${index}/identity`, "semantic.identity_mismatch", "route identity does not match method, path, and selectors"));
    }
    evidenceReference(endpoint.evidence_ids, evidenceIds, `/endpoints/${index}/evidence_ids`, issues);
    endpoint.parameters.forEach((parameter, parameterIndex) => {
      evidenceReference(
        parameter.presence.evidence_ids,
        evidenceIds,
        `/endpoints/${index}/parameters/${parameterIndex}/presence/evidence_ids`,
        issues,
      );
    });
    endpoint.request_bodies.forEach((body, bodyIndex) => {
      evidenceReference(
        body.presence.evidence_ids,
        evidenceIds,
        `/endpoints/${index}/request_bodies/${bodyIndex}/presence/evidence_ids`,
        issues,
      );
    });
  });

  Object.entries(snapshot.schemas).forEach(([key, component]) => {
    if (key !== component.schema_id) issues.push(issue(`/schemas/${key}/schema_id`, "semantic.identity_mismatch", "schema key and ID differ"));
    evidenceReference(component.evidence_ids, evidenceIds, `/schemas/${key}/evidence_ids`, issues);
  });

  snapshot.claims.forEach((claim, index) => {
    if (claim.subject.service_id !== snapshot.service.service_id) {
      issues.push(issue(`/claims/${index}/subject/service_id`, "semantic.cross_service_reference", "claim belongs to another service"));
    }
    if (claim.subject.endpoint_id !== undefined && !endpointIds.has(claim.subject.endpoint_id)) {
      issues.push(issue(`/claims/${index}/subject/endpoint_id`, "semantic.dangling_reference", "unknown endpoint reference"));
    }
    evidenceReference(claim.evidence_ids, evidenceIds, `/claims/${index}/evidence_ids`, issues);
  });

  snapshot.editorial_reviews.forEach((review, index) => {
    if (!claimIds.has(review.claim_id)) issues.push(issue(`/editorial_reviews/${index}/claim_id`, "semantic.dangling_reference", "unknown claim reference"));
  });

  const evidenceById = new Map<string, Evidence>(snapshot.evidence.map((evidence) => [evidence.evidence_id, evidence]));
  const claimById = new Map(snapshot.claims.map((claim) => [claim.claim_id, claim]));
  const qualifyingMethodByBasis = {
    supported_runtime_validator: "runtime_validator",
    deterministic_analysis: "deterministic_analysis",
    behavioral_verification: "behavioral_verification",
  } as const;
  const qualifyingMethods = new Set<string>(Object.values(qualifyingMethodByBasis));
  snapshot.export_eligibility.forEach((eligibility, index) => {
    if (!claimIds.has(eligibility.claim_id)) issues.push(issue(`/export_eligibility/${index}/claim_id`, "semantic.dangling_reference", "unknown claim reference"));
    if (eligibility.scope.service_id !== snapshot.service.service_id) {
      issues.push(issue(`/export_eligibility/${index}/scope/service_id`, "semantic.cross_service_reference", "eligibility belongs to another service"));
    }
    if (eligibility.scope.snapshot_id !== snapshot.snapshot_id) {
      issues.push(issue(`/export_eligibility/${index}/scope/snapshot_id`, "semantic.dangling_reference", "eligibility references another snapshot"));
    }
    eligibility.scope.endpoint_ids.forEach((id, endpointIndex) => {
      if (!endpointIds.has(id)) issues.push(issue(`/export_eligibility/${index}/scope/endpoint_ids/${endpointIndex}`, "semantic.dangling_reference", "unknown endpoint reference"));
    });
    if (eligibility.status === "eligible") {
      const claim = claimById.get(eligibility.claim_id);
      if (claim?.subject.endpoint_id !== undefined && !eligibility.scope.endpoint_ids.includes(claim.subject.endpoint_id)) {
        issues.push(issue(`/export_eligibility/${index}/scope/endpoint_ids`, "semantic.scope_mismatch", "eligibility scope excludes the claim subject"));
      }
      if (claim !== undefined) {
        const contradictoryClaim = snapshot.claims.find((candidate) =>
          candidate.claim_id !== claim.claim_id
          && candidate.predicate === claim.predicate
          && candidate.subject.service_id === claim.subject.service_id
          && candidate.subject.endpoint_id === claim.subject.endpoint_id
          && candidate.subject.schema_pointer === claim.subject.schema_pointer
          && conditionKey(candidate.condition) === conditionKey(claim.condition)
          && canonicalJson(candidate.value) !== canonicalJson(claim.value));
        if (contradictoryClaim !== undefined) {
          issues.push(issue(`/export_eligibility/${index}/claim_id`, "semantic.conflicting_claims", "eligible claim has an unresolved contradiction"));
        }
      }
      eligibility.basis.evidence_ids.forEach((id, evidenceIndex) => {
        const evidence = evidenceById.get(id);
        if (!evidence) issues.push(issue(`/export_eligibility/${index}/basis/evidence_ids/${evidenceIndex}`, "semantic.dangling_reference", "unknown evidence reference"));
        else {
          if (claim !== undefined && !claim.evidence_ids.includes(id)) {
            issues.push(issue(`/export_eligibility/${index}/basis/evidence_ids/${evidenceIndex}`, "semantic.unrelated_evidence", "eligibility evidence is not attached to the claim"));
          }
          if (!qualifyingMethods.has(evidence.method)) {
            issues.push(issue(`/export_eligibility/${index}/basis/evidence_ids/${evidenceIndex}`, "semantic.ineligible_evidence", "evidence method cannot establish normative eligibility"));
          }
          if (evidence.method !== qualifyingMethodByBasis[eligibility.basis.kind]) {
            issues.push(issue(`/export_eligibility/${index}/basis/evidence_ids/${evidenceIndex}`, "semantic.basis_mismatch", "eligibility basis does not match the evidence method"));
          }
          if (evidence.scope.snapshot_id !== snapshot.snapshot_id
            || evidence.scope.service_id !== eligibility.scope.service_id
            || (claim?.subject.endpoint_id !== undefined && evidence.scope.endpoint_id !== claim.subject.endpoint_id)
            || (claim?.subject.endpoint_id === undefined && evidence.scope.endpoint_id !== undefined)) {
            issues.push(issue(`/export_eligibility/${index}/basis/evidence_ids/${evidenceIndex}`, "semantic.scope_mismatch", "eligibility evidence does not cover the claim scope"));
          }
        }
      });
    }
  });

  snapshot.dependencies.forEach((dependency, index) => {
    if (!endpointIds.has(dependency.from_endpoint_id)) issues.push(issue(`/dependencies/${index}/from_endpoint_id`, "semantic.dangling_reference", "unknown endpoint reference"));
    const targetExists = dependency.to.kind === "endpoint" ? endpointIds.has(dependency.to.id)
      : dependency.to.kind === "schema" ? schemaIds.has(dependency.to.id) : evidenceIds.has(dependency.to.id);
    if (!targetExists) issues.push(issue(`/dependencies/${index}/to/id`, "semantic.dangling_reference", "unknown dependency target"));
    evidenceReference(dependency.evidence_ids, evidenceIds, `/dependencies/${index}/evidence_ids`, issues);
  });

  snapshot.diagnostics.forEach((diagnostic, index) => {
    diagnostic.affected_endpoint_ids.forEach((id, endpointIndex) => {
      if (!endpointIds.has(id)) issues.push(issue(`/diagnostics/${index}/affected_endpoint_ids/${endpointIndex}`, "semantic.dangling_reference", "unknown endpoint reference"));
    });
    evidenceReference(diagnostic.evidence_ids, evidenceIds, `/diagnostics/${index}/evidence_ids`, issues);
  });
  snapshot.coverage.diagnostic_ids.forEach((id, index) => {
    if (!diagnosticIds.has(id)) issues.push(issue(`/coverage/diagnostic_ids/${index}`, "semantic.dangling_reference", "unknown diagnostic reference"));
  });
  if (snapshot.coverage.status === "incomplete" && snapshot.coverage.diagnostic_ids.length === 0) {
    issues.push(issue("/coverage/diagnostic_ids", "semantic.incomplete_coverage_without_diagnostic", "incomplete coverage must identify affected diagnostics"));
  }

  const refs: Array<{ ref: string; path: string }> = [];
  collectSchemaRefs(snapshot.schemas, "/schemas", refs);
  collectSchemaRefs(snapshot.endpoints, "/endpoints", refs);
  refs.forEach(({ ref, path }) => {
    if (ref.startsWith("#/schemas/") && !schemaIds.has(ref.slice("#/schemas/".length))) {
      issues.push(issue(path, "semantic.dangling_reference", "unknown schema reference"));
    } else if (!ref.startsWith("#/schemas/")) {
      issues.push(issue(path, "semantic.invalid_api_schema", "only local component references are supported"));
    }
  });
  if (!issues.some((item) => item.code === "semantic.invalid_api_schema" || item.code === "semantic.dangling_reference")) {
    issues.push(...embeddedSchemaIssues(snapshot));
  }
  return issues;
};

export const ContractSnapshotSchemaReferences = [
  JsonValueSchema,
  ApiSchemaSchema,
  SchemaComponentSchema,
  ConditionSchema,
  PresenceFactSchema,
  EvidenceSchema,
  ClaimSchema,
  EditorialReviewSchema,
  ExportEligibilitySchema,
  EndpointIdentitySchema,
  EndpointSchema,
];

export const parseContractSnapshot = parserFor(
  ContractSnapshotSchema,
  validateContractSnapshotSemantics,
  ContractSnapshotSchemaReferences,
);
export const validateContractSnapshot = parseContractSnapshot;
