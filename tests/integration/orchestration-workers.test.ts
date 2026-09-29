import { expect, test } from "vitest";

import { applyOrchestrationMigrations, createOrchestrationRepository, createOrchestrationWorker } from "../../packages/orchestration/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";
import { acquireAdvisoryLocks, capacityGlobalLock, capacityRepositoryLock, capacityServiceLock,
  configurationLock } from "../../packages/orchestration/src/locking.js";
import { setOrchestrationSearchPath } from "../../packages/orchestration/src/database.js";

const config = { fingerprint: "workers-config", document: {
  config_version: "1.0.0", access_scopes: [{ access_scope_id: "engineering", label: "Engineering" }],
  repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce", access_scope_id: "engineering",
    services: [{ service_id: "orders", root: "services/orders", analyzer: { adapter_id: "typescript", adapter_version: "1" },
      intended_branches: ["main"], environments: [] }] }],
  inference: { enabled: false }, logs: { enabled: false },
} };
const admin = { tenantId: "tenant-a", principalId: "admin", capabilities: ["configuration.admin"] };
const eventContext = { tenantId: "tenant-a", principalId: "connector", producerId: "github-adapter",
  allowedEventTypes: ["branch.updated"], allowedRepositories: ["commerce"], allowedServices: ["orders"],
  deploymentAuthorityGrants: [], capabilities: ["event.ingest"] };
const event = (id: string, sequence: string) => ({
  event_version: "1.0.0", event_id: id, event_type: "branch.updated",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `delivery-${sequence}`, order: { kind: "sequence", value: sequence } },
  payload: { branch: "main", prior_revision: null, new_revision: sequence.repeat(40).slice(0, 40), reference_state: "fast_forward" },
});
const jobWorker = (workerId: string) => ({ workerId, instanceId: "instance-1", capabilities: ["jobs.execute"] });
const outboxWorker = { workerId: "delivery", instanceId: "instance-1", capabilities: ["outbox.deliver"] };

const setup = async (configInput = config) => {
  const database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
  await repository.registerConfiguration(admin, configInput);
  await repository.activateInitialConfiguration(admin, { fingerprint: "workers-config" });
  return { database, repository, worker: createOrchestrationWorker(database.pool, { schema: database.schema }),
    schemaSql: quoteCatalogTestSchema(database.schema) };
};

test("concurrent claims respect service capacity and a matching live lease can be heartbeated", async () => {
  const { database, repository, worker } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const [first, second] = await Promise.all([
      worker.claimJobs(jobWorker("worker-a"), { limit: 1 }),
      worker.claimJobs(jobWorker("worker-b"), { limit: 1 }),
    ]);
    expect(first.length + second.length).toBe(1);
    const claim = [...first, ...second][0]!;
    const owner = first.length ? jobWorker("worker-a") : jobWorker("worker-b");
    const heartbeat = await worker.heartbeatJob(owner, claim.lease);
    expect(heartbeat.leaseToken).toBe(claim.lease.leaseToken);
    await expect(worker.heartbeatJob(jobWorker("intruder"), claim.lease)).rejects.toMatchObject({ code: "JOB_LEASE_CONFLICT" });
  } finally { await database.cleanup(); }
});

test("policy limits are versioned and cap claims across services in a repository", async () => {
  const expanded = structuredClone(config);
  expanded.document.repositories[0]!.services.push({
    ...structuredClone(expanded.document.repositories[0]!.services[0]!), service_id: "payments", root: "services/payments",
  });
  const { database, repository, worker } = await setup(expanded);
  try {
    expect(await worker.putConcurrencyPolicy(admin, {
      globalLimit: 2, repositoryLimit: 1, serviceLimit: 1,
    })).toMatchObject({ policyVersion: "1", repositoryLimit: 1 });
    await expect(worker.putConcurrencyPolicy(admin, {
      globalLimit: 2, repositoryLimit: 1, serviceLimit: 1, expectedVersion: "2",
    })).rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });
    await expect(worker.putConcurrencyPolicy(admin, {
      globalLimit: 1, repositoryLimit: 2, serviceLimit: 1,
    })).rejects.toMatchObject({ code: "INVALID_ORCHESTRATION_INPUT" });
    for (const [serviceId, revision] of [["orders", "1"], ["payments", "2"]] as const) {
      const next = event(`branch-${serviceId}`, revision);
      next.subjects.service_ids = [serviceId];
      await repository.ingestEvent({ ...eventContext, allowedServices: ["orders", "payments"] }, next);
    }
    expect((await worker.claimJobs(jobWorker("worker-a"), { limit: 2 })).length).toBe(1);
    expect(await worker.claimJobs(jobWorker("worker-b"), { limit: 2 })).toEqual([]);
  } finally { await database.cleanup(); }
});

test("a saturated service does not block another service in the same repository", async () => {
  const expanded = structuredClone(config);
  expanded.document.repositories[0]!.services.push({
    ...structuredClone(expanded.document.repositories[0]!.services[0]!), service_id: "payments", root: "services/payments",
  });
  const { database, repository, worker } = await setup(expanded);
  try {
    for (const [serviceId, revision] of [["orders", "1"], ["payments", "2"]] as const) {
      const next = event(`branch-${serviceId}`, revision);
      next.subjects.service_ids = [serviceId];
      await repository.ingestEvent({ ...eventContext, allowedServices: ["orders", "payments"] }, next);
    }
    const [first] = await worker.claimJobs(jobWorker("worker-a"), { limit: 1 });
    const [second] = await worker.claimJobs(jobWorker("worker-b"), { limit: 1 });
    expect(first?.jobId).toBeDefined();
    expect(second?.jobId).toBeDefined();
    expect(second?.jobId).not.toBe(first?.jobId);
  } finally { await database.cleanup(); }
});

test("the global policy limit spans repositories while other tenants remain independent", async () => {
  const expanded = structuredClone(config);
  const second = structuredClone(expanded.document.repositories[0]!);
  second.repository_id = "billing";
  second.locator = "acme/billing";
  second.services[0]!.service_id = "payments";
  second.services[0]!.root = "services/payments";
  expanded.document.repositories.push(second);
  const { database, repository, worker } = await setup(expanded);
  try {
    await worker.putConcurrencyPolicy(admin, { globalLimit: 1, repositoryLimit: 1, serviceLimit: 1 });
    for (const [repositoryId, serviceId, revision] of [
      ["commerce", "orders", "1"], ["billing", "payments", "2"],
    ] as const) {
      const next = event(`branch-${serviceId}`, revision);
      next.subjects.repository_id = repositoryId;
      next.subjects.service_ids = [serviceId];
      await repository.ingestEvent({ ...eventContext, allowedRepositories: ["billing", "commerce"],
        allowedServices: ["orders", "payments"] }, next);
    }
    expect((await worker.claimJobs(jobWorker("worker-a"), { limit: 2 })).length).toBe(1);
    expect(await worker.claimJobs(jobWorker("worker-b"), { limit: 2 })).toEqual([]);
  } finally { await database.cleanup(); }
});

test("terminal baseline failure propagates once to blocked PR preview without an attempt", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    const pr = {
      ...event("pr-1", "1"), event_type: "pull_request.updated",
      payload: { pull_request_id: "42", state: "open", base_branch: "main", base_revision: "a".repeat(40),
        head_branch: "feature/test", head_revision: "b".repeat(40) },
    };
    await repository.ingestEvent({ ...eventContext, allowedEventTypes: ["pull_request.updated"] }, pr);
    const jobs = await database.pool.query<{ job_id: string; kind: string; state: string }>(
      `SELECT job_id,kind,state FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a'`,
    );
    expect(jobs.rows.map((row) => row.kind).sort()).toEqual(["baseline_analysis", "pr_preview_analysis"]);
    const baseline = jobs.rows.find((row) => row.kind === "baseline_analysis")!;
    const preview = jobs.rows.find((row) => row.kind === "pr_preview_analysis")!;
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET max_attempts=1 WHERE tenant_id='tenant-a' AND job_id=$1`,
      [baseline.job_id],
    );
    const [claim] = await worker.claimJobs(jobWorker("worker-a"), { limit: 1 });
    expect(claim?.jobId).toBe(baseline.job_id);
    expect(await worker.failJob(jobWorker("worker-a"), claim!.lease, new Error("private source path"))).toMatchObject({
      state: "failed", safeErrorCode: "JOB_EXECUTION_FAILED",
    });
    const dependent = await database.pool.query<{ state: string; attempt_count: string; safe_last_error_code: string }>(
      `SELECT state,attempt_count::text,safe_last_error_code
       FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND job_id=$1`, [preview.job_id],
    );
    expect(dependent.rows[0]).toEqual({ state: "failed", attempt_count: "0", safe_last_error_code: "JOB_DEPENDENCY_FAILED" });
    const checkpoint = await database.pool.query<{ last_terminal_outcome: string }>(
      `SELECT last_terminal_outcome FROM ${schemaSql}.orchestration_analysis_checkpoints
       WHERE tenant_id='tenant-a' AND current_job_id=$1`, [baseline.job_id],
    );
    expect(checkpoint.rows[0]?.last_terminal_outcome).toBe("failed");
    const prCheckpoint = await database.pool.query<{ latest_outcome: string }>(
      `SELECT latest_outcome FROM ${schemaSql}.orchestration_pr_checkpoints
       WHERE tenant_id='tenant-a' AND current_job_id=$1`, [preview.job_id],
    );
    expect(prCheckpoint.rows[0]?.latest_outcome).toBe("failed");
    expect(await worker.claimJobs(jobWorker("worker-b"), { limit: 2 })).toEqual([]);
    const notifications = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.orchestration_outbox
       WHERE tenant_id='tenant-a' AND job_id=$1 AND payload->>'state'='failed'`, [preview.job_id],
    );
    expect(notifications.rows[0]?.count).toBe("1");
  } finally { await database.cleanup(); }
});

test("explicit cancellation propagates through a dependent chain in the same transaction", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    for (const id of ["41", "42", "43"]) {
      await repository.ingestEvent({ ...eventContext, allowedEventTypes: ["pull_request.updated"] }, {
        ...event(`pr-${id}`, id), event_type: "pull_request.updated",
        payload: { pull_request_id: id, state: "open", base_branch: "main", base_revision: "a".repeat(40),
          head_branch: `feature/${id}`, head_revision: id.repeat(20) },
      });
    }
    const jobs = await database.pool.query<{ job_id: string; pull_request_id: string }>(
      `SELECT job_id,pull_request_id FROM ${schemaSql}.orchestration_jobs
       WHERE tenant_id='tenant-a' AND kind='pr_preview_analysis' ORDER BY pull_request_id`,
    );
    expect(jobs.rows).toHaveLength(3);
    await database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_job_dependencies (tenant_id,job_id,prerequisite_job_id)
       VALUES ('tenant-a',$1,$2),('tenant-a',$3,$1)`,
      [jobs.rows[1]!.job_id, jobs.rows[0]!.job_id, jobs.rows[2]!.job_id],
    );
    await repository.cancelJob({ tenantId: "tenant-a", principalId: "admin",
      capabilities: ["orchestration.cancel"] }, jobs.rows[0]!.job_id);
    const states = await database.pool.query<{ job_id: string; state: string; attempt_count: string; safe_last_error_code: string | null }>(
      `SELECT job_id,state,attempt_count::text,safe_last_error_code
       FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND job_id=ANY($1::text[])
       ORDER BY job_id`, [jobs.rows.map((row) => row.job_id)],
    );
    expect(states.rows.find((row) => row.job_id === jobs.rows[0]!.job_id)?.state).toBe("cancelled");
    for (const child of jobs.rows.slice(1)) {
      expect(states.rows.find((row) => row.job_id === child.job_id)).toMatchObject({
        state: "failed", attempt_count: "0", safe_last_error_code: "JOB_DEPENDENCY_FAILED",
      });
    }
  } finally { await database.cleanup(); }
});

test("a leased dependent receives cancellation request and finalizes after its lease expires", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await worker.putConcurrencyPolicy(admin, { globalLimit: 2, repositoryLimit: 2, serviceLimit: 2 });
    await repository.ingestEvent({ ...eventContext, allowedEventTypes: ["repository.baseline_requested"] }, {
      ...event("baseline-1", "1"), event_type: "repository.baseline_requested",
      payload: { immutable_revision: "a".repeat(40), service_ids: ["orders"] },
    });
    const baseline = await database.pool.query<{ job_id: string }>(
      `SELECT job_id FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND kind='baseline_analysis'`,
    );
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET available_at=clock_timestamp()+interval '1 hour',max_attempts=1
       WHERE tenant_id='tenant-a' AND job_id=$1`, [baseline.rows[0]!.job_id],
    );
    await repository.ingestEvent(eventContext, event("branch-1", "2"));
    const [branchClaim] = await worker.claimJobs(jobWorker("worker-a"), { limit: 1 });
    expect(branchClaim?.kind).toBe("branch_analysis");
    await database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_job_dependencies (tenant_id,job_id,prerequisite_job_id)
       VALUES ('tenant-a',$1,$2)`, [branchClaim!.jobId, baseline.rows[0]!.job_id],
    );
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET available_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id='tenant-a' AND job_id=$1`, [baseline.rows[0]!.job_id],
    );
    const [baselineClaim] = await worker.claimJobs(jobWorker("worker-b"), { limit: 1 });
    expect(baselineClaim?.jobId).toBe(baseline.rows[0]!.job_id);
    await worker.failJob(jobWorker("worker-b"), baselineClaim!.lease, "private failure");
    const requested = await database.pool.query<{ state: string; cancellation_requested: boolean }>(
      `SELECT state,cancellation_requested FROM ${schemaSql}.orchestration_jobs
       WHERE tenant_id='tenant-a' AND job_id=$1`, [branchClaim!.jobId],
    );
    expect(requested.rows[0]).toEqual({ state: "leased", cancellation_requested: true });
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id='tenant-a' AND job_id=$1`, [branchClaim!.jobId],
    );
    await worker.claimJobs(jobWorker("worker-c"), { limit: 1 });
    const finalized = await database.pool.query<{ state: string; latest_outcome: string }>(
      `SELECT job.state,checkpoint.latest_outcome FROM ${schemaSql}.orchestration_jobs job
       JOIN ${schemaSql}.orchestration_branch_checkpoints checkpoint
         ON checkpoint.tenant_id=job.tenant_id AND checkpoint.current_job_id=job.job_id
       WHERE job.tenant_id='tenant-a' AND job.job_id=$1`, [branchClaim!.jobId],
    );
    expect(finalized.rows[0]).toEqual({ state: "cancelled", latest_outcome: "cancelled" });
  } finally { await database.cleanup(); }
});

test("superseded leased work finalizes on recovery and never claims the old generation", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const [old] = await worker.claimJobs(jobWorker("worker-a"), { limit: 1 });
    await repository.ingestEvent(eventContext, event("branch-2", "2"));
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id='tenant-a' AND job_id=$1`, [old!.jobId],
    );
    const [current] = await worker.claimJobs(jobWorker("worker-b"), { limit: 1 });
    expect(current?.jobId).not.toBe(old!.jobId);
    const oldState = await database.pool.query<{ state: string }>(
      `SELECT state FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND job_id=$1`, [old!.jobId],
    );
    expect(oldState.rows[0]?.state).toBe("superseded");
    await expect(worker.heartbeatJob(jobWorker("worker-a"), old!.lease)).rejects.toMatchObject({ code: "JOB_LEASE_CONFLICT" });
  } finally { await database.cleanup(); }
});

test("outbox delivery is retryable after crash and exhaustion preserves the job", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const [initial] = await worker.claimOutbox(outboxWorker, { limit: 1 });
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_outbox SET lease_expires_at=clock_timestamp()-interval '1 second',max_attempts=2
       WHERE tenant_id=$1 AND outbox_id=$2`, [initial!.tenantId, initial!.outboxId],
    );
    await worker.claimOutbox(outboxWorker, { limit: 1 });
    const waiting = await database.pool.query<{ state: string; safe_last_error_code: string | null }>(
      `SELECT state,safe_last_error_code FROM ${schemaSql}.orchestration_outbox
       WHERE tenant_id=$1 AND outbox_id=$2`, [initial!.tenantId, initial!.outboxId],
    );
    expect(waiting.rows[0]).toEqual({ state: "retry_wait", safe_last_error_code: null });
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_outbox SET available_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id=$1 AND outbox_id=$2`, [initial!.tenantId, initial!.outboxId],
    );
    const replay = (await worker.claimOutbox(outboxWorker, { limit: 32 })).find((row) => row.outboxId === initial!.outboxId)!;
    expect(replay.lease.leaseToken).not.toBe(initial!.lease.leaseToken);
    await expect(worker.acknowledgeOutbox(outboxWorker, initial!.lease)).rejects.toMatchObject({ code: "OUTBOX_LEASE_CONFLICT" });
    expect(await worker.failOutbox(outboxWorker, replay.lease, "private delivery error")).toMatchObject({
      state: "exhausted", safeErrorCode: "OUTBOX_DELIVERY_FAILED",
    });
    const jobCount = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a'`,
    );
    expect(jobCount.rows[0]?.count).toBe("1");
  } finally { await database.cleanup(); }
});

test("expired jobs recover with database-time backoff and exhaust deterministically", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const [claim] = await worker.claimJobs(jobWorker("worker-a"), { limit: 1 });
    expect(claim).toBeDefined();
    await database.pool.query(`UPDATE ${schemaSql}.orchestration_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id='tenant-a' AND job_id=$1`, [claim!.jobId]);
    expect(await worker.claimJobs(jobWorker("worker-b"), { limit: 1 })).toEqual([]);
    const row = await database.pool.query<{ state: string; attempt_count: string; available_at: Date; database_now: Date }>(
      `SELECT state, attempt_count::text, available_at, clock_timestamp() AS database_now
       FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND job_id=$1`, [claim!.jobId]);
    expect(row.rows[0]?.state).toBe("retry_wait");
    expect(row.rows[0]?.attempt_count).toBe("1");
    expect(row.rows[0]!.available_at.getTime()).toBeGreaterThan(row.rows[0]!.database_now.getTime());
  } finally { await database.cleanup(); }
});

test("explicit failure retries with a fresh token then exhausts at the configured attempt count", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const [first] = await worker.claimJobs(jobWorker("worker-a"), { limit: 1 });
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET max_attempts=2
       WHERE tenant_id='tenant-a' AND job_id=$1`, [first!.jobId],
    );
    expect(await worker.failJob(jobWorker("worker-a"), first!.lease, { secret: "redacted" })).toMatchObject({
      state: "retry_wait", attemptCount: "1", safeErrorCode: "JOB_EXECUTION_FAILED",
    });
    const waiting = await database.pool.query<{ available_at: Date; database_now: Date }>(
      `SELECT available_at,clock_timestamp() AS database_now FROM ${schemaSql}.orchestration_jobs
       WHERE tenant_id='tenant-a' AND job_id=$1`, [first!.jobId],
    );
    expect(waiting.rows[0]!.available_at.getTime() - waiting.rows[0]!.database_now.getTime()).toBeGreaterThan(0);
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET available_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id='tenant-a' AND job_id=$1`, [first!.jobId],
    );
    const [second] = await worker.claimJobs(jobWorker("worker-b"), { limit: 1 });
    expect(second?.lease.leaseToken).not.toBe(first!.lease.leaseToken);
    await expect(worker.failJob(jobWorker("worker-a"), first!.lease, "stale"))
      .rejects.toMatchObject({ code: "JOB_LEASE_CONFLICT" });
    expect(await worker.failJob(jobWorker("worker-b"), second!.lease, "private failure")).toMatchObject({
      state: "failed", attemptCount: "2", safeErrorCode: "JOB_EXECUTION_FAILED",
    });
    const checkpoint = await database.pool.query<{ latest_outcome: string }>(
      `SELECT latest_outcome FROM ${schemaSql}.orchestration_branch_checkpoints
       WHERE tenant_id='tenant-a' AND current_job_id=$1`, [first!.jobId],
    );
    expect(checkpoint.rows[0]?.latest_outcome).toBe("failed");
    expect(await worker.claimJobs(jobWorker("worker-c"))).toEqual([]);
  } finally { await database.cleanup(); }
});

test("outbox leases retry and capability denial has no database side effects", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    await expect(worker.claimOutbox(jobWorker("worker-a"))).rejects.toMatchObject({ code: "WORKER_UNAUTHORIZED" });
    const [record] = await worker.claimOutbox(outboxWorker, { limit: 1 });
    expect(record).toBeDefined();
    const failed = await worker.failOutbox(outboxWorker, record!.lease, new Error("private transport secret"));
    expect(failed.state).toBe("retry_wait");
    const row = await database.pool.query<{ safe_last_error_code: string; lease_token: string | null }>(
      `SELECT safe_last_error_code,lease_token FROM ${schemaSql}.orchestration_outbox WHERE tenant_id=$1 AND outbox_id=$2`,
      [record!.tenantId, record!.outboxId]);
    expect(row.rows[0]).toEqual({ safe_last_error_code: "OUTBOX_DELIVERY_FAILED", lease_token: null });
    await expect(worker.acknowledgeOutbox(jobWorker("worker-a"), record!.lease)).rejects.toMatchObject({ code: "WORKER_UNAUTHORIZED" });
  } finally { await database.cleanup(); }
});

test("heartbeat racing expired-lease recovery has one database-time winner", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  const barrier = await database.pool.connect();
  let barrierOpen = false;
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const [claim] = await worker.claimJobs(jobWorker("worker-a"), { limit: 1 });
    await barrier.query("BEGIN");
    barrierOpen = true;
    await setOrchestrationSearchPath(barrier, database.schema);
    await acquireAdvisoryLocks(barrier, [configurationLock("tenant-a"), capacityGlobalLock("tenant-a"),
      capacityRepositoryLock("tenant-a", "commerce"), capacityServiceLock("tenant-a", "commerce", "orders")]);
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs SET lease_expires_at=clock_timestamp()+interval '50 milliseconds'
       WHERE tenant_id='tenant-a' AND job_id=$1`, [claim!.jobId],
    );
    const heartbeat = worker.heartbeatJob(jobWorker("worker-a"), claim!.lease);
    await database.pool.query("SELECT pg_sleep(0.08)");
    const recovery = worker.claimJobs(jobWorker("worker-b"), { limit: 1 });
    await barrier.query("COMMIT");
    barrierOpen = false;
    const outcomes = await Promise.allSettled([heartbeat, recovery]);
    expect(outcomes[0]).toMatchObject({ status: "rejected", reason: { code: "JOB_LEASE_CONFLICT" } });
    expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: [] });
    const state = await database.pool.query<{ state: string; live_count: string }>(
      `SELECT state,(SELECT count(*)::text FROM ${schemaSql}.orchestration_jobs
         WHERE tenant_id='tenant-a' AND state='leased' AND lease_expires_at>clock_timestamp()) AS live_count
       FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND job_id=$1`, [claim!.jobId],
    );
    expect(state.rows[0]).toEqual({ state: "retry_wait", live_count: "0" });
  } finally {
    if (barrierOpen) await barrier.query("ROLLBACK");
    barrier.release();
    await database.cleanup();
  }
});

test("outbox acknowledgement is durable and a replayed token cannot deliver twice", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const [record] = await worker.claimOutbox(outboxWorker, { limit: 1 });
    await worker.acknowledgeOutbox(outboxWorker, record!.lease);
    await expect(worker.acknowledgeOutbox(outboxWorker, record!.lease)).rejects.toMatchObject({
      code: "OUTBOX_LEASE_CONFLICT",
    });
    const stored = await database.pool.query<{ state: string; delivered_at: Date | null }>(
      `SELECT state,delivered_at FROM ${schemaSql}.orchestration_outbox
       WHERE tenant_id=$1 AND outbox_id=$2`, [record!.tenantId, record!.outboxId],
    );
    expect(stored.rows[0]?.state).toBe("delivered");
    expect(stored.rows[0]?.delivered_at).toBeInstanceOf(Date);
  } finally { await database.cleanup(); }
});

test("competing outbox workers cannot lease the same record", async () => {
  const { database, repository, worker, schemaSql } = await setup();
  try {
    await repository.ingestEvent(eventContext, event("branch-1", "1"));
    const selected = await database.pool.query<{ outbox_id: string }>(
      `SELECT outbox_id FROM ${schemaSql}.orchestration_outbox
       WHERE tenant_id='tenant-a' ORDER BY outbox_id LIMIT 1`,
    );
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_outbox SET state='delivered',delivered_at=clock_timestamp()
       WHERE tenant_id='tenant-a' AND outbox_id<>$1`, [selected.rows[0]!.outbox_id],
    );
    const [first, second] = await Promise.all([
      worker.claimOutbox(outboxWorker, { limit: 1 }),
      worker.claimOutbox({ workerId: "delivery-b", instanceId: "instance-1", capabilities: ["outbox.deliver"] }, { limit: 1 }),
    ]);
    expect(first.length + second.length).toBe(1);
    expect([...first, ...second][0]?.outboxId).toBe(selected.rows[0]!.outbox_id);
  } finally { await database.cleanup(); }
});
