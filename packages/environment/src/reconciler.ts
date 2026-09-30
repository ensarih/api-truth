import { parseEvent } from "@api-truth/ir";
import type { OrchestrationRepository } from "@api-truth/orchestration";

import { EnvironmentError } from "./errors.js";
import type { EnvironmentRepository, ServingReconciliationTicket } from "./repository.js";

type ExactScope = Readonly<Pick<ServingReconciliationTicket,
  "tenantId" | "repositoryId" | "serviceId" | "environment">>;

export type ExactServingProvider = Readonly<{
  observe(scope: ExactScope): Promise<unknown>;
}>;

export const createEnvironmentReconciler = (ports: Readonly<{
  environment: EnvironmentRepository;
  orchestration: Pick<OrchestrationRepository, "ingestEvent">;
  provider: ExactServingProvider;
  workerIdentity: unknown;
  eventContext: unknown;
}>) => Object.freeze({
  async reconcile(scope: ExactScope): Promise<Readonly<{
    outcome: "no_pending" | "applied" | "pending" | "superseded";
  }>> {
    const ticket = await ports.environment.getPendingServingReconciliation(ports.workerIdentity, scope);
    if (ticket === undefined) return Object.freeze({ outcome: "no_pending" });
    const candidate = await ports.provider.observe(Object.freeze({ tenantId: ticket.tenantId,
      repositoryId: ticket.repositoryId, serviceId: ticket.serviceId, environment: ticket.environment }));
    const parsed = parseEvent(candidate);
    if (!parsed.ok || parsed.value.event_type !== "deployment.changed"
      || (parsed.value.payload as { change_kind?: unknown }).change_kind !== "serving_observation"
      || parsed.value.subjects.repository_id !== ticket.repositoryId
      || parsed.value.subjects.service_ids.length !== 1
      || parsed.value.subjects.service_ids[0] !== ticket.serviceId
      || (parsed.value.payload as { environment: string }).environment !== ticket.environment
      || parsed.value.subjects.environment !== undefined
        && parsed.value.subjects.environment !== ticket.environment) {
      throw new EnvironmentError("ENVIRONMENT_NOT_FOUND_OR_DENIED");
    }
    const event = parsed.value;
    await ports.orchestration.ingestEvent(ports.eventContext, event);
    return ports.environment.confirmServingReconciliation(ports.workerIdentity, ticket,
      { tenantId: ticket.tenantId, producerId: event.producer.producer_id, eventId: event.event_id });
  },
});
