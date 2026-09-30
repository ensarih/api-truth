import { parseEvent } from "@api-truth/ir";
import { canonicalOrchestrationHash } from "@api-truth/orchestration";

import { EnvironmentError } from "./errors.js";

type ObservationPayload = Readonly<{
  change_kind: "serving_observation"; environment: string; effective_order: string;
  source: Readonly<{ authority_id: string; reference: string; access_label: string }>;
  completeness: "complete" | "incomplete" | "transitional";
  serving_state: unknown; rollback_request_id?: string;
}>;
type Observation = Readonly<{
  repositoryId: string; serviceId: string; environment: string; provider: string;
  payload: ObservationPayload;
}>;

const canonicalDecimal = /^(0|[1-9][0-9]*)$/;
const parseObservation = (input: unknown): Observation => {
  const parsed = parseEvent(input);
  if (!parsed.ok || parsed.value.event_type !== "deployment.changed"
    || (parsed.value.payload as { change_kind?: unknown }).change_kind !== "serving_observation") {
    throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
  }
  const event = parsed.value;
  const payload = event.payload as ObservationPayload;
  const repositoryId = event.subjects.repository_id;
  if (repositoryId === undefined || event.subjects.service_ids.length !== 1
    || event.subjects.environment !== undefined && event.subjects.environment !== payload.environment) {
    throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
  }
  return Object.freeze({ repositoryId, serviceId: event.subjects.service_ids[0]!,
    environment: payload.environment, provider: event.provider_evidence.provider, payload });
};

const compareDecimal = (current: string, incoming: string): "older" | "equal" | "newer" => {
  if (incoming.length !== current.length) return incoming.length < current.length ? "older" : "newer";
  return incoming === current ? "equal" : incoming < current ? "older" : "newer";
};

const stateHash = (payload: ObservationPayload): string => {
  const state = payload.serving_state as { status: string; inventory?: Array<{ artifact_id: string }> };
  const inventory = state.status === "known" && state.inventory !== undefined
    ? [...state.inventory].sort((left, right) => left.artifact_id < right.artifact_id ? -1
      : left.artifact_id > right.artifact_id ? 1 : 0) : undefined;
  return canonicalOrchestrationHash({ completeness: payload.completeness,
    source_access_label: payload.source.access_label,
    serving_state: inventory === undefined ? state : { ...state, inventory },
    ...(payload.rollback_request_id === undefined ? {} : { rollback_request_id: payload.rollback_request_id }) });
};

export type ServingObservationClassification = "apply" | "stale" | "replay" | "reconcile";

export const classifyServingObservation = (currentInput: unknown, incomingInput: unknown): ServingObservationClassification => {
  const incoming = parseObservation(incomingInput);
  const current = currentInput === undefined ? undefined : parseObservation(currentInput);
  if (current !== undefined && (current.repositoryId !== incoming.repositoryId
    || current.serviceId !== incoming.serviceId || current.environment !== incoming.environment)) {
    throw new EnvironmentError("INVALID_ENVIRONMENT_INPUT");
  }
  if (!canonicalDecimal.test(incoming.payload.effective_order)) return "reconcile";
  if (current === undefined) return "apply";
  if (current.provider !== incoming.provider
    || current.payload.source.authority_id !== incoming.payload.source.authority_id
    || !canonicalDecimal.test(current.payload.effective_order)) return "reconcile";
  const order = compareDecimal(current.payload.effective_order, incoming.payload.effective_order);
  if (order === "newer") return "apply";
  if (order === "older") return "stale";
  return current.payload.source.reference === incoming.payload.source.reference
    && stateHash(current.payload) === stateHash(incoming.payload) ? "replay" : "reconcile";
};
