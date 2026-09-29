import { OrchestrationError } from "./errors.js";
import { canonicalOrchestrationJson } from "./canonical.js";
import type { JobState } from "./types.js";

export type ReducedJob = Readonly<{
  state: JobState;
  errorCode?: "JOB_DEPENDENCY_FAILED" | "JOB_EXECUTION_FAILED";
  supersedingJobId?: string;
}>;

export type JobTransition =
  | { kind: "lease" }
  | { kind: "succeed" }
  | { kind: "retry" }
  | { kind: "fail" }
  | { kind: "cancel" }
  | { kind: "supersede"; supersedingJobId: string }
  | { kind: "dependency_failed"; cancellationRequested?: boolean; supersedingJobId?: string };

const terminal = new Set<JobState>(["succeeded", "failed", "cancelled", "superseded"]);

const detachedRecord = (input: unknown): Record<string, unknown> => {
  let value: unknown;
  try { value = JSON.parse(canonicalOrchestrationJson(input)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  return value as Record<string, unknown>;
};

const parseReducedJob = (input: unknown): ReducedJob => {
  const value = detachedRecord(input);
  const allowed = new Set(["state", "errorCode", "supersedingJobId"]);
  const states: JobState[] = ["queued", "leased", "retry_wait", "succeeded", "failed", "cancelled", "superseded"];
  if (Object.keys(value).some((key) => !allowed.has(key)) || !states.includes(value.state as JobState)
    || value.errorCode !== undefined && value.errorCode !== "JOB_DEPENDENCY_FAILED" && value.errorCode !== "JOB_EXECUTION_FAILED"
    || value.supersedingJobId !== undefined && (typeof value.supersedingJobId !== "string" || value.supersedingJobId.length === 0)) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  return value as ReducedJob;
};

const parseTransition = (input: unknown): JobTransition => {
  const value = detachedRecord(input);
  if (typeof value.kind !== "string") throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  const keys = Object.keys(value);
  if (["lease", "succeed", "retry", "fail", "cancel"].includes(value.kind) && keys.length === 1) return value as JobTransition;
  if (value.kind === "supersede" && keys.length === 2 && typeof value.supersedingJobId === "string" && value.supersedingJobId.length > 0) {
    return value as JobTransition;
  }
  if (value.kind === "dependency_failed" && keys.every((key) => ["kind", "cancellationRequested", "supersedingJobId"].includes(key))
    && (value.cancellationRequested === undefined || typeof value.cancellationRequested === "boolean")
    && (value.supersedingJobId === undefined || typeof value.supersedingJobId === "string" && value.supersedingJobId.length > 0)) {
    return value as JobTransition;
  }
  throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
};

export const reduceJobState = (currentInput: unknown, transitionInput: unknown): ReducedJob => {
  const current = parseReducedJob(currentInput);
  const transition = parseTransition(transitionInput);
  if (terminal.has(current.state)) return current;
  if (transition.kind === "dependency_failed") {
    if (transition.supersedingJobId !== undefined) return Object.freeze({ state: "superseded", supersedingJobId: transition.supersedingJobId });
    if (transition.cancellationRequested === true) return Object.freeze({ state: "cancelled" });
    if (current.state === "queued" || current.state === "retry_wait") {
      return Object.freeze({ state: "failed", errorCode: "JOB_DEPENDENCY_FAILED" });
    }
    throw new OrchestrationError("JOB_LEASE_CONFLICT");
  }
  if (transition.kind === "cancel") return Object.freeze({ state: "cancelled" });
  if (transition.kind === "supersede") return Object.freeze({ state: "superseded", supersedingJobId: transition.supersedingJobId });
  if (transition.kind === "lease" && (current.state === "queued" || current.state === "retry_wait")) return Object.freeze({ state: "leased" });
  if (current.state === "leased" && transition.kind === "succeed") return Object.freeze({ state: "succeeded" });
  if (current.state === "leased" && transition.kind === "retry") return Object.freeze({ state: "retry_wait" });
  if (current.state === "leased" && transition.kind === "fail") return Object.freeze({ state: "failed", errorCode: "JOB_EXECUTION_FAILED" });
  throw new OrchestrationError("JOB_LEASE_CONFLICT");
};

export const computeRetryDelayMs = (input: unknown): number => {
  const value = detachedRecord(input);
  if (Object.keys(value).some((key) => !["attempt", "baseDelayMs", "maxDelayMs"].includes(key))) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  const { attempt, baseDelayMs, maxDelayMs } = value;
  if (typeof attempt !== "number" || typeof baseDelayMs !== "number" || typeof maxDelayMs !== "number"
    || !Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1
    || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  if (attempt > 53) return maxDelayMs;
  return Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
};

export type OutboxState = "pending" | "leased" | "retry_wait" | "delivered" | "exhausted";
export const reduceOutboxState = (
  stateInput: unknown,
  transitionInput: unknown,
): OutboxState => {
  const states: OutboxState[] = ["pending", "leased", "retry_wait", "delivered", "exhausted"];
  const transitions = ["lease", "deliver", "retry", "exhaust"] as const;
  if (!states.includes(stateInput as OutboxState) || !transitions.includes(transitionInput as typeof transitions[number])) {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  const state = stateInput as OutboxState;
  const transition = transitionInput as typeof transitions[number];
  if (state === "delivered" || state === "exhausted") return state;
  if (transition === "lease" && (state === "pending" || state === "retry_wait")) return "leased";
  if (state === "leased" && transition === "deliver") return "delivered";
  if (state === "leased" && transition === "retry") return "retry_wait";
  if (state === "leased" && transition === "exhaust") return "exhausted";
  throw new OrchestrationError("OUTBOX_LEASE_CONFLICT");
};
