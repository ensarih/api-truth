import type { EventEnvelope, InstallationConfig } from "@api-truth/ir";

export const EVENT_TYPES = [
  "branch.updated",
  "configuration.changed",
  "deployment.changed",
  "pull_request.updated",
  "reconciliation.requested",
  "repository.baseline_requested",
  "source_document.changed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type EventCapability = "configuration.admin" | "event.ingest";
export type ControlCapability = "configuration.admin" | "orchestration.cancel" | "orchestration.status.read";
export type WorkerCapability = "jobs.execute" | "outbox.deliver";

export type ConfigurationPair = { fingerprint: string; document: InstallationConfig };
export type ProviderCheckpoint = {
  evidence: {
    provider: string;
    provider_reference: string;
    order?: { kind: "sequence" | "cursor" | "effective_version"; value: string };
  };
  relevantPayload: unknown;
};
export type ProviderUpdateClassification = "first" | "exact_replay" | "newer" | "stale" | "conflict" | "incomparable";

export type JobState = "queued" | "leased" | "retry_wait" | "succeeded" | "failed" | "cancelled" | "superseded";
export type JobKind = "baseline_analysis" | "branch_analysis" | "pr_preview_analysis" | "branch_reconciliation" | "pr_reconciliation";

export type OrchestrationErrorCode =
  | "INVALID_ORCHESTRATION_INPUT"
  | "EVENT_UNAUTHORIZED"
  | "EVENT_ID_CONFLICT"
  | "EVENT_SUBJECT_MISMATCH"
  | "CONFIGURATION_NOT_FOUND"
  | "CONFIGURATION_CONFLICT"
  | "CONFIGURATION_UNAUTHORIZED"
  | "EVENT_ORDER_CONFLICT"
  | "REVISION_ASSOCIATION_CONFLICT"
  | "JOB_NOT_FOUND_OR_DENIED"
  | "WORKER_UNAUTHORIZED"
  | "JOB_LEASE_CONFLICT"
  | "JOB_CANCELLED"
  | "JOB_SUPERSEDED"
  | "JOB_DEPENDENCY_FAILED"
  | "JOB_EXECUTION_FAILED"
  | "RECONCILIATION_FAILED"
  | "OUTBOX_LEASE_CONFLICT"
  | "OUTBOX_DELIVERY_FAILED"
  | "PROMOTION_INELIGIBLE"
  | "ORCHESTRATION_STORAGE_ERROR";
