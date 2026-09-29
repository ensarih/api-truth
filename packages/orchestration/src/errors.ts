import type { ValidationError } from "@api-truth/ir";
import type { OrchestrationErrorCode } from "./types.js";

export type OrchestrationIssue = Readonly<{ path: string; code: string }>;

const messages: Record<OrchestrationErrorCode, string> = {
  INVALID_ORCHESTRATION_INPUT: "Orchestration input is invalid",
  EVENT_UNAUTHORIZED: "Event is not authorized",
  EVENT_ID_CONFLICT: "Event identity conflicts with stored content",
  EVENT_SUBJECT_MISMATCH: "Event subjects do not match authorized configuration",
  CONFIGURATION_NOT_FOUND: "Configuration was not found",
  CONFIGURATION_CONFLICT: "Configuration conflicts with stored content",
  CONFIGURATION_UNAUTHORIZED: "Configuration operation is not authorized",
  EVENT_ORDER_CONFLICT: "Event order conflicts with current state",
  REVISION_ASSOCIATION_CONFLICT: "Revision association conflicts with stored content",
  JOB_NOT_FOUND_OR_DENIED: "Job was not found or access was denied",
  WORKER_UNAUTHORIZED: "Worker is not authorized",
  JOB_LEASE_CONFLICT: "Job lease conflicts with current state",
  JOB_CANCELLED: "Job was cancelled",
  JOB_SUPERSEDED: "Job was superseded",
  JOB_DEPENDENCY_FAILED: "Job dependency failed",
  JOB_EXECUTION_FAILED: "Job execution failed",
  RECONCILIATION_FAILED: "Reconciliation failed",
  OUTBOX_LEASE_CONFLICT: "Outbox lease conflicts with current state",
  OUTBOX_DELIVERY_FAILED: "Outbox delivery failed",
  PROMOTION_INELIGIBLE: "Branch promotion is not eligible",
  ORCHESTRATION_STORAGE_ERROR: "Orchestration storage operation failed",
};

const safeSegments = new Set([
  "adapterId", "allowedEventTypes", "allowedRepositories", "allowedServices", "attemptCount",
  "capabilities", "checkpointVersion", "configuration", "deploymentAuthorityGrants", "document",
  "environment", "event", "event_type", "fingerprint", "instanceId", "maxAttempts", "payload",
  "principalId", "producer", "producerId", "repository_id", "repositoryId", "safeErrorCode",
  "service_ids", "serviceId", "source", "subjects", "tenantId", "workerId",
]);

const safeCodes = new Set([
  "shape.additionalProperties", "shape.anyOf", "shape.const", "shape.enum", "shape.format",
  "shape.invalid_json_value", "shape.maxItems", "shape.maxLength", "shape.minItems", "shape.minimum",
  "shape.minLength", "shape.oneOf", "shape.pattern", "shape.required", "shape.type", "shape.uniqueItems",
  "semantic.noncanonical_order", "semantic.scope_mismatch", "validation.invalid",
]);

export const sanitizeOrchestrationIssuePath = (candidate: string): string => {
  if (candidate === "/" || !candidate.startsWith("/")) return "/";
  return `/${candidate.split("/").slice(1).map((segment) =>
    /^(0|[1-9][0-9]*)$/.test(segment) || safeSegments.has(segment) ? segment : "*"
  ).join("/")}`;
};

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  readonly retryable: boolean;
  readonly issues?: ReadonlyArray<OrchestrationIssue>;

  constructor(code: OrchestrationErrorCode, options: { retryable?: boolean; issues?: ReadonlyArray<OrchestrationIssue> } = {}) {
    super(messages[code]);
    this.name = "OrchestrationError";
    this.code = code;
    this.retryable = options.retryable ?? [
      "JOB_EXECUTION_FAILED", "RECONCILIATION_FAILED", "OUTBOX_DELIVERY_FAILED", "ORCHESTRATION_STORAGE_ERROR",
    ].includes(code);
    if (options.issues !== undefined) {
      this.issues = Object.freeze(options.issues.map((input) => {
        try {
          const descriptors = Object.getOwnPropertyDescriptors(input);
          const path = descriptors.path && "value" in descriptors.path && typeof descriptors.path.value === "string"
            ? sanitizeOrchestrationIssuePath(descriptors.path.value) : "/";
          const issueCode = descriptors.code && "value" in descriptors.code && typeof descriptors.code.value === "string" && safeCodes.has(descriptors.code.value)
            ? descriptors.code.value : "validation.invalid";
          return Object.freeze({ path, code: issueCode });
        } catch {
          return Object.freeze({ path: "/", code: "validation.invalid" });
        }
      }));
    }
  }
}

export const orchestrationValidationError = (validation: ValidationError): OrchestrationError =>
  new OrchestrationError("INVALID_ORCHESTRATION_INPUT", { issues: validation.issues });

export const orchestrationStorageError = (cause?: unknown): OrchestrationError => Object.defineProperty(
  new OrchestrationError("ORCHESTRATION_STORAGE_ERROR", { retryable: true }),
  "cause", { value: cause, enumerable: false, configurable: true },
);
