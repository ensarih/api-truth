import { expect, test } from "vitest";

import { applyOrchestrationMigrations, createOrchestrationRepository } from "../../packages/orchestration/src/index.js";
import { catalogBranchAdvisoryKey } from "../../packages/catalog/src/index.js";
import { setOrchestrationSearchPath } from "../../packages/orchestration/src/database.js";
import {
  acquireAdvisoryLocks,
  capacityServiceLock,
  catalogBranchLock,
} from "../../packages/orchestration/src/locking.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const configuration = () => ({
  fingerprint: "config-a",
  document: {
    config_version: "1.0.0",
    access_scopes: [{ access_scope_id: "engineering", label: "Engineering" }],
    repositories: [{
      repository_id: "commerce", provider: "github", locator: "acme/commerce", access_scope_id: "engineering",
      services: [{
        service_id: "orders", root: "services/orders", analyzer: { adapter_id: "typescript", adapter_version: "1" },
        intended_branches: ["main"],
        environments: [{ name: "uat", intended_branch: "main", deployment_authority: { adapter_id: "deploy", access_scope_id: "engineering" } }],
      }],
    }],
    inference: { enabled: false }, logs: { enabled: false },
  },
});

const admin = {
  tenantId: "tenant-a", principalId: "admin", capabilities: ["configuration.admin", "orchestration.status.read"],
};

const context = (eventTypes = ["branch.updated", "pull_request.updated", "reconciliation.requested", "repository.baseline_requested"]) => ({
  tenantId: "tenant-a", principalId: "connector", producerId: "github-adapter",
  allowedEventTypes: [...eventTypes].sort(), allowedRepositories: ["commerce"], allowedServices: ["orders"],
  deploymentAuthorityGrants: [], capabilities: ["event.ingest"],
});

const envelope = (eventId: string, eventType: string, sequence: string, payload: unknown) => ({
  event_version: "1.0.0", event_id: eventId, event_type: eventType,
  producer: { producer_id: "github-adapter", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: { provider: "github", provider_reference: `delivery-${sequence}`, order: { kind: "sequence", value: sequence } },
  payload,
});

const branch = (eventId: string, sequence: string, revision: string, referenceState = "fast_forward") => envelope(
  eventId,
  "branch.updated",
  sequence,
  { branch: "main", prior_revision: null, new_revision: revision, reference_state: referenceState },
);

const setup = async (config = configuration()) => {
  const database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
  await repository.registerConfiguration(admin, config);
  await repository.activateInitialConfiguration(admin, { fingerprint: "config-a" });
  return { database, repository, schemaSql: quoteCatalogTestSchema(database.schema) };
};

test("opposite multi-service input order completes through canonical locks without partial writes", async () => {
  const config = configuration();
  config.document.repositories[0]!.services.push({
    ...structuredClone(config.document.repositories[0]!.services[0]!),
    service_id: "payments",
    root: "services/payments",
  });
  const { database, repository, schemaSql } = await setup(config);
  try {
    const eventContext = {
      ...context(["branch.updated"]),
      allowedServices: ["orders", "payments"],
    };
    const first = branch("multi-1", "1", "a".repeat(40));
    first.subjects.service_ids = ["orders", "payments"];
    const second = branch("multi-2", "2", "b".repeat(40));
    second.subjects.service_ids = ["payments", "orders"];
    const receipts = await Promise.all([
      repository.ingestEvent(eventContext, first),
      repository.ingestEvent(eventContext, second),
    ]);
    expect(receipts).toEqual([
      { outcome: "accepted", disposition: "scheduled", dispositionCounts: { scheduled: 2 } },
      { outcome: "accepted", disposition: "scheduled", dispositionCounts: { scheduled: 2 } },
    ]);
    const checkpoints = await database.pool.query<{ service_id: string; desired_revision: string }>(
      `SELECT service_id,desired_revision FROM ${schemaSql}.orchestration_branch_checkpoints
       WHERE tenant_id='tenant-a' ORDER BY service_id COLLATE "C"`,
    );
    expect(checkpoints.rows).toEqual([
      { service_id: "orders", desired_revision: "b".repeat(40) },
      { service_id: "payments", desired_revision: "b".repeat(40) },
    ]);
  } finally { await database.cleanup(); }
});

test("multi-service PR scheduling writes every PR checkpoint before its analysis prerequisites", async () => {
  const config = configuration();
  config.document.repositories[0]!.services.push({
    ...structuredClone(config.document.repositories[0]!.services[0]!),
    service_id: "payments",
    root: "services/payments",
  });
  const { database, repository, schemaSql } = await setup(config);
  try {
    const eventContext = { ...context(["pull_request.updated"]), allowedServices: ["orders", "payments"] };
    const event = envelope("multi-pr", "pull_request.updated", "1", {
      pull_request_id: "42", state: "open", base_branch: "main", base_revision: "a".repeat(40),
      head_branch: "feature/multi", head_revision: "b".repeat(40),
    });
    event.subjects.service_ids = ["payments", "orders"];
    await expect(repository.ingestEvent(eventContext, event)).resolves.toEqual({
      outcome: "accepted", disposition: "scheduled", dispositionCounts: { scheduled: 2 },
    });
    const counts = await database.pool.query<{
      pr_checkpoints: string; analysis_checkpoints: string; jobs: string; dependencies: string;
    }>(
      `SELECT
         (SELECT count(*) FROM ${schemaSql}.orchestration_pr_checkpoints)::text AS pr_checkpoints,
         (SELECT count(*) FROM ${schemaSql}.orchestration_analysis_checkpoints)::text AS analysis_checkpoints,
         (SELECT count(*) FROM ${schemaSql}.orchestration_jobs)::text AS jobs,
         (SELECT count(*) FROM ${schemaSql}.orchestration_job_dependencies)::text AS dependencies`,
    );
    expect(counts.rows).toEqual([{
      pr_checkpoints: "2", analysis_checkpoints: "2", jobs: "4", dependencies: "2",
    }]);
  } finally { await database.cleanup(); }
});

test("cross-repository reconciliation checkpoints follow repository then service order", async () => {
  const config = configuration();
  const firstRepository = config.document.repositories[0]!;
  firstRepository.repository_id = "repo-z";
  firstRepository.locator = "acme/repo-z";
  firstRepository.services[0]!.service_id = "service-a";
  const secondRepository = structuredClone(firstRepository);
  secondRepository.repository_id = "repo-a";
  secondRepository.locator = "acme/repo-a";
  secondRepository.services[0]!.service_id = "service-z";
  secondRepository.services[0]!.root = "services/z";
  config.document.repositories.push(secondRepository);
  const { database, repository, schemaSql } = await setup(config);
  try {
    await database.pool.query(
      `CREATE TABLE ${schemaSql}.checkpoint_write_order (
         sequence bigserial PRIMARY KEY, repository_id text NOT NULL, service_id text NOT NULL
       )`,
    );
    await database.pool.query(
      `CREATE FUNCTION ${schemaSql}.capture_checkpoint_write_order()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         INSERT INTO ${schemaSql}.checkpoint_write_order(repository_id,service_id)
         VALUES (NEW.repository_id,NEW.service_id);
         RETURN NEW;
       END;
       $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER capture_checkpoint_write_order
       BEFORE INSERT ON ${schemaSql}.orchestration_reconciliation_checkpoints
       FOR EACH ROW EXECUTE FUNCTION ${schemaSql}.capture_checkpoint_write_order()`,
    );
    const reconciliation = envelope("cross-repository", "reconciliation.requested", "1", {
      scope: { service_ids: ["service-a", "service-z"], environments: [] },
      provider_snapshot_reference: "snapshot-cross-repository",
    });
    delete (reconciliation.subjects as { repository_id?: string }).repository_id;
    reconciliation.subjects.service_ids = ["service-a", "service-z"];
    await repository.ingestEvent({
      ...context(["reconciliation.requested"]),
      allowedRepositories: ["repo-a", "repo-z"],
      allowedServices: ["service-a", "service-z"],
    }, reconciliation);
    const order = await database.pool.query<{ repository_id: string; service_id: string }>(
      `SELECT repository_id,service_id FROM ${schemaSql}.checkpoint_write_order ORDER BY sequence`,
    );
    expect(order.rows).toEqual([
      { repository_id: "repo-a", service_id: "service-z" },
      { repository_id: "repo-z", service_id: "service-a" },
    ]);
  } finally { await database.cleanup(); }
});

test("advances ordered branches, ignores replay/stale evidence, and supersedes old work", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    const revisionA = "a".repeat(40);
    const revisionB = "b".repeat(40);
    await expect(repository.ingestEvent(context(), branch("branch-1", "1", revisionA))).resolves.toMatchObject({
      disposition: "scheduled", dispositionCounts: { scheduled: 1 },
    });
    await expect(repository.ingestEvent(context(), branch("branch-stale", "0", "0".repeat(40)))).resolves.toMatchObject({
      disposition: "ignored_stale",
    });
    await expect(repository.ingestEvent(context(), {
      ...branch("branch-replay", "1", revisionA),
      provider_evidence: { provider: "github", provider_reference: "delivery-1", order: { kind: "sequence", value: "1" } },
    })).resolves.toMatchObject({ disposition: "no_work" });

    const hugeSequence = "9".repeat(500);
    await expect(repository.ingestEvent(context(), branch("branch-2", hugeSequence, revisionB))).resolves.toMatchObject({
      disposition: "scheduled",
    });
    const state = await database.pool.query<{
      desired_revision: string; checkpoint_version: string; analysis_generation: string; current_state: string; old_state: string;
      exchange_version: string; ir_version: string; identity_version: string; config_version: string;
    }>(
      `SELECT checkpoint.desired_revision, checkpoint.checkpoint_version::text, checkpoint.analysis_generation::text,
              current_job.state AS current_state, old_job.state AS old_state, current_job.exchange_version,
              current_job.ir_version, current_job.identity_version, current_job.config_version
       FROM ${schemaSql}.orchestration_branch_checkpoints checkpoint
       JOIN ${schemaSql}.orchestration_jobs current_job ON current_job.tenant_id=checkpoint.tenant_id AND current_job.job_id=checkpoint.current_job_id
       JOIN ${schemaSql}.orchestration_jobs old_job ON old_job.tenant_id=checkpoint.tenant_id AND old_job.target_revision=$1
       WHERE checkpoint.tenant_id='tenant-a' AND checkpoint.repository_id='commerce'
         AND checkpoint.service_id='orders' AND checkpoint.branch='main'`,
      [revisionA],
    );
    expect(state.rows).toEqual([{
      desired_revision: revisionB, checkpoint_version: "2", analysis_generation: "2",
      current_state: "queued", old_state: "superseded", exchange_version: "1.0.0", ir_version: "1.0.0",
      identity_version: "1.0.0", config_version: "1.0.0",
    }]);

    await expect(repository.ingestEvent(context(), branch("branch-conflict", hugeSequence, "c".repeat(40))))
      .rejects.toMatchObject({ code: "EVENT_ORDER_CONFLICT" });
    const conflict = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.orchestration_events WHERE event_id='branch-conflict'`,
    );
    expect(conflict.rows).toEqual([{ count: "0" }]);

    await expect(repository.ingestEvent(context(), branch(
      "branch-delete", `1${"0".repeat(500)}`, "schema-required-but-ignored", "deleted",
    ))).resolves.toMatchObject({ disposition: "scheduled" });
    const absent = await database.pool.query<{ desired_state: string; desired_revision: string | null; current_job_id: string | null }>(
      `SELECT desired_state,desired_revision,current_job_id FROM ${schemaSql}.orchestration_branch_checkpoints
       WHERE tenant_id='tenant-a' AND repository_id='commerce' AND service_id='orders' AND branch='main'`,
    );
    expect(absent.rows).toEqual([{ desired_state: "absent", desired_revision: null, current_job_id: null }]);
  } finally { await database.cleanup(); }
});

test("coalesces baseline prerequisites and increments their generation after terminal failure", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    const revision = "a".repeat(40);
    const baseline = (eventId: string) => envelope(
      eventId,
      "repository.baseline_requested",
      eventId,
      { immutable_revision: revision, service_ids: ["orders"] },
    );
    await expect(repository.ingestEvent(context(), baseline("baseline-1"))).resolves.toMatchObject({ disposition: "scheduled" });
    await expect(repository.ingestEvent(context(), baseline("baseline-2"))).resolves.toMatchObject({ disposition: "no_work" });
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs
       SET state='failed',safe_last_error_code='JOB_EXECUTION_FAILED',completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE tenant_id='tenant-a' AND kind='baseline_analysis'`,
    );
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_analysis_checkpoints
       SET last_terminal_outcome='failed',updated_at=clock_timestamp() WHERE tenant_id='tenant-a'`,
    );
    await expect(repository.ingestEvent(context(), baseline("baseline-3"))).resolves.toMatchObject({ disposition: "scheduled" });
    const rows = await database.pool.query<{ attempt_generation: string; jobs: string }>(
      `SELECT checkpoint.attempt_generation::text,
              (SELECT count(*) FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND kind='baseline_analysis')::text AS jobs
       FROM ${schemaSql}.orchestration_analysis_checkpoints checkpoint WHERE tenant_id='tenant-a'`,
    );
    expect(rows.rows).toEqual([{ attempt_generation: "2", jobs: "2" }]);
  } finally { await database.cleanup(); }
});

test("uses reconciliation for incomparable branch evidence without changing desired revision", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    const revision = "a".repeat(40);
    await repository.ingestEvent(context(), branch("ordered", "1", revision));
    const event = branch("opaque", "2", "b".repeat(40));
    event.provider_evidence = {
      provider: "github", provider_reference: "cursor-delivery", order: { kind: "cursor", value: "opaque" },
    } as never;
    await expect(repository.ingestEvent(context(), event)).resolves.toMatchObject({
      disposition: "reconciliation_required", dispositionCounts: { reconciliation_required: 1 },
    });
    const rows = await database.pool.query<{ desired_revision: string; kind: string; disposition: string; linked: boolean }>(
      `SELECT branch.desired_revision, job.kind, target.disposition,
              target.reconciliation_id = job.job_id AS linked
       FROM ${schemaSql}.orchestration_branch_checkpoints branch
       JOIN ${schemaSql}.orchestration_reconciliation_checkpoints reconcile
         USING (tenant_id,repository_id,service_id,branch)
       JOIN ${schemaSql}.orchestration_jobs job ON job.tenant_id=reconcile.tenant_id AND job.job_id=reconcile.current_job_id
       JOIN ${schemaSql}.orchestration_event_targets target
         ON target.tenant_id=job.tenant_id AND target.event_id='opaque'
       WHERE branch.tenant_id='tenant-a'`,
    );
    expect(rows.rows).toEqual([{
      desired_revision: revision, kind: "branch_reconciliation", disposition: "reconciliation_required", linked: true,
    }]);
  } finally { await database.cleanup(); }
});

test("coalesces repeated exact-branch reconciliation requests across event identities", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    const reconciliation = (eventId: string) => ({
      ...envelope(eventId, "reconciliation.requested", eventId, {
        scope: { service_ids: ["orders"], environments: [] },
        provider_snapshot_reference: "snapshot-shared",
      }),
      subjects: { repository_id: "commerce", service_ids: ["orders"] },
    });
    await expect(repository.ingestEvent(context(), reconciliation("reconcile-1"))).resolves.toMatchObject({ disposition: "scheduled" });
    await expect(repository.ingestEvent(context(), reconciliation("reconcile-2"))).resolves.toMatchObject({ disposition: "scheduled" });
    const rows = await database.pool.query<{ jobs: string; targets: string; links: string }>(
      `SELECT
         (SELECT count(*) FROM ${schemaSql}.orchestration_jobs WHERE kind='branch_reconciliation')::text AS jobs,
         (SELECT count(*) FROM ${schemaSql}.orchestration_event_targets WHERE scope_key='reconciliation:main')::text AS targets,
         (SELECT count(DISTINCT job_id) FROM ${schemaSql}.orchestration_event_targets
          WHERE scope_key='reconciliation:main')::text AS links`,
    );
    expect(rows.rows).toEqual([{ jobs: "1", targets: "2", links: "1" }]);
  } finally { await database.cleanup(); }
});

test("coalesces an equivalent opaque PR observation without replacing its reconciliation job", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    const opaquePr = (eventId: string, cursor: string, headRevision: string) => ({
      ...envelope(eventId, "pull_request.updated", eventId, {
        pull_request_id: "opaque-42", state: "updated", base_branch: "main", base_revision: "a".repeat(40),
        head_branch: "feature/opaque", head_revision: headRevision,
      }),
      provider_evidence: {
        provider: "github", provider_reference: `opaque-${cursor}`, order: { kind: "cursor", value: cursor },
      },
    });
    await expect(repository.ingestEvent(context(), opaquePr("opaque-pr-1", "cursor-1", "b".repeat(40))))
      .resolves.toMatchObject({ disposition: "reconciliation_required" });
    await expect(repository.ingestEvent(context(), opaquePr("opaque-pr-2", "cursor-1", "b".repeat(40))))
      .resolves.toMatchObject({ disposition: "reconciliation_required" });
    const rows = await database.pool.query<{
      jobs: string; targets: string; links: string; state: string; base_revision: string | null; request_state: string;
    }>(
      `SELECT
         (SELECT count(*) FROM ${schemaSql}.orchestration_jobs WHERE kind='pr_reconciliation')::text AS jobs,
         (SELECT count(*) FROM ${schemaSql}.orchestration_event_targets WHERE scope_key='pr:opaque-42')::text AS targets,
         (SELECT count(DISTINCT reconciliation_id) FROM ${schemaSql}.orchestration_event_targets
          WHERE scope_key='pr:opaque-42')::text AS links,
         checkpoint.state,checkpoint.base_revision,
         checkpoint.reconciliation_request->'relevantPayload'->>'state' AS request_state
       FROM ${schemaSql}.orchestration_pr_checkpoints checkpoint`,
    );
    expect(rows.rows).toEqual([{
      jobs: "1", targets: "2", links: "1", state: "pending", base_revision: null, request_state: "updated",
    }]);
  } finally { await database.cleanup(); }
});

test.each([
  { authoritativeState: "closed", opaqueState: "open" },
  { authoritativeState: "open", opaqueState: "closed" },
])("preserves authoritative $authoritativeState PR state across opaque $opaqueState", async ({ authoritativeState, opaqueState }) => {
  const { database, repository, schemaSql } = await setup();
  try {
    const ordered = envelope("ordered-pr", "pull_request.updated", "1", {
      pull_request_id: "authority-42", state: authoritativeState, base_branch: "main", base_revision: "a".repeat(40),
      head_branch: "feature/authority", head_revision: "b".repeat(40),
    });
    await repository.ingestEvent(context(), ordered);
    const opaque = envelope("opaque-after-ordered", "pull_request.updated", "opaque", {
      pull_request_id: "authority-42", state: opaqueState, base_branch: "main", base_revision: "c".repeat(40),
      head_branch: "feature/changed", head_revision: "d".repeat(40),
    });
    opaque.provider_evidence = {
      provider: "github", provider_reference: "opaque-later", order: { kind: "cursor", value: "cursor-later" },
    } as never;
    await expect(repository.ingestEvent(context(), opaque)).resolves.toMatchObject({
      disposition: "reconciliation_required",
    });
    const rows = await database.pool.query<{
      state: string; base_revision: string; head_revision: string; provider_reference: string;
      order_kind: string; order_value: string; checkpoint_version: string; reconciliation_generation: string;
      request_state: string; request_base_revision: string; request_head_revision: string; current_kind: string;
    }>(
      `SELECT checkpoint.state,checkpoint.base_revision,checkpoint.head_revision,checkpoint.provider_reference,
              checkpoint.order_kind,checkpoint.order_value,checkpoint.checkpoint_version::text,
              checkpoint.reconciliation_generation::text,
              checkpoint.reconciliation_request->'relevantPayload'->>'state' AS request_state,
              checkpoint.reconciliation_request->'relevantPayload'->>'base_revision' AS request_base_revision,
              checkpoint.reconciliation_request->'relevantPayload'->>'head_revision' AS request_head_revision,
              job.kind AS current_kind
       FROM ${schemaSql}.orchestration_pr_checkpoints checkpoint
       JOIN ${schemaSql}.orchestration_jobs job
         ON job.tenant_id=checkpoint.tenant_id AND job.job_id=checkpoint.current_job_id
       WHERE checkpoint.pull_request_id='authority-42'`,
    );
    expect(rows.rows).toEqual([{
      state: authoritativeState, base_revision: "a".repeat(40), head_revision: "b".repeat(40),
      provider_reference: "delivery-1", order_kind: "sequence", order_value: "1", checkpoint_version: "1",
      reconciliation_generation: "1", request_state: opaqueState, request_base_revision: "c".repeat(40),
      request_head_revision: "d".repeat(40), current_kind: "pr_reconciliation",
    }]);
  } finally { await database.cleanup(); }
});

test("replaces a leased opaque PR reconciliation when a materially different close arrives", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    const opaquePr = (eventId: string, cursor: string, state: string) => ({
      ...envelope(eventId, "pull_request.updated", eventId, {
        pull_request_id: "opaque-close", state, base_branch: "main", base_revision: "a".repeat(40),
        head_branch: "feature/opaque", head_revision: "b".repeat(40),
      }),
      provider_evidence: {
        provider: "github", provider_reference: `opaque-${cursor}`, order: { kind: "cursor", value: cursor },
      },
    });
    await repository.ingestEvent(context(), opaquePr("opaque-open", "cursor-1", "open"));
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs
       SET state='leased',lease_worker_id='worker',lease_instance_id='instance',lease_token='token',
           lease_expires_at=clock_timestamp()+interval '5 minutes',started_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE kind='pr_reconciliation'`,
    );
    await expect(repository.ingestEvent(context(), opaquePr("opaque-close", "cursor-2", "closed")))
      .resolves.toMatchObject({ disposition: "reconciliation_required" });
    const rows = await database.pool.query<{
      state: string; reconciliation_generation: string; checkpoint_version: string; request_state: string;
      current_state: string; old_state: string; cancellation_requested: boolean; linked: boolean;
    }>(
      `SELECT checkpoint.state,checkpoint.reconciliation_generation::text,checkpoint.checkpoint_version::text,
              checkpoint.reconciliation_request->'relevantPayload'->>'state' AS request_state,
              current_job.state AS current_state,old_job.state AS old_state,old_job.cancellation_requested,
              old_job.superseding_job_id=current_job.job_id AS linked
       FROM ${schemaSql}.orchestration_pr_checkpoints checkpoint
       JOIN ${schemaSql}.orchestration_jobs current_job
         ON current_job.tenant_id=checkpoint.tenant_id AND current_job.job_id=checkpoint.current_job_id
       JOIN ${schemaSql}.orchestration_jobs old_job
         ON old_job.tenant_id=checkpoint.tenant_id AND old_job.event_id='opaque-open'
       WHERE checkpoint.pull_request_id='opaque-close'`,
    );
    expect(rows.rows).toEqual([{
      state: "pending", reconciliation_generation: "2", checkpoint_version: "1", request_state: "closed", current_state: "queued",
      old_state: "leased", cancellation_requested: true, linked: true,
    }]);
  } finally { await database.cleanup(); }
});

test.each(["queued", "leased", "succeeded", "failed"] as const)(
  "advances same-revision provider evidence without a new generation when current work is %s",
  async (jobState) => {
    const { database, repository, schemaSql } = await setup();
    try {
      const revision = "a".repeat(40);
      await repository.ingestEvent(context(), branch(`same-${jobState}-1`, "1", revision));
      if (jobState === "leased") {
        await database.pool.query(
          `UPDATE ${schemaSql}.orchestration_jobs SET state='leased',lease_worker_id='worker',lease_instance_id='instance',
             lease_token='token',lease_expires_at=clock_timestamp()+interval '5 minutes',started_at=clock_timestamp()
           WHERE kind='branch_analysis'`,
        );
      } else if (jobState === "succeeded" || jobState === "failed") {
        await database.pool.query(
          `UPDATE ${schemaSql}.orchestration_jobs SET state=$1,completed_at=clock_timestamp(),
             safe_last_error_code=CASE WHEN $1='failed' THEN 'JOB_EXECUTION_FAILED' ELSE NULL END
           WHERE kind='branch_analysis'`,
          [jobState],
        );
      }
      const receipt = await repository.ingestEvent(context(), branch(`same-${jobState}-2`, "2", revision));
      expect(receipt.disposition).toBe(jobState === "queued" || jobState === "leased" ? "scheduled" : "no_work");
      const rows = await database.pool.query<{ jobs: string; checkpoint_version: string; generation: string; order_value: string }>(
        `SELECT (SELECT count(*) FROM ${schemaSql}.orchestration_jobs WHERE kind='branch_analysis')::text AS jobs,
                checkpoint_version::text,generation.analysis_generation::text AS generation,order_value
         FROM ${schemaSql}.orchestration_branch_checkpoints generation`,
      );
      expect(rows.rows).toEqual([{ jobs: "1", checkpoint_version: "2", generation: "1", order_value: "2" }]);
    } finally { await database.cleanup(); }
  },
);

test("marks leased old work for cancellation while preserving its lease", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    await repository.ingestEvent(context(), branch("leased-1", "1", "a".repeat(40)));
    await database.pool.query(
      `UPDATE ${schemaSql}.orchestration_jobs
       SET state='leased',lease_worker_id='worker',lease_instance_id='instance',lease_token='token',
           lease_expires_at=clock_timestamp()+interval '5 minutes',started_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE tenant_id='tenant-a' AND kind='branch_analysis'`,
    );
    await repository.ingestEvent(context(), branch("leased-2", "2", "b".repeat(40)));
    const leased = await database.pool.query<{
      state: string; cancellation_requested: boolean; superseding_job_id: string | null; lease_token: string | null;
    }>(
      `SELECT state,cancellation_requested,superseding_job_id,lease_token FROM ${schemaSql}.orchestration_jobs
       WHERE tenant_id='tenant-a' AND target_revision=$1`,
      ["a".repeat(40)],
    );
    expect(leased.rows).toEqual([{
      state: "leased", cancellation_requested: true,
      superseding_job_id: expect.any(String), lease_token: "token",
    }]);
  } finally { await database.cleanup(); }
});

test("automatic leased supersession waits for the service capacity lock", async () => {
  const { database, repository } = await setup();
  const blocker = await database.pool.connect();
  try {
    await repository.ingestEvent(context(), branch("capacity-1", "1", "a".repeat(40)));
    await database.pool.query(
      `UPDATE ${quoteCatalogTestSchema(database.schema)}.orchestration_jobs
       SET state='leased',lease_worker_id='worker',lease_instance_id='instance',lease_token='token',
           lease_expires_at=clock_timestamp()+interval '5 minutes',started_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE tenant_id='tenant-a' AND kind='branch_analysis'`,
    );
    await blocker.query("BEGIN");
    await setOrchestrationSearchPath(blocker, database.schema);
    await acquireAdvisoryLocks(blocker, [capacityServiceLock("tenant-a", "commerce", "orders")]);
    const pending = repository.ingestEvent(context(), branch("capacity-2", "2", "b".repeat(40)));
    const beforeRelease = await Promise.race([
      pending.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 75)),
    ]);
    expect(beforeRelease).toBe("blocked");
    await blocker.query("ROLLBACK");
    await expect(pending).resolves.toMatchObject({ disposition: "scheduled" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await database.cleanup();
  }
});

test("control cancellation is tenant-scoped, capability-gated, and updates the owning checkpoint", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    await repository.ingestEvent(context(), branch("cancel-1", "1", "a".repeat(40)));
    const selected = await database.pool.query<{ job_id: string }>(
      `SELECT job_id FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND kind='branch_analysis'`,
    );
    const jobId = selected.rows[0]!.job_id;
    await expect(repository.cancelJob({ tenantId: "tenant-a", principalId: "reader", capabilities: ["orchestration.status.read"] }, jobId))
      .rejects.toMatchObject({ code: "JOB_NOT_FOUND_OR_DENIED" });
    await expect(repository.cancelJob({ tenantId: "tenant-b", principalId: "operator", capabilities: ["orchestration.cancel"] }, jobId))
      .rejects.toMatchObject({ code: "JOB_NOT_FOUND_OR_DENIED" });
    await expect(repository.cancelJob({ tenantId: "tenant-a", principalId: "operator", capabilities: ["orchestration.cancel"] }, jobId))
      .resolves.toEqual({ jobId, state: "cancelled" });
    const state = await database.pool.query<{ state: string; cancellation_requested: boolean; current_job_id: string | null; latest_outcome: string }>(
      `SELECT job.state,job.cancellation_requested,checkpoint.current_job_id,checkpoint.latest_outcome
       FROM ${schemaSql}.orchestration_jobs job
       JOIN ${schemaSql}.orchestration_branch_checkpoints checkpoint USING (tenant_id,repository_id,service_id)
       WHERE job.tenant_id='tenant-a' AND job.job_id=$1`,
      [jobId],
    );
    expect(state.rows).toEqual([{
      state: "cancelled", cancellation_requested: true, current_job_id: null, latest_outcome: "cancelled",
    }]);
  } finally { await database.cleanup(); }
});

test("isolates PR generations and does not cancel a shared baseline prerequisite on close", async () => {
  const { database, repository, schemaSql } = await setup();
  try {
    const baseRevision = "a".repeat(40);
    const prPayload = (state: string, head: string) => ({
      pull_request_id: "42", state, base_branch: "main", base_revision: baseRevision,
      head_branch: "feature/orders", head_revision: head,
    });
    await repository.ingestEvent(context(), envelope("pr-open", "pull_request.updated", "1", prPayload("open", "b".repeat(40))));
    await repository.ingestEvent(context(), envelope("pr-update", "pull_request.updated", "2", prPayload("updated", "c".repeat(40))));
    await repository.ingestEvent(context(), envelope("pr-close", "pull_request.updated", "3", prPayload("closed", "c".repeat(40))));
    const jobs = await database.pool.query<{ kind: string; state: string; count: string }>(
      `SELECT kind,state,count(*)::text AS count FROM ${schemaSql}.orchestration_jobs
       GROUP BY kind,state ORDER BY kind COLLATE "C",state COLLATE "C"`,
    );
    expect(jobs.rows).toEqual([
      { kind: "baseline_analysis", state: "queued", count: "1" },
      { kind: "pr_preview_analysis", state: "cancelled", count: "1" },
      { kind: "pr_preview_analysis", state: "superseded", count: "1" },
    ]);
    const dependency = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.orchestration_job_dependencies`,
    );
    expect(dependency.rows).toEqual([{ count: "2" }]);
  } finally { await database.cleanup(); }
});

test("D08 catalog lock is accepted as the exact D06 advisory lock", async () => {
  const { database } = await setup();
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await setOrchestrationSearchPath(client, database.schema);
    const input = { tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", branch: "main" };
    await acquireAdvisoryLocks(client, [catalogBranchLock(input.tenantId, input.repositoryId, input.serviceId, input.branch)]);
    const held = await client.query<{ held: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
           AND classid=(((hashtextextended($1,0) >> 32) & 4294967295)::oid)
           AND objid=((hashtextextended($1,0) & 4294967295)::oid) AND objsubid=1
       ) AS held`,
      [catalogBranchAdvisoryKey(input)],
    );
    expect(held.rows).toEqual([{ held: true }]);
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await database.cleanup();
  }
});

test("explicit analyzer IR version is pinned in durable jobs and analysis identity",async()=>{
 const config=configuration();
 Object.assign(config.document.repositories[0]!.services[0]!.analyzer,{adapter_id:"nodejs-swagger-express-mw",adapter_version:"0.32.0",ir_version:"1.1.0"});
 const {database,repository,schemaSql}=await setup(config);
 try{
  await repository.ingestEvent(context(),branch("configured-ir","1","a".repeat(40)));
  const jobs=await database.pool.query(`SELECT ir_version,analyzer_adapter_id,semantic_identity FROM ${schemaSql}.orchestration_jobs WHERE tenant_id='tenant-a' AND kind='branch_analysis'`);
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0]).toMatchObject({ir_version:"1.1.0",analyzer_adapter_id:"nodejs-swagger-express-mw",semantic_identity:{analysis:{irVersion:"1.1.0"}}});
 }finally{await database.cleanup();}
});
