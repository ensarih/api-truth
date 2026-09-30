import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../packages/catalog/src/canonical.js";
import { applyOrchestrationMigrations } from "../../packages/orchestration/src/index.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase } from "./support/database.js";

const context = { tenantId: "openapi-tenant", principalId: "openapi-reader" };
const selector = { kind: "revision" as const, repositoryId: "commerce", serviceId: "orders",
  snapshotId: "snapshot-orders-rev-b", revision: "rev-b", configFingerprint: "sha256:config-a" };
const key = { repositoryId: selector.repositoryId, serviceId: selector.serviceId,
  kind: "revision" as const, revision: selector.revision };
const branchKey = { repositoryId: selector.repositoryId, serviceId: selector.serviceId,
  kind: "branch" as const, branch: "main" };
let database: CatalogTestDatabase;
let store: ReturnType<typeof createOpenApiPublicationStore>;

const fixture = async (): Promise<ContractSnapshot> => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json", import.meta.url), "utf8")) as ContractSnapshot;
  snapshot.endpoints = [snapshot.endpoints[0]!];
  snapshot.schemas = {};
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0]!.parameters = snapshot.endpoints[0]!.parameters.slice(0, 1);
  snapshot.endpoints[0]!.responses[0]!.content[0]!.schema = { type: "string" };
  snapshot.evidence = snapshot.evidence.filter((item) => item.scope.endpoint_id !== "ep-create");
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-proof", method: "deterministic_analysis", limitations: [],
    scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0]!.evidence_ids = ["ev-proof"];
  snapshot.endpoints[0]!.parameters[0]!.presence.evidence_ids = ["ev-proof"];
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-anonymous", method: "deterministic_analysis", limitations: [] });
  snapshot.endpoints[0]!.security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  return snapshot;
};

const seed = async (snapshot: ContractSnapshot, tenantId = context.tenantId): Promise<void> => {
  const scope = "openapi-read";
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active) VALUES($1,$2,true) ON CONFLICT DO NOTHING`,
    [tenantId, scope]);
  await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants(tenant_id,principal_id,access_scope_id,active)
    VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING`, [tenantId, context.principalId, scope]);
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots(tenant_id,snapshot_id,repository_id,service_id,
    immutable_revision,analyzer_status,ir_version,identity_version,config_fingerprint,identity_sha256,
    content_sha256,required_scope_ids,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [tenantId, snapshot.snapshot_id, snapshot.service.repository_id, snapshot.service.service_id,
      snapshot.source.immutable_revision, snapshot.coverage.status === "complete" ? "success" : "partial",
      snapshot.ir_version, snapshot.identity_version,
      snapshot.config.config_fingerprint, snapshotIdentitySha256(snapshot), snapshotContentSha256(snapshot),
      [scope], JSON.stringify(snapshot)]);
};

const pointBranch = async (snapshotId: string, pointerVersion = "1"): Promise<void> => {
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_branch_pointers
    (tenant_id,repository_id,service_id,branch,snapshot_id,pointer_version,provider,provider_reference)
    VALUES($1,$2,$3,$4,$5,$6::bigint,'github','commit-a')
    ON CONFLICT (tenant_id,repository_id,service_id,branch) DO UPDATE
      SET snapshot_id=EXCLUDED.snapshot_id,pointer_version=EXCLUDED.pointer_version`,
  [context.tenantId, selector.repositoryId, selector.serviceId, branchKey.branch, snapshotId, pointerVersion]);
};

beforeEach(async () => {
  database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  await applyOpenApiMigrations(database.pool, { schema: database.schema });
  store = createOpenApiPublicationStore(database.pool, { schema: database.schema });
});
afterEach(async () => { await database.cleanup(); });

describe("OpenAPI publications", () => {
  test("prepares, publishes and reads a branch pinned to its exact catalog pointer", async () => {
    await seed(await fixture());
    await pointBranch(selector.snapshotId);
    const prepared = await store.prepareBranch(context, branchKey);
    expect(prepared.provenance.selector).toMatchObject({ kind: "branch", branch: "main",
      snapshotId: selector.snapshotId, pointerVersion: "1", configFingerprint: selector.configFingerprint });
    const published = await store.publish(context, prepared, { state: "absent" });
    expect((await store.readCurrent(context, branchKey)).publicationId).toBe(published.publicationId);
    const schema = quoteCatalogTestSchema(database.schema);
    const row = await database.pool.query<{ branch_pointer_version: string }>(
      `SELECT branch_pointer_version::text FROM ${schema}.openapi_publications WHERE publication_id=$1`,
      [published.publicationId]);
    expect(row.rows[0]?.branch_pointer_version).toBe("1");
  });

  test("rejects stale branch preparation and stops serving current after catalog promotion", async () => {
    const original = await fixture();
    await seed(original);
    await pointBranch(original.snapshot_id);
    const prepared = await store.prepareBranch(context, branchKey);
    const next: ContractSnapshot = { ...original, snapshot_id: "branch-next" };
    next.evidence = next.evidence.map((item) => ({ ...item,
      scope: { ...item.scope, snapshot_id: next.snapshot_id } }));
    await seed(next);
    await pointBranch(next.snapshot_id, "2");
    await expect(store.publish(context, prepared, { state: "absent" }))
      .rejects.toMatchObject({ code: "STALE_POINTER" });
    const fresh = await store.prepareBranch(context, branchKey);
    await store.publish(context, fresh, { state: "absent" });
    await pointBranch(original.snapshot_id, "3");
    await expect(store.readCurrent(context, branchKey)).rejects.toMatchObject({ code: "STALE_POINTER" });
  });

  test("treats a new pointer version for the same snapshot as a distinct branch publication", async () => {
    await seed(await fixture());
    await pointBranch(selector.snapshotId);
    const first = await store.publish(context, await store.prepareBranch(context, branchKey), { state: "absent" });
    await pointBranch(selector.snapshotId, "2");
    const next = await store.prepareBranch(context, branchKey);
    const second = await store.publish(context, next, { state: "present", pointerVersion: "1" });
    expect(second.publicationId).not.toBe(first.publicationId);
    expect(second.pointerVersion).toBe("2");
    expect((await store.readCurrent(context, branchKey)).publicationId).toBe(second.publicationId);
  });

  test("rechecks branch access at preparation, publication, and current read", async () => {
    await seed(await fixture());
    await pointBranch(selector.snapshotId);
    const prepared = await store.prepareBranch(context, branchKey);
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false WHERE tenant_id=$1`,
      [context.tenantId]);
    await expect(store.prepareBranch(context, branchKey))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
    await expect(store.publish(context, prepared, { state: "absent" }))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=true WHERE tenant_id=$1`,
      [context.tenantId]);
    await store.publish(context, prepared, { state: "absent" });
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false WHERE tenant_id=$1`,
      [context.tenantId]);
    await expect(store.readCurrent(context, branchKey))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
  });
  test("withholds a retained branch pointer after authoritative branch deletion", async () => {
    await seed(await fixture());
    await pointBranch(selector.snapshotId);
    const prepared = await store.prepareBranch(context, branchKey);
    const published = await store.publish(context, prepared, { state: "absent" });
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`INSERT INTO ${schema}.orchestration_branch_checkpoints
      (tenant_id,repository_id,service_id,branch,desired_state,desired_revision,
       provider,provider_reference,checkpoint_version,analysis_generation,latest_outcome)
      VALUES($1,$2,$3,$4,'absent',NULL,'github','branch-deleted',1,0,'absent')`,
      [context.tenantId, branchKey.repositoryId, branchKey.serviceId, branchKey.branch]);
    await expect(store.readCurrent(context, branchKey)).rejects.toMatchObject({ code: "STALE_POINTER" });
    await expect(store.prepareBranch(context, branchKey)).rejects.toMatchObject({ code: "STALE_POINTER" });
    await expect(store.publish(context, prepared, { state: "absent" }))
      .rejects.toMatchObject({ code: "STALE_POINTER" });
    expect((await store.readPublication(context, published.publicationId)).publicationId)
      .toBe(published.publicationId);
  });
  test("migration replay is idempotent and checksum mismatch is rejected", async () => {
    await applyOpenApiMigrations(database.pool, { schema: database.schema });
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`UPDATE ${schema}.openapi_schema_migrations SET checksum_sha256=$1`, [`sha256:${"0".repeat(64)}`]);
    await expect(applyOpenApiMigrations(database.pool, { schema: database.schema })).rejects.toThrow("checksum mismatch");
  });
  test("upgrades a v1 schema containing an old environment publication without exposing it", async () => {
    const snapshot = await fixture();
    await seed(snapshot);
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`ALTER TABLE ${schema}.openapi_publications
      DROP CONSTRAINT openapi_environment_scope_ids_valid`);
    await database.pool.query(`ALTER TABLE ${schema}.openapi_publications DROP COLUMN environment_scope_ids`);
    await database.pool.query(`DELETE FROM ${schema}.openapi_schema_migrations
      WHERE version='0002_environment_read_scopes'`);
    const artifactHash = `sha256:${"0".repeat(64)}`;
    const legacyId = `sha256:${"e".repeat(64)}`;
    await database.pool.query(`INSERT INTO ${schema}.openapi_artifacts(tenant_id,content_sha256,bytes)
      VALUES($1,$2,$3)`, [context.tenantId, artifactHash, Buffer.from("{}")]);
    await database.pool.query(`INSERT INTO ${schema}.openapi_publications
      (publication_id,tenant_id,repository_id,service_id,selector_kind,selector_value,
       environment_checkpoint_version,snapshot_id,immutable_revision,config_version,
       config_fingerprint,source_digest,snapshot_content_sha256,content_sha256)
      VALUES($1,$2,$3,$4,'environment','uat',1,$5,$6,$7,$8,$9,$10,$11)`,
      [legacyId, context.tenantId, selector.repositoryId, selector.serviceId,
        snapshot.snapshot_id, snapshot.source.immutable_revision, snapshot.config.config_version,
        snapshot.config.config_fingerprint, snapshot.source.source_digest,
        snapshotContentSha256(snapshot), artifactHash]);
    await expect(applyOpenApiMigrations(database.pool, { schema: database.schema })).resolves.toBeUndefined();
    await expect(store.readPublication(context, legacyId))
      .rejects.toMatchObject({ code: "CORRUPT_STORAGE" });
  });

  test("publishes strict bytes once and replays without advancing pointer", async () => {
    await seed(await fixture());
    const prepared = await store.prepareRevision(context, selector);
    expect(prepared.publishable).toBe(true);
    const first = await store.publish(context, prepared, { state: "absent" });
    const replay = await store.publish(context, prepared, { state: "absent" });
    expect(replay.publicationId).toBe(first.publicationId);
    expect(replay.pointerVersion).toBe("1");
    expect((await store.readCurrent(context, key)).bytes).toEqual(first.bytes);
    expect((await store.readPublication(context, first.publicationId)).bytes).toEqual(first.bytes);
    const schema = quoteCatalogTestSchema(database.schema);
    const count = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${schema}.openapi_publications`);
    expect(count.rows[0]!.count).toBe("1");
  });

  test("rejects unpublishable compilation, tampered bytes, and stale CAS without changing current", async () => {
    const snapshot = await fixture();
    await seed(snapshot);
    const prepared = await store.prepareRevision(context, selector);
    const first = await store.publish(context, prepared, { state: "absent" });
    const tampered = { ...prepared, bytes: new Uint8Array(prepared.bytes!) };
    tampered.bytes[0] = 0;
    await expect(store.publish(context, tampered, { state: "present", pointerVersion: "1" }))
      .rejects.toMatchObject({ code: "INVALID_PUBLICATION" });
    const another = { ...snapshot, snapshot_id: "another-snapshot" };
    another.evidence = another.evidence.map((item) => ({ ...item,
      scope: { ...item.scope, snapshot_id: another.snapshot_id } }));
    await seed(another);
    const second = await store.prepareRevision(context, { ...selector, snapshotId: another.snapshot_id });
    await expect(store.publish(context, second, { state: "absent" }))
      .rejects.toMatchObject({ code: "STALE_POINTER" });
    const unpublishable = { ...second, publishable: false };
    await expect(store.publish(context, unpublishable, { state: "present", pointerVersion: "1" }))
      .rejects.toMatchObject({ code: "INVALID_PUBLICATION" });
    const blocked: ContractSnapshot = { ...snapshot, snapshot_id: "blocked-snapshot",
      coverage: { status: "incomplete", reason: "computed route expressions remain", analyzed_roots: ["src"],
        unresolved_roots: ["src/legacy"], diagnostic_ids: ["diag-computed-route"] } };
    blocked.evidence = blocked.evidence.map((item) => ({ ...item,
      scope: { ...item.scope, snapshot_id: blocked.snapshot_id } }));
    await seed(blocked);
    const failedCompile = await store.prepareRevision(context, { ...selector, snapshotId: blocked.snapshot_id });
    expect(failedCompile.publishable).toBe(false);
    await expect(store.publish(context, failedCompile, { state: "present", pointerVersion: "1" }))
      .rejects.toMatchObject({ code: "INVALID_PUBLICATION" });
    expect((await store.readCurrent(context, key)).publicationId).toBe(first.publicationId);
  });

  test("enforces tenant and grant isolation on historical reads", async () => {
    await seed(await fixture());
    const first = await store.publish(context, await store.prepareRevision(context, selector), { state: "absent" });
    await expect(store.readPublication({ ...context, tenantId: "elsewhere" }, first.publicationId))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false WHERE tenant_id=$1`, [context.tenantId]);
    await expect(store.readPublication(context, first.publicationId))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
    await expect(store.readCurrent(context, key)).rejects.toMatchObject({ code: "NOT_FOUND_OR_DENIED" });
  });

  test("rolls back artifact and publication when pointer promotion fails", async () => {
    const snapshot = await fixture();
    await seed(snapshot);
    const first = await store.publish(context, await store.prepareRevision(context, selector), { state: "absent" });
    const another: ContractSnapshot = { ...snapshot, snapshot_id: "rollback-snapshot" };
    another.evidence = another.evidence.map((item) => ({ ...item,
      scope: { ...item.scope, snapshot_id: another.snapshot_id } }));
    await seed(another);
    const prepared = await store.prepareRevision(context, { ...selector, snapshotId: another.snapshot_id });
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`CREATE FUNCTION ${schema}.reject_openapi_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test rejection'; END $$`);
    await database.pool.query(`CREATE TRIGGER reject_openapi_pointer BEFORE UPDATE ON ${schema}.openapi_current_pointers
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_openapi_pointer()`);
    await expect(store.publish(context, prepared, { state: "present", pointerVersion: "1" }))
      .rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await store.readCurrent(context, key)).publicationId).toBe(first.publicationId);
    const artifacts = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${schema}.openapi_artifacts`);
    const publications = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${schema}.openapi_publications`);
    expect(artifacts.rows[0]!.count).toBe("1");
    expect(publications.rows[0]!.count).toBe("1");
  });

  test("detects stored byte corruption and rejects a cross-scope pointer", async () => {
    await seed(await fixture());
    const first = await store.publish(context, await store.prepareRevision(context, selector), { state: "absent" });
    const schema = quoteCatalogTestSchema(database.schema);
    await expect(database.pool.query(`INSERT INTO ${schema}.openapi_current_pointers
      (tenant_id,repository_id,service_id,selector_kind,selector_value,publication_id,pointer_version)
      VALUES($1,'other-repository',$2,'revision',$3,$4,1)`,
    [context.tenantId, selector.serviceId, selector.revision, first.publicationId])).rejects.toMatchObject({ code: "23503" });
    await database.pool.query(`ALTER TABLE ${schema}.openapi_artifacts DISABLE TRIGGER openapi_artifacts_immutable`);
    await database.pool.query(`UPDATE ${schema}.openapi_artifacts SET bytes=$1 WHERE tenant_id=$2`,
      [Buffer.from("tampered"), context.tenantId]);
    await expect(store.readPublication(context, first.publicationId)).rejects.toMatchObject({ code: "CORRUPT_STORAGE" });
  });
  test("rejects a forged historical publication manifest even when its artifact bytes are valid", async () => {
    await seed(await fixture());
    const first = await store.publish(context, await store.prepareRevision(context, selector), { state: "absent" });
    const schema = quoteCatalogTestSchema(database.schema);
    const forgedId = `sha256:${"f".repeat(64)}`;
    await database.pool.query(`INSERT INTO ${schema}.openapi_publications
      (publication_id,tenant_id,repository_id,service_id,selector_kind,selector_value,
       snapshot_id,immutable_revision,config_version,config_fingerprint,source_digest,
       snapshot_content_sha256,content_sha256)
      SELECT $1,tenant_id,repository_id,service_id,selector_kind,selector_value,
       snapshot_id,immutable_revision,config_version,config_fingerprint,source_digest,
       snapshot_content_sha256,content_sha256
      FROM ${schema}.openapi_publications WHERE publication_id=$2`, [forgedId, first.publicationId]);
    await expect(store.readPublication(context, forgedId)).rejects.toMatchObject({ code: "CORRUPT_STORAGE" });
  });
});
