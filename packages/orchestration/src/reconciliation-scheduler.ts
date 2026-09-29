import { parseEvent } from "@api-truth/ir";

import { canonicalOrchestrationHash, canonicalOrchestrationJson, canonicalStringSet } from "./canonical.js";
import { OrchestrationError } from "./errors.js";
import type { EventReceipt, OrchestrationRepository } from "./repository.js";
import { parseAuthenticatedEventContext, parseProviderEvidence } from "./schemas.js";

const nonempty = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);

export type ScheduledReconciliationRequest = Readonly<{
  /** Reuse this key and occurredAt for every retry of the same provider snapshot. */
  idempotencyKey: string;
  occurredAt: string;
  receivedAt: string;
  repositoryId: string;
  serviceIds: readonly string[];
  environments: readonly string[];
  providerSnapshotReference: string;
  providerEvidence: { provider: string; provider_reference: string;
    order?: { kind: "sequence" | "cursor" | "effective_version"; value: string } };
}>;

export const createReconciliationScheduler = (
  repository: Pick<OrchestrationRepository, "ingestEvent">,
): Readonly<{ request(context: unknown, input: ScheduledReconciliationRequest): Promise<EventReceipt> }> => ({
  async request(contextInput, input) {
    const context = parseAuthenticatedEventContext(contextInput);
    if (!context.ok) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    let request: Record<string, unknown>;
    try {
      const detached: unknown = JSON.parse(canonicalOrchestrationJson(input));
      if (detached === null || typeof detached !== "object" || Array.isArray(detached)) {
        throw new Error("invalid request");
      }
      request = detached as Record<string, unknown>;
    } catch { throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT"); }
    const keys = ["idempotencyKey", "occurredAt", "receivedAt", "repositoryId", "serviceIds",
      "environments", "providerSnapshotReference", "providerEvidence"].sort();
    const actual = Object.keys(request).sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])
      || !nonempty(request.idempotencyKey) || !nonempty(request.repositoryId)
      || !nonempty(request.providerSnapshotReference)
      || !Array.isArray(request.serviceIds) || request.serviceIds.length === 0
      || !request.serviceIds.every(nonempty)
      || !Array.isArray(request.environments) || !request.environments.every(nonempty)) {
      throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    }
    const evidence = parseProviderEvidence(request.providerEvidence);
    if (!evidence.ok || evidence.value.order?.kind === "sequence"
      && !/^(0|[1-9][0-9]*)$/.test(evidence.value.order.value)) {
      throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    }
    const event = {
      event_version: "1.0.0", event_id: `scheduled-reconciliation-${canonicalOrchestrationHash({
        tenantId: context.value.tenantId, producerId: context.value.producerId,
        idempotencyKey: request.idempotencyKey,
      }).slice("sha256:".length)}`, event_type: "reconciliation.requested",
      producer: { producer_id: context.value.producerId, adapter_version: "scheduler-1" },
      occurred_at: request.occurredAt, received_at: request.receivedAt,
      subjects: { repository_id: request.repositoryId,
        service_ids: canonicalStringSet(request.serviceIds as string[]) },
      provider_evidence: evidence.value,
      payload: { scope: { service_ids: canonicalStringSet(request.serviceIds as string[]),
        environments: canonicalStringSet(request.environments as string[]) },
        provider_snapshot_reference: request.providerSnapshotReference },
    };
    const parsed = parseEvent(event);
    if (!parsed.ok) throw new OrchestrationError("INVALID_ORCHESTRATION_INPUT");
    return repository.ingestEvent(context.value, parsed.value);
  },
});
