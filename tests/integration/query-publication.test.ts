import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../packages/catalog/src/canonical.js";
import { applyOrchestrationMigrations } from "../../packages/orchestration/src/migrations.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { createQueryReader } from "../../packages/query/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase } from "./support/database.js";

const context = { tenantId: "tenant-publication-query", principalId: "reader" };
const query = (selector: object) => ({ version: "1", tenantId: context.tenantId,
  repositoryId: "commerce", serviceId: "orders", selector });
let database: CatalogTestDatabase;
let snapshot: ContractSnapshot;

const strictFixture = async (): Promise<ContractSnapshot> => {
  const value = JSON.parse(await readFile("tests/fixtures/ir/express-snapshot.json", "utf8")) as ContractSnapshot;
  value.endpoints = [value.endpoints[0]!]; value.schemas = {}; value.claims = [];
  value.editorial_reviews = []; value.export_eligibility = []; value.dependencies = [];
  value.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  value.endpoints[0]!.parameters = value.endpoints[0]!.parameters.slice(0, 1);
  value.endpoints[0]!.responses[0]!.content[0]!.schema = { type: "string" };
  value.evidence = value.evidence.filter((item) => item.scope.endpoint_id !== "ep-create");
  value.evidence.push({ ...value.evidence[0]!, evidence_id: "ev-proof", method: "deterministic_analysis",
    limitations: [], scope: { service_id: "orders", snapshot_id: value.snapshot_id, endpoint_id: "ep-get" } });
  value.endpoints[0]!.evidence_ids = ["ev-proof"];
  value.endpoints[0]!.parameters[0]!.presence.evidence_ids = ["ev-proof"];
  value.evidence.push({ ...value.evidence[0]!, evidence_id: "ev-anonymous", method: "deterministic_analysis",
    limitations: [] });
  value.endpoints[0]!.security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  return value;
};
const seedSnapshot = async (value: ContractSnapshot) => {
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
     identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES ($1,$2,$3,$4,$5,'success',$6,$7,$8,$9,$10,$11,$12::jsonb)`, [context.tenantId,
    value.snapshot_id,value.service.repository_id,value.service.service_id,value.source.immutable_revision,
    value.ir_version,value.identity_version,value.config.config_fingerprint,
    snapshotIdentitySha256(value),snapshotContentSha256(value),["read"],JSON.stringify(value)]);
};
const pointBranch = async (id: string, version: number) => {
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_branch_pointers
    (tenant_id,repository_id,service_id,branch,snapshot_id,pointer_version,provider,provider_reference)
    VALUES ($1,'commerce','orders','main',$2,$3,'github','commit')
    ON CONFLICT (tenant_id,repository_id,service_id,branch) DO UPDATE
      SET snapshot_id=EXCLUDED.snapshot_id,pointer_version=EXCLUDED.pointer_version`, [context.tenantId,id,version]);
};
beforeEach(async () => {
  database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  await applyOpenApiMigrations(database.pool, { schema: database.schema });
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active) VALUES ($1,'read',true)`, [context.tenantId]);
  await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants
    (tenant_id,principal_id,access_scope_id,active) VALUES ($1,$2,'read',true)`, [context.tenantId,context.principalId]);
  snapshot = await strictFixture();
  await seedSnapshot(snapshot);
});
afterEach(async () => { await database.cleanup(); });

test("query shows strict export absence, then the exact D10 current publication", async () => {
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const store = createOpenApiPublicationStore(database.pool, { schema: database.schema });
  const selected = query({ kind: "revision", revision: "rev-b" });
  expect(await reader.readContract(context, selected)).toMatchObject({ status: "resolved",
    pin: { snapshotId: snapshot.snapshot_id }, publication: { status: "absent" } });
  const preparation = await store.prepareRevision(context, { kind: "revision", repositoryId: "commerce",
    serviceId: "orders", snapshotId: snapshot.snapshot_id, revision: "rev-b",
    configFingerprint: snapshot.config.config_fingerprint });
  const published = await store.publish(context, preparation, { state: "absent" });
  const current = await reader.readContract(context, selected);
  expect(current).toMatchObject({ status: "resolved", pin: { snapshotId: snapshot.snapshot_id,
    revision: snapshot.source.immutable_revision, configFingerprint: snapshot.config.config_fingerprint },
    publication: { status: "current", publicationId: published.publicationId,
      contentSha256: published.contentSha256, selector: { kind: "revision",
        snapshotId: snapshot.snapshot_id, revision: snapshot.source.immutable_revision,
        configFingerprint: snapshot.config.config_fingerprint } } });
  expect((await store.readCurrent(context, { kind: "revision", repositoryId: "commerce",
    serviceId: "orders", revision: "rev-b" })).publicationId).toBe(published.publicationId);
  const historical = await reader.readPublication(context,
    { tenantId: context.tenantId, repositoryId: "commerce", serviceId: "orders",
      publicationId: published.publicationId });
  expect(historical).toMatchObject({ publicationId: published.publicationId,
    pin: { snapshotId: snapshot.snapshot_id, revision: "rev-b" } });
  expect(historical.bytes).toEqual(published.bytes);
  expect(historical).not.toHaveProperty("current");
  await expect(reader.readPublication(context, { tenantId: context.tenantId,
    repositoryId: "other", serviceId: "orders", publicationId: published.publicationId }))
    .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
    WHERE tenant_id=$1 AND principal_id=$2`, [context.tenantId,context.principalId]);
  await expect(reader.readPublication(context,
    { tenantId: context.tenantId, repositoryId: "commerce", serviceId: "orders",
      publicationId: published.publicationId }))
    .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
});

test("a superseded branch publication is historical, never current for the new pin", async () => {
  await pointBranch(snapshot.snapshot_id, 1);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const store = createOpenApiPublicationStore(database.pool, { schema: database.schema });
  const prepared = await store.prepareBranch(context,
    { kind: "branch", repositoryId: "commerce", serviceId: "orders", branch: "main" });
  const published = await store.publish(context, prepared, { state: "absent" });
  const selection = query({ kind: "branch", branch: "main" });
  expect(await reader.readContract(context, selection)).toMatchObject({ status: "resolved",
    pin: { snapshotId: snapshot.snapshot_id, pointerVersion: "1" },
    publication: { status: "current", publicationId: published.publicationId,
      selector: { kind: "branch", branch: "main", pointerVersion: "1", snapshotId: snapshot.snapshot_id } } });
  const next = JSON.parse(JSON.stringify(snapshot).replaceAll(snapshot.snapshot_id, "snapshot-next")) as ContractSnapshot;
  await seedSnapshot(next);
  await pointBranch(next.snapshot_id, 2);
  expect(await reader.readContract(context, selection)).toMatchObject({ status: "resolved",
    pin: { snapshotId: next.snapshot_id, pointerVersion: "2" }, publication: { status: "absent" } });
  expect((await reader.readPublication(context,
    { tenantId: context.tenantId, repositoryId: "commerce", serviceId: "orders",
      publicationId: published.publicationId })).bytes).toEqual(published.bytes);
});


test("a concurrent branch promotion cannot combine an old contract with a new publication pin", async () => {
  await pointBranch(snapshot.snapshot_id, 1);
  const store = createOpenApiPublicationStore(database.pool, { schema: database.schema });
  const published = await store.publish(context, await store.prepareBranch(context,
    { kind: "branch", repositoryId: "commerce", serviceId: "orders", branch: "main" }),
  { state: "absent" });
  const next = JSON.parse(JSON.stringify(snapshot).replaceAll(snapshot.snapshot_id, "snapshot-next")) as ContractSnapshot;
  await seedSnapshot(next);
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
  const wrapped = { connect: async () => {
    const client = await database.pool.connect();
    let armed = true;
    return new Proxy(client, { get(target, property) {
      if (property === "query") return async (sql: string, values?: unknown[]) => {
        const result = await target.query(sql, values);
        if (armed && sql.includes("FROM catalog_branch_pointers")
          && sql.includes("SELECT snapshot_id,pointer_version::text")) {
          armed = false;
          reached();
          await resumePromise;
        }
        return result;
      };
      if (property === "release") return target.release.bind(target);
      return Reflect.get(target, property);
    } });
  } } as unknown as Pool;
  const reader = createQueryReader(wrapped, { schema: database.schema });
  const pending = reader.readContract(context, query({ kind: "branch", branch: "main" }))
    .then((value) => ({ status: "returned" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }));
  await reachedPromise;
  await pointBranch(next.snapshot_id, 2);
  resume();
  const outcome = await pending;
  if (outcome.status === "returned") {
    expect(outcome.value).toMatchObject({ status: "resolved",
      pin: { snapshotId: snapshot.snapshot_id, pointerVersion: "1" },
      publication: { status: "current", publicationId: published.publicationId } });
  } else {
    expect(["QUERY_STORAGE_ERROR", "QUERY_STALE_SELECTION"])
      .toContain((outcome.error as { code?: string }).code);
  }
});
