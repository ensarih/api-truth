export type EnvironmentErrorCode = "INVALID_ENVIRONMENT_INPUT" | "ENVIRONMENT_NOT_FOUND_OR_DENIED"
  | "ENVIRONMENT_STORAGE_ERROR" | "ARTIFACT_BINDING_CONFLICT";

const messages: Record<EnvironmentErrorCode, string> = {
  INVALID_ENVIRONMENT_INPUT: "Environment input is invalid",
  ENVIRONMENT_NOT_FOUND_OR_DENIED: "Environment event was not found or access was denied",
  ENVIRONMENT_STORAGE_ERROR: "Environment storage operation failed",
  ARTIFACT_BINDING_CONFLICT: "Artifact binding conflicts with stored evidence",
};

export class EnvironmentError extends Error {
  readonly code: EnvironmentErrorCode;
  readonly retryable: boolean;

  constructor(code: EnvironmentErrorCode) {
    super(messages[code]);
    this.name = "EnvironmentError";
    this.code = code;
    this.retryable = code === "ENVIRONMENT_STORAGE_ERROR";
  }
}
