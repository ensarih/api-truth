import { expect, test } from "vitest";
import type { Pool } from "pg";

import { createOrchestrationRepository, type OrchestrationObservation } from "../../packages/orchestration/src/index.js";

test("denied event ingress emits one bounded observation before database or event access", async () => {
  const observations: OrchestrationObservation[] = [];
  let connections = 0;
  let eventReads = 0;
  const pool = { connect: async () => { connections += 1; throw new Error("database must not be touched"); } } as unknown as Pool;
  const repository = createOrchestrationRepository(pool, {
    schema: "unused",
    observer: { observe: (observation) => { observations.push(observation); } },
  });
  const hostileEvent = new Proxy({}, { ownKeys: () => { eventReads += 1; throw new Error("private-event-marker"); } });

  await expect(repository.ingestEvent({
    tenantId: "tenant-a", principalId: "denied", producerId: "producer",
    allowedEventTypes: [], allowedRepositories: [], allowedServices: [],
    deploymentAuthorityGrants: [], capabilities: [],
  }, hostileEvent)).rejects.toMatchObject({ code: "EVENT_UNAUTHORIZED" });

  expect(connections).toBe(0);
  expect(eventReads).toBe(0);
  expect(observations).toEqual([{ name: "event.ingress", outcome: "unauthorized", count: 1 }]);
  expect(JSON.stringify(observations)).not.toContain("tenant-a");
});

test("observer failures never change orchestration outcomes", async () => {
  const pool = { connect: async () => { throw new Error("database must not be touched"); } } as unknown as Pool;
  const repository = createOrchestrationRepository(pool, {
    schema: "unused",
    observer: { observe: () => { throw new Error("private-observer-marker"); } },
  });
  await expect(repository.ingestEvent({ capabilities: [] }, {})).rejects.toMatchObject({
    code: "EVENT_UNAUTHORIZED",
    message: "Event is not authorized",
  });
});
