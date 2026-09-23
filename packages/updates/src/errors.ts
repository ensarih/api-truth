import type { ValidationError } from "@api-truth/ir";
import type { UpdateErrorCode } from "./types.js";

export type UpdateIssue = Readonly<{ path: string; code: string }>;

const messages: Record<UpdateErrorCode, string> = {
  INVALID_UPDATE_INPUT: "Update input is invalid",
  UPDATE_SCOPE_MISMATCH: "Update scope does not match",
  UPDATE_ANALYSIS_MISMATCH: "Update analysis does not match",
  UPDATE_COMPARISON_INCOMPATIBLE: "Contract snapshots cannot be compared",
  UPDATE_EXECUTION_FAILED: "Update execution failed",
};

type UpdateErrorOptions = {
  issues?: ReadonlyArray<UpdateIssue>;
  retryable?: boolean;
};

const safePathSegments = new Set([
  "action", "affected_endpoint_ids", "after", "analysis", "analysis_key", "analyzed_roots",
  "analyzer", "analyzer_exchange_version", "analyzer_id", "analyzer_version", "application_path",
  "base", "base_analysis_key", "base_revision", "base_snapshot", "base_snapshot_id",
  "base_source_digest", "before", "changed_paths", "changed_paths_complete", "claims", "code",
  "comparison_status", "component_id", "condition", "config", "config_fingerprint", "config_version",
  "content", "contract_changes_output_version", "contract_difference_version", "coverage",
  "coverage_status", "created_at", "dependencies", "dependency_coverage", "diagnostics", "difference_id",
  "difference_set_id", "differences", "editorial_reviews", "endpoint_id", "endpoints", "evidence",
  "export_eligibility", "extraction_mode", "fact_key", "fact_kind", "fallback_reasons", "headers",
  "identity", "identity_version", "immutable_revision", "in", "incomplete_reason_codes", "ir_version",
  "kind", "name", "parameters", "plan", "plan_id", "predicate", "properties", "repository_id",
  "request_bodies", "responses", "schema", "schema_id", "schemas", "security", "service", "service_id",
  "service_root", "severity", "snapshot_id", "source", "source_digest", "status", "subject", "target",
  "target_revision", "target_source_digest", "update_plan_version", "value", "verification",
]);

const safeIssueCodes = new Set([
  "shape.additionalProperties", "shape.anyOf", "shape.const", "shape.enum", "shape.format",
  "shape.invalid_json_value", "shape.maximum", "shape.maxItems", "shape.maxLength", "shape.minItems",
  "shape.minimum", "shape.minLength", "shape.minProperties", "shape.oneOf", "shape.pattern",
  "shape.required", "shape.type", "shape.uniqueItems",
  "semantic.action_mode_mismatch", "semantic.analysis_mismatch", "semantic.basis_mismatch",
  "semantic.conflicting_artifact_mapping", "semantic.conflicting_claims", "semantic.cross_repository_reference",
  "semantic.cross_service_reference",
  "semantic.dangling_reference", "semantic.duplicate_comparison_key", "semantic.duplicate_id",
  "semantic.environment_mismatch",
  "semantic.fact_key_mismatch", "semantic.identity_mismatch", "semantic.incomplete_coverage_without_diagnostic",
  "semantic.incomplete_absence", "semantic.incomplete_reason_mismatch", "semantic.inconsistent_completeness",
  "semantic.inconsistent_coverage", "semantic.ineligible_evidence",
  "semantic.intended_branch_mismatch", "semantic.invalid_api_schema", "semantic.invalid_path_syntax",
  "semantic.invalid_subject", "semantic.missing_fact_key", "semantic.nested_snapshot_mismatch",
  "semantic.noncanonical_order",
  "semantic.path_outside_service_root", "semantic.reuse_mismatch", "semantic.route_identity_collision",
  "semantic.scope_mismatch", "semantic.unchanged_condition_group", "semantic.unrelated_evidence",
  "semantic.unsafe_fact_projection",
]);

export const sanitizeUpdateIssuePath = (candidate: string): string => {
  if (candidate === "/" || !candidate.startsWith("/")) return "/";
  const segments = candidate.split("/").slice(1).map((segment) => {
    if (/^(0|[1-9][0-9]*)$/.test(segment)) return segment;
    return safePathSegments.has(segment) ? segment : "*";
  });
  return `/${segments.join("/")}`;
};

const sanitizeUpdateIssueCode = (candidate: string): string =>
  safeIssueCodes.has(candidate) ? candidate : "validation.invalid";

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;
  readonly issues?: ReadonlyArray<UpdateIssue>;
  readonly retryable: boolean;

  constructor(code: UpdateErrorCode, options: UpdateErrorOptions = {}) {
    super(messages[code]);
    this.name = "UpdateError";
    this.code = code;
    this.retryable = options.retryable ?? code === "UPDATE_EXECUTION_FAILED";
    if (options.issues !== undefined) {
      this.issues = Object.freeze(options.issues.map((candidate) => {
        let path = "/";
        let issueCode = "validation.invalid";
        try {
          const descriptors = Object.getOwnPropertyDescriptors(candidate);
          const pathDescriptor = descriptors.path;
          const codeDescriptor = descriptors.code;
          if (pathDescriptor && "value" in pathDescriptor && typeof pathDescriptor.value === "string") {
            path = sanitizeUpdateIssuePath(pathDescriptor.value);
          }
          if (codeDescriptor && "value" in codeDescriptor && typeof codeDescriptor.value === "string") {
            issueCode = sanitizeUpdateIssueCode(codeDescriptor.value);
          }
        } catch {
          // Hostile issue objects collapse to fixed safe placeholders.
        }
        return Object.freeze({ path, code: issueCode });
      }));
    }
  }
}

export const updateValidationError = (
  code: "INVALID_UPDATE_INPUT" | "UPDATE_SCOPE_MISMATCH" | "UPDATE_ANALYSIS_MISMATCH" | "UPDATE_COMPARISON_INCOMPATIBLE",
  validation: ValidationError,
): UpdateError => new UpdateError(code, { issues: validation.issues });

export const updateExecutionError = (_cause?: unknown): UpdateError =>
  Object.defineProperty(
    new UpdateError("UPDATE_EXECUTION_FAILED", { retryable: true }),
    "cause",
    { value: _cause, enumerable: false, configurable: true },
  );

export const asUpdateError = (error: unknown): UpdateError => {
  try {
    if (error instanceof UpdateError) return error;
  } catch {
    // A thrown Proxy can have hostile prototype traps.
  }
  return updateExecutionError(error);
};
