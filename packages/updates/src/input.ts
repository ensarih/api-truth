import {
  failure,
  issue,
  parseContractSnapshot,
  type ValidationIssue,
  type ValidationResult,
} from "@api-truth/ir";
import { canonicalJson, isCanonicalStringSet } from "./canonical.js";
import { UpdateError, sanitizeUpdateIssuePath, updateValidationError } from "./errors.js";
import {
  unsafeParseUpdatePlanningInputShape,
  type UpdatePlanningInput,
} from "./schema.js";

const prefixed = (prefix: string, validationIssues: readonly ValidationIssue[]): ValidationIssue[] =>
  validationIssues.map((candidate) => issue(
    sanitizeUpdateIssuePath(`${prefix}${candidate.path === "/" ? "" : candidate.path}`),
    candidate.code,
    "nested contract is invalid",
  ));

const semanticIssues = (input: UpdatePlanningInput): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  if (!isCanonicalStringSet(input.changed_paths)) {
    issues.push(issue(
      "/changed_paths",
      "semantic.noncanonical_order",
      "changed paths must be unique and UTF-8 byte sorted",
    ));
  }
  const snapshotResult = parseContractSnapshot(input.base_snapshot);
  if (!snapshotResult.ok) {
    issues.push(...prefixed("/base_snapshot", snapshotResult.error.issues));
    return issues;
  }

  const snapshot = snapshotResult.value;
  if (input.target.repository_id !== snapshot.service.repository_id) {
    issues.push(issue("/target/repository_id", "semantic.scope_mismatch", "target repository differs from base service"));
  }
  if (input.target.service_id !== snapshot.service.service_id) {
    issues.push(issue("/target/service_id", "semantic.scope_mismatch", "target service differs from base service"));
  }
  if (input.target.service_root !== snapshot.service.root) {
    issues.push(issue("/target/service_root", "semantic.scope_mismatch", "target root differs from base service"));
  }

  const expectedBaseAnalysis = {
    analyzer: snapshot.analyzer,
    ir_version: snapshot.ir_version,
    identity_version: snapshot.identity_version,
    config_version: snapshot.config.config_version,
    config_fingerprint: snapshot.config.config_fingerprint,
  };
  const recordedBaseAnalysis = {
    analyzer: input.base_analysis_key.analyzer,
    ir_version: input.base_analysis_key.ir_version,
    identity_version: input.base_analysis_key.identity_version,
    config_version: input.base_analysis_key.config_version,
    config_fingerprint: input.base_analysis_key.config_fingerprint,
  };
  if (canonicalJson(expectedBaseAnalysis) !== canonicalJson(recordedBaseAnalysis)) {
    issues.push(issue("/base_analysis_key", "semantic.analysis_mismatch", "recorded base analysis differs from its snapshot"));
  }

  const root = input.target.service_root;
  input.changed_paths.forEach((path, index) => {
    const insideRoot = root === "." || path === root || path.startsWith(`${root}/`);
    if (!insideRoot) {
      issues.push(issue(
        `/changed_paths/${index}`,
        "semantic.path_outside_service_root",
        "changed path is outside the selected service root",
      ));
    }
  });
  return issues;
};

export const parseUpdatePlanningInput = (
  value: unknown,
): ValidationResult<UpdatePlanningInput> => {
  const shape = unsafeParseUpdatePlanningInputShape(value);
  if (!shape.ok) {
    return failure(shape.error.issues.map((candidate) => issue(
      sanitizeUpdateIssuePath(candidate.path),
      candidate.code,
      candidate.message,
    )));
  }
  try {
    const issues = semanticIssues(shape.value);
    return issues.length === 0 ? shape : failure(issues);
  } catch {
    return failure([issue("/", "shape.invalid_json_value", "input must contain only JSON values")]);
  }
};

export const validateUpdatePlanningInput = (value: unknown): UpdatePlanningInput => {
  const parsed = parseUpdatePlanningInput(value);
  if (parsed.ok) return parsed.value;
  const issueCodes = new Set(parsed.error.issues.map((candidate) => candidate.code));
  if (issueCodes.has("semantic.scope_mismatch")) {
    throw updateValidationError("UPDATE_SCOPE_MISMATCH", parsed.error);
  }
  if (issueCodes.has("semantic.analysis_mismatch")) {
    throw updateValidationError("UPDATE_ANALYSIS_MISMATCH", parsed.error);
  }
  throw updateValidationError("INVALID_UPDATE_INPUT", parsed.error);
};

export const invalidUpdateInput = (): never => {
  throw new UpdateError("INVALID_UPDATE_INPUT");
};
