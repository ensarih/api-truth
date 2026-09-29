import { canonicalOrchestrationJson } from "./canonical.js";
import { OrchestrationError } from "./errors.js";
import { parseProviderEvidence } from "./schemas.js";
import type { ProviderCheckpoint, ProviderUpdateClassification } from "./types.js";

const canonicalDecimal = /^(0|[1-9][0-9]*)$/;

export const compareCanonicalSequence = (current: string, next: string): "older" | "equal" | "newer" | "invalid" => {
  if (!canonicalDecimal.test(current) || !canonicalDecimal.test(next)) return "invalid";
  if (next.length < current.length) return "older";
  if (next.length > current.length) return "newer";
  if (next === current) return "equal";
  return next < current ? "older" : "newer";
};

const sameSemanticCheckpoint = (current: ProviderCheckpoint, next: ProviderCheckpoint): boolean =>
  current.evidence.provider_reference === next.evidence.provider_reference
  && canonicalOrchestrationJson(current.relevantPayload) === canonicalOrchestrationJson(next.relevantPayload);

const sameExactCheckpoint = (current: ProviderCheckpoint, next: ProviderCheckpoint): boolean =>
  canonicalOrchestrationJson(current.evidence) === canonicalOrchestrationJson(next.evidence)
  && canonicalOrchestrationJson(current.relevantPayload) === canonicalOrchestrationJson(next.relevantPayload);

export const classifyProviderUpdate = (
  currentInput: unknown,
  nextInput: unknown,
): ProviderUpdateClassification => {
  const parseCheckpoint = (input: unknown): ProviderCheckpoint => {
    let detached: unknown;
    try { detached = JSON.parse(canonicalOrchestrationJson(input)); } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
    if (detached === null || typeof detached !== "object" || Array.isArray(detached)
      || Object.keys(detached).length !== 2 || !Object.hasOwn(detached, "evidence") || !Object.hasOwn(detached, "relevantPayload")) {
      throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    }
    const candidate = detached as { evidence: unknown; relevantPayload: unknown };
    const evidence = parseProviderEvidence(candidate.evidence);
    if (!evidence.ok) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    return { evidence: evidence.value, relevantPayload: candidate.relevantPayload };
  };
  const next = parseCheckpoint(nextInput);
  const current = currentInput === undefined ? undefined : parseCheckpoint(currentInput);
  if (current === undefined) {
    return next.evidence.order?.kind === "sequence" && !canonicalDecimal.test(next.evidence.order.value)
      ? "incomparable" : "first";
  }
  if (current.evidence.provider !== next.evidence.provider) return "incomparable";
  const oldOrder = current.evidence.order;
  const newOrder = next.evidence.order;
  if (oldOrder?.kind !== "sequence" || newOrder?.kind !== "sequence") {
    if (sameExactCheckpoint(current, next)) return "exact_replay";
    return "incomparable";
  }
  const comparison = compareCanonicalSequence(oldOrder.value, newOrder.value);
  if (comparison === "invalid") return "incomparable";
  if (comparison === "older") return "stale";
  if (comparison === "newer") return "newer";
  return sameSemanticCheckpoint(current, next) ? "exact_replay" : "conflict";
};
