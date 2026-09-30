import { detachedFrozen } from "./canonical.js";
import type { JobKind } from "./types.js";

export type OrchestrationObservation =
  | Readonly<{ name: "event.ingress"; outcome: "accepted" | "duplicate" | "stale" | "ignored_unconfigured" | "unauthorized" | "reconciliation_required"; count: number }>
  | Readonly<{ name: "job.lifecycle"; kind: JobKind; outcome: "queued" | "leased" | "lease_expired" | "retried" | "succeeded" | "failed" | "cancelled" | "superseded"; count: number; attempt?: number; queueDelayMs?: number; runDurationMs?: number; retryDelayMs?: number }>
  | Readonly<{ name: "reconciliation.lifecycle"; kind: "branch" | "pull_request"; outcome: "no_work" | "repaired" | "absent" | "obsolete" | "failed"; count: number }>
  | Readonly<{ name: "catalog.snapshot"; outcome: "inserted" | "existing"; count: number }>
  | Readonly<{ name: "catalog.branch"; outcome: "promoted" | "existing" | "conflict"; count: number }>
  | Readonly<{ name: "outbox.lifecycle"; outcome: "pending" | "delivered" | "retried" | "exhausted"; count: number; attempt?: number; retryDelayMs?: number }>;

export type OrchestrationObserver = Readonly<{
  observe(observation: OrchestrationObservation): void;
}>;

export type OrchestrationObserverOptions = Readonly<{ observer?: OrchestrationObserver }>;

const noOpObserver: OrchestrationObserver = Object.freeze({ observe: () => undefined });

export const orchestrationObserver = (options: OrchestrationObserverOptions): OrchestrationObserver =>
  options.observer !== undefined && typeof options.observer.observe === "function" ? options.observer : noOpObserver;

export const emitOrchestrationObservation = (
  observer: OrchestrationObserver,
  observation: OrchestrationObservation,
): void => {
  try {
    observer.observe(detachedFrozen(observation));
  } catch {
    // Operational telemetry must never change the durable orchestration outcome.
  }
};

