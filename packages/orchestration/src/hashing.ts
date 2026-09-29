import { parseEvent, type EventEnvelope } from "@api-truth/ir";
import { canonicalOrchestrationHash, canonicalOrchestrationJson, canonicalStringSet } from "./canonical.js";
import { OrchestrationError, orchestrationValidationError } from "./errors.js";

const byCanonicalJson = (left: unknown, right: unknown): number =>
  Buffer.compare(Buffer.from(canonicalOrchestrationJson(left)), Buffer.from(canonicalOrchestrationJson(right)));

export const normalizedEventIdentityProjection = (input: unknown): Omit<EventEnvelope, "received_at"> => {
  let detached: EventEnvelope;
  try {
    detached = JSON.parse(canonicalOrchestrationJson(input)) as EventEnvelope;
  } catch {
    throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  }
  const parsed = parseEvent(detached);
  if (!parsed.ok) throw orchestrationValidationError(parsed.error);
  const event = structuredClone(parsed.value);
  event.subjects.service_ids = canonicalStringSet(event.subjects.service_ids);
  if (event.event_type === "repository.baseline_requested") {
    (event.payload as { service_ids: string[] }).service_ids = canonicalStringSet((event.payload as { service_ids: string[] }).service_ids);
  } else if (event.event_type === "configuration.changed") {
    const payload = event.payload as { affected_service_ids: string[] };
    payload.affected_service_ids = canonicalStringSet(payload.affected_service_ids);
  } else if (event.event_type === "reconciliation.requested") {
    const scope = (event.payload as { scope: { service_ids: string[]; environments: string[] } }).scope;
    scope.service_ids = canonicalStringSet(scope.service_ids);
    scope.environments = canonicalStringSet(scope.environments);
  } else if (event.event_type === "deployment.changed") {
    const payload = event.payload as {
      change_kind: string;
      serving_state?: {
        status: string;
        inventory?: unknown[];
        observed_artifact_ids?: string[];
      };
    };
    if (payload.change_kind === "serving_observation" && payload.serving_state?.inventory !== undefined) {
      payload.serving_state.inventory.sort(byCanonicalJson);
    }
    if (payload.change_kind === "serving_observation" && payload.serving_state?.observed_artifact_ids !== undefined) {
      payload.serving_state.observed_artifact_ids = canonicalStringSet(payload.serving_state.observed_artifact_ids);
    }
  }
  const { received_at: _receivedAt, ...projection } = event;
  return projection;
};

export const eventSha256 = (input: unknown): `sha256:${string}` =>
  canonicalOrchestrationHash(normalizedEventIdentityProjection(input));

export const semanticOrchestrationId = (prefixInput: unknown, identity: unknown): string => {
  if (prefixInput !== "job" && prefixInput !== "outbox") throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
  return `${prefixInput}-${canonicalOrchestrationHash(identity).slice("sha256:".length)}`;
};
