import { contractSnapshotFromAnalyzerResult } from "@api-truth/catalog";
import {
  CONFIG_VERSION,
  IDENTITY_VERSION,
  issue,
  parseAnalyzerRequest,
  parseAnalyzerResult,
  parseContractSnapshot,
  type AnalyzerRequest,
  type AnalyzerResult,
  type ContractSnapshot,
  type ValidationError,
} from "@api-truth/ir";
import { canonicalJson, canonicalSha256Hex } from "./canonical.js";
import { compareContractSnapshots } from "./differences.js";
import { UpdateError, updateExecutionError, updateValidationError } from "./errors.js";
import {
  parseContractDifferenceSet,
  parseUpdatePlan,
  type ContractDifferenceSet,
  type UpdatePlan,
} from "./schema.js";
import { CONTRACT_DIFFERENCE_VERSION } from "./types.js";

export type Analyzer = {
  analyze(request: AnalyzerRequest): Promise<AnalyzerResult>;
};

export type ExecuteUpdateInput = {
  plan: UpdatePlan;
  request: AnalyzerRequest;
  base_snapshot: ContractSnapshot;
  config_fingerprint: string;
};

export type UpdateExecutionResult = {
  plan: UpdatePlan;
  analyzer_result?: AnalyzerResult;
  target_snapshot: ContractSnapshot;
  differences: ContractDifferenceSet;
};

type ParsedExecutionInput = {
  plan: UpdatePlan;
  request: AnalyzerRequest;
  baseSnapshot: ContractSnapshot;
  configFingerprint: string;
};

const exactKeys = (descriptors: PropertyDescriptorMap, expected: readonly string[]): boolean => {
  const keys = Object.keys(descriptors).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const prefixedValidation = (prefix: string, validation: ValidationError): ValidationError => ({
  kind: "validation_error",
  issues: validation.issues.map((candidate) => issue(
    `${prefix}${candidate.path === "/" ? "" : candidate.path}`,
    candidate.code,
    "nested update execution input is invalid",
  )),
});

const invalidInput = (path = "/", code = "shape.type"): never => {
  throw new UpdateError("INVALID_UPDATE_INPUT", { issues: [{ path, code }] });
};

const parseExecutionInput = (value: unknown): ParsedExecutionInput => {
  let descriptors: PropertyDescriptorMap;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidInput();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalidInput();
  }
  if (!exactKeys(descriptors, ["plan", "request", "base_snapshot", "config_fingerprint"])) {
    return invalidInput("/", "shape.additionalProperties");
  }
  for (const key of ["plan", "request", "base_snapshot", "config_fingerprint"] as const) {
    if (!("value" in descriptors[key]!)) return invalidInput(`/${key}`, "shape.type");
  }

  const parsedPlan = parseUpdatePlan(descriptors.plan!.value);
  if (!parsedPlan.ok) {
    throw updateValidationError("INVALID_UPDATE_INPUT", prefixedValidation("/plan", parsedPlan.error));
  }
  let parsedRequest: ReturnType<typeof parseAnalyzerRequest>;
  let parsedBase: ReturnType<typeof parseContractSnapshot>;
  try {
    parsedRequest = parseAnalyzerRequest(descriptors.request!.value);
    parsedBase = parseContractSnapshot(descriptors.base_snapshot!.value);
  } catch {
    return invalidInput("/", "shape.invalid_json_value");
  }
  if (!parsedRequest.ok) {
    throw updateValidationError("INVALID_UPDATE_INPUT", prefixedValidation("/request", parsedRequest.error));
  }
  if (!parsedBase.ok) {
    throw updateValidationError("INVALID_UPDATE_INPUT", prefixedValidation("/base_snapshot", parsedBase.error));
  }
  const fingerprint = descriptors.config_fingerprint!.value;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    return invalidInput("/config_fingerprint", "shape.minLength");
  }
  return {
    plan: parsedPlan.value,
    request: parsedRequest.value,
    baseSnapshot: parsedBase.value,
    configFingerprint: fingerprint,
  };
};

const analyzerFor = (value: unknown): Analyzer => {
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidInput("/analyzer");
    descriptor = Object.getOwnPropertyDescriptor(value, "analyze");
  } catch {
    return invalidInput("/analyzer");
  }
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    return invalidInput("/analyzer/analyze");
  }
  return value as Analyzer;
};

const mismatch = (
  code: "UPDATE_SCOPE_MISMATCH" | "UPDATE_ANALYSIS_MISMATCH",
  path: string,
  issueCode: "semantic.scope_mismatch" | "semantic.analysis_mismatch" | "semantic.action_mode_mismatch",
): never => {
  throw new UpdateError(code, { issues: [{ path, code: issueCode }] });
};

const agrees = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const validateBaseAgreement = (input: ParsedExecutionInput): void => {
  const { plan, baseSnapshot } = input;
  const service = plan.service;
  if (baseSnapshot.snapshot_id !== service.base_snapshot_id) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/base_snapshot/snapshot_id", "semantic.scope_mismatch");
  }
  if (baseSnapshot.service.repository_id !== service.repository_id) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/base_snapshot/service/repository_id", "semantic.scope_mismatch");
  }
  if (baseSnapshot.service.service_id !== service.service_id) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/base_snapshot/service/service_id", "semantic.scope_mismatch");
  }
  if (baseSnapshot.service.root !== service.service_root) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/base_snapshot/service/root", "semantic.scope_mismatch");
  }
  if (baseSnapshot.source.immutable_revision !== service.base_revision) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/base_snapshot/source/immutable_revision", "semantic.scope_mismatch");
  }
  if (baseSnapshot.source.source_digest !== service.base_source_digest) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/base_snapshot/source/source_digest", "semantic.scope_mismatch");
  }
  const actualBaseAnalysis = {
    analyzer: baseSnapshot.analyzer,
    ir_version: baseSnapshot.ir_version,
    identity_version: baseSnapshot.identity_version,
    config_version: baseSnapshot.config.config_version,
    config_fingerprint: baseSnapshot.config.config_fingerprint,
  };
  const recordedBaseAnalysis = {
    analyzer: plan.analysis.base.analyzer,
    ir_version: plan.analysis.base.ir_version,
    identity_version: plan.analysis.base.identity_version,
    config_version: plan.analysis.base.config_version,
    config_fingerprint: plan.analysis.base.config_fingerprint,
  };
  if (!agrees(actualBaseAnalysis, recordedBaseAnalysis)) {
    mismatch("UPDATE_ANALYSIS_MISMATCH", "/base_snapshot", "semantic.analysis_mismatch");
  }
};

const validateRequestAgreement = (input: ParsedExecutionInput): void => {
  const { plan, request, configFingerprint } = input;
  const expectedSource = {
    repository_id: plan.service.repository_id,
    service_id: plan.service.service_id,
    service_root: plan.service.service_root,
    immutable_revision: plan.service.target_revision,
    source_digest: plan.service.target_source_digest,
  };
  const actualSource = {
    repository_id: request.source.repository_id,
    service_id: request.source.service_id,
    service_root: request.source.service_root,
    immutable_revision: request.source.immutable_revision,
    source_digest: request.source.source_digest,
  };
  if (!agrees(actualSource, expectedSource)) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/request/source", "semantic.scope_mismatch");
  }
  const resolutionInput = request.resolution_inputs[0];
  if (request.resolution_inputs.length !== 1
    || resolutionInput?.kind !== "source_tree"
    || resolutionInput.path !== plan.service.service_root
    || resolutionInput.digest !== plan.service.target_source_digest) {
    mismatch("UPDATE_SCOPE_MISMATCH", "/request/resolution_inputs", "semantic.scope_mismatch");
  }
  if (!agrees(request.analyzer, plan.analysis.target.analyzer)
    || request.exchange_version !== plan.analysis.target.analyzer_exchange_version
    || request.ir_version !== plan.analysis.target.ir_version
    || plan.analysis.target.identity_version !== IDENTITY_VERSION
    || plan.analysis.target.config_version !== CONFIG_VERSION
    || configFingerprint !== plan.analysis.target.config_fingerprint) {
    mismatch("UPDATE_ANALYSIS_MISMATCH", "/request", "semantic.analysis_mismatch");
  }
  if (!agrees(request.changed_paths, plan.changed_paths)) {
    mismatch("UPDATE_ANALYSIS_MISMATCH", "/request/changed_paths", "semantic.analysis_mismatch");
  }
  if (plan.action === "analyze_full_service"
    && (plan.extraction_mode !== "fallback_full_service"
      || request.extraction_mode !== "fallback_full_service")) {
    mismatch("UPDATE_ANALYSIS_MISMATCH", "/request/extraction_mode", "semantic.action_mode_mismatch");
  }
};

const executionFailure = (path: string, code: string): never => {
  throw new UpdateError("UPDATE_EXECUTION_FAILED", { issues: [{ path, code }], retryable: true });
};

const validateResultAgreement = (
  result: AnalyzerResult,
  request: AnalyzerRequest,
  plan: UpdatePlan,
): void => {
  if (result.status === "failed") {
    executionFailure("/analyzer_result/status", "semantic.ineligible_evidence");
  }
  if (result.request_id !== request.request_id) {
    executionFailure("/analyzer_result/request_id", "semantic.analysis_mismatch");
  }
  if (!agrees(result.analyzer, request.analyzer)
    || result.exchange_version !== request.exchange_version
    || result.ir_version !== request.ir_version
    || result.identity_version !== plan.analysis.target.identity_version) {
    executionFailure("/analyzer_result", "semantic.analysis_mismatch");
  }
  if (!agrees(result.source, request.source)) {
    executionFailure("/analyzer_result/source", "semantic.scope_mismatch");
  }
};

const emptyDifferenceSet = (snapshot: ContractSnapshot): ContractDifferenceSet => {
  const content = {
    contract_difference_version: CONTRACT_DIFFERENCE_VERSION,
    service_id: snapshot.service.service_id,
    base: { snapshot_id: snapshot.snapshot_id, immutable_revision: snapshot.source.immutable_revision },
    target: { snapshot_id: snapshot.snapshot_id, immutable_revision: snapshot.source.immutable_revision },
    comparison_status: "complete" as const,
    incomplete_reason_codes: [],
    differences: [],
  };
  const candidate = {
    difference_set_id: `difference-set-${canonicalSha256Hex(content)}`,
    ...content,
  };
  const parsed = parseContractDifferenceSet(candidate);
  if (!parsed.ok) return executionFailure("/differences", "semantic.identity_mismatch");
  return parsed.value;
};

const parsedAnalyzerResult = (value: unknown): AnalyzerResult => {
  let parsed: ReturnType<typeof parseAnalyzerResult>;
  try {
    parsed = parseAnalyzerResult(value);
  } catch {
    return executionFailure("/analyzer_result", "shape.invalid_json_value");
  }
  if (!parsed.ok) {
    throw new UpdateError("UPDATE_EXECUTION_FAILED", {
      issues: prefixedValidation("/analyzer_result", parsed.error).issues,
      retryable: true,
    });
  }
  return parsed.value;
};

const parsedTargetSnapshot = (value: unknown): ContractSnapshot => {
  const parsed = parseContractSnapshot(value);
  if (!parsed.ok) {
    throw new UpdateError("UPDATE_EXECUTION_FAILED", {
      issues: prefixedValidation("/target_snapshot", parsed.error).issues,
      retryable: true,
    });
  }
  return parsed.value;
};

export const executeUpdate = async (
  value: unknown,
  analyzerValue: unknown,
): Promise<UpdateExecutionResult> => {
  const input = parseExecutionInput(value);
  const analyzer = analyzerFor(analyzerValue);
  validateBaseAgreement(input);
  validateRequestAgreement(input);

  if (input.plan.action === "reuse_base_snapshot") {
    if (input.baseSnapshot.coverage.status !== "complete") {
      mismatch("UPDATE_ANALYSIS_MISMATCH", "/plan/action", "semantic.action_mode_mismatch");
    }
    return {
      plan: input.plan,
      target_snapshot: input.baseSnapshot,
      differences: emptyDifferenceSet(input.baseSnapshot),
    };
  }

  const request: AnalyzerRequest = {
    ...input.request,
    changed_paths: [...input.plan.changed_paths],
    extraction_mode: "fallback_full_service",
  };
  let rawResult: unknown;
  try {
    rawResult = await analyzer.analyze(request);
  } catch (error) {
    throw updateExecutionError(error);
  }
  const result = parsedAnalyzerResult(rawResult);
  validateResultAgreement(result, request, input.plan);

  let targetSnapshot: ContractSnapshot;
  try {
    targetSnapshot = parsedTargetSnapshot(
      contractSnapshotFromAnalyzerResult(result, input.configFingerprint).snapshot,
    );
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw updateExecutionError(error);
  }
  if (targetSnapshot.config.config_version !== input.plan.analysis.target.config_version
    || targetSnapshot.config.config_fingerprint !== input.plan.analysis.target.config_fingerprint) {
    return executionFailure("/target_snapshot/config", "semantic.analysis_mismatch");
  }

  const differences = compareContractSnapshots({
    base_snapshot: input.baseSnapshot,
    target_snapshot: targetSnapshot,
  });
  return {
    plan: input.plan,
    analyzer_result: result,
    target_snapshot: targetSnapshot,
    differences,
  };
};
