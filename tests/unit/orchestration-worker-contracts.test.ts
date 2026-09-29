import { expect, test } from "vitest";
import type { Pool } from "pg";

import { createOrchestrationWorker } from "../../packages/orchestration/src/index.js";

test("every worker operation rejects the wrong capability before touching the database", async () => {
  let connections = 0;
  const pool = { connect: async () => { connections += 1; throw new Error("database must not be touched"); } } as unknown as Pool;
  const worker = createOrchestrationWorker(pool, { schema: "unused" });
  const jobsOnly = { workerId: "jobs", instanceId: "one", capabilities: ["jobs.execute"] };
  const outboxOnly = { workerId: "delivery", instanceId: "one", capabilities: ["outbox.deliver"] };
  const calls = [
    worker.claimJobs(outboxOnly), worker.heartbeatJob(outboxOnly, { hostile: true }),
    worker.failJob(outboxOnly, { hostile: true }, new Error("private")),
    worker.claimOutbox(jobsOnly), worker.acknowledgeOutbox(jobsOnly, { hostile: true }),
    worker.failOutbox(jobsOnly, { hostile: true }, new Error("private")),
    worker.claimJobs({ workerId: "hostile", instanceId: "one", capabilities: ["jobs.execute"], extra: "secret" }),
  ];
  const outcomes = await Promise.allSettled(calls);
  expect(outcomes).toHaveLength(7);
  for (const outcome of outcomes) expect(outcome).toMatchObject({
    status: "rejected", reason: { code: "WORKER_UNAUTHORIZED" },
  });
  expect(connections).toBe(0);
});
