import { expect, test } from "vitest";

import {
  applyOrchestrationMigrationManifest,
  applyOrchestrationMigrations,
  createOrchestrationRepository,
} from "../../packages/orchestration/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const configuration = (fingerprint = "config-a") => ({
  fingerprint,
  document: {
    config_version: "1.0.0",
    access_scopes: [{ access_scope_id: "engineering", label: "Engineering" }],
    repositories: [{
      repository_id: "commerce", provider: "github", locator: "acme/commerce", access_scope_id: "engineering",
      services: [
        {
          service_id: "orders", root: "services/orders",
          analyzer: { adapter_id: "typescript", adapter_version: "1" },
          intended_branches: ["main"],
          environments: [{ name: "uat", intended_branch: "main", deployment_authority: { adapter_id: "deploy", access_scope_id: "engineering" } }],
        },
        {
          service_id: "payments", root: "services/payments",
          analyzer: { adapter_id: "typescript", adapter_version: "1" },
          intended_branches: [], environments: [],
        },
      ],
    }],
    inference: { enabled: false }, logs: { enabled: false },
  },
});

const admin = (tenantId = "tenant-a") => ({
  tenantId, principalId: "admin", capabilities: ["configuration.admin", "orchestration.status.read"],
});
const eventContext = (tenantId = "tenant-a") => ({
  tenantId, principalId: "connector", producerId: "github-adapter",
  allowedEventTypes: ["branch.updated", "configuration.changed", "deployment.changed", "source_document.changed"],
  allowedRepositories: ["commerce"], allowedServices: ["orders", "payments"],
  deploymentAuthorityGrants: [], capabilities: ["configuration.admin", "event.ingest"],
});
const branchEvent = (overrides: Record<string, unknown> = {}) => ({
  event_version: "1.0.0", event_id: "event-1", event_type: "branch.updated",
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders", "payments"] },
  provider_evidence: { provider: "github", provider_reference: "delivery-1", order: { kind: "sequence", value: "1" } },
  payload: { branch: "main", prior_revision: null, new_revision: "a".repeat(40), reference_state: "created" },
  ...overrides,
});

test("requires compatible D06 objects before creating any D08 ledger", async () => {
  const database = await createCatalogTestDatabase({ migrate: false });
  try {
    await expect(applyOrchestrationMigrations(database.pool, { schema: database.schema }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
    const result = await database.pool.query<{ name: string | null }>("SELECT to_regclass($1)::text AS name", [
      `${database.schema}.orchestration_schema_migrations`,
    ]);
    expect(result.rows).toEqual([{ name: null }]);
  } finally { await database.cleanup(); }
});

test("applies D08 independently, replays idempotently, and rejects checksum drift", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const rows = await database.pool.query<{ version: string }>(
      `SELECT version FROM ${schemaSql}.orchestration_schema_migrations`,
    );
    expect(rows.rows).toEqual([
      { version: "0001_orchestration_core" },
      { version: "0002_ordered_scheduling" },
      { version: "0003_durable_workers" },
      { version: "0004_atomic_execution" },
      { version: "0005_revision_target_uniqueness" },
      { version: "0006_observed_capture_associations" },
      { version: "0007_observed_capture_verifications" },
      { version: "0008_capture_verification_admissions" },
      { version: "0009_capture_verification_leases" },
      { version: "0010_capture_verification_results" },
      { version: "0011_capture_verification_cancellation" },
      { version: "0012_revision_resolution_inputs" },
      { version: "0013_loaded_document_verifications" },
    ]);
    await expect(applyOrchestrationMigrationManifest(database.pool, { schema: database.schema }, [
      { version: "0001_orchestration_core", sql: "SELECT 'private migration body'" },
    ])).rejects.toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
  } finally { await database.cleanup(); }
});

test("registers immutable configurations idempotently and isolates tenants", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    await expect(repository.registerConfiguration(admin(), configuration())).resolves.toMatchObject({ outcome: "inserted" });
    await expect(repository.registerConfiguration(admin(), configuration())).resolves.toMatchObject({ outcome: "existing" });
    const changed = configuration();
    changed.document.logs = {
      enabled: true, adapter_id: "logs", credential: { secret_ref: { scheme: "env", locator: "LOG_TOKEN" } },
    } as never;
    await expect(repository.registerConfiguration(admin(), changed)).rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });
    await expect(repository.registerConfiguration(admin("tenant-b"), configuration())).resolves.toMatchObject({ outcome: "inserted" });
    await expect(repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" })).resolves.toMatchObject({ checkpointVersion: "1" });
    await expect(repository.getActiveConfigurationSummary(admin("tenant-b"))).rejects.toMatchObject({ code: "JOB_NOT_FOUND_OR_DENIED" });
  } finally { await database.cleanup(); }
});

test("stores mixed targets, equivalent deliveries, and conflicts atomically", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin(), configuration());
    await repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await expect(repository.ingestEvent(eventContext(), branchEvent())).resolves.toEqual({
      outcome: "accepted", disposition: "mixed",
      dispositionCounts: { scheduled: 1, ignored_unconfigured_branch: 1 },
    });
    await expect(repository.ingestEvent(eventContext(), branchEvent({ received_at: "2026-01-02T00:00:00.000Z" })))
      .resolves.toMatchObject({ outcome: "duplicate", disposition: "mixed" });
    await expect(repository.ingestEvent(eventContext(), branchEvent({
      payload: { branch: "main", prior_revision: null, new_revision: "b".repeat(40), reference_state: "created" },
    }))).rejects.toMatchObject({ code: "EVENT_ID_CONFLICT" });
    await expect(repository.ingestEvent(eventContext(), branchEvent({
      provider_evidence: {
        provider: "github", provider_reference: "different-delivery", order: { kind: "sequence", value: "1" },
      },
    }))).rejects.toMatchObject({ code: "EVENT_ID_CONFLICT" });
    const counts = await database.pool.query<{ events: string; deliveries: string; targets: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM ${schemaSql}.orchestration_events)::text AS events,
              (SELECT count(*) FROM ${schemaSql}.orchestration_event_deliveries)::text AS deliveries,
              (SELECT count(*) FROM ${schemaSql}.orchestration_event_targets)::text AS targets,
              (SELECT count(*) FROM ${schemaSql}.orchestration_outbox)::text AS outbox`,
    );
    expect(counts.rows).toEqual([{ events: "1", deliveries: "2", targets: "2", outbox: "3" }]);
  } finally { await database.cleanup(); }
});

test("concurrent equivalent deliveries create one event and one target/outbox set", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin(), configuration());
    await repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const receipts = await Promise.all([
      repository.ingestEvent(eventContext(), branchEvent()),
      repository.ingestEvent(eventContext(), branchEvent({ received_at: "2026-01-01T00:00:02.000Z" })),
    ]);
    expect(receipts.map((receipt) => receipt.outcome).sort()).toEqual(["accepted", "duplicate"]);
    const rows = await database.pool.query<{ events: string; deliveries: string; targets: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM ${schemaSql}.orchestration_events)::text AS events,
              (SELECT count(*) FROM ${schemaSql}.orchestration_event_deliveries)::text AS deliveries,
              (SELECT count(*) FROM ${schemaSql}.orchestration_event_targets)::text AS targets,
              (SELECT count(*) FROM ${schemaSql}.orchestration_outbox)::text AS outbox`,
    );
    expect(rows.rows).toEqual([{ events: "1", deliveries: "2", targets: "2", outbox: "3" }]);
  } finally { await database.cleanup(); }
});

test("denies event input before touching it or PostgreSQL", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("private-event-value"); } });
    await expect(repository.ingestEvent({ ...eventContext(), capabilities: [] }, hostile))
      .rejects.toMatchObject({ code: "EVENT_UNAUTHORIZED" });
    const result = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${schemaSql}.orchestration_events`);
    expect(result.rows).toEqual([{ count: "0" }]);
  } finally { await database.cleanup(); }
});

test("activates a registered candidate by CAS and computes external-fingerprint impact for every service", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin(), configuration("config-a"));
    await repository.registerConfiguration(admin(), configuration("config-b"));
    await repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await expect(repository.activateConfigurationByCas(admin(), {
      fingerprint: "config-b", expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "approval-1" },
    })).resolves.toEqual({
      outcome: "activated", fingerprint: "config-b", checkpointVersion: "2",
      affectedServiceIds: ["orders", "payments"],
    });
    await expect(repository.getActiveConfigurationSummary(admin())).resolves.toMatchObject({
      fingerprint: "config-b", configVersion: "1.0.0", checkpointVersion: "2",
    });
    await expect(repository.activateConfigurationByCas(admin(), {
      fingerprint: "config-a", expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "approval-2" },
    })).rejects.toMatchObject({ code: "CONFIGURATION_CONFLICT" });
  } finally { await database.cleanup(); }
});

test("configuration events require exact registered candidate authority and activate all impacted services", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin(), configuration("config-a"));
    await repository.registerConfiguration(admin(), configuration("config-b"));
    await repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const event = {
      event_version: "1.0.0", event_id: "config-event", event_type: "configuration.changed",
      producer: { producer_id: "github-adapter", adapter_version: "1" },
      occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
      subjects: { service_ids: ["orders", "payments"] },
      provider_evidence: { provider: "github", provider_reference: "config-delivery", order: { kind: "sequence", value: "1" } },
      payload: {
        config_version: "1.0.0", config_fingerprint: "config-b",
        affected_service_ids: ["orders", "payments"], affected_scope: "installation",
      },
    };
    await expect(repository.ingestEvent(eventContext(), event)).resolves.toEqual({
      outcome: "accepted", disposition: "scheduled", dispositionCounts: { scheduled: 2 },
    });
    await expect(repository.ingestEvent(eventContext(), {
      ...event, received_at: "2026-01-02T00:00:01.000Z",
    })).resolves.toEqual({
      outcome: "duplicate", disposition: "scheduled", dispositionCounts: { scheduled: 2 },
    });
    await expect(repository.ingestEvent(eventContext(), {
      ...event,
      payload: { ...event.payload, affected_scope: "different-content" },
    })).rejects.toMatchObject({ code: "EVENT_ID_CONFLICT" });
    await expect(repository.getActiveConfigurationSummary(admin())).resolves.toMatchObject({
      fingerprint: "config-b", checkpointVersion: "2",
    });
    const counts = await database.pool.query<{ deliveries: string; targets: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM ${schemaSql}.orchestration_event_targets)::text AS targets,
              (SELECT count(*) FROM ${schemaSql}.orchestration_event_deliveries)::text AS deliveries,
              (SELECT count(*) FROM ${schemaSql}.orchestration_outbox)::text AS outbox`,
    );
    expect(counts.rows).toEqual([{ deliveries: "2", targets: "2", outbox: "5" }]);
    const reconciliation = await database.pool.query<{
      branch: string; config_fingerprint: string; event_id: string | null; state: string;
    }>(
      `SELECT job.branch,job.config_fingerprint,job.event_id,job.state
       FROM ${schemaSql}.orchestration_jobs job
       WHERE job.kind='branch_reconciliation'`,
    );
    expect(reconciliation.rows).toEqual([{
      branch: "main", config_fingerprint: "config-b", event_id: "config-event", state: "queued",
    }]);
  } finally { await database.cleanup(); }
});

test("CAS activation cancels stale work, reconciles exact new branches, and honors an empty allowlist", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const configA = configuration("config-a");
    const configB = configuration("config-b");
    configB.document.repositories[0]!.services[0]!.intended_branches = ["release"];
    configB.document.repositories[0]!.services[0]!.environments = [];
    const configC = configuration("config-c");
    configC.document.repositories[0]!.services[0]!.intended_branches = [];
    configC.document.repositories[0]!.services[0]!.environments = [];
    await repository.registerConfiguration(admin(), configA);
    await repository.registerConfiguration(admin(), configB);
    await repository.registerConfiguration(admin(), configC);
    await repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    await repository.ingestEvent(eventContext(), branchEvent({ subjects: {
      repository_id: "commerce", service_ids: ["orders"],
    } }));
    await repository.ingestEvent({
      ...eventContext(),
      allowedEventTypes: [...eventContext().allowedEventTypes, "repository.baseline_requested"].sort(),
    }, branchEvent({
      event_id: "baseline-before-config", event_type: "repository.baseline_requested",
      subjects: { repository_id: "commerce", service_ids: ["orders"] },
      provider_evidence: {
        provider: "github", provider_reference: "baseline-delivery", order: { kind: "sequence", value: "2" },
      },
      payload: { immutable_revision: "b".repeat(40), service_ids: ["orders"] },
    }));

    await expect(repository.activateConfigurationByCas(admin(), {
      fingerprint: "config-b", expectedCheckpointVersion: "1",
      providerEvidence: { provider: "control-plane", provider_reference: "approval-b" },
    })).resolves.toMatchObject({ outcome: "activated", checkpointVersion: "2" });
    const afterB = await database.pool.query<{
      branch: string; kind: string; state: string; config_fingerprint: string; event_id: string | null;
    }>(
      `SELECT branch,kind,state,config_fingerprint,event_id FROM ${schemaSql}.orchestration_jobs
       WHERE service_id='orders' ORDER BY kind COLLATE "C",branch COLLATE "C"`,
    );
    expect(afterB.rows).toEqual([
      { branch: null, kind: "baseline_analysis", state: "cancelled", config_fingerprint: "config-a", event_id: "baseline-before-config" },
      { branch: "main", kind: "branch_analysis", state: "cancelled", config_fingerprint: "config-a", event_id: "event-1" },
      { branch: "release", kind: "branch_reconciliation", state: "queued", config_fingerprint: "config-b", event_id: null },
    ]);

    await expect(repository.activateConfigurationByCas(admin(), {
      fingerprint: "config-c", expectedCheckpointVersion: "2",
      providerEvidence: { provider: "control-plane", provider_reference: "approval-c" },
    })).resolves.toMatchObject({ outcome: "activated", checkpointVersion: "3" });
    const afterC = await database.pool.query<{
      state: string; cancellation_requested: boolean; current_job_id: string | null; last_outcome: string | null;
    }>(
      `SELECT job.state,job.cancellation_requested,checkpoint.current_job_id,checkpoint.last_outcome
       FROM ${schemaSql}.orchestration_jobs job
       JOIN ${schemaSql}.orchestration_reconciliation_checkpoints checkpoint
         ON checkpoint.tenant_id=job.tenant_id AND checkpoint.current_job_id IS NULL
        AND checkpoint.repository_id=job.repository_id AND checkpoint.service_id=job.service_id AND checkpoint.branch=job.branch
       WHERE job.kind='branch_reconciliation'`,
    );
    expect(afterC.rows).toEqual([{
      state: "cancelled", cancellation_requested: false, current_job_id: null, last_outcome: "obsolete",
    }]);
  } finally { await database.cleanup(); }
});

test("persists deferred events without jobs and protects immutable evidence rows", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin(), configuration());
    await repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const event = {
      event_version: "1.0.0", event_id: "document-event", event_type: "source_document.changed",
      producer: { producer_id: "github-adapter", adapter_version: "1" },
      occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
      subjects: { repository_id: "commerce", service_ids: ["orders"] },
      provider_evidence: { provider: "confluence", provider_reference: "page-1" },
      payload: { document_id: "architecture", source_version: "7", state: "updated", access_label: "engineering" },
    };
    await expect(repository.ingestEvent(eventContext(), event)).resolves.toEqual({
      outcome: "accepted", disposition: "deferred_handler", dispositionCounts: { deferred_handler: 1 },
    });
    const jobs = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${schemaSql}.orchestration_jobs`);
    expect(jobs.rows).toEqual([{ count: "0" }]);
    await expect(database.pool.query(`UPDATE ${schemaSql}.orchestration_events SET event_type = 'branch.updated'`))
      .rejects.toMatchObject({ code: "55000" });
    await expect(database.pool.query(`DELETE FROM ${schemaSql}.orchestration_configurations`))
      .rejects.toMatchObject({ code: "55000" });
  } finally { await database.cleanup(); }
});

test("rolls back later D08 migration failure without leaking objects or SQL details", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const failure = await applyOrchestrationMigrationManifest(database.pool, { schema: database.schema }, [
      { version: "0002_broken", sql: "CREATE TABLE private_partial (id text); SELECT private syntax" },
    ]).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
    expect(JSON.stringify(failure)).not.toContain("private syntax");
    const result = await database.pool.query<{ table_name: string | null; count: string }>(
      `SELECT to_regclass($1)::text AS table_name,
              (SELECT count(*) FROM ${schemaSql}.orchestration_schema_migrations)::text AS count`,
      [`${database.schema}.private_partial`],
    );
    expect(result.rows).toEqual([{ table_name: null, count: "13" }]);
  } finally { await database.cleanup(); }
});

test("rejects catalog lookalike constraints before creating any D08 object", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    const constraints = await database.pool.query<{ table_name: string; constraint_name: string; constraint_type: string }>(
      `SELECT table_row.relname AS table_name, constraint_row.conname AS constraint_name,
              constraint_row.contype::text AS constraint_type
       FROM pg_catalog.pg_constraint constraint_row
       JOIN pg_catalog.pg_class table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       WHERE namespace_row.nspname = $1 AND table_row.relname IN ('catalog_snapshots', 'catalog_branch_pointers')`,
      [database.schema],
    );
    const uniqueName = constraints.rows.find((row) => row.table_name === "catalog_snapshots" && row.constraint_type === "u")!.constraint_name;
    const foreignName = constraints.rows.find((row) => row.table_name === "catalog_branch_pointers" && row.constraint_type === "f")!.constraint_name;
    await database.pool.query(`ALTER TABLE ${schemaSql}.catalog_branch_pointers DROP CONSTRAINT "${foreignName}"`);
    await database.pool.query(`ALTER TABLE ${schemaSql}.catalog_snapshots DROP CONSTRAINT "${uniqueName}"`);
    await database.pool.query(`ALTER TABLE ${schemaSql}.catalog_snapshots ADD UNIQUE (tenant_id, repository_id, snapshot_id)`);
    await database.pool.query(`ALTER TABLE ${schemaSql}.catalog_branch_pointers ADD FOREIGN KEY
      (tenant_id, repository_id, service_id, branch)
      REFERENCES ${schemaSql}.catalog_branch_pointers (tenant_id, repository_id, service_id, branch)`);
    await expect(applyOrchestrationMigrations(database.pool, { schema: database.schema }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
    const result = await database.pool.query<{ ledger: string | null; configurations: string | null }>(
      "SELECT to_regclass($1)::text AS ledger, to_regclass($2)::text AS configurations",
      [`${database.schema}.orchestration_schema_migrations`, `${database.schema}.orchestration_configurations`],
    );
    expect(result.rows).toEqual([{ ledger: null, configurations: null }]);
  } finally { await database.cleanup(); }
});

test.each([
  ["delete action", "ON DELETE CASCADE"],
  ["deferrability", "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED"],
  ["validation state", "ON DELETE RESTRICT NOT VALID"],
] as const)("rejects an exact-column D06 foreign key with incompatible %s", async (_case, foreignKeySuffix) => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    const foreign = await database.pool.query<{ constraint_name: string }>(
      `SELECT constraint_row.conname AS constraint_name
       FROM pg_catalog.pg_constraint constraint_row
       JOIN pg_catalog.pg_class table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       WHERE namespace_row.nspname = $1 AND table_row.relname = 'catalog_branch_pointers'
         AND constraint_row.contype = 'f'`,
      [database.schema],
    );
    await database.pool.query(
      `ALTER TABLE ${schemaSql}.catalog_branch_pointers DROP CONSTRAINT "${foreign.rows[0]!.constraint_name}"`,
    );
    await database.pool.query(
      `ALTER TABLE ${schemaSql}.catalog_branch_pointers ADD FOREIGN KEY
       (tenant_id, repository_id, service_id, snapshot_id)
       REFERENCES ${schemaSql}.catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id)
       ${foreignKeySuffix}`,
    );
    await expect(applyOrchestrationMigrations(database.pool, { schema: database.schema }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
    const result = await database.pool.query<{ ledger: string | null; configurations: string | null }>(
      "SELECT to_regclass($1)::text AS ledger, to_regclass($2)::text AS configurations",
      [`${database.schema}.orchestration_schema_migrations`, `${database.schema}.orchestration_configurations`],
    );
    expect(result.rows).toEqual([{ ledger: null, configurations: null }]);
  } finally { await database.cleanup(); }
});

test("enforces tenant-scoped result/outbox keys, bounded outcomes, and immutable dependencies", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const config = configuration();
    await database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_configurations
       (tenant_id, config_fingerprint, config_version, document_sha256, document, registrar_principal_id)
       VALUES ('tenant-a', 'config-a', '1.0.0', $1, $2, 'admin')`,
      [`sha256:${"1".repeat(64)}`, config.document],
    );
    await database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_jobs
       (tenant_id, job_id, dedupe_key, kind, repository_id, service_id, config_fingerprint,
        config_document_sha256, subject_generation, state, max_attempts, completed_at,
        service_root, analyzer_adapter_id, analyzer_adapter_version, exchange_version, ir_version,
        identity_version, config_version, semantic_identity)
       VALUES ('tenant-a', 'job-a', $1, 'baseline_analysis', 'commerce', 'orders', 'config-a', $2, 1, 'succeeded', 1, clock_timestamp(),
               'services/orders','typescript','1','1.0.0','1.0.0','1.0.0','1.0.0','{}'),
              ('tenant-a', 'job-b', $3, 'baseline_analysis', 'commerce', 'orders', 'config-a', $2, 1, 'queued', 1, NULL,
               'services/orders','typescript','1','1.0.0','1.0.0','1.0.0','1.0.0','{}')`,
      [`sha256:${"2".repeat(64)}`, `sha256:${"1".repeat(64)}`, `sha256:${"3".repeat(64)}`],
    );
    await expect(database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_job_results
       (tenant_id, job_id, repository_id, service_id, scope_kind, target_snapshot_id, coverage_status)
       VALUES ('tenant-a', 'job-a', 'commerce', 'orders', 'baseline', 'missing', 'complete')`,
    )).rejects.toMatchObject({ code: "23503" });
    await expect(database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_analysis_checkpoints
       (tenant_id, repository_id, service_id, service_root, immutable_revision, analyzer_adapter_id,
        analyzer_adapter_version, exchange_version, ir_version, identity_version, config_version,
        config_fingerprint, attempt_generation, last_terminal_outcome)
       VALUES ('tenant-a','commerce','orders','services/orders','rev','typescript','1','1.0.0','1.0.0','1.0.0','1.0.0','config-a',1,'invented')`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_branch_checkpoints
       (tenant_id,repository_id,service_id,branch,desired_state,desired_revision,provider,provider_reference,
        checkpoint_version,analysis_generation,current_job_id,latest_outcome)
       VALUES ('tenant-a','commerce','orders','main','present','rev','github','ref',1,1,'job-b','queued')`,
    )).rejects.toMatchObject({ code: "23514" });
    await database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_job_dependencies (tenant_id, job_id, prerequisite_job_id)
       VALUES ('tenant-a', 'job-b', 'job-a')`,
    );
    await expect(database.pool.query(
      `UPDATE ${schemaSql}.orchestration_job_dependencies SET prerequisite_job_id = 'job-b'`,
    )).rejects.toMatchObject({ code: "55000" });

    await database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_events
       (tenant_id, producer_id, event_id, event_sha256, event_type, service_ids, document, adapter_version,
        provider, provider_reference, active_config_fingerprint)
       VALUES ('tenant-a','producer-a','event-a',$1,'source_document.changed',ARRAY['orders'],'{}','1','source','ref','config-a')`,
      [`sha256:${"4".repeat(64)}`],
    );
    await expect(database.pool.query(
      `INSERT INTO ${schemaSql}.orchestration_outbox
       (tenant_id, outbox_id, dedupe_key, message_kind, event_producer_id, event_id, payload, state, max_attempts)
       VALUES ('tenant-a','outbox-a',$1,'event.disposition','producer-b','event-a','{}','pending',1)`,
      [`sha256:${"5".repeat(64)}`],
    )).rejects.toMatchObject({ code: "23503" });
  } finally { await database.cleanup(); }
});

test("contains corrupt public database projections behind safe storage errors", async () => {
  const database = await createCatalogTestDatabase();
  const schemaSql = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    await repository.registerConfiguration(admin(), configuration());
    await repository.activateInitialConfiguration(admin(), { fingerprint: "config-a" });
    const checkpointConstraint = await database.pool.query<{ constraint_name: string }>(
      `WITH target_constraints AS MATERIALIZED (
         SELECT oid,conname FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass
       )
       SELECT conname AS constraint_name FROM target_constraints
       WHERE pg_catalog.pg_get_constraintdef(oid) LIKE '%checkpoint_version > 0%'`,
      [`${schemaSql}.orchestration_active_configurations`],
    );
    await database.pool.query(
      `ALTER TABLE ${schemaSql}.orchestration_active_configurations DROP CONSTRAINT "${checkpointConstraint.rows[0]!.constraint_name}"`,
    );
    await database.pool.query(`UPDATE ${schemaSql}.orchestration_active_configurations SET checkpoint_version = 0`);
    const summaryFailure = await repository.getActiveConfigurationSummary(admin()).catch((error: unknown) => error);
    expect(summaryFailure).toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
    expect(JSON.stringify(summaryFailure)).not.toContain("config-a");

    await database.pool.query(`UPDATE ${schemaSql}.orchestration_active_configurations SET checkpoint_version = 1`);
    await repository.ingestEvent(eventContext(), branchEvent());
    const dispositionConstraints = await database.pool.query<{ constraint_name: string }>(
      `WITH target_constraints AS MATERIALIZED (
         SELECT oid,conname FROM pg_catalog.pg_constraint WHERE conrelid = $1::regclass
       )
       SELECT conname AS constraint_name FROM target_constraints
       WHERE pg_catalog.pg_get_constraintdef(oid) LIKE '%disposition%'`,
      [`${schemaSql}.orchestration_event_targets`],
    );
    for (const constraint of dispositionConstraints.rows) {
      await database.pool.query(
        `ALTER TABLE ${schemaSql}.orchestration_event_targets DROP CONSTRAINT "${constraint.constraint_name}"`,
      );
    }
    for (const [index, marker] of ["private-corrupt-marker", "__proto__", "constructor", "prototype"].entries()) {
      await database.pool.query(`ALTER TABLE ${schemaSql}.orchestration_event_targets DISABLE TRIGGER orchestration_event_targets_immutable`);
      await database.pool.query(`UPDATE ${schemaSql}.orchestration_event_targets SET disposition = $1`, [marker]);
      await database.pool.query(`ALTER TABLE ${schemaSql}.orchestration_event_targets ENABLE TRIGGER orchestration_event_targets_immutable`);
      const receiptFailure = await repository.ingestEvent(eventContext(), {
        ...branchEvent(), received_at: `2026-01-02T00:00:0${index}.000Z`,
      }).catch((error: unknown) => error);
      expect(receiptFailure).toMatchObject({ code: "ORCHESTRATION_STORAGE_ERROR" });
      expect(JSON.stringify(receiptFailure)).not.toContain(marker);
    }
    const deliveries = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.orchestration_event_deliveries`,
    );
    expect(deliveries.rows).toEqual([{ count: "1" }]);
  } finally { await database.cleanup(); }
});
