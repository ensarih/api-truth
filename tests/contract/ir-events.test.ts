import { describe, expect, test } from "vitest";
import { parseEvent } from "../../packages/ir/src/index.js";

const envelope = (event_type: string, payload: unknown) => ({
  event_version: "1.0.0",
  event_id: `evt-${event_type}`,
  event_type,
  producer: { producer_id: "enterprise-cd", adapter_version: "2.1.0" },
  occurred_at: "2026-09-16T06:00:00Z",
  received_at: "2026-09-16T06:00:02Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "enterprise-cd", provider_reference: "delivery-42", order: { kind: "sequence", value: "42" } },
  payload,
});

const expectInvalid = (value: unknown, code?: string) => {
  const result = parseEvent(value);
  expect(result.ok).toBe(false);
  if (!result.ok && code) expect(result.error.issues.some((item) => item.code === code)).toBe(true);
};

describe("event envelope", () => {
  test.each([
    ["repository.baseline_requested", { immutable_revision: "rev-a", service_ids: ["orders"] }],
    ["pull_request.updated", { pull_request_id: "pr-7", state: "open", base_branch: "main", base_revision: "rev-a", head_branch: "feature/refund", head_revision: "rev-b" }],
    ["branch.updated", { branch: "main", prior_revision: "rev-a", new_revision: "rev-b", reference_state: "fast_forward" }],
    ["configuration.changed", { config_version: "1.0.0", config_fingerprint: "sha256:cfg", affected_service_ids: ["orders"], affected_scope: "analysis_and_exposure" }],
    ["source_document.changed", { document_id: "page-1", source_version: "17", state: "updated", access_label: "orders-read" }],
    ["reconciliation.requested", { scope: { service_ids: ["orders"], environments: ["production"] }, provider_snapshot_reference: "inventory-42" }],
  ])("accepts %s", (eventType, payload) => {
    expect(parseEvent(envelope(eventType, payload))).toMatchObject({ ok: true });
  });

  test("keeps deployment attempts separate from authoritative serving observations", () => {
    const attempt = envelope("deployment.changed", {
      change_kind: "attempt",
      deployment_id: "dep-42",
      environment: "production",
      attempt_state: "failed",
      effective_order: "42",
      artifact_id: "artifact-b",
      revision: { state: "known", revision: "rev-b" },
    });
    expect(parseEvent(attempt)).toMatchObject({ ok: true });
    expectInvalid({ ...attempt, payload: { ...(attempt.payload as Record<string, unknown>), active_inventory: [] } });
  });

  test("accepts mixed serving sets and unknown artifact revisions", () => {
    const event = envelope("deployment.changed", {
      change_kind: "serving_observation",
      observation_id: "srv-42",
      environment: "production",
      source: { authority_id: "runtime-inventory", reference: "inventory-42", access_label: "ops-read" },
      completeness: "transitional",
      effective_order: "43",
      serving_state: {
        status: "known",
        inventory: [
          { artifact_id: "artifact-b", revision: { state: "known", revision: "rev-b" } },
          { artifact_id: "artifact-c", revision: { state: "unknown", reason: "mapping pending" } }
        ]
      }
    });
    expect(parseEvent(event)).toMatchObject({ ok: true });
  });

  test("permits complete empty inventory to establish absence", () => {
    expect(parseEvent(envelope("deployment.changed", {
      change_kind: "serving_observation",
      observation_id: "srv-empty",
      environment: "production",
      source: { authority_id: "runtime-inventory", reference: "inventory-43", access_label: "ops-read" },
      completeness: "complete",
      effective_order: "43",
      serving_state: { status: "known", inventory: [] }
    }))).toMatchObject({ ok: true });
  });

  test("rejects incomplete empty inventory as confirmed absence", () => {
    expectInvalid(envelope("deployment.changed", {
      change_kind: "serving_observation",
      observation_id: "srv-empty",
      environment: "production",
      source: { authority_id: "runtime-inventory", reference: "inventory-43", access_label: "ops-read" },
      completeness: "incomplete",
      effective_order: "43",
      serving_state: { status: "known", inventory: [] }
    }), "semantic.incomplete_absence");
  });

  test("records a rollback request only as an attempt", () => {
    expect(parseEvent(envelope("deployment.changed", {
      change_kind: "attempt",
      deployment_id: "rollback-1",
      environment: "production",
      attempt_state: "rollback_requested",
      effective_order: "44",
      target_revision: "rev-a",
      revision: { state: "unknown", reason: "request has not changed serving state" }
    }))).toMatchObject({ ok: true });
  });

  test("rejects malformed timestamps and unsupported event versions without echoing payload", () => {
    const marker = "sensitive-payload-value";
    const event = { ...envelope("branch.updated", { branch: marker }), event_version: "2.0.0", occurred_at: "today" };
    const result = parseEvent(event);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
