import { expect, test, vi } from "vitest";

import { applyOrchestrationMigrations, createOrchestrationRepository }
  from "../../packages/orchestration/src/index.js";
import { applyEnvironmentMigrations, createEnvironmentRepository }
  from "../../packages/environment/src/index.js";
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
      `SELECT version FROM ${schema}.environment_schema_migrations`,
    );
    expect(after.rows).toEqual([{ version: "0001_deployment_attempts" }]);
    await database.pool.query(`UPDATE ${schema}.environment_schema_migrations SET checksum_sha256=$1`,
      [`sha256:${"0".repeat(64)}`]);
    await expect(applyEnvironmentMigrations(database.pool, { schema: database.schema }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_STORAGE_ERROR" });
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
