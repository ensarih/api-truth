export const UPDATE_PLAN_VERSION = "1.0.0" as const;
export const CONTRACT_DIFFERENCE_VERSION = "1.0.0" as const;
export const CONTRACT_CHANGES_OUTPUT_VERSION = "1.0.0" as const;

export const UPDATE_FALLBACK_REASONS = [
  "adapter_incremental_targets_unsupported",
  "prior_coverage_incomplete",
  "changed_paths_incomplete",
  "changed_paths_digest_mismatch",
  "changed_path_unindexed",
  "dependency_index_incomplete",
  "analyzer_changed",
  "config_changed",
  "ir_changed",
  "identity_changed",
] as const;

export type UpdateFallbackReason = typeof UPDATE_FALLBACK_REASONS[number];

export const DIFFERENCE_INCOMPLETE_REASONS = [
  "base_coverage_incomplete",
  "target_coverage_incomplete",
  "identity_version_changed",
] as const;

export type DifferenceIncompleteReason = typeof DIFFERENCE_INCOMPLETE_REASONS[number];

export const DIFFERENCE_KINDS = [
  "endpoint.added",
  "endpoint.removed",
  "endpoint.absence_unconfirmed",
  "endpoint.path_parameter_names_changed",
  "parameter.added",
  "parameter.removed",
  "parameter.changed",
  "request_body.added",
  "request_body.removed",
  "request_body.changed",
  "response.added",
  "response.removed",
  "response.changed",
  "security.changed",
  "schema.added",
  "schema.removed",
  "schema.changed",
  "claim.added",
  "claim.removed",
  "claim.changed",
  "condition.added",
  "condition.removed",
  "condition.changed",
  "fact.absence_unconfirmed",
  "analysis.coverage_changed",
  "analysis.identity_changed",
  "analysis.diagnostic_added",
  "analysis.diagnostic_resolved",
] as const;

export type DifferenceKind = typeof DIFFERENCE_KINDS[number];
export type CompatibilityLabel = "non_breaking" | "potentially_breaking" | "unknown";

export type UpdateErrorCode =
  | "INVALID_UPDATE_INPUT"
  | "UPDATE_SCOPE_MISMATCH"
  | "UPDATE_ANALYSIS_MISMATCH"
  | "UPDATE_COMPARISON_INCOMPATIBLE"
  | "UPDATE_EXECUTION_FAILED";
