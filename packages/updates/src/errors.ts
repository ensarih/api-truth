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
            path = pathDescriptor.value;
          }
          if (codeDescriptor && "value" in codeDescriptor && typeof codeDescriptor.value === "string") {
            issueCode = codeDescriptor.value;
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
