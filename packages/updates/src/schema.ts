import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  AnalyzerExchangeVersionSchema,
  ConditionSchema,
  ConfigVersionSchema,
  ContractSnapshotSchema,
  ContractSnapshotSchemaReferences,
  IdentityVersionSchema,
  ImmutableRevisionSchema,
  IrVersionSchema,
  JsonValueSchema,
  NormalizedProjectPathSchema,
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

export const DifferenceSubjectSchema = Type.Object({
  service_id: NonEmptyString(),
  endpoint_id: Type.Optional(NonEmptyString()),
  component_id: Type.Optional(NonEmptyString()),
  affected_endpoint_ids: Type.Optional(Type.Array(NonEmptyString(), { minItems: 1, uniqueItems: true })),
  fact_kind: Type.Optional(NonEmptyString()),
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

const validateDifferenceSemantics = (
  difference: ContractDifference,
  path: string,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  if (difference.subject.affected_endpoint_ids !== undefined
    && !isCanonicalStringSet(difference.subject.affected_endpoint_ids)) {
    issues.push(orderIssue(`${path}/subject/affected_endpoint_ids`));
  }
  if (difference.subject.affected_endpoint_ids !== undefined && !difference.kind.startsWith("schema.")) {
    issues.push(fixedIssue(`${path}/subject/affected_endpoint_ids`, "semantic.invalid_subject", "affected endpoints are reserved for schema differences"));
  }
  const serviceScoped = difference.kind === "analysis.coverage_changed"
    || difference.kind === "analysis.identity_changed";
  if (!serviceScoped && (difference.subject.fact_kind === undefined || difference.subject.fact_key === undefined)) {
    issues.push(fixedIssue(`${path}/subject`, "semantic.missing_fact_key", "difference subject requires a fact key"));
  }
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
    issues.push(...validateDifferenceSemantics(difference, path));
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
    if (difference.difference_id !== `difference-${canonicalSha256Hex(identityContent)}`) {
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
  if (set.difference_set_id !== `difference-set-${canonicalSha256Hex(content)}`) {
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
