import { expect, test } from "vitest";

import { classifyServingObservation } from "../../packages/environment/src/index.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const observed = (effectiveOrder: string, revision = revisionA) => ({
  event_version: "1.0.0", event_id: `observation-${effectiveOrder}-${revision[0]}`,
  event_type: "deployment.changed", producer: { producer_id: "deploy", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"], environment: "uat" },
  provider_evidence: { provider: "deploy", provider_reference: `delivery-${effectiveOrder}` },
  payload: { change_kind: "serving_observation", observation_id: `observation-${effectiveOrder}`,
    environment: "uat", source: { authority_id: "inventory", reference: `inventory-${effectiveOrder}`,
      access_label: "engineering" }, completeness: "complete", effective_order: effectiveOrder,
    serving_state: { status: "known", inventory: [{ artifact_id: `artifact-${revision[0]}`,
      revision: { state: "known", revision } }] } },
});

test("canonical effective order advances even when arrival times or provider event order differ", () => {
  const first = observed("9");
  const newer = { ...observed("10", revisionB), occurred_at: "2025-01-01T00:00:00.000Z" };
  expect(classifyServingObservation(undefined, first)).toBe("apply");
  expect(classifyServingObservation(first, newer)).toBe("apply");
  expect(classifyServingObservation(newer, first)).toBe("stale");
});

test("equal effective order replays only the same source and serving state", () => {
  const first = observed("9");
  expect(classifyServingObservation(first, { ...first, event_id: "duplicate-delivery" })).toBe("replay");
  expect(classifyServingObservation(first, { ...first, payload: { ...first.payload,
    serving_state: { status: "known", inventory: [{ artifact_id: "artifact-b",
      revision: { state: "known", revision: revisionB } }] } } })).toBe("reconcile");
  expect(classifyServingObservation(first, { ...first, payload: { ...first.payload,
    source: { ...first.payload.source, reference: "different-source-version" } } })).toBe("reconcile");
  expect(classifyServingObservation(first, { ...first, payload: { ...first.payload,
    source: { ...first.payload.source, access_label: "restricted" } } })).toBe("reconcile");
});

test("missing or noncanonical effective order and authority changes require exact reconciliation", () => {
  const first = observed("9");
  expect(classifyServingObservation(undefined, observed("opaque"))).toBe("reconcile");
  expect(classifyServingObservation(first, observed("09"))).toBe("reconcile");
  expect(classifyServingObservation(first, { ...observed("10"), payload: { ...observed("10").payload,
    source: { authority_id: "other", reference: "inventory-10", access_label: "engineering" } } }))
    .toBe("reconcile");
});

test("authoritative unknown and complete absence are ordered observations, not attempts", () => {
  const first = observed("9");
  const unknown = { ...observed("10"), payload: { ...observed("10").payload,
    completeness: "incomplete", serving_state: { status: "unknown", reason: "rollout state unavailable" } } };
  const absent = { ...observed("11"), payload: { ...observed("11").payload,
    serving_state: { status: "known", inventory: [] } } };
  expect(classifyServingObservation(first, unknown)).toBe("apply");
  expect(classifyServingObservation(unknown, absent)).toBe("apply");
  expect(classifyServingObservation(absent, unknown)).toBe("stale");
});

test("attempt payloads and mismatched environment scopes fail without echoing input", () => {
  const first = observed("9");
  const marker = "secret://untrusted-reference";
  expect(() => classifyServingObservation(first, { ...first, subjects: { ...first.subjects,
    environment: "production" }, payload: { ...first.payload, source: { ...first.payload.source,
      reference: marker } } })).toThrowError(expect.objectContaining({ code: "INVALID_ENVIRONMENT_INPUT" }));
  try {
    classifyServingObservation(undefined, { ...first, payload: { change_kind: "attempt" } });
  } catch (error) { expect(JSON.stringify(error)).not.toContain(marker); }
});
