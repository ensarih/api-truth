import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { parseContractSnapshot, type ContractSnapshot } from "../../packages/ir/src/index.js";
import { snapshotContentSha256, snapshotIdentitySha256 } from "../../packages/catalog/src/canonical.js";
import { applyOrchestrationMigrations } from "../../packages/orchestration/src/migrations.js";
import { createQueryReader } from "../../packages/query/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase } from "./support/database.js";

let database: CatalogTestDatabase;
let base: ContractSnapshot;
const scope = "orders-read";
const tenantId = "tenant-query";
const principalId = "reader";
const selection = (selector: object) => ({ version: "1", tenantId,
  repositoryId: "commerce", serviceId: "orders", selector });
const context = { tenantId, principalId };

beforeAll(async () => {
  const parsed = parseContractSnapshot(JSON.parse(await readFile("tests/fixtures/ir/express-snapshot.json", "utf8")));
  if (!parsed.ok) throw new Error("Invalid test snapshot");
  base = parsed.value;
});
beforeEach(async () => {
  database = await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool, { schema: database.schema });
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.access_scopes (tenant_id,access_scope_id,active) VALUES ($1,$2,true)`, [tenantId, scope]);
  await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants (tenant_id,principal_id,access_scope_id,active) VALUES ($1,$2,$3,true)`, [tenantId, principalId, scope]);
});
afterEach(async () => { await database.cleanup(); });

const seedSnapshot = async (snapshot: ContractSnapshot) => {
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,
     ir_version,identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [tenantId, snapshot.snapshot_id,
    snapshot.service.repository_id, snapshot.service.service_id, snapshot.source.immutable_revision,
    snapshot.coverage.status === "complete" ? "success" : "partial", snapshot.ir_version,
    snapshot.identity_version, snapshot.config.config_fingerprint, snapshotIdentitySha256(snapshot),
    snapshotContentSha256(snapshot), [scope], JSON.stringify(snapshot)]);
};

const seedPointer = async (snapshotId: string) => {
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.catalog_branch_pointers
    (tenant_id,repository_id,service_id,branch,snapshot_id,provider,provider_reference)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId,"commerce","orders","main",snapshotId,"test","test-1"]);
};

test("revision read resolves one authorized, integrity-checked snapshot", async () => {
  await seedSnapshot(base);
  const result = await createQueryReader(database.pool, { schema: database.schema }).readContract(context,
    selection({ kind: "revision", revision: "rev-b" }));
  expect(result).toMatchObject({ status: "resolved", pin: { snapshotId: base.snapshot_id,
    revision: "rev-b", configFingerprint: "sha256:config-a" }, snapshot: { snapshot_id: base.snapshot_id } });
  expect(result.status === "resolved" && result.snapshot.endpoints.length).toBeGreaterThan(0);
});

test("revoked grants and other tenant reads fail closed", async () => {
  await seedSnapshot(base);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const selected = selection({ kind: "revision", revision: "rev-b" });
  await database.pool.query(`UPDATE ${quoteCatalogTestSchema(database.schema)}.principal_scope_grants SET active=false
    WHERE tenant_id=$1 AND principal_id=$2`, [tenantId, principalId]);
  await expect(reader.readContract(context, selected)).rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
  await expect(reader.readContract({ tenantId: "other", principalId }, selected))
    .rejects.toMatchObject({ code: "INVALID_QUERY_CONTEXT" });
});

test("branch reads current pointer and detects ambiguity after a move", async () => {
  await seedSnapshot(base);
  await seedPointer(base.snapshot_id);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const selected = selection({ kind: "branch", branch: "main" });
  const first = await reader.readContract(context, selected);
  expect(first).toMatchObject({ status: "resolved", pin: { snapshotId: base.snapshot_id, pointerVersion: "1" } });
  const next = JSON.parse(JSON.stringify(base).replaceAll("snapshot-orders-rev-b", "snapshot-orders-rev-c")
    .replaceAll("rev-b", "rev-c")) as ContractSnapshot;
  await seedSnapshot(next);
  await database.pool.query(`UPDATE ${quoteCatalogTestSchema(database.schema)}.catalog_branch_pointers
    SET snapshot_id=$1,pointer_version=2 WHERE tenant_id=$2 AND branch='main'`, [next.snapshot_id,tenantId]);
  const moved = await reader.readContract(context, selected);
  expect(moved).toMatchObject({ status: "resolved", pin: { snapshotId: next.snapshot_id, pointerVersion: "2" } });
});

test("two snapshots for one revision are ambiguous and expose no contract", async () => {
  await seedSnapshot(base);
  const second = JSON.parse(JSON.stringify(base).replaceAll("snapshot-orders-rev-b", "snapshot-orders-rev-b-other")) as ContractSnapshot;
  await seedSnapshot(second);
  const result = await createQueryReader(database.pool, { schema: database.schema }).readContract(context,
    selection({ kind: "revision", revision: "rev-b" }));
  expect(result).toEqual({ status: "ambiguous", selector: selection({ kind: "revision", revision: "rev-b" }) });
});

test("branch read rejects stale expected pointer version and retained pointer after deletion", async () => {
  await seedSnapshot(base);
  await seedPointer(base.snapshot_id);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  await expect(reader.readContract(context, selection({ kind: "branch", branch: "main", expectedPointerVersion: "2" })))
    .rejects.toMatchObject({ code: "QUERY_STALE_SELECTION" });
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_branch_checkpoints
    (tenant_id,repository_id,service_id,branch,desired_state,provider,provider_reference,
     checkpoint_version,analysis_generation,latest_outcome)
    VALUES ($1,$2,$3,$4,'absent','test','deleted',1,0,'absent')`, [tenantId,"commerce","orders","main"]);
  await expect(reader.readContract(context, selection({ kind: "branch", branch: "main" })))
    .rejects.toMatchObject({ code: "QUERY_STALE_SELECTION" });
});

test("branch read rejects a retained pointer while reconciliation is required", async () => {
  await seedSnapshot(base);
  await seedPointer(base.snapshot_id);
  const schema = quoteCatalogTestSchema(database.schema);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_branch_checkpoints
    (tenant_id,repository_id,service_id,branch,desired_state,desired_revision,provider,provider_reference,
     checkpoint_version,analysis_generation,latest_outcome)
    VALUES ($1,$2,$3,$4,'present',$5,'test','uncertain',1,0,'reconciliation_required')`,
    [tenantId,"commerce","orders","main",base.source.immutable_revision]);
  await expect(createQueryReader(database.pool, { schema: database.schema }).readContract(context,
    selection({ kind: "branch", branch: "main" }))).rejects.toMatchObject({ code: "QUERY_STALE_SELECTION" });
});

test("environment read pins only one observed, bound and authorized snapshot in the same read", async () => {
  const { applyEnvironmentMigrations } = await import("../../packages/environment/src/migrations.js");
  const { canonicalOrchestrationHash } = await import("../../packages/orchestration/src/canonical.js");
  await applyEnvironmentMigrations(database.pool, { schema: database.schema });
  await seedSnapshot(base);
  const schema = quoteCatalogTestSchema(database.schema);
  for (const additional of ["engineering", "deployment", "source-read"]) {
    await database.pool.query(`INSERT INTO ${schema}.access_scopes (tenant_id,access_scope_id,active) VALUES ($1,$2,true)`, [tenantId,additional]);
    await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants (tenant_id,principal_id,access_scope_id,active)
      VALUES ($1,$2,$3,true)`, [tenantId,principalId,additional]);
  }
  const document = { config_version: "1.0.0", access_scopes: [
    { access_scope_id: "engineering", label: "Engineering" },
    { access_scope_id: "deployment", label: "Deployment" },
    { access_scope_id: "source-read", label: "Serving source" },
    { access_scope_id: scope, label: "Contracts" },
  ], repositories: [{ repository_id: "commerce", provider: "github", locator: "acme/commerce",
    access_scope_id: "engineering", services: [{ service_id: "orders", root: "services/orders",
      analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
      environments: [{ name: "uat", intended_branch: "main",
        deployment_authority: { adapter_id: "deploy", access_scope_id: "deployment" } }],
    }] }], inference: { enabled: false }, logs: { enabled: false } };
  await database.pool.query(`INSERT INTO ${schema}.orchestration_configurations
    (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId,base.config.config_fingerprint,"1.0.0",
    canonicalOrchestrationHash(document),JSON.stringify(document),"admin"]);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_active_configurations
    (tenant_id,config_fingerprint,checkpoint_version) VALUES ($1,$2,1)`, [tenantId,base.config.config_fingerprint]);
  for (const eventId of ["serving", "attempt"]) {
    await database.pool.query(`INSERT INTO ${schema}.orchestration_events
      (tenant_id,producer_id,event_id,event_sha256,event_type,repository_id,service_ids,document,
       adapter_version,provider,provider_reference,active_config_fingerprint)
      VALUES ($1,'deploy',$2,$3,'deployment.changed','commerce',ARRAY['orders'],$4,'1','test',$2,$5)`,
    [tenantId,eventId,`sha256:${"a".repeat(64)}`,JSON.stringify({}),base.config.config_fingerprint]);
  }
  await database.pool.query(`INSERT INTO ${schema}.environment_serving_observations
    (tenant_id,producer_id,event_id,repository_id,service_id,environment,observation_id,
     source_authority_id,source_access_label,effective_order,completeness,serving_status,inventory,
     active_config_fingerprint,disposition)
    VALUES ($1,'deploy','serving','commerce','orders','uat','observation-1',
      'inventory','source-read','1','complete','known',$2,$3,'applied')`,
    [tenantId,JSON.stringify([{ artifact_id: "artifact-a", revision: { state: "known", revision: "rev-b" } }]),
      base.config.config_fingerprint]);
  await database.pool.query(`INSERT INTO ${schema}.environment_serving_checkpoints
    (tenant_id,repository_id,service_id,environment,current_producer_id,current_event_id,version)
    VALUES ($1,'commerce','orders','uat','deploy','serving',7)`, [tenantId]);
  await database.pool.query(`INSERT INTO ${schema}.environment_deployment_attempts
    (tenant_id,producer_id,event_id,repository_id,service_id,environment,deployment_id,attempt_state,
     effective_order,artifact_id,revision_state,revision,active_config_fingerprint)
    VALUES ($1,'deploy','attempt','commerce','orders','uat','deploy-1','succeeded',
      '1','artifact-a','known','rev-b',$2)`, [tenantId,base.config.config_fingerprint]);
  await database.pool.query(`INSERT INTO ${schema}.environment_artifact_bindings
    (tenant_id,repository_id,service_id,artifact_id,revision,first_producer_id,first_event_id)
    VALUES ($1,'commerce','orders','artifact-a','rev-b','deploy','attempt')`, [tenantId]);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const selected = selection({ kind: "environment", environment: "uat", expectedCheckpointVersion: "7" });
  expect(await reader.readContract(context, selected)).toMatchObject({ status: "resolved",
    pin: { snapshotId: base.snapshot_id, checkpointVersion: "7" } });
  expect(await reader.searchServices(context, { tenantId, query: "ord", limit: 5, environment: "uat" }))
    .toMatchObject({ services: [{ repositoryId: "commerce", serviceId: "orders",
      environment: { name: "uat", status: "resolved", pin: { snapshotId: base.snapshot_id } } }] });
  await expect(reader.readContract(context, selection({ kind: "environment", environment: "uat",
    expectedCheckpointVersion: "6" }))).rejects.toMatchObject({ code: "QUERY_STALE_SELECTION" });
  const ambiguousSnapshot = JSON.parse(JSON.stringify(base)
    .replaceAll("snapshot-orders-rev-b", "snapshot-orders-rev-b-ambiguous")) as ContractSnapshot;
  await seedSnapshot(ambiguousSnapshot);
  expect(await reader.readContract(context, selected)).toEqual({ status: "ambiguous", selector: selected });
  await database.pool.query(`UPDATE ${schema}.environment_serving_checkpoints
    SET pending_producer_id='deploy',pending_event_id='serving',reconciliation_required=true,version=8
    WHERE tenant_id=$1`, [tenantId]);
  const currentEnvironment = selection({ kind: "environment", environment: "uat" });
  expect(await reader.readContract(context, currentEnvironment))
    .toEqual({ status: "unknown", selector: currentEnvironment });
  expect(await reader.searchServices(context, { tenantId, query: "ord", limit: 5, environment: "uat" }))
    .toEqual({ services: [{ repositoryId: "commerce", serviceId: "orders",
      environment: { name: "uat", status: "unknown" } }], truncated: false });
  expect(await reader.compareContracts(context,
    selection({ kind: "revision", revision: "rev-b" }), currentEnvironment))
    .toEqual({ status: "unavailable", beforeStatus: "ambiguous", afterStatus: "unknown" });
  await expect(reader.readContract(context, selected))
    .rejects.toMatchObject({ code: "QUERY_STALE_SELECTION" });
  await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
    WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id='source-read'`, [tenantId,principalId]);
  await expect(reader.readContract(context, selected))
    .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
  expect(await reader.searchServices(context, { tenantId, query: "ord", limit: 5, environment: "uat" }))
    .toEqual({ services: [], truncated: false });
});

test("exact endpoint and schema reads reuse the authorized contract pin", async () => {
  await seedSnapshot(base);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const selected = selection({ kind: "revision", revision: "rev-b" });
  const endpoint = await reader.readEndpoint(context, selected, "ep-get");
  expect(endpoint).toMatchObject({ status: "resolved", pin: { snapshotId: base.snapshot_id },
    endpoint: { endpoint_id: "ep-get" } });
  const schema = await reader.readSchema(context, selected, "CreateOrder");
  expect(schema).toMatchObject({ status: "resolved", pin: { snapshotId: base.snapshot_id },
    schema: { schema_id: "CreateOrder" } });
  await expect(reader.readEndpoint(context, selected, "missing"))
    .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
  await expect(reader.readSchema(context, selected, "__proto__"))
    .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
  await database.pool.query(`UPDATE ${quoteCatalogTestSchema(database.schema)}.principal_scope_grants
    SET active=false WHERE tenant_id=$1 AND principal_id=$2`, [tenantId,principalId]);
  await expect(reader.readSchema(context, selected, "CreateOrder"))
    .rejects.toMatchObject({ code: "QUERY_NOT_FOUND_OR_DENIED" });
});

test("contract comparison resolves both selectors under one authorization snapshot", async () => {
  const before = JSON.parse(JSON.stringify(base).replaceAll("rev-b", "a".repeat(40))) as ContractSnapshot;
  const after = JSON.parse(JSON.stringify(base).replaceAll("snapshot-orders-rev-b", "snapshot-orders-rev-c")
    .replaceAll("rev-b", "b".repeat(40))) as ContractSnapshot;
  await seedSnapshot(before);
  await seedSnapshot(after);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const comparison = await reader.compareContracts(context,
    selection({ kind: "revision", revision: "a".repeat(40) }),
    selection({ kind: "revision", revision: "b".repeat(40) }));
  expect(comparison).toMatchObject({ status: "compared", before: { snapshotId: before.snapshot_id },
    after: { snapshotId: after.snapshot_id }, differences: { service_id: "orders" } });
});

test("service discovery filters current configuration by policy and reports unknown environment honestly", async () => {
  const { applyEnvironmentMigrations } = await import("../../packages/environment/src/migrations.js");
  const { canonicalOrchestrationHash } = await import("../../packages/orchestration/src/canonical.js");
  await applyEnvironmentMigrations(database.pool, { schema: database.schema });
  const schema = quoteCatalogTestSchema(database.schema);
  const config = { config_version: "1.0.0", access_scopes: [
    { access_scope_id: "public-repo", label: "Public" },
    { access_scope_id: "secret-repo", label: "Secret" },
    { access_scope_id: "deployment", label: "Deployment" },
  ], repositories: [
    { repository_id: "commerce", provider: "github", locator: "acme/commerce",
      access_scope_id: "public-repo", services: [{ service_id: "orders", root: "services/orders",
        analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
        environments: [{ name: "uat", intended_branch: "main",
          deployment_authority: { adapter_id: "deploy", access_scope_id: "deployment" } }] }] },
    { repository_id: "secret", provider: "github", locator: "acme/secret",
      access_scope_id: "secret-repo", services: [{ service_id: "hidden", root: "services/hidden",
        analyzer: { adapter_id: "typescript", adapter_version: "1" }, intended_branches: ["main"],
        environments: [{ name: "uat", intended_branch: "main",
          deployment_authority: { adapter_id: "deploy", access_scope_id: "deployment" } }] }] },
  ], inference: { enabled: false }, logs: { enabled: false } };
  for (const id of ["public-repo", "secret-repo", "deployment"]) {
    await database.pool.query(`INSERT INTO ${schema}.access_scopes (tenant_id,access_scope_id,active)
      VALUES ($1,$2,true)`, [tenantId,id]);
  }
  await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants
    (tenant_id,principal_id,access_scope_id,active) VALUES ($1,$2,'public-repo',true)`, [tenantId,principalId]);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_configurations
    (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES ($1,'config-search','1.0.0',$2,$3,'admin')`, [tenantId,canonicalOrchestrationHash(config),JSON.stringify(config)]);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_active_configurations
    (tenant_id,config_fingerprint,checkpoint_version) VALUES ($1,'config-search',1)`, [tenantId]);
  const reader = createQueryReader(database.pool, { schema: database.schema });
  const request = { tenantId, query: "", limit: 10 };
  expect(await reader.searchServices(context, request)).toEqual({ services: [
    { repositoryId: "commerce", serviceId: "orders" }], truncated: false });
  expect(await reader.searchServices(context, { ...request, query: "hidden" }))
    .toEqual({ services: [], truncated: false });
  expect(await reader.searchServices(context, { ...request, environment: "uat" }))
    .toEqual({ services: [], truncated: false });
  await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants
    (tenant_id,principal_id,access_scope_id,active) VALUES ($1,$2,'deployment',true)`, [tenantId,principalId]);
  expect(await reader.searchServices(context, { ...request, environment: "uat" }))
    .toEqual({ services: [{ repositoryId: "commerce", serviceId: "orders",
      environment: { name: "uat", status: "unknown" } }], truncated: false });
  await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants
    (tenant_id,principal_id,access_scope_id,active) VALUES ($1,$2,'secret-repo',true)`, [tenantId,principalId]);
  expect(await reader.searchServices(context, { ...request, limit: 2 }))
    .toEqual({ services: [{ repositoryId: "commerce", serviceId: "orders" },
      { repositoryId: "secret", serviceId: "hidden" }], truncated: false });
  await expect(reader.searchServices(context, { ...request, limit: 1 }))
    .rejects.toMatchObject({ code: "QUERY_RESULT_LIMIT_EXCEEDED" });
  await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
    WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id IN ('public-repo','secret-repo')`, [tenantId,principalId]);
  expect(await reader.searchServices(context, request)).toEqual({ services: [], truncated: false });
  await expect(reader.searchServices(context, { ...request, limit: 0 }))
    .rejects.toMatchObject({ code: "INVALID_QUERY_SEARCH" });
  await expect(reader.searchServices(context, { ...request, query: "x".repeat(129) }))
    .rejects.toMatchObject({ code: "INVALID_QUERY_SEARCH" });
  let invoked = false;
  const accessor = Object.defineProperty({ tenantId, limit: 10 }, "query", { enumerable: true,
    get() { invoked = true; return "orders"; } });
  await expect(reader.searchServices(context, accessor))
    .rejects.toMatchObject({ code: "INVALID_QUERY_SEARCH" });
  expect(invoked).toBe(false);
});
