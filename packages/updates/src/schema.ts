import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  AnalyzerExchangeVersionSchema,
  ApiSchemaSchema,
  ConditionSchema,
  ConfigVersionSchema,
  ContractSnapshotSchema,
  ContractSnapshotSchemaReferences,
  IdentityVersionSchema,
  ImmutableRevisionSchema,
  IrVersionSchema,
  JsonValueSchema,
  NormalizedProjectPathSchema,
  EndpointIdentitySchema,
  failure,
  issue,
  parserFor,
  type JsonValue,
  type ValidationIssue,
  type ValidationResult,
} from "@api-truth/ir";
import { canonicalJson, canonicalSha256Hex, compareUtf8, isCanonicalBy, isCanonicalStringSet } from "./canonical.js";
import {
  CONTRACT_CHANGES_OUTPUT_VERSION,
  CONTRACT_DIFFERENCE_VERSION,
  DIFFERENCE_INCOMPLETE_REASONS,
  DIFFERENCE_KINDS,
  UPDATE_FALLBACK_REASONS,
  UPDATE_PLAN_VERSION,
} from "./types.js";

const NonEmptyString = () => Type.String({ minLength: 1 });
const CanonicalSha256Schema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });

const safeParserFor = <Schema extends TSchema>(
  schema: Schema,
  semantic?: (value: Static<Schema>) => ValidationIssue[],
  references: TSchema[] = [],
): ((value: unknown) => ValidationResult<Static<Schema>>) => {
  const parser = parserFor(schema, semantic, references);
  return (value: unknown) => {
    try {
      canonicalJson(value);
      return parser(value);
    } catch {
      return failure([issue("/", "shape.invalid_json_value", "input must contain only JSON values")]);
    }
  };
};

export const AnalysisKeySchema = Type.Object({
  analyzer: Type.Object({
    analyzer_id: NonEmptyString(),
    analyzer_version: NonEmptyString(),
  }, { additionalProperties: false }),
  analyzer_exchange_version: AnalyzerExchangeVersionSchema,
  ir_version: IrVersionSchema,
  identity_version: IdentityVersionSchema,
  config_version: ConfigVersionSchema,
  config_fingerprint: NonEmptyString(),
}, {
  $id: "https://api-truth.dev/schemas/analysis-key-1.0.0.json",
  additionalProperties: false,
});

export type AnalysisKey = Static<typeof AnalysisKeySchema>;

export const UpdatePlanningInputSchema = Type.Object({
  base_snapshot: Type.Ref(ContractSnapshotSchema),
  base_analysis_key: Type.Ref(AnalysisKeySchema),
  target: Type.Object({
    repository_id: NonEmptyString(),
    service_id: NonEmptyString(),
    service_root: NormalizedProjectPathSchema,
    immutable_revision: ImmutableRevisionSchema,
    source_digest: CanonicalSha256Schema,
    analysis_key: Type.Ref(AnalysisKeySchema),
  }, { additionalProperties: false }),
  changed_paths: Type.Array(NormalizedProjectPathSchema),
  changed_paths_complete: Type.Boolean(),
}, {
  $id: "https://api-truth.dev/schemas/update-planning-input-1.0.0.json",
  additionalProperties: false,
});

export type UpdatePlanningInput = Static<typeof UpdatePlanningInputSchema>;

export const UpdateFallbackReasonSchema = Type.Union([
  Type.Literal("adapter_incremental_targets_unsupported"),
  Type.Literal("prior_coverage_incomplete"),
  Type.Literal("changed_paths_incomplete"),
  Type.Literal("changed_paths_digest_mismatch"),
  Type.Literal("changed_path_unindexed"),
  Type.Literal("dependency_index_incomplete"),
  Type.Literal("analyzer_changed"),
  Type.Literal("config_changed"),
  Type.Literal("ir_changed"),
  Type.Literal("identity_changed"),
]);

export const UpdatePlanSchema = Type.Object({
  update_plan_version: Type.Literal(UPDATE_PLAN_VERSION),
  plan_id: NonEmptyString(),
  service: Type.Object({
    repository_id: NonEmptyString(),
    service_id: NonEmptyString(),
    service_root: NormalizedProjectPathSchema,
    base_snapshot_id: NonEmptyString(),
    base_revision: ImmutableRevisionSchema,
    target_revision: ImmutableRevisionSchema,
    base_source_digest: CanonicalSha256Schema,
    target_source_digest: CanonicalSha256Schema,
  }, { additionalProperties: false }),
  analysis: Type.Object({
    base: Type.Ref(AnalysisKeySchema),
    target: Type.Ref(AnalysisKeySchema),
  }, { additionalProperties: false }),
  changed_paths: Type.Array(NormalizedProjectPathSchema, { uniqueItems: true }),
  dependency_coverage: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
  affected_endpoint_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
  action: Type.Union([Type.Literal("reuse_base_snapshot"), Type.Literal("analyze_full_service")]),
  extraction_mode: Type.Optional(Type.Literal("fallback_full_service")),
  fallback_reasons: Type.Array(UpdateFallbackReasonSchema, { uniqueItems: true }),
}, {
  $id: "https://api-truth.dev/schemas/update-plan-1.0.0.json",
  additionalProperties: false,
});

export type UpdatePlan = Static<typeof UpdatePlanSchema>;

export type ContractCondition = Static<typeof ConditionSchema>;

export const ClaimConditionAssignmentSchema = Type.Object({
  value: Type.Ref(JsonValueSchema),
  verification: Type.Union([
    Type.Literal("declared"),
    Type.Literal("established_by_analysis"),
    Type.Literal("observed"),
    Type.Literal("inferred"),
    Type.Literal("owner_asserted"),
  ]),
  condition: Type.Ref(ConditionSchema),
}, {
  $id: "https://api-truth.dev/schemas/claim-condition-assignment-1.0.0.json",
  additionalProperties: false,
});

export type ClaimConditionAssignment = {
  value: JsonValue;
  verification:
    | "declared"
    | "established_by_analysis"
    | "observed"
    | "inferred"
    | "owner_asserted";
  condition: ContractCondition;
};

export const CompatibilityLabelSchema = Type.Union([
  Type.Literal("non_breaking"),
  Type.Literal("potentially_breaking"),
  Type.Literal("unknown"),
]);

export const DifferenceKindSchema = Type.Union([
  Type.Literal("endpoint.added"),
  Type.Literal("endpoint.removed"),
  Type.Literal("endpoint.absence_unconfirmed"),
  Type.Literal("endpoint.path_parameter_names_changed"),
  Type.Literal("parameter.added"),
  Type.Literal("parameter.removed"),
  Type.Literal("parameter.changed"),
  Type.Literal("request_body.added"),
  Type.Literal("request_body.removed"),
  Type.Literal("request_body.changed"),
  Type.Literal("response.added"),
  Type.Literal("response.removed"),
  Type.Literal("response.changed"),
  Type.Literal("security.changed"),
  Type.Literal("schema.added"),
  Type.Literal("schema.removed"),
  Type.Literal("schema.changed"),
  Type.Literal("claim.added"),
  Type.Literal("claim.removed"),
  Type.Literal("claim.changed"),
  Type.Literal("condition.added"),
  Type.Literal("condition.removed"),
  Type.Literal("condition.changed"),
  Type.Literal("fact.absence_unconfirmed"),
  Type.Literal("analysis.coverage_changed"),
  Type.Literal("analysis.identity_changed"),
  Type.Literal("analysis.diagnostic_added"),
  Type.Literal("analysis.diagnostic_resolved"),
]);

export const FactKindSchema = Type.Union([
  Type.Literal("endpoint"),
  Type.Literal("parameter"),
  Type.Literal("request_body"),
  Type.Literal("response"),
  Type.Literal("security"),
  Type.Literal("schema"),
  Type.Literal("claim"),
  Type.Literal("condition_group"),
  Type.Literal("diagnostic"),
  Type.Literal("coverage"),
  Type.Literal("identity"),
]);

export const DifferenceSubjectSchema = Type.Object({
  service_id: NonEmptyString(),
  endpoint_id: Type.Optional(NonEmptyString()),
  component_id: Type.Optional(NonEmptyString()),
  affected_endpoint_ids: Type.Optional(Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true })),
  fact_kind: Type.Optional(FactKindSchema),
  fact_key: Type.Optional(NonEmptyString()),
}, { additionalProperties: false });

export const ConditionGroupSubjectSchema = Type.Object({
  service_id: NonEmptyString(),
  endpoint_id: Type.Optional(NonEmptyString()),
  component_id: Type.Optional(NonEmptyString()),
  affected_endpoint_ids: Type.Optional(Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true })),
  fact_kind: Type.Literal("condition_group"),
  fact_key: NonEmptyString(),
}, { additionalProperties: false });

const SerializationProjectionSchema = Type.Object({
  format: Type.Optional(NonEmptyString()),
  style: Type.Optional(NonEmptyString()),
  explode: Type.Optional(Type.Boolean()),
  content_encoding: Type.Optional(NonEmptyString()),
}, { additionalProperties: false, minProperties: 1 });

const PresenceProjectionSchema = Type.Union([
  Type.Object({
    state: Type.Literal("conditional"),
    condition: Type.Ref(ConditionSchema),
  }, { additionalProperties: false }),
  Type.Object({
    state: Type.Union([
      Type.Literal("required"),
      Type.Literal("optional"),
      Type.Literal("unknown"),
    ]),
  }, { additionalProperties: false }),
]);

const ParameterProjectionSchema = Type.Object({
  name: Type.Optional(NonEmptyString()),
  in: Type.Optional(Type.Union([
    Type.Literal("path"),
    Type.Literal("query"),
    Type.Literal("header"),
    Type.Literal("cookie"),
  ])),
  presence: Type.Optional(PresenceProjectionSchema),
  schema: Type.Optional(Type.Ref(ApiSchemaSchema)),
  serialization: Type.Optional(SerializationProjectionSchema),
}, { additionalProperties: false, minProperties: 1 });

const RequestBodyProjectionSchema = Type.Object({
  media_type: Type.Optional(NonEmptyString()),
  presence: Type.Optional(PresenceProjectionSchema),
  schema: Type.Optional(Type.Ref(ApiSchemaSchema)),
  serialization: Type.Optional(SerializationProjectionSchema),
}, { additionalProperties: false, minProperties: 1 });

const ResponseStatusProjectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("exact"), code: Type.Integer({ minimum: 100, maximum: 599 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("range"), range: Type.String({ pattern: "^[1-5]XX$" }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("default") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unknown"), reason: NonEmptyString() }, { additionalProperties: false }),
]);

const ResponseProjectionSchema = Type.Object({
  status: Type.Optional(ResponseStatusProjectionSchema),
  content: Type.Optional(Type.Array(Type.Object({
    media_type: NonEmptyString(),
    schema: Type.Ref(ApiSchemaSchema),
    serialization: SerializationProjectionSchema,
  }, { additionalProperties: false }))),
  headers: Type.Optional(Type.Array(Type.Object({
    name: NonEmptyString(),
    schema: Type.Ref(ApiSchemaSchema),
  }, { additionalProperties: false }))),
}, { additionalProperties: false, minProperties: 1 });

const SecurityProjectionSchema = Type.Object({
  alternatives: Type.Array(Type.Object({
    requirements: Type.Array(Type.Object({
      scheme: NonEmptyString(),
      scopes: Type.Array(Type.String()),
    }, { additionalProperties: false }), { minItems: 1 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const EndpointProjectionSchema = Type.Object({
  endpoint_id: Type.Optional(NonEmptyString()),
  identity: Type.Optional(Type.Ref(EndpointIdentitySchema)),
  method: Type.Optional(Type.String({ pattern: "^[A-Z]+$" })),
  application_path: Type.Optional(Type.String({ pattern: "^/" })),
  parameters: Type.Optional(Type.Array(ParameterProjectionSchema)),
  request_bodies: Type.Optional(Type.Array(RequestBodyProjectionSchema)),
  responses: Type.Optional(Type.Array(ResponseProjectionSchema)),
  security: Type.Optional(SecurityProjectionSchema),
}, { additionalProperties: false, minProperties: 1 });

const SchemaProjectionSchema = Type.Union([
  Type.Ref(ApiSchemaSchema),
  Type.Object({
    schema_id: NonEmptyString(),
    schema: Type.Ref(ApiSchemaSchema),
  }, { additionalProperties: false }),
]);

const ClaimMemberProjectionSchema = Type.Object({
  value: Type.Ref(JsonValueSchema),
  verification: Type.Union([
    Type.Literal("declared"),
    Type.Literal("established_by_analysis"),
    Type.Literal("observed"),
    Type.Literal("inferred"),
    Type.Literal("owner_asserted"),
  ]),
  condition: Type.Optional(Type.Ref(ConditionSchema)),
}, { additionalProperties: false });

const ClaimProjectionSchema = Type.Array(ClaimMemberProjectionSchema, { minItems: 1 });
const PathParameterNamesProjectionSchema = Type.Array(NonEmptyString(), { uniqueItems: true });
const DiagnosticProjectionSchema = Type.Object({
  code: NonEmptyString(),
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  affected_endpoint_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
}, { additionalProperties: false });
const CoverageProjectionSchema = Type.Union([
  Type.Object({
    status: Type.Literal("complete"),
    analyzed_roots: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("incomplete"),
    analyzed_roots: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
    unresolved_roots: Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true }),
    reason: NonEmptyString(),
  }, { additionalProperties: false }),
]);
const IdentityProjectionSchema = Type.Union([
  IdentityVersionSchema,
  Type.Object({ identity_version: IdentityVersionSchema }, { additionalProperties: false }),
]);

type NonEmptyAssignments = [ClaimConditionAssignment, ...ClaimConditionAssignment[]];
const EmptyAssignmentsSchema = Type.Tuple([]);
const NonEmptyAssignmentsSchema = Type.Unsafe<NonEmptyAssignments>(
  Type.Array(Type.Ref(ClaimConditionAssignmentSchema), { minItems: 1, uniqueItems: true }),
);

const ConditionAddedDifferenceSchema = Type.Object({
  difference_id: NonEmptyString(),
  kind: Type.Literal("condition.added"),
  compatibility: Type.Literal("potentially_breaking"),
  subject: ConditionGroupSubjectSchema,
  before: EmptyAssignmentsSchema,
  after: NonEmptyAssignmentsSchema,
}, { additionalProperties: false });

const ConditionRemovedDifferenceSchema = Type.Object({
  difference_id: NonEmptyString(),
  kind: Type.Literal("condition.removed"),
  compatibility: Type.Literal("unknown"),
  subject: ConditionGroupSubjectSchema,
  before: NonEmptyAssignmentsSchema,
  after: EmptyAssignmentsSchema,
}, { additionalProperties: false });

const ConditionChangedDifferenceSchema = Type.Object({
  difference_id: NonEmptyString(),
  kind: Type.Literal("condition.changed"),
  compatibility: Type.Literal("potentially_breaking"),
  subject: ConditionGroupSubjectSchema,
  before: NonEmptyAssignmentsSchema,
  after: NonEmptyAssignmentsSchema,
}, { additionalProperties: false });

const NonConditionDifferenceKindSchema = Type.Exclude(DifferenceKindSchema, Type.Union([
  Type.Literal("condition.added"),
  Type.Literal("condition.removed"),
  Type.Literal("condition.changed"),
]));

const GeneralContractDifferenceSchema = Type.Object({
  difference_id: NonEmptyString(),
  kind: NonConditionDifferenceKindSchema,
  compatibility: CompatibilityLabelSchema,
  subject: DifferenceSubjectSchema,
  before: Type.Optional(Type.Ref(JsonValueSchema)),
  after: Type.Optional(Type.Ref(JsonValueSchema)),
}, { additionalProperties: false });

export const ContractDifferenceSchema = Type.Union([
  GeneralContractDifferenceSchema,
  ConditionAddedDifferenceSchema,
  ConditionRemovedDifferenceSchema,
  ConditionChangedDifferenceSchema,
], { $id: "https://api-truth.dev/schemas/contract-difference-1.0.0.json" });

export type DifferenceSubject = Static<typeof DifferenceSubjectSchema>;
export type ConditionGroupSubject = Static<typeof ConditionGroupSubjectSchema>;
export type ContractDifference = Static<typeof ContractDifferenceSchema>;
export type ConditionGroupDifference =
  | Static<typeof ConditionAddedDifferenceSchema>
  | Static<typeof ConditionRemovedDifferenceSchema>
  | Static<typeof ConditionChangedDifferenceSchema>;

export const DifferenceIncompleteReasonSchema = Type.Union([
  Type.Literal("base_coverage_incomplete"),
  Type.Literal("target_coverage_incomplete"),
  Type.Literal("identity_version_changed"),
]);

export const ContractDifferenceSetSchema = Type.Object({
  contract_difference_version: Type.Literal(CONTRACT_DIFFERENCE_VERSION),
  difference_set_id: NonEmptyString(),
  service_id: NonEmptyString(),
  base: Type.Object({
    snapshot_id: NonEmptyString(),
    immutable_revision: ImmutableRevisionSchema,
  }, { additionalProperties: false }),
  target: Type.Object({
    snapshot_id: NonEmptyString(),
    immutable_revision: ImmutableRevisionSchema,
  }, { additionalProperties: false }),
  comparison_status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
  incomplete_reason_codes: Type.Array(DifferenceIncompleteReasonSchema, { uniqueItems: true }),
  differences: Type.Array(Type.Ref(ContractDifferenceSchema)),
}, {
  $id: "https://api-truth.dev/schemas/contract-difference-set-1.0.0.json",
  additionalProperties: false,
});

export type ContractDifferenceSet = Static<typeof ContractDifferenceSetSchema>;

export const ContractChangesSnapshotSummarySchema = Type.Object({
  snapshot_id: NonEmptyString(),
  immutable_revision: ImmutableRevisionSchema,
  analyzer: Type.Object({
    analyzer_id: NonEmptyString(),
    analyzer_version: NonEmptyString(),
  }, { additionalProperties: false }),
  ir_version: IrVersionSchema,
  identity_version: IdentityVersionSchema,
  config_version: ConfigVersionSchema,
  coverage_status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
}, { additionalProperties: false });

export type ContractChangesSnapshotSummary = Static<typeof ContractChangesSnapshotSummarySchema>;

export const ContractChangesPlanSummarySchema = Type.Object({
  update_plan_version: Type.Literal(UPDATE_PLAN_VERSION),
  plan_id: NonEmptyString(),
  action: Type.Union([Type.Literal("reuse_base_snapshot"), Type.Literal("analyze_full_service")]),
  extraction_mode: Type.Optional(Type.Literal("fallback_full_service")),
  dependency_coverage: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
  affected_endpoint_ids: Type.Array(NonEmptyString(), { uniqueItems: true }),
  fallback_reasons: Type.Array(UpdateFallbackReasonSchema, { uniqueItems: true }),
}, { additionalProperties: false });

export type ContractChangesPlanSummary = Static<typeof ContractChangesPlanSummarySchema>;

export const ContractChangesOutputSchema = Type.Object({
  contract_changes_output_version: Type.Literal(CONTRACT_CHANGES_OUTPUT_VERSION),
  plan: ContractChangesPlanSummarySchema,
  base: ContractChangesSnapshotSummarySchema,
  target: ContractChangesSnapshotSummarySchema,
  differences: Type.Ref(ContractDifferenceSetSchema),
}, {
  $id: "https://api-truth.dev/schemas/contract-changes-output-1.0.0.json",
  additionalProperties: false,
});

export type ContractChangesOutput = Static<typeof ContractChangesOutputSchema>;

const fixedIssue = (path: string, code: string, message: string): ValidationIssue => issue(path, code, message);

const orderIssue = (path: string): ValidationIssue =>
  fixedIssue(path, "semantic.noncanonical_order", "values are not in canonical order");

const validatePlanSemantics = (plan: UpdatePlan): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  if (!isCanonicalStringSet(plan.changed_paths)) issues.push(orderIssue("/changed_paths"));
  if (!isCanonicalStringSet(plan.affected_endpoint_ids)) issues.push(orderIssue("/affected_endpoint_ids"));
  plan.changed_paths.forEach((path, index) => {
    const root = plan.service.service_root;
    if (root !== "." && path !== root && !path.startsWith(`${root}/`)) {
      issues.push(fixedIssue(
        `/changed_paths/${index}`,
        "semantic.path_outside_service_root",
        "changed path is outside the selected service root",
      ));
    }
  });
  const reasonRanks = new Map(UPDATE_FALLBACK_REASONS.map((reason, index) => [reason, index]));
  if (!isCanonicalBy(plan.fallback_reasons, (reason) => String(reasonRanks.get(reason)))) {
    issues.push(orderIssue("/fallback_reasons"));
  }
  if (plan.action === "reuse_base_snapshot") {
    if (plan.extraction_mode !== undefined) {
      issues.push(fixedIssue("/extraction_mode", "semantic.action_mode_mismatch", "reuse must omit extraction mode"));
    }
    if (plan.fallback_reasons.length !== 0) {
      issues.push(fixedIssue("/fallback_reasons", "semantic.action_mode_mismatch", "reuse cannot have fallback reasons"));
    }
    if (plan.changed_paths.length !== 0 || plan.affected_endpoint_ids.length !== 0
      || plan.dependency_coverage !== "complete"
      || plan.service.base_source_digest !== plan.service.target_source_digest
      || canonicalJson(plan.analysis.base) !== canonicalJson(plan.analysis.target)) {
      issues.push(fixedIssue("/action", "semantic.reuse_mismatch", "reuse requires identical source and analysis inputs"));
    }
  } else {
    if (plan.extraction_mode !== "fallback_full_service") {
      issues.push(fixedIssue("/extraction_mode", "semantic.action_mode_mismatch", "full analysis requires fallback mode"));
    }
    if (!plan.fallback_reasons.includes("adapter_incremental_targets_unsupported")) {
      issues.push(fixedIssue("/fallback_reasons", "semantic.action_mode_mismatch", "full analysis requires its adapter fallback reason"));
    }
  }
  const { plan_id: _planId, ...content } = plan;
  if (plan.plan_id !== `update-plan-${canonicalSha256Hex(content)}`) {
    issues.push(fixedIssue("/plan_id", "semantic.identity_mismatch", "plan ID does not match canonical content"));
  }
  return issues;
};

const differenceSortKey = (difference: ContractDifference): string[] => {
  const taxonomyRank = DIFFERENCE_KINDS.indexOf(difference.kind);
  return [
    difference.subject.endpoint_id ?? "",
    difference.subject.component_id ?? "",
    canonicalJson(difference.subject.affected_endpoint_ids ?? []),
    difference.subject.fact_kind ?? "",
    difference.subject.fact_key ?? "",
    String(taxonomyRank).padStart(3, "0"),
    difference.difference_id,
  ];
};

const compareDifference = (left: ContractDifference, right: ContractDifference): number => {
  const leftKey = differenceSortKey(left);
  const rightKey = differenceSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const compared = compareUtf8(leftKey[index]!, rightKey[index]!);
    if (compared !== 0) return compared;
  }
  return 0;
};

const validateAssignmentOrder = (
  assignments: readonly ClaimConditionAssignment[],
  path: string,
  issues: ValidationIssue[],
) => {
  if (!isCanonicalBy(assignments, canonicalJson)) issues.push(orderIssue(path));
};

const projectionReferences = [JsonValueSchema, ApiSchemaSchema, ConditionSchema, EndpointIdentitySchema];
const parseEndpointProjection = safeParserFor(EndpointProjectionSchema, undefined, projectionReferences);
const parseParameterProjection = safeParserFor(ParameterProjectionSchema, undefined, projectionReferences);
const parseRequestBodyProjection = safeParserFor(RequestBodyProjectionSchema, undefined, projectionReferences);
const parseResponseProjection = safeParserFor(ResponseProjectionSchema, undefined, projectionReferences);
const parseSecurityProjection = safeParserFor(SecurityProjectionSchema);
const parseSchemaProjection = safeParserFor(SchemaProjectionSchema, undefined, projectionReferences);
const parseClaimProjection = safeParserFor(ClaimProjectionSchema, undefined, [JsonValueSchema, ConditionSchema]);
const parsePathParameterNamesProjection = safeParserFor(PathParameterNamesProjectionSchema);
const parseDiagnosticProjection = safeParserFor(DiagnosticProjectionSchema);
const parseCoverageProjection = safeParserFor(CoverageProjectionSchema);
const parseIdentityProjection = safeParserFor(IdentityProjectionSchema);

type ParsedFactKey = { factKind: Static<typeof FactKindSchema>; tuple: unknown[] };

const expectedFactKind = (difference: ContractDifference): Static<typeof FactKindSchema> | undefined => {
  if (difference.kind.startsWith("endpoint.")) return "endpoint";
  if (difference.kind.startsWith("parameter.")) return "parameter";
  if (difference.kind.startsWith("request_body.")) return "request_body";
  if (difference.kind.startsWith("response.")) return "response";
  if (difference.kind === "security.changed") return "security";
  if (difference.kind.startsWith("schema.")) return "schema";
  if (difference.kind.startsWith("claim.")) return "claim";
  if (difference.kind.startsWith("condition.")) return "condition_group";
  if (difference.kind.startsWith("analysis.diagnostic_")) return "diagnostic";
  if (difference.kind === "analysis.coverage_changed") return "coverage";
  if (difference.kind === "analysis.identity_changed") return "identity";
  if (difference.kind === "fact.absence_unconfirmed") {
    const factKind = difference.subject.fact_kind;
    return factKind === "parameter" || factKind === "request_body" || factKind === "response"
      || factKind === "schema" || factKind === "claim" ? factKind : undefined;
  }
  return undefined;
};

const canonicalStatusKey = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (canonicalJson(parsed) !== value || !Array.isArray(parsed)) return false;
    return (parsed.length === 2 && parsed[0] === "exact"
      && Number.isInteger(parsed[1]) && Number(parsed[1]) >= 100 && Number(parsed[1]) <= 599)
      || (parsed.length === 2 && parsed[0] === "range"
        && typeof parsed[1] === "string" && /^[1-5]XX$/.test(parsed[1]))
      || (parsed.length === 1 && parsed[0] === "default")
      || (parsed.length === 2 && parsed[0] === "unknown"
        && typeof parsed[1] === "string" && parsed[1].length > 0);
  } catch {
    return false;
  }
};

const noUnexpectedSubjectFields = (
  difference: ContractDifference,
  allowed: ReadonlySet<"endpoint_id" | "component_id" | "affected_endpoint_ids">,
): boolean => (difference.subject.endpoint_id === undefined || allowed.has("endpoint_id"))
  && (difference.subject.component_id === undefined || allowed.has("component_id"))
  && (difference.subject.affected_endpoint_ids === undefined || allowed.has("affected_endpoint_ids"));

const parseAndValidateFactKey = (
  difference: ContractDifference,
  path: string,
): { parsed?: ParsedFactKey; issues: ValidationIssue[] } => {
  const issues: ValidationIssue[] = [];
  const expected = expectedFactKind(difference);
  if (expected === undefined || difference.subject.fact_kind !== expected) {
    issues.push(fixedIssue(
      `${path}/subject/fact_kind`,
      "semantic.fact_key_mismatch",
      "difference kind and fact kind disagree",
    ));
    return { issues };
  }
  let tuple: unknown;
  try {
    tuple = JSON.parse(difference.subject.fact_key ?? "");
    if (canonicalJson(tuple) !== difference.subject.fact_key) throw new Error("noncanonical");
  } catch {
    issues.push(fixedIssue(
      `${path}/subject/fact_key`,
      "semantic.fact_key_mismatch",
      "fact key is not its exact canonical tuple",
    ));
    return { issues };
  }
  if (!Array.isArray(tuple)) {
    issues.push(fixedIssue(`${path}/subject/fact_key`, "semantic.fact_key_mismatch", "fact key must be a tuple"));
    return { issues };
  }

  const endpointId = difference.subject.endpoint_id;
  const componentId = difference.subject.component_id;
  const affectedIds = difference.subject.affected_endpoint_ids ?? [];
  let valid = false;
  switch (expected) {
    case "endpoint":
      valid = typeof endpointId === "string" && noUnexpectedSubjectFields(difference, new Set(["endpoint_id"]))
        && tuple.length === 2 && tuple[0] === "endpoint" && tuple[1] === endpointId;
      break;
    case "parameter":
      valid = typeof endpointId === "string" && noUnexpectedSubjectFields(difference, new Set(["endpoint_id"]))
        && tuple.length === 4 && tuple[0] === "parameter" && tuple[1] === endpointId
        && (tuple[2] === "path" || tuple[2] === "query" || tuple[2] === "header" || tuple[2] === "cookie")
        && typeof tuple[3] === "string" && tuple[3].length > 0;
      break;
    case "request_body":
      valid = typeof endpointId === "string" && noUnexpectedSubjectFields(difference, new Set(["endpoint_id"]))
        && tuple.length === 3 && tuple[0] === "request_body" && tuple[1] === endpointId
        && typeof tuple[2] === "string" && tuple[2].length > 0;
      break;
    case "response":
      valid = typeof endpointId === "string" && noUnexpectedSubjectFields(difference, new Set(["endpoint_id"]))
        && tuple.length === 3 && tuple[0] === "response" && tuple[1] === endpointId
        && canonicalStatusKey(tuple[2]);
      break;
    case "security":
      valid = typeof endpointId === "string" && noUnexpectedSubjectFields(difference, new Set(["endpoint_id"]))
        && tuple.length === 2 && tuple[0] === "security" && tuple[1] === endpointId;
      break;
    case "schema":
      valid = typeof componentId === "string"
        && noUnexpectedSubjectFields(difference, new Set(["component_id", "affected_endpoint_ids"]))
        && tuple.length === 2 && tuple[0] === "schema" && tuple[1] === componentId;
      break;
    case "claim":
      valid = noUnexpectedSubjectFields(difference, new Set(["endpoint_id"]))
        && tuple.length === 4 && tuple[0] === "claim"
        && (tuple[1] === null || typeof tuple[1] === "string")
        && tuple[1] === (endpointId ?? null)
        && (tuple[2] === null || (typeof tuple[2] === "string" && tuple[2].length > 0))
        && typeof tuple[3] === "string" && tuple[3].length > 0;
      break;
    case "condition_group":
      valid = noUnexpectedSubjectFields(difference, new Set(["endpoint_id"]))
        && tuple.length === 5 && tuple[0] === "condition_group" && tuple[1] === "claim"
        && (tuple[2] === null || typeof tuple[2] === "string")
        && tuple[2] === (endpointId ?? null)
        && (tuple[3] === null || (typeof tuple[3] === "string" && tuple[3].length > 0))
        && typeof tuple[4] === "string" && tuple[4].length > 0;
      break;
    case "diagnostic":
      valid = noUnexpectedSubjectFields(difference, new Set(["affected_endpoint_ids"]))
        && tuple.length === 3 && tuple[0] === "diagnostic"
        && typeof tuple[1] === "string" && tuple[1].length > 0
        && typeof tuple[2] === "string" && tuple[2] === canonicalJson(affectedIds);
      break;
    case "coverage":
      valid = noUnexpectedSubjectFields(difference, new Set())
        && tuple.length === 1 && tuple[0] === "coverage";
      break;
    case "identity":
      valid = noUnexpectedSubjectFields(difference, new Set())
        && tuple.length === 1 && tuple[0] === "identity";
      break;
  }
  if (!valid) {
    issues.push(fixedIssue(
      `${path}/subject/fact_key`,
      "semantic.fact_key_mismatch",
      "fact key does not match its difference subject",
    ));
    return { issues };
  }
  return { parsed: { factKind: expected, tuple }, issues };
};

const projectionParser = (
  difference: ContractDifference,
  fact: ParsedFactKey,
): ((value: unknown) => ValidationResult<unknown>) => {
  if (difference.kind === "endpoint.path_parameter_names_changed") return parsePathParameterNamesProjection;
  switch (fact.factKind) {
    case "endpoint": return parseEndpointProjection;
    case "parameter": return parseParameterProjection;
    case "request_body": return parseRequestBodyProjection;
    case "response": return parseResponseProjection;
    case "security": return parseSecurityProjection;
    case "schema": return parseSchemaProjection;
    case "claim": return parseClaimProjection;
    case "diagnostic": return parseDiagnosticProjection;
    case "coverage": return parseCoverageProjection;
    case "identity": return parseIdentityProjection;
    case "condition_group": return parseClaimConditionAssignment;
  }
};

const projectionAgreesWithFact = (
  value: unknown,
  difference: ContractDifference,
  fact: ParsedFactKey,
): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  switch (fact.factKind) {
    case "endpoint": return record.endpoint_id === undefined || record.endpoint_id === difference.subject.endpoint_id;
    case "parameter": return (record.in === undefined || record.in === fact.tuple[2])
      && (record.name === undefined || record.name === fact.tuple[3]);
    case "request_body": return record.media_type === undefined || record.media_type === fact.tuple[2];
    case "schema": return record.schema_id === undefined || record.schema_id === difference.subject.component_id;
    case "diagnostic": return record.code === fact.tuple[1]
      && canonicalJson(record.affected_endpoint_ids) === canonicalJson(difference.subject.affected_endpoint_ids ?? []);
    default: return true;
  }
};

const validateFactProjections = (
  difference: ContractDifference,
  fact: ParsedFactKey,
  path: string,
): ValidationIssue[] => {
  if (fact.factKind === "condition_group") return [];
  const issues: ValidationIssue[] = [];
  const parser = projectionParser(difference, fact);
  for (const side of ["before", "after"] as const) {
    if (!(side in difference)) continue;
    const value = difference[side];
    if (!parser(value).ok || !projectionAgreesWithFact(value, difference, fact)) {
      issues.push(fixedIssue(
        `${path}/${side}`,
        "semantic.unsafe_fact_projection",
        "fact projection contains unsupported or private metadata",
      ));
    }
  }
  return issues;
};

const validateDifferenceSemantics = (
  difference: ContractDifference,
  path: string,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  if (difference.subject.affected_endpoint_ids !== undefined
    && !isCanonicalStringSet(difference.subject.affected_endpoint_ids)) {
    issues.push(orderIssue(`${path}/subject/affected_endpoint_ids`));
  }
  if (difference.subject.affected_endpoint_ids !== undefined
    && difference.subject.fact_kind !== "schema"
    && difference.subject.fact_kind !== "diagnostic") {
    issues.push(fixedIssue(`${path}/subject/affected_endpoint_ids`, "semantic.invalid_subject", "affected endpoints are reserved for schema differences"));
  }
  const factResult = parseAndValidateFactKey(difference, path);
  issues.push(...factResult.issues);
  if (factResult.parsed !== undefined) issues.push(...validateFactProjections(difference, factResult.parsed, path));
  if (difference.kind.startsWith("condition.")) {
    const conditionDifference = difference as ConditionGroupDifference;
    validateAssignmentOrder(conditionDifference.before, `${path}/before`, issues);
    validateAssignmentOrder(conditionDifference.after, `${path}/after`, issues);
    if (difference.kind === "condition.changed"
      && canonicalJson(conditionDifference.before) === canonicalJson(conditionDifference.after)) {
      issues.push(fixedIssue(path, "semantic.unchanged_condition_group", "changed condition groups must differ"));
    }
  }
  return issues;
};

const validateDifferenceSetSemantics = (set: ContractDifferenceSet): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const reasonRanks = new Map(DIFFERENCE_INCOMPLETE_REASONS.map((reason, index) => [reason, index]));
  if (!isCanonicalBy(set.incomplete_reason_codes, (reason) => String(reasonRanks.get(reason)))) {
    issues.push(orderIssue("/incomplete_reason_codes"));
  }
  if ((set.comparison_status === "complete") !== (set.incomplete_reason_codes.length === 0)) {
    issues.push(fixedIssue("/comparison_status", "semantic.incomplete_reason_mismatch", "comparison status and reasons disagree"));
  }

  const seenIds = new Set<string>();
  const seenSubjects = new Set<string>();
  set.differences.forEach((difference, index) => {
    const path = `/differences/${index}`;
    if (seenIds.has(difference.difference_id)) {
      issues.push(fixedIssue(`${path}/difference_id`, "semantic.duplicate_id", "duplicate difference ID"));
    }
    seenIds.add(difference.difference_id);
    const subjectKey = canonicalJson([difference.kind, difference.subject]);
    if (seenSubjects.has(subjectKey)) {
      issues.push(fixedIssue(`${path}/subject`, "semantic.duplicate_comparison_key", "duplicate difference subject"));
    }
    seenSubjects.add(subjectKey);
    if (difference.subject.service_id !== set.service_id) {
      issues.push(fixedIssue(`${path}/subject/service_id`, "semantic.scope_mismatch", "difference service does not match its set"));
    }
    const differenceIssues = validateDifferenceSemantics(difference, path);
    issues.push(...differenceIssues);
    const identityContent = {
      version: CONTRACT_DIFFERENCE_VERSION,
      service_id: set.service_id,
      base_snapshot_id: set.base.snapshot_id,
      target_snapshot_id: set.target.snapshot_id,
      kind: difference.kind,
      subject: difference.subject,
      ...("before" in difference ? { before: difference.before } : {}),
      ...("after" in difference ? { after: difference.after } : {}),
    };
    if (differenceIssues.length === 0
      && difference.difference_id !== `difference-${canonicalSha256Hex(identityContent)}`) {
      issues.push(fixedIssue(`${path}/difference_id`, "semantic.identity_mismatch", "difference ID does not match canonical content"));
    }
  });
  for (let index = 1; index < set.differences.length; index += 1) {
    if (compareDifference(set.differences[index - 1]!, set.differences[index]!) >= 0) {
      issues.push(orderIssue("/differences"));
      break;
    }
  }
  const { difference_set_id: _setId, ...content } = set;
  if (issues.length === 0
    && set.difference_set_id !== `difference-set-${canonicalSha256Hex(content)}`) {
    issues.push(fixedIssue("/difference_set_id", "semantic.identity_mismatch", "difference-set ID does not match canonical content"));
  }
  return issues;
};

const validatePlanSummary = (
  plan: ContractChangesPlanSummary,
  prefix: string,
  issues: ValidationIssue[],
) => {
  if (!isCanonicalStringSet(plan.affected_endpoint_ids)) issues.push(orderIssue(`${prefix}/affected_endpoint_ids`));
  const reasonRanks = new Map(UPDATE_FALLBACK_REASONS.map((reason, index) => [reason, index]));
  if (!isCanonicalBy(plan.fallback_reasons, (reason) => String(reasonRanks.get(reason)))) {
    issues.push(orderIssue(`${prefix}/fallback_reasons`));
  }
  if (plan.action === "reuse_base_snapshot") {
    if (plan.extraction_mode !== undefined || plan.fallback_reasons.length !== 0) {
      issues.push(fixedIssue(prefix, "semantic.action_mode_mismatch", "reuse summary has inconsistent mode"));
    }
  } else if (plan.extraction_mode !== "fallback_full_service"
    || !plan.fallback_reasons.includes("adapter_incremental_targets_unsupported")) {
    issues.push(fixedIssue(prefix, "semantic.action_mode_mismatch", "analysis summary has inconsistent mode"));
  }
};

const validateOutputSemantics = (output: ContractChangesOutput): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  validatePlanSummary(output.plan, "/plan", issues);
  const nested = parseContractDifferenceSet(output.differences);
  if (!nested.ok) {
    nested.error.issues.forEach((nestedIssue) => {
      issues.push(fixedIssue(
        `/differences${nestedIssue.path === "/" ? "" : nestedIssue.path}`,
        nestedIssue.code,
        "nested difference set is invalid",
      ));
    });
  }
  if (output.base.snapshot_id !== output.differences.base.snapshot_id
    || output.base.immutable_revision !== output.differences.base.immutable_revision) {
    issues.push(fixedIssue("/base", "semantic.nested_snapshot_mismatch", "base summary and differences disagree"));
  }
  if (output.target.snapshot_id !== output.differences.target.snapshot_id
    || output.target.immutable_revision !== output.differences.target.immutable_revision) {
    issues.push(fixedIssue("/target", "semantic.nested_snapshot_mismatch", "target summary and differences disagree"));
  }
  return issues;
};

const commonReferences = [JsonValueSchema, ConditionSchema, ClaimConditionAssignmentSchema];
export const ContractDifferenceSchemaReferences = [...commonReferences, ContractDifferenceSchema];

export const parseAnalysisKey = safeParserFor(AnalysisKeySchema);
export const parseClaimConditionAssignment = safeParserFor(
  ClaimConditionAssignmentSchema,
  undefined,
  [JsonValueSchema, ConditionSchema],
);
export const parseUpdatePlan = safeParserFor(UpdatePlanSchema, validatePlanSemantics, [AnalysisKeySchema]);
export const parseContractDifference = safeParserFor(
  ContractDifferenceSchema,
  (difference) => validateDifferenceSemantics(difference, ""),
  commonReferences,
);
export const parseContractDifferenceSet = safeParserFor(
  ContractDifferenceSetSchema,
  validateDifferenceSetSemantics,
  ContractDifferenceSchemaReferences,
);
export const parseContractChangesOutput = safeParserFor(
  ContractChangesOutputSchema,
  validateOutputSemantics,
  [...ContractDifferenceSchemaReferences, ContractDifferenceSetSchema],
);

export const UpdatePlanningInputSchemaReferences = [
  ...ContractSnapshotSchemaReferences,
  ContractSnapshotSchema,
  AnalysisKeySchema,
];

export const unsafeParseUpdatePlanningInputShape = safeParserFor(
  UpdatePlanningInputSchema,
  undefined,
  UpdatePlanningInputSchemaReferences,
);
