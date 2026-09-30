import { expect, test, vi } from "vitest";

import { applyOrchestrationMigrations, createOrchestrationRepository }
  from "../../packages/orchestration/src/index.js";
import { applyEnvironmentMigrations, createEnvironmentInboxWorker, createEnvironmentReconciler,
  createEnvironmentReconciliationWorker, createEnvironmentRepository }
  from "../../packages/environment/src/index.js";
import { EnvironmentError } from "../../packages/environment/src/errors.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const worker = { workerId: "environment-worker", instanceId: "local-1", capabilities: ["jobs.execute"] };
const admin = (tenantId = "tenant-a") => ({ tenantId, principalId: "admin", capabilities: ["configuration.admin"] });
const configuration = () => ({ fingerprint: "config-a", document: {
  config_version: "1.0.0", access_scopes: [{ access_scope_id: "engineering", label: "Engineering" }],
  repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce",
    access_scope_id: "engineering", services: [{ service_id: "orders", root: "services/orders",
      analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
      environments: [{ name: "uat", intended_branch: "main",
        deployment_authority: { adapter_id: "deploy", access_scope_id: "engineering" } }],
    }] }], inference: { enabled: false }, logs: { enabled: false },
} });
const eventContext = (tenantId = "tenant-a", authorized = true) => ({
  tenantId, principalId: "connector", producerId: "deploy", allowedEventTypes: ["deployment.changed"],
  allowedRepositories: ["commerce"], allowedServices: ["orders"],
  deploymentAuthorityGrants: authorized ? [{ repositoryId: "commerce", serviceId: "orders", environment: "uat",
    adapterId: "deploy", sourceAuthorityIds: ["inventory"] }] : [],
  capabilities: ["event.ingest"],
});
const attempt = (eventId: string, revision: { state: "known"; revision: string } | { state: "unknown"; reason: string },
  artifactId = "artifact-a") => ({
  event_version: "1.0.0", event_id: eventId, event_type: "deployment.changed",
  producer: { producer_id: "deploy", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"], environment: "uat" },
  provider_evidence: { provider: "deploy", provider_reference: eventId,
    order: { kind: "sequence", value: "1" } },
  payload: { change_kind: "attempt", deployment_id: eventId, environment: "uat",
    attempt_state: "failed", effective_order: "1", artifact_id: artifactId, revision },
});
const serving = (eventId: string, order: string, inventory: Array<{ artifact_id: string;
  revision: { state: "known"; revision: string } }>, overrides: Record<string, unknown> = {}) => ({
  event_version: "1.0.0", event_id: eventId, event_type: "deployment.changed",
  producer: { producer_id: "deploy", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"], environment: "uat" },
  provider_evidence: { provider: "deploy", provider_reference: eventId },
  payload: { change_kind: "serving_observation", observation_id: eventId, environment: "uat",
    source: { authority_id: "inventory", reference: `inventory-${order}`, access_label: "engineering" },
    completeness: "complete", effective_order: order,
    serving_state: { status: "known", inventory }, ...overrides },
});

test("D09 migrations require D08 and replay without changing the ledger", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await expect(applyEnvironmentMigrations(database.pool, { schema: database.schema }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_STORAGE_ERROR" });
    const before = await database.pool.query<{ name: string | null }>("SELECT to_regclass($1)::text AS name", [
      `${database.schema}.environment_schema_migrations`,
    ]);
    expect(before.rows).toEqual([{ name: null }]);
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const after = await database.pool.query<{ version: string }>(
      `SELECT version FROM ${schema}.environment_schema_migrations ORDER BY version`,
    );
    expect(after.rows).toEqual([{ version: "0001_deployment_attempts" },
      { version: "0002_serving_observations" }, { version: "0003_deployment_inbox" },
      { version: "0004_reconciliation_tasks" }]);
    await database.pool.query(`UPDATE ${schema}.environment_schema_migrations SET checksum_sha256=$1`,
      [`sha256:${"0".repeat(64)}`]);
    await expect(applyEnvironmentMigrations(database.pool, { schema: database.schema }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_STORAGE_ERROR" });
  } finally { await database.cleanup(); }
});

test("the deployment inbox backfills authenticated events and captures later events once", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await orchestration.ingestEvent(eventContext(), attempt("before-d09", { state: "known", revision: revisionA }));
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    await orchestration.ingestEvent(eventContext(), attempt("after-d09", { state: "known", revision: revisionB }));
    await orchestration.ingestEvent(eventContext(), attempt("after-d09", { state: "known", revision: revisionB }));
    const pending = await database.pool.query<{ event_id: string; state: string; attempt_count: string }>(
      `SELECT event_id,state,attempt_count::text FROM ${schema}.environment_deployment_inbox ORDER BY event_id`,
    );
    expect(pending.rows).toEqual([
      { event_id: "after-d09", state: "pending", attempt_count: "0" },
      { event_id: "before-d09", state: "pending", attempt_count: "0" },
    ]);
  } finally { await database.cleanup(); }
});

test("inbox workers deliver each authenticated deployment event and recover an expired lease", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    await orchestration.ingestEvent(eventContext(), attempt("a-attempt", { state: "known", revision: revisionA }));
    await orchestration.ingestEvent(eventContext(), serving("b-serving", "1", [artA]));
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const inbox = createEnvironmentInboxWorker(database.pool, { schema: database.schema }, environment);
    await expect(inbox.drain({ ...worker, capabilities: [] }))
      .rejects.toMatchObject({ code: "WORKER_UNAUTHORIZED" });
    const concurrent = await Promise.all([inbox.drain(worker, 2), inbox.drain(worker, 2)]);
    expect(concurrent.flat().map((outcome) => outcome.state)).toEqual(["delivered", "delivered"]);
    await expect(inbox.drain(worker)).resolves.toEqual([]);
    expect((await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.environment_deployment_attempts`,
    )).rows[0]?.count).toBe("1");
    expect((await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.environment_serving_observations`,
    )).rows[0]?.count).toBe("1");
    await orchestration.ingestEvent(eventContext(), attempt("c-after-crash", { state: "known", revision: revisionA },
      "artifact-c"));
    await database.pool.query(
      `UPDATE ${schema}.environment_deployment_inbox SET state='leased',attempt_count=1,
       lease_token='crashed-worker',lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE event_id='c-after-crash'`,
    );
    await expect(inbox.drain(worker)).resolves.toMatchObject([{ eventId: "c-after-crash", state: "delivered" }]);
    const queue = await database.pool.query<{ event_id: string; state: string; attempt_count: string }>(
      `SELECT event_id,state,attempt_count::text FROM ${schema}.environment_deployment_inbox ORDER BY event_id`,
    );
    expect(queue.rows).toEqual([
      { event_id: "a-attempt", state: "delivered", attempt_count: "1" },
      { event_id: "b-serving", state: "delivered", attempt_count: "1" },
      { event_id: "c-after-crash", state: "delivered", attempt_count: "2" },
    ]);
  } finally { await database.cleanup(); }
});

test("an artifact conflict exhausts only its event with a safe error code", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await orchestration.ingestEvent(eventContext(), attempt("a-first", { state: "known", revision: revisionA }));
    await orchestration.ingestEvent(eventContext(), attempt("b-conflict", { state: "known", revision: revisionB }));
    const inbox = createEnvironmentInboxWorker(database.pool, { schema: database.schema },
      createEnvironmentRepository(database.pool, { schema: database.schema }));
    const outcomes = await inbox.drain(worker);
    expect(outcomes.map((outcome) => outcome.state)).toEqual(["delivered", "exhausted"]);
    const queue = await database.pool.query<{ event_id: string; safe_last_error_code: string | null }>(
      `SELECT event_id,safe_last_error_code FROM ${schema}.environment_deployment_inbox ORDER BY event_id`,
    );
    expect(queue.rows).toEqual([{ event_id: "a-first", safe_last_error_code: null },
      { event_id: "b-conflict", safe_last_error_code: "ARTIFACT_BINDING_CONFLICT" }]);
    expect((await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.environment_deployment_attempts`,
    )).rows[0]?.count).toBe("1");
  } finally { await database.cleanup(); }
});

test("a transient inbox consumption failure is retried without duplicating the attempt", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await orchestration.ingestEvent(eventContext(), attempt("retry-attempt", { state: "known", revision: revisionA }));
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    let failOnce = true;
    const inbox = createEnvironmentInboxWorker(database.pool, { schema: database.schema }, {
      recordAttempt: async (workerIdentity, eventIdentity) => {
        if (failOnce) { failOnce = false; throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR"); }
        return environment.recordAttempt(workerIdentity, eventIdentity);
      },
      recordServingObservation: environment.recordServingObservation,
    });
    await expect(inbox.drain(worker)).resolves.toMatchObject([{ state: "retry_wait" }]);
    await expect(inbox.drain(worker)).resolves.toEqual([]);
    await database.pool.query(
      `UPDATE ${schema}.environment_deployment_inbox SET available_at=clock_timestamp()-interval '1 second'
       WHERE event_id='retry-attempt'`,
    );
    await expect(inbox.drain(worker)).resolves.toMatchObject([{ state: "delivered" }]);
    const persisted = await database.pool.query<{ state: string; attempt_count: string;
      safe_last_error_code: string | null }>(
      `SELECT state,attempt_count::text,safe_last_error_code
       FROM ${schema}.environment_deployment_inbox WHERE event_id='retry-attempt'`,
    );
    expect(persisted.rows).toEqual([{ state: "delivered", attempt_count: "2", safe_last_error_code: null }]);
    expect((await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.environment_deployment_attempts`,
    )).rows[0]?.count).toBe("1");
  } finally { await database.cleanup(); }
});

test("the reconciliation worker repairs an opaque serving state from one exact provider scope", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const inbox = createEnvironmentInboxWorker(database.pool, { schema: database.schema }, environment);
    const scope = { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", environment: "uat" };
    await orchestration.ingestEvent(eventContext(), serving("opaque-inbox", "cursor-one", []));
    await expect(inbox.drain(worker)).resolves.toMatchObject([{ eventId: "opaque-inbox", state: "delivered" }]);
    const observed = vi.fn(async () => serving("provider-exact", "cursor-two", []));
    const reconciler = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: observed }, workerIdentity: worker, eventContext: eventContext() });
    const scheduling = createEnvironmentReconciliationWorker(database.pool, { schema: database.schema }, reconciler);
    const runs = await Promise.all([scheduling.drain(worker), scheduling.drain(worker)]);
    expect(runs.flat()).toMatchObject([{ scope, state: "resolved" }]);
    expect(observed).toHaveBeenCalledExactlyOnceWith(scope);
    await expect(scheduling.drain(worker)).resolves.toEqual([]);
    await expect(inbox.drain(worker)).resolves.toMatchObject([{ eventId: "provider-exact", state: "delivered" }]);
    const checkpoint = await database.pool.query<{ current_event_id: string; reconciliation_required: boolean }>(
      `SELECT current_event_id,reconciliation_required FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([{ current_event_id: "provider-exact", reconciliation_required: false }]);
    const task = await database.pool.query<{ state: string; attempt_count: string }>(
      `SELECT state,attempt_count::text FROM ${schema}.environment_reconciliation_tasks`,
    );
    expect(task.rows).toEqual([{ state: "resolved", attempt_count: "1" }]);
  } finally { await database.cleanup(); }
});

test("an incomplete provider result backs off, then a later exact result resolves the same scope", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const inbox = createEnvironmentInboxWorker(database.pool, { schema: database.schema }, environment);
    await orchestration.ingestEvent(eventContext(), serving("opaque-start", "cursor-one", []));
    await inbox.drain(worker);
    let observations = 0;
    const reconciler = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => {
        observations += 1;
        return observations === 1 ? serving("still-unknown", "cursor-two", [], {
          completeness: "incomplete", serving_state: { status: "unknown", reason: "inventory unavailable" },
        }) : serving("finally-known", "cursor-three", []);
      } }, workerIdentity: worker, eventContext: eventContext() });
    const scheduling = createEnvironmentReconciliationWorker(database.pool, { schema: database.schema }, reconciler);
    await expect(scheduling.drain(worker)).resolves.toMatchObject([{ state: "retry_wait" }]);
    await expect(scheduling.drain(worker)).resolves.toEqual([]);
    await database.pool.query(
      `UPDATE ${schema}.environment_reconciliation_tasks
       SET available_at=clock_timestamp()-interval '1 second'`,
    );
    await expect(scheduling.drain(worker)).resolves.toMatchObject([{ state: "resolved" }]);
    expect(observations).toBe(2);
    const checkpoint = await database.pool.query<{ current_event_id: string; reconciliation_required: boolean }>(
      `SELECT current_event_id,reconciliation_required FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([{ current_event_id: "finally-known", reconciliation_required: false }]);
  } finally { await database.cleanup(); }
});

test("a transient provider failure retains a safe retry and later confirms the exact scope", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    await orchestration.ingestEvent(eventContext(), serving("provider-pending", "cursor-one", []));
    await createEnvironmentInboxWorker(database.pool, { schema: database.schema }, environment).drain(worker);
    let calls = 0;
    const exact = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => serving("provider-success", "cursor-two", []) },
      workerIdentity: worker, eventContext: eventContext() });
    const scheduling = createEnvironmentReconciliationWorker(database.pool, { schema: database.schema }, {
      reconcile: async (scope) => {
        calls += 1;
        if (calls === 1) throw new EnvironmentError("ENVIRONMENT_STORAGE_ERROR");
        return exact.reconcile(scope);
      },
    });
    await expect(scheduling.drain(worker)).resolves.toMatchObject([{ state: "retry_wait" }]);
    const failed = await database.pool.query<{ state: string; safe_last_error_code: string }>(
      `SELECT state,safe_last_error_code FROM ${schema}.environment_reconciliation_tasks`,
    );
    expect(failed.rows).toEqual([{ state: "retry_wait", safe_last_error_code: "ENVIRONMENT_STORAGE_ERROR" }]);
    await expect(scheduling.drain(worker)).resolves.toEqual([]);
    await database.pool.query(`UPDATE ${schema}.environment_reconciliation_tasks
      SET available_at=clock_timestamp()-interval '1 second'`);
    await expect(scheduling.drain(worker)).resolves.toMatchObject([{ state: "resolved" }]);
    expect(calls).toBe(2);
  } finally { await database.cleanup(); }
});

test("configuration activation during provider observation cannot apply the old ticket", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.registerConfiguration(admin(), { ...configuration(), fingerprint: "config-b" });
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    await orchestration.ingestEvent(eventContext(), serving("old-pending", "cursor-one", []));
    await createEnvironmentInboxWorker(database.pool, { schema: database.schema }, environment).drain(worker);
    let calls = 0;
    const exact = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => {
        calls += 1;
        if (calls === 1) await orchestration.activateConfigurationByCas(admin(), {
          fingerprint: "config-b", expectedCheckpointVersion: "1",
          providerEvidence: { provider: "control-plane", provider_reference: "activation-b" },
        });
        return serving(calls === 1 ? "stale-confirmation" : "fresh-confirmation", `cursor-${calls}`, []);
      } }, workerIdentity: worker, eventContext: eventContext() });
    const scheduling = createEnvironmentReconciliationWorker(database.pool, { schema: database.schema }, exact);
    await expect(scheduling.drain(worker)).resolves.toMatchObject([{ state: "retry_wait" }]);
    expect((await database.pool.query<{ current_event_id: string | null }>(
      `SELECT current_event_id FROM ${schema}.environment_serving_checkpoints`,
    )).rows).toEqual([{ current_event_id: null }]);
    await database.pool.query(`UPDATE ${schema}.environment_reconciliation_tasks
      SET available_at=clock_timestamp()-interval '1 second'`);
    await expect(scheduling.drain(worker)).resolves.toMatchObject([{ state: "resolved" }]);
    expect((await database.pool.query<{ current_event_id: string }>(
      `SELECT current_event_id FROM ${schema}.environment_serving_checkpoints`,
    )).rows).toEqual([{ current_event_id: "fresh-confirmation" }]);
  } finally { await database.cleanup(); }
});

test("ordered serving observations keep mixed rollout, confirmed rollback, and absence distinct", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const consume = async (event: ReturnType<typeof serving>) => {
      await orchestration.ingestEvent(eventContext(), event);
      return environment.recordServingObservation(worker,
        { tenantId: "tenant-a", producerId: "deploy", eventId: event.event_id });
    };
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    const artB = { artifact_id: "artifact-b", revision: { state: "known" as const, revision: revisionB } };
    await expect(consume(serving("observed-a", "1", [artA])))
      .resolves.toEqual({ outcome: "inserted", disposition: "applied" });
    await expect(consume(serving("mixed", "2", [artA, artB])))
      .resolves.toEqual({ outcome: "inserted", disposition: "applied" });
    await orchestration.ingestEvent(eventContext(), attempt("failed-rollout", { state: "known", revision: revisionB }, "artifact-b"));
    await environment.recordAttempt(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "failed-rollout" });
    await expect(consume(serving("stale", "1", [artA])))
      .resolves.toEqual({ outcome: "inserted", disposition: "stale" });
    await expect(consume(serving("opaque", "cursor-3", [artA])))
      .resolves.toEqual({ outcome: "inserted", disposition: "reconciliation_required" });
    const before = await database.pool.query<{ current_event_id: string; reconciliation_required: boolean }>(
      `SELECT current_event_id,reconciliation_required FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(before.rows).toEqual([{ current_event_id: "mixed", reconciliation_required: true }]);
    await orchestration.ingestEvent(eventContext(), attempt("rollback-request", { state: "known", revision: revisionA }));
    await environment.recordAttempt(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "rollback-request" });
    expect((await database.pool.query<{ current_event_id: string }>(
      `SELECT current_event_id FROM ${schema}.environment_serving_checkpoints`,
    )).rows).toEqual([{ current_event_id: "mixed" }]);
    await expect(consume(serving("rollback-confirmed", "3", [artA],
      { rollback_request_id: "rollback-request" })))
      .resolves.toEqual({ outcome: "inserted", disposition: "applied" });
    await expect(consume(serving("confirmed-absent", "4", [])))
      .resolves.toEqual({ outcome: "inserted", disposition: "applied" });
    const after = await database.pool.query<{ current_event_id: string; reconciliation_required: boolean }>(
      `SELECT current_event_id,reconciliation_required FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(after.rows).toEqual([{ current_event_id: "confirmed-absent", reconciliation_required: false }]);
  } finally { await database.cleanup(); }
});

test("same-order conflict requests reconciliation without replacing current serving state", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    const artB = { artifact_id: "artifact-b", revision: { state: "known" as const, revision: revisionB } };
    for (const event of [serving("first", "10", [artA]), serving("conflict", "10", [artB])]) {
      await orchestration.ingestEvent(eventContext(), event);
    }
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    await expect(environment.recordServingObservation(worker, identity("first")))
      .resolves.toEqual({ outcome: "inserted", disposition: "applied" });
    await expect(environment.recordServingObservation(worker, identity("conflict")))
      .resolves.toEqual({ outcome: "inserted", disposition: "reconciliation_required" });
    await expect(environment.recordServingObservation(worker, identity("conflict")))
      .resolves.toEqual({ outcome: "existing", disposition: "reconciliation_required" });
    const checkpoint = await database.pool.query<{ current_event_id: string; pending_event_id: string;
      reconciliation_required: boolean }>(
        `SELECT current_event_id,pending_event_id,reconciliation_required
         FROM ${schema}.environment_serving_checkpoints`,
      );
    expect(checkpoint.rows).toEqual([{ current_event_id: "first", pending_event_id: "conflict",
      reconciliation_required: true }]);
  } finally { await database.cleanup(); }
});

test("an initial opaque observation stays pending until exact ordered evidence arrives", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    await orchestration.ingestEvent(eventContext(), serving("opaque-first", "cursor-one", [artA]));
    await orchestration.ingestEvent(eventContext(), serving("exact-next", "2", [artA]));
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    await expect(environment.recordServingObservation(worker, identity("opaque-first")))
      .resolves.toEqual({ outcome: "inserted", disposition: "reconciliation_required" });
    const pending = await database.pool.query<{ current_event_id: string | null; pending_event_id: string }>(
      `SELECT current_event_id,pending_event_id FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(pending.rows).toEqual([{ current_event_id: null, pending_event_id: "opaque-first" }]);
    await expect(environment.recordServingObservation(worker, identity("exact-next")))
      .resolves.toEqual({ outcome: "inserted", disposition: "applied" });
    const applied = await database.pool.query<{ current_event_id: string; pending_event_id: string | null }>(
      `SELECT current_event_id,pending_event_id FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(applied.rows).toEqual([{ current_event_id: "exact-next", pending_event_id: null }]);
  } finally { await database.cleanup(); }
});

test("exact reconciliation confirms an opaque provider inventory without treating its cursor as an order", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const scope = { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", environment: "uat" };
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    await orchestration.ingestEvent(eventContext(), serving("opaque-pending", "cursor-old", [artA]));
    await environment.recordServingObservation(worker, identity("opaque-pending"));
    const ticket = await environment.getPendingServingReconciliation(worker, scope);
    expect(ticket).toMatchObject({ ...scope, pendingEventId: "opaque-pending", configFingerprint: "config-a" });
    await orchestration.ingestEvent(eventContext(), serving("exact-confirmation", "cursor-new", []));
    await expect(environment.confirmServingReconciliation(worker, ticket, identity("exact-confirmation")))
      .resolves.toEqual({ outcome: "applied" });
    await expect(environment.confirmServingReconciliation(worker, ticket, identity("exact-confirmation")))
      .resolves.toEqual({ outcome: "superseded" });
    const checkpoint = await database.pool.query<{ current_event_id: string; pending_event_id: string | null;
      reconciliation_required: boolean }>(
      `SELECT current_event_id,pending_event_id,reconciliation_required
       FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([{ current_event_id: "exact-confirmation", pending_event_id: null,
      reconciliation_required: false }]);
  } finally { await database.cleanup(); }
});

test("exact reconciliation rejects a stale ticket after a newer observation and keeps the original checkpoint", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const scope = { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", environment: "uat" };
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    await orchestration.ingestEvent(eventContext(), serving("opaque-pending", "cursor-old", [artA]));
    await environment.recordServingObservation(worker, identity("opaque-pending"));
    const ticket = await environment.getPendingServingReconciliation(worker, scope);
    await orchestration.ingestEvent(eventContext(), serving("newer-current", "7", [artA]));
    await environment.recordServingObservation(worker, identity("newer-current"));
    await orchestration.ingestEvent(eventContext(), serving("late-confirmation", "cursor-late", []));
    await expect(environment.confirmServingReconciliation(worker, ticket, identity("late-confirmation")))
      .resolves.toEqual({ outcome: "superseded" });
    const checkpoint = await database.pool.query<{ current_event_id: string; pending_event_id: string | null }>(
      `SELECT current_event_id,pending_event_id FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([{ current_event_id: "newer-current", pending_event_id: null }]);
  } finally { await database.cleanup(); }
});

test("the provider reconciler queries one exact scope and rejects an unrelated response before ingestion", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const scope = { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", environment: "uat" };
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    await orchestration.ingestEvent(eventContext(), serving("opaque-for-provider", "cursor-old", []));
    await environment.recordServingObservation(worker, identity("opaque-for-provider"));
    const observed = vi.fn(async () => serving("provider-confirmed", "cursor-new", []));
    const reconciler = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: observed }, workerIdentity: worker, eventContext: eventContext() });
    await expect(reconciler.reconcile(scope)).resolves.toEqual({ outcome: "applied" });
    expect(observed).toHaveBeenCalledExactlyOnceWith(scope);
    await expect(reconciler.reconcile(scope)).resolves.toEqual({ outcome: "no_pending" });
    expect(observed).toHaveBeenCalledTimes(1);

    await orchestration.ingestEvent(eventContext(), serving("opaque-again", "cursor-next", []));
    await environment.recordServingObservation(worker, identity("opaque-again"));
    const bad = createEnvironmentReconciler({ environment, orchestration,
      provider: { observe: async () => ({ ...serving("wrong-scope", "cursor-wrong", []),
        subjects: { repository_id: "other", service_ids: ["orders"], environment: "uat" } }) },
      workerIdentity: worker, eventContext: eventContext() });
    await expect(bad.reconcile(scope)).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    const event = await database.pool.query(`SELECT event_id FROM ${schema}.orchestration_events
      WHERE event_id='wrong-scope'`);
    expect(event.rows).toEqual([]);
  } finally { await database.cleanup(); }
});

test("an incomplete exact response stays pending and a configuration change supersedes its ticket", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.registerConfiguration(admin(), { ...configuration(), fingerprint: "config-b" });
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const scope = { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", environment: "uat" };
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    await orchestration.ingestEvent(eventContext(), serving("pending-incomplete", "cursor-a", []));
    await environment.recordServingObservation(worker, identity("pending-incomplete"));
    const ticket = await environment.getPendingServingReconciliation(worker, scope);
    await orchestration.ingestEvent(eventContext(), serving("still-incomplete", "cursor-b", [], {
      completeness: "incomplete", serving_state: { status: "unknown", reason: "inventory unavailable" },
    }));
    await expect(environment.confirmServingReconciliation(worker, ticket, identity("still-incomplete")))
      .resolves.toEqual({ outcome: "pending" });
    const next = await environment.getPendingServingReconciliation(worker, scope);
    expect(next).toMatchObject({ pendingEventId: "still-incomplete" });
    await expect(environment.confirmServingReconciliation(worker, next, identity("still-incomplete")))
      .resolves.toEqual({ outcome: "pending" });
    await orchestration.activateConfigurationByCas(admin(), { fingerprint: "config-b", expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "activation-b" } });
    await orchestration.ingestEvent(eventContext(), serving("post-config-confirmation", "cursor-c", []));
    await expect(environment.confirmServingReconciliation(worker, next, identity("post-config-confirmation")))
      .resolves.toEqual({ outcome: "superseded" });
    const checkpoint = await database.pool.query<{ current_event_id: string; pending_event_id: string }>(
      `SELECT current_event_id,pending_event_id FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([{ current_event_id: "still-incomplete", pending_event_id: "still-incomplete" }]);
  } finally { await database.cleanup(); }
});

test("competing exact confirmations apply once under the same checkpoint version", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const scope = { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", environment: "uat" };
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    await orchestration.ingestEvent(eventContext(), serving("opaque-race", "cursor-a", []));
    await environment.recordServingObservation(worker, identity("opaque-race"));
    const ticket = await environment.getPendingServingReconciliation(worker, scope);
    await Promise.all(["candidate-a", "candidate-b"].map((eventId) =>
      orchestration.ingestEvent(eventContext(), serving(eventId, `cursor-${eventId}`, []))));
    const results = await Promise.all(["candidate-a", "candidate-b"].map((eventId) =>
      environment.confirmServingReconciliation(worker, ticket, identity(eventId))));
    expect(results.map((result) => result.outcome).sort()).toEqual(["applied", "superseded"]);
    const checkpoint = await database.pool.query<{ current_event_id: string; pending_event_id: string | null;
      version: string }>(
      `SELECT current_event_id,pending_event_id,version::text FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(["candidate-a", "candidate-b"]).toContain(checkpoint.rows[0]?.current_event_id);
    expect(checkpoint.rows[0]).toMatchObject({ pending_event_id: null, version: "2" });
  } finally { await database.cleanup(); }
});

test("concurrent observations converge on the newest effective order", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    await orchestration.ingestEvent(eventContext(), serving("older", "10", [artA]));
    await orchestration.ingestEvent(eventContext(), serving("newer", "11", [artA]));
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    const outcomes = await Promise.all([
      environment.recordServingObservation(worker, identity("newer")),
      environment.recordServingObservation(worker, identity("older")),
    ]);
    expect(outcomes.map((result) => result.disposition)).toContain("applied");
    expect(outcomes.map((result) => result.disposition)).not.toContain("reconciliation_required");
    const checkpoint = await database.pool.query<{ current_event_id: string; reconciliation_required: boolean }>(
      `SELECT current_event_id,reconciliation_required FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([{ current_event_id: "newer", reconciliation_required: false }]);
  } finally { await database.cleanup(); }
});

test("the serving ledger keeps unknown revision reasons out of its safe inventory", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const marker = "secret://private-build-reference";
    await orchestration.ingestEvent(eventContext(), serving("unresolved", "1", [], {
      serving_state: { status: "known", inventory: [{ artifact_id: "artifact-a",
        revision: { state: "unknown", reason: marker } }] },
    }));
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    await environment.recordServingObservation(worker,
      { tenantId: "tenant-a", producerId: "deploy", eventId: "unresolved" });
    const persisted = await database.pool.query<{ inventory: string }>(
      `SELECT inventory::text FROM ${schema}.environment_serving_observations`,
    );
    expect(persisted.rows[0]!.inventory).toContain('"state": "unknown"');
    expect(persisted.rows[0]!.inventory).not.toContain(marker);
  } finally { await database.cleanup(); }
});

test("an observation from a superseded configuration cannot become current", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.registerConfiguration(admin(), { ...configuration(), fingerprint: "config-b" });
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    await orchestration.ingestEvent(eventContext(), serving("old-config", "1", [artA]));
    await orchestration.activateConfigurationByCas(admin(), { fingerprint: "config-b", expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "activation-b" } });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    await expect(environment.recordServingObservation(worker,
      { tenantId: "tenant-a", producerId: "deploy", eventId: "old-config" }))
      .resolves.toEqual({ outcome: "inserted", disposition: "reconciliation_required" });
    const checkpoint = await database.pool.query<{ current_event_id: string | null; pending_event_id: string }>(
      `SELECT current_event_id,pending_event_id FROM ${schema}.environment_serving_checkpoints`,
    );
    expect(checkpoint.rows).toEqual([{ current_event_id: null, pending_event_id: "old-config" }]);
  } finally { await database.cleanup(); }
});

test("unknown serving state remains current but still requests exact reconciliation", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const artA = { artifact_id: "artifact-a", revision: { state: "known" as const, revision: revisionA } };
    await orchestration.ingestEvent(eventContext(), serving("known-before", "1", [artA]));
    await orchestration.ingestEvent(eventContext(), serving("unknown-now", "2", [], {
      completeness: "incomplete", serving_state: { status: "unknown", reason: "active set unavailable" },
    }));
    await orchestration.ingestEvent(eventContext(), serving("known-after", "3", [artA]));
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const identity = (eventId: string) => ({ tenantId: "tenant-a", producerId: "deploy", eventId });
    await environment.recordServingObservation(worker, identity("known-before"));
    await expect(environment.recordServingObservation(worker, identity("unknown-now")))
      .resolves.toEqual({ outcome: "inserted", disposition: "applied" });
    const unknown = await database.pool.query<{ current_event_id: string; pending_event_id: string;
      reconciliation_required: boolean }>(
        `SELECT current_event_id,pending_event_id,reconciliation_required
         FROM ${schema}.environment_serving_checkpoints`,
      );
    expect(unknown.rows).toEqual([{ current_event_id: "unknown-now", pending_event_id: "unknown-now",
      reconciliation_required: true }]);
    await environment.recordServingObservation(worker, identity("known-after"));
    const confirmed = await database.pool.query<{ current_event_id: string; pending_event_id: string | null;
      reconciliation_required: boolean }>(
        `SELECT current_event_id,pending_event_id,reconciliation_required
         FROM ${schema}.environment_serving_checkpoints`,
      );
    expect(confirmed.rows).toEqual([{ current_event_id: "known-after", pending_event_id: null,
      reconciliation_required: false }]);
  } finally { await database.cleanup(); }
});

test("concurrent replay records one attempt and one artifact binding", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await orchestration.ingestEvent(eventContext(), attempt("parallel", { state: "known", revision: revisionA }));
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const identity = { tenantId: "tenant-a", producerId: "deploy", eventId: "parallel" };
    const outcomes = await Promise.all([environment.recordAttempt(worker, identity),
      environment.recordAttempt(worker, identity)]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["existing", "inserted"]);
    const counts = await database.pool.query<{ attempts: string; bindings: string }>(
      `SELECT (SELECT count(*) FROM ${schema}.environment_deployment_attempts)::text AS attempts,
              (SELECT count(*) FROM ${schema}.environment_artifact_bindings)::text AS bindings`,
    );
    expect(counts.rows).toEqual([{ attempts: "1", bindings: "1" }]);
  } finally { await database.cleanup(); }
});

test("consumes a previously authenticated attempt once and binds its exact artifact revision", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const event = attempt("deploy-1", { state: "known", revision: revisionA });
    await expect(orchestration.ingestEvent(eventContext(), event))
      .resolves.toMatchObject({ disposition: "deferred_handler" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    const identity = { tenantId: "tenant-a", producerId: "deploy", eventId: "deploy-1" };
    await expect(environment.recordAttempt(worker, identity))
      .resolves.toEqual({ outcome: "inserted", artifactBinding: "inserted" });
    await expect(environment.recordAttempt(worker, identity))
      .resolves.toEqual({ outcome: "existing", artifactBinding: "existing" });
    const rows = await database.pool.query<{ attempts: string; bindings: string; revision: string; state: string }>(
      `SELECT (SELECT count(*) FROM ${schema}.environment_deployment_attempts)::text AS attempts,
              (SELECT count(*) FROM ${schema}.environment_artifact_bindings)::text AS bindings,
              binding.revision,attempt.attempt_state AS state
       FROM ${schema}.environment_artifact_bindings binding
       JOIN ${schema}.environment_deployment_attempts attempt
         ON attempt.tenant_id=binding.tenant_id AND attempt.producer_id=binding.first_producer_id
           AND attempt.event_id=binding.first_event_id`,
    );
    expect(rows.rows).toEqual([{ attempts: "1", bindings: "1", revision: revisionA, state: "failed" }]);
    await expect(database.pool.query(`UPDATE ${schema}.environment_artifact_bindings SET revision=$1`, [revisionB]))
      .rejects.toMatchObject({ code: "55000" });
  } finally { await database.cleanup(); }
});

test("crash before D09 consumption replays safely and an unknown revision creates no binding", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const event = attempt("deploy-unknown", { state: "unknown", reason: "build missing" });
    const { environment: _omitted, ...subjects } = event.subjects;
    await orchestration.ingestEvent(eventContext(), { ...event, subjects });
    const restarted = createEnvironmentRepository(database.pool, { schema: database.schema });
    await expect(restarted.recordAttempt(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "deploy-unknown" }))
      .resolves.toEqual({ outcome: "inserted", artifactBinding: "unavailable" });
    const counts = await database.pool.query<{ attempts: string; bindings: string }>(
      `SELECT (SELECT count(*) FROM ${schema}.environment_deployment_attempts)::text AS attempts,
              (SELECT count(*) FROM ${schema}.environment_artifact_bindings)::text AS bindings`,
    );
    expect(counts.rows).toEqual([{ attempts: "1", bindings: "0" }]);
  } finally { await database.cleanup(); }
});

test("a conflicting artifact revision rolls back its attempt and remains tenant scoped", async () => {
  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      await orchestration.registerConfiguration(admin(tenantId), configuration());
      await orchestration.activateInitialConfiguration(admin(tenantId), { fingerprint: "config-a" });
    }
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    await orchestration.ingestEvent(eventContext(), attempt("deploy-a", { state: "known", revision: revisionA }));
    await environment.recordAttempt(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "deploy-a" });
    await orchestration.ingestEvent(eventContext(), attempt("deploy-b", { state: "known", revision: revisionB }));
    await expect(environment.recordAttempt(worker, { tenantId: "tenant-a", producerId: "deploy", eventId: "deploy-b" }))
      .rejects.toMatchObject({ code: "ARTIFACT_BINDING_CONFLICT" });
    await orchestration.ingestEvent(eventContext("tenant-b"), attempt("deploy-b", { state: "known", revision: revisionB }));
    await expect(environment.recordAttempt(worker, { tenantId: "tenant-b", producerId: "deploy", eventId: "deploy-b" }))
      .resolves.toMatchObject({ outcome: "inserted", artifactBinding: "inserted" });
    const rows = await database.pool.query<{ tenant_id: string; revision: string }>(
      `SELECT tenant_id,revision FROM ${schema}.environment_artifact_bindings ORDER BY tenant_id`,
    );
    expect(rows.rows).toEqual([{ tenant_id: "tenant-a", revision: revisionA },
      { tenant_id: "tenant-b", revision: revisionB }]);
    const count = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.environment_deployment_attempts WHERE tenant_id='tenant-a'`,
    );
    expect(count.rows).toEqual([{ count: "1" }]);
  } finally { await database.cleanup(); }
});

test("untrusted events and workers cannot write environment facts", async () => {
  const connect = vi.fn();
  const environmentWithoutDatabase = createEnvironmentRepository({ connect } as never, { schema: "api_truth_test_unit" });
  await expect(environmentWithoutDatabase.recordAttempt({ ...worker, capabilities: [] },
    { tenantId: "tenant-a", producerId: "deploy", eventId: "missing" }))
    .rejects.toMatchObject({ code: "WORKER_UNAUTHORIZED" });
  expect(connect).not.toHaveBeenCalled();

  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyEnvironmentMigrations(database.pool, { schema: database.schema });
    const orchestration = createOrchestrationRepository(database.pool, { schema: database.schema });
    await orchestration.registerConfiguration(admin(), configuration());
    await orchestration.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await expect(orchestration.ingestEvent(eventContext("tenant-a", false),
      attempt("unauthorized", { state: "known", revision: revisionA })))
      .rejects.toMatchObject({ code: "EVENT_UNAUTHORIZED" });
    const environment = createEnvironmentRepository(database.pool, { schema: database.schema });
    await expect(environment.recordAttempt(worker,
      { tenantId: "tenant-a", producerId: "deploy", eventId: "unauthorized" }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    await orchestration.ingestEvent(eventContext(), attempt("authorized", { state: "known", revision: revisionA }));
    await expect(environment.recordAttempt(worker,
      { tenantId: "tenant-b", producerId: "deploy", eventId: "authorized" }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    await orchestration.ingestEvent(eventContext(), {
      ...attempt("observation", { state: "known", revision: revisionA }),
      payload: { change_kind: "serving_observation", observation_id: "observation", environment: "uat",
        source: { authority_id: "inventory", reference: "inventory-1", access_label: "engineering" },
        completeness: "complete", effective_order: "2", serving_state: { status: "known", inventory: [] } },
    });
    await expect(environment.recordAttempt(worker,
      { tenantId: "tenant-a", producerId: "deploy", eventId: "observation" }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_NOT_FOUND_OR_DENIED" });
    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schema}.environment_deployment_attempts`,
    );
    expect(rows.rows).toEqual([{ count: "0" }]);
  } finally { await database.cleanup(); }
});
