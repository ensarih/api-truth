import {readFile} from "node:fs/promises";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import type {ContractSnapshot,InstallationConfig} from "../../packages/ir/src/index.js";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {applyEnvironmentMigrations} from "../../packages/environment/src/migrations.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {canonicalOrchestrationHash} from "../../packages/orchestration/src/canonical.js";
import {applySemanticHistoryMigrations,createSemanticService} from "../../packages/semantics/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";

const tenantId="tenant-semantic-history",repositoryId="commerce",serviceId="orders",environment="uat";
const principalId="history-reader",otherPrincipalId="other-reader",fingerprint="sha256:config-a";
const scopes=["repository-read","deployment-read","source-read","contract-read","docs-read","orders-read"];
let database:CatalogTestDatabase;
let snapshot:ContractSnapshot;
const schema=()=>quoteCatalogTestSchema(database.schema);
const context=(principal=principalId)=>({tenantId,principalId:principal});
const selection=(checkpoint="7")=>({version:"1",tenantId,repositoryId,serviceId,
  selector:{kind:"environment",environment,expectedCheckpointVersion:checkpoint}});
const answer=()=>({status:"suggestions",suggestions:[{endpointId:"ep-get",
  intent:"CANARY_PROVIDER_INTENT",summary:"CANARY_PROVIDER_SUMMARY",evidenceIds:["ev-doc-get"]}]});
const service=(archiveHistory?:boolean,providerPort=vi.fn(async()=>answer()))=>
  createSemanticService(database.pool,{schema:database.schema,providerPort,
    ...(archiveHistory===undefined?{}:{archiveHistory})});

beforeEach(async()=>{
  database=await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool,{schema:database.schema});
  await applyEnvironmentMigrations(database.pool,{schema:database.schema});
  await applyOpenApiMigrations(database.pool,{schema:database.schema});
  for(const scope of scopes){
    await database.pool.query(`INSERT INTO ${schema()}.access_scopes(tenant_id,access_scope_id,active)
      VALUES($1,$2,true)`,[tenantId,scope]);
    for(const principal of [principalId,otherPrincipalId])
      await database.pool.query(`INSERT INTO ${schema()}.principal_scope_grants
        (tenant_id,principal_id,access_scope_id,active) VALUES($1,$2,$3,true)`,
      [tenantId,principal,scope]);
  }
  const config:InstallationConfig={config_version:"1.0.0",
    access_scopes:scopes.map(access_scope_id=>({access_scope_id,label:access_scope_id})),
    repositories:[{repository_id:repositoryId,provider:"github",locator:"example/commerce",
      access_scope_id:"repository-read",services:[{service_id:serviceId,root:"services/orders",
        analyzer:{adapter_id:"typescript",adapter_version:"1"},intended_branches:["main"],
        environments:[{name:environment,intended_branch:"main",
          deployment_authority:{adapter_id:"deploy",access_scope_id:"deployment-read"}}]}]}],
    inference:{enabled:true,provider:"openai",model:"synthetic-model",
      credential:{secret_ref:{scheme:"env",locator:"CANARY_MODEL_KEY"}}},logs:{enabled:false}};
  await database.pool.query(`INSERT INTO ${schema()}.orchestration_configurations
    (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES($1,$2,'1.0.0',$3,$4,'admin')`,
  [tenantId,fingerprint,canonicalOrchestrationHash(config),JSON.stringify(config)]);
  await database.pool.query(`INSERT INTO ${schema()}.orchestration_active_configurations
    (tenant_id,config_fingerprint,checkpoint_version) VALUES($1,$2,1)`,[tenantId,fingerprint]);
  snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  snapshot.evidence.push({evidence_id:"ev-doc-get",source:{kind:"api_document",source_id:repositoryId},
    source_version:snapshot.source.immutable_revision,location:{pointer:"/paths/~1api~1orders/get/summary"},
    method:"type_declaration",scope:{service_id:serviceId,snapshot_id:snapshot.snapshot_id,
      endpoint_id:"ep-get",revision:snapshot.source.immutable_revision},limitations:[],access_label:"docs-read"});
  snapshot.claims.push({claim_id:"claim-get-summary",subject:{service_id:serviceId,endpoint_id:"ep-get"},
    predicate:"operation.summary",value:"Read a stored order by identifier.",verification:"declared",
    evidence_ids:["ev-doc-get"]});
  const get=snapshot.endpoints.find(endpoint=>endpoint.endpoint_id==="ep-get")!;
  snapshot.evidence.push({evidence_id:"ev-doc-route",source:{kind:"api_document",source_id:repositoryId},
    source_version:snapshot.source.immutable_revision,location:{pointer:"/paths/~1api~1orders/get"},
    method:"type_declaration",scope:{service_id:serviceId,snapshot_id:snapshot.snapshot_id,
      endpoint_id:"ep-get",revision:snapshot.source.immutable_revision},limitations:[],access_label:"docs-read"});
  snapshot.claims.push({claim_id:"claim-get-route",subject:{service_id:serviceId,endpoint_id:"ep-get"},
    predicate:"route.declaration",value:{method:get.identity.method,path:get.application_path},
    verification:"declared",evidence_ids:["ev-doc-route"]});
  await database.pool.query(`INSERT INTO ${schema()}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
     identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'partial',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
  [tenantId,snapshot.snapshot_id,repositoryId,serviceId,snapshot.source.immutable_revision,
    snapshot.ir_version,snapshot.identity_version,fingerprint,snapshotIdentitySha256(snapshot),
    snapshotContentSha256(snapshot),["contract-read"],JSON.stringify(snapshot)]);
  for(const eventId of ["attempt","serving"])
    await database.pool.query(`INSERT INTO ${schema()}.orchestration_events
      (tenant_id,producer_id,event_id,event_sha256,event_type,repository_id,service_ids,document,
       adapter_version,provider,provider_reference,active_config_fingerprint)
      VALUES($1,'deploy',$2,$3,'deployment.changed',$4,ARRAY[$5],$6,'1','test',$2,$7)`,
    [tenantId,eventId,`sha256:${"a".repeat(64)}`,repositoryId,serviceId,"{}",fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_serving_observations
    (tenant_id,producer_id,event_id,repository_id,service_id,environment,observation_id,
     source_authority_id,source_access_label,effective_order,completeness,serving_status,inventory,
     active_config_fingerprint,disposition)
    VALUES($1,'deploy','serving',$2,$3,$4,'serving','inventory','source-read','1',
      'complete','known',$5,$6,'applied')`,
  [tenantId,repositoryId,serviceId,environment,JSON.stringify([{artifact_id:"artifact-a",
    revision:{state:"known",revision:snapshot.source.immutable_revision}}]),fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_serving_checkpoints
    (tenant_id,repository_id,service_id,environment,current_producer_id,current_event_id,version)
    VALUES($1,$2,$3,$4,'deploy','serving',7)`,[tenantId,repositoryId,serviceId,environment]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_deployment_attempts
    (tenant_id,producer_id,event_id,repository_id,service_id,environment,deployment_id,attempt_state,
     effective_order,artifact_id,revision_state,revision,active_config_fingerprint)
    VALUES($1,'deploy','attempt',$2,$3,$4,'attempt','succeeded','1','artifact-a','known',$5,$6)`,
  [tenantId,repositoryId,serviceId,environment,snapshot.source.immutable_revision,fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_artifact_bindings
    (tenant_id,repository_id,service_id,artifact_id,revision,first_producer_id,first_event_id)
    VALUES($1,$2,$3,'artifact-a',$4,'deploy','attempt')`,
  [tenantId,repositoryId,serviceId,snapshot.source.immutable_revision]);
  await applySemanticHistoryMigrations(database.pool,{schema:database.schema});
});
afterEach(async()=>{await database.cleanup();});

const stored=async()=>database.pool.query<{safe_result:unknown;principal_id:string}>(
  `SELECT safe_result,principal_id FROM ${schema()}.semantic_inference_history ORDER BY history_id`);

test("opt-in archive stores only cited metadata and reads exact current pin for the same principal",async()=>{
  await applySemanticHistoryMigrations(database.pool,{schema:database.schema});
  const provider=vi.fn(async()=>answer());
  const semantic=service(true,provider);
  await semantic.discover(context(),selection(),["ep-get"],"Find an order");
  const rows=await stored();expect(rows.rows).toHaveLength(1);
  const serialized=JSON.stringify(rows.rows);
  expect(serialized).not.toMatch(/CANARY_PROVIDER_INTENT|CANARY_PROVIDER_SUMMARY|Find an order|CANARY_MODEL_KEY/);
  const history=await semantic.readHistory(context(),selection(),["ep-get"],20);
  expect(history).toMatchObject({status:"resolved",pin:{snapshotId:snapshot.snapshot_id,
    checkpointVersion:"7"},records:[{verification:"inferred",review:"unreviewed",normative:false,
      requestedEndpointIds:["ep-get"],
      result:{status:"suggestions",suggestions:[{endpointId:"ep-get",evidenceIds:["ev-doc-get"]}]},
      provenance:{provider:"openai",model:"synthetic-model",
        promptVersion:"semantic-discovery-1"}}],truncated:false});
  expect(await semantic.readHistory(context(otherPrincipalId),selection(),["ep-get"],20))
    .toMatchObject({records:[]});
  expect(provider).toHaveBeenCalledTimes(1);
});

test("archive remains off by default and malformed history limits fail before database access",async()=>{
  const provider=vi.fn(async()=>answer());
  const semantic=service(undefined,provider);
  await semantic.analyze(context(),selection(),["ep-get"]);
  expect((await stored()).rows).toHaveLength(0);
  await expect(semantic.readHistory(context(),selection(),["ep-get"],20))
    .rejects.toMatchObject({code:"SEMANTIC_INVALID_REQUEST"});
  const archival=service(true,provider);
  for(const limit of [null,0,21,"1"])
    await expect(archival.readHistory(context(),selection(),["ep-get"],limit))
      .rejects.toMatchObject({code:"SEMANTIC_INVALID_REQUEST"});
  await expect(archival.analyze(context(),selection(),["ep-create"]))
    .resolves.toMatchObject({status:"no_context"});
  expect((await stored()).rows).toHaveLength(0);
});

test("default-off inference does not require the optional history table",async()=>{
  await database.pool.query(`DROP TABLE ${schema()}.semantic_inference_history`);
  const semantic=service();
  await expect(semantic.analyze(context(),selection(),["ep-get"]))
    .resolves.toMatchObject({status:"suggestions",verification:"inferred",normative:false});
  await expect(semantic.readHistory(context(),selection(),["ep-get"],1))
    .rejects.toMatchObject({code:"SEMANTIC_INVALID_REQUEST"});
});

test("revocation and serving checkpoint changes hide retained history",async()=>{
  const semantic=service(true);
  await semantic.analyze(context(),selection(),["ep-get"]);
  expect((await stored()).rows).toHaveLength(1);
  await database.pool.query(`UPDATE ${schema()}.principal_scope_grants SET active=false
    WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id='docs-read'`,[tenantId,principalId]);
  await expect(semantic.readHistory(context(),selection(),["ep-get"],20))
    .rejects.toMatchObject({code:"SEMANTIC_NOT_FOUND_OR_DENIED"});
  await database.pool.query(`UPDATE ${schema()}.principal_scope_grants SET active=true
    WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id='docs-read'`,[tenantId,principalId]);
  await database.pool.query(`UPDATE ${schema()}.environment_serving_checkpoints SET version=8
    WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,
  [tenantId,repositoryId,serviceId,environment]);
  await expect(semantic.readHistory(context(),selection(),["ep-get"],20))
    .rejects.toMatchObject({code:"SEMANTIC_STALE_CONTEXT"});
  expect(await semantic.readHistory(context(),selection("8"),["ep-get"],20))
    .toMatchObject({records:[]});
  expect((await stored()).rows).toHaveLength(1);
});

test("provider-time revocation and failed archive write persist no result",async()=>{
  const provider=vi.fn(async()=>{
    await database.pool.query(`UPDATE ${schema()}.principal_scope_grants SET active=false
      WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id='docs-read'`,[tenantId,principalId]);
    return answer();
  });
  await expect(service(true,provider).analyze(context(),selection(),["ep-get"]))
    .rejects.toMatchObject({code:"SEMANTIC_STALE_CONTEXT"});
  expect((await stored()).rows).toHaveLength(0);
  await database.pool.query(`UPDATE ${schema()}.principal_scope_grants SET active=true
    WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id='docs-read'`,[tenantId,principalId]);
  await database.pool.query(`DROP TABLE ${schema()}.semantic_inference_history`);
  await expect(service(true).analyze(context(),selection(),["ep-get"]))
    .rejects.toMatchObject({code:"SEMANTIC_STORAGE_ERROR"});
});

test("a changed active configuration does not serve old inference history",async()=>{
  const semantic=service(true);
  await semantic.analyze(context(),selection(),["ep-get"]);
  const original=(await database.pool.query<{document:unknown;document_sha256:string}>(
    `SELECT document,document_sha256 FROM ${schema()}.orchestration_configurations WHERE tenant_id=$1`,
    [tenantId])).rows[0]!;
  await database.pool.query(`INSERT INTO ${schema()}.orchestration_configurations
    (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES($1,'sha256:config-b','1.0.0',$2,$3::jsonb,'admin')`,
  [tenantId,original.document_sha256,JSON.stringify(original.document)]);
  await database.pool.query(`UPDATE ${schema()}.orchestration_active_configurations
    SET config_fingerprint='sha256:config-b',checkpoint_version=2 WHERE tenant_id=$1`,[tenantId]);
  await expect(semantic.readHistory(context(),selection(),["ep-get"],20))
    .rejects.toMatchObject({code:"SEMANTIC_NOT_FOUND_OR_DENIED"});
  expect((await stored()).rows).toHaveLength(1);
});

test("immutable stored result is hash-checked and cannot be silently edited",async()=>{
  const semantic=service(true);
  await semantic.analyze(context(),selection(),["ep-get"]);
  await expect(database.pool.query(`UPDATE ${schema()}.semantic_inference_history
    SET model='altered' WHERE tenant_id=$1`,[tenantId])).rejects.toThrow();
  await database.pool.query(`ALTER TABLE ${schema()}.semantic_inference_history
    DISABLE TRIGGER semantic_inference_history_immutable`);
  await database.pool.query(`UPDATE ${schema()}.semantic_inference_history
    SET safe_result=jsonb_set(safe_result,'{suggestions,0,endpointId}','"ep-create"'::jsonb)
    WHERE tenant_id=$1`,[tenantId]);
  await database.pool.query(`ALTER TABLE ${schema()}.semantic_inference_history
    ENABLE TRIGGER semantic_inference_history_immutable`);
  await expect(semantic.readHistory(context(),selection(),["ep-get"],20))
    .rejects.toMatchObject({code:"SEMANTIC_STORAGE_ERROR"});
});

test("prompt provenance is covered by the stored record hash",async()=>{
  const semantic=service(true);
  await semantic.analyze(context(),selection(),["ep-get"]);
  await database.pool.query(`ALTER TABLE ${schema()}.semantic_inference_history
    DISABLE TRIGGER semantic_inference_history_immutable`);
  await database.pool.query(`UPDATE ${schema()}.semantic_inference_history
    SET prompt_version='semantic-discovery-1' WHERE tenant_id=$1`,[tenantId]);
  await database.pool.query(`ALTER TABLE ${schema()}.semantic_inference_history
    ENABLE TRIGGER semantic_inference_history_immutable`);
  await expect(semantic.readHistory(context(),selection(),["ep-get"],20))
    .rejects.toMatchObject({code:"SEMANTIC_STORAGE_ERROR"});
});
