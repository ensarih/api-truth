import {readFile} from "node:fs/promises";
import {once} from "node:events";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {applyEnvironmentMigrations} from "../../packages/environment/src/migrations.js";
import {type ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyObservationMigrations,createSyntheticExampleService} from "../../packages/observations/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {canonicalOrchestrationHash} from "../../packages/orchestration/src/canonical.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createPortalServer} from "../../apps/portal/src/server.js";
import {createApiTruthMcpServer} from "../../apps/mcp/src/server.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";

const tenantId="tenant-observations-query",principalId="reader",repositoryId="commerce",serviceId="orders",environment="uat";
const scopes=["repository-read","deployment-read","contract-read","source-read"];
const context={tenantId,principalId};
let database:CatalogTestDatabase,snapshot:ContractSnapshot,schema:string;
const selection=(selector:object)=>({version:"1",tenantId,repositoryId,serviceId,selector});
const query=()=>createQueryReader(database.pool,{schema:database.schema});

beforeEach(async()=>{
  database=await createCatalogTestDatabase();schema=quoteCatalogTestSchema(database.schema);
  await applyOrchestrationMigrations(database.pool,{schema:database.schema});
  await applyEnvironmentMigrations(database.pool,{schema:database.schema});
  await applyOpenApiMigrations(database.pool,{schema:database.schema});
  await applyObservationMigrations(database.pool,{schema:database.schema});
  snapshot=JSON.parse(await readFile("tests/fixtures/ir/express-snapshot.json","utf8")) as ContractSnapshot;
  for(const scope of scopes){
    await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active) VALUES($1,$2,true)`,[tenantId,scope]);
    await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants(tenant_id,principal_id,access_scope_id,active) VALUES($1,$2,$3,true)`,[tenantId,principalId,scope]);
  }
  const config={config_version:"1.0.0",access_scopes:scopes.map(access_scope_id=>({access_scope_id,label:access_scope_id})),
    repositories:[{repository_id:repositoryId,provider:"github",locator:"acme/commerce",access_scope_id:scopes[0],services:[{
      service_id:serviceId,root:"services/orders",analyzer:{adapter_id:"typescript",adapter_version:"1"},intended_branches:["main"],
      environments:[{name:environment,intended_branch:"main",deployment_authority:{adapter_id:"deploy",access_scope_id:scopes[1]}}]}]}],
    inference:{enabled:false},logs:{enabled:false}};
  await database.pool.query(`INSERT INTO ${schema}.orchestration_configurations(tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES($1,$2,'1.0.0',$3,$4::jsonb,'admin')`,[tenantId,snapshot.config.config_fingerprint,canonicalOrchestrationHash(config),JSON.stringify(config)]);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_active_configurations(tenant_id,config_fingerprint,checkpoint_version) VALUES($1,$2,1)`,
    [tenantId,snapshot.config.config_fingerprint]);
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots(tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,
    ir_version,identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,[tenantId,snapshot.snapshot_id,repositoryId,serviceId,
      snapshot.source.immutable_revision,snapshot.coverage.status==="complete"?"success":"partial",snapshot.ir_version,snapshot.identity_version,
      snapshot.config.config_fingerprint,snapshotIdentitySha256(snapshot),snapshotContentSha256(snapshot),[scopes[2]],JSON.stringify(snapshot)]);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_events(tenant_id,producer_id,event_id,event_sha256,event_type,repository_id,service_ids,document,
    adapter_version,provider,provider_reference,active_config_fingerprint) VALUES($1,'deploy','attempt',$2,'deployment.changed',$3,ARRAY[$4],'{}'::jsonb,'1','test','attempt',$5),
    ($1,'deploy','serving',$2,'deployment.changed',$3,ARRAY[$4],'{}'::jsonb,'1','test','serving',$5)`,
    [tenantId,`sha256:${"a".repeat(64)}`,repositoryId,serviceId,snapshot.config.config_fingerprint]);
  await database.pool.query(`INSERT INTO ${schema}.environment_deployment_attempts(tenant_id,producer_id,event_id,repository_id,service_id,environment,deployment_id,
    attempt_state,effective_order,artifact_id,revision_state,revision,active_config_fingerprint)
    VALUES($1,'deploy','attempt',$2,$3,$4,'deploy-1','succeeded','1','artifact-a','known',$5,$6)`,
    [tenantId,repositoryId,serviceId,environment,snapshot.source.immutable_revision,snapshot.config.config_fingerprint]);
  await database.pool.query(`INSERT INTO ${schema}.environment_serving_observations(tenant_id,producer_id,event_id,repository_id,service_id,environment,observation_id,
    source_authority_id,source_access_label,effective_order,completeness,serving_status,inventory,active_config_fingerprint,disposition)
    VALUES($1,'deploy','serving',$2,$3,$4,'observed','inventory',$5,'1','complete','known',$6::jsonb,$7,'applied')`,
    [tenantId,repositoryId,serviceId,environment,scopes[3],JSON.stringify([{artifact_id:"artifact-a",revision:{state:"known",revision:snapshot.source.immutable_revision}}]),snapshot.config.config_fingerprint]);
  await database.pool.query(`INSERT INTO ${schema}.environment_serving_checkpoints(tenant_id,repository_id,service_id,environment,current_producer_id,current_event_id,version)
    VALUES($1,$2,$3,$4,'deploy','serving',7)`,[tenantId,repositoryId,serviceId,environment]);
  await database.pool.query(`INSERT INTO ${schema}.environment_artifact_bindings(tenant_id,repository_id,service_id,artifact_id,revision,first_producer_id,first_event_id)
    VALUES($1,$2,$3,'artifact-a',$4,'deploy','attempt')`,[tenantId,repositoryId,serviceId,snapshot.source.immutable_revision]);
});
afterEach(async()=>{await database.cleanup();});

const seedObservation=async(checkpointVersion="7",recordId="550e8400-e29b-4d4a-a716-446655440001")=>{
  await database.pool.query(`INSERT INTO ${schema}.observation_imports(tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,
    checkpoint_version,source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,'550e8400-e29b-4d4a-a716-446655440000',$5,$6,$7,$8,'gateway-log','artifact-7',
      '2026-10-09T00:00:00Z','2026-10-09T01:00:00Z','metadata-only-1','[]'::jsonb) ON CONFLICT DO NOTHING`,
    [tenantId,repositoryId,serviceId,environment,snapshot.snapshot_id,snapshot.source.immutable_revision,snapshot.config.config_fingerprint,checkpointVersion]);
  await database.pool.query(`INSERT INTO ${schema}.observation_records(tenant_id,repository_id,service_id,environment,import_id,record_id,status,reason,endpoint_id,
    mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,'550e8400-e29b-4d4a-a716-446655440000',$5,'confirmed',NULL,'ep-get','gateway-orders','GET',200,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,recordId]);
};

test("authorized query returns only bounded metadata for the current environment pin",async()=>{
  await seedObservation();
  const result=await query().readMetadataObservations(context,selection({kind:"environment",environment}),{limit:10});
  expect(result).toMatchObject({status:"resolved",pin:{snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,checkpointVersion:"7"},
    records:[{recordId:"550e8400-e29b-4d4a-a716-446655440001",sourceId:"gateway-log",sourceVersion:"artifact-7",status:"confirmed",
      endpointId:"ep-get",mappingId:"gateway-orders",method:"GET",statusCode:200,completeness:"metadata_only"}],truncated:false});
  expect(JSON.stringify(result)).not.toMatch(/url|body|cookie|token|hash/i);
  expect(await query().readMetadataObservations(context,selection({kind:"environment",environment}),{limit:1,endpointId:"ep-get"}))
    .toMatchObject({status:"resolved",records:[{endpointId:"ep-get"}]});
});

test("old checkpoint rows are excluded and access revocation denies metadata reads",async()=>{
  await seedObservation("7");
  await database.pool.query(`UPDATE ${schema}.environment_serving_checkpoints SET version=8 WHERE tenant_id=$1`,[tenantId]);
  expect(await query().readMetadataObservations(context,selection({kind:"environment",environment}),{limit:10}))
    .toMatchObject({status:"resolved",pin:{checkpointVersion:"8"},records:[]});
  await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false WHERE tenant_id=$1 AND principal_id=$2`,[tenantId,principalId]);
  await expect(query().readMetadataObservations(context,selection({kind:"environment",environment}),{limit:10}))
    .rejects.toMatchObject({code:"QUERY_NOT_FOUND_OR_DENIED"});
});

test("limit-plus-one results have stable order and report truncation",async()=>{
  await seedObservation("7","550e8400-e29b-4d4a-a716-446655440003");
  await seedObservation("7","550e8400-e29b-4d4a-a716-446655440001");
  await seedObservation("7","550e8400-e29b-4d4a-a716-446655440002");
  const selected=selection({kind:"environment",environment});
  const first=await query().readMetadataObservations(context,selected,{limit:2});
  const second=await query().readMetadataObservations(context,selected,{limit:2});
  expect(first).toMatchObject({truncated:true,records:[
    {recordId:"550e8400-e29b-4d4a-a716-446655440001"},
    {recordId:"550e8400-e29b-4d4a-a716-446655440002"}]});
  expect(second).toEqual(first);
});

test("stale expected checkpoint and invalid options fail before any database read",async()=>{
  const connect=vi.spyOn(database.pool,"connect");
  await expect(query().readMetadataObservations(context,
    selection({kind:"revision",revision:snapshot.source.immutable_revision}),{limit:1}))
    .rejects.toMatchObject({code:"INVALID_QUERY_OBSERVATION"});
  await expect(query().readMetadataObservations(context,
    selection({kind:"environment",environment}),{limit:0})).rejects.toMatchObject({code:"INVALID_QUERY_OBSERVATION"});
  const hostile=new Proxy({limit:1},{get(){throw new Error("must not execute proxy trap");}});
  await expect(query().readMetadataObservations(context,
    selection({kind:"environment",environment}),hostile)).rejects.toMatchObject({code:"INVALID_QUERY_OBSERVATION"});
  expect(connect).not.toHaveBeenCalled();
  connect.mockRestore();
  await seedObservation();
  await database.pool.query(`UPDATE ${schema}.environment_serving_checkpoints SET version=8 WHERE tenant_id=$1`,[tenantId]);
  await expect(query().readMetadataObservations(context,
    selection({kind:"environment",environment,expectedCheckpointVersion:"7"}),{limit:1}))
    .rejects.toMatchObject({code:"QUERY_STALE_SELECTION"});
});

test("query, portal, and MCP return the same current observation pin and deny it after revocation",async()=>{
  await seedObservation();
  const reader=query();
  const selected=selection({kind:"environment",environment,expectedCheckpointVersion:"7"});
  const direct=await reader.readMetadataObservations(context,selected,{limit:10});
  if(direct.status!=="resolved")throw new Error("Expected current observation pin");
  const portal=createPortalServer({authenticate:async()=>context,query:reader});
  portal.listen(0,"127.0.0.1");await once(portal,"listening");
  const address=portal.address();if(!address||typeof address==="string")throw new Error("Missing portal address");
  const client=new Client({name:"observation-query-test",version:"1.0.0"});
  const server=createApiTruthMcpServer({authenticate:async()=>context,query:reader});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  const base=`http://127.0.0.1:${address.port}`;
  try{
    const contractResponse=await fetch(`${base}/api/contract?repositoryId=${repositoryId}&serviceId=${serviceId}&kind=environment&value=${environment}`);
    expect(contractResponse.status).toBe(200);
    const contract=await contractResponse.json() as {pin:{snapshotId:string;revision:string;configFingerprint:string;checkpointVersion:string}};
    const portalResponse=await fetch(`${base}/api/observations?repositoryId=${repositoryId}&serviceId=${serviceId}&environment=${environment}&expectedCheckpointVersion=7&limit=10`);
    expect(portalResponse.status).toBe(200);
    const portalData=await portalResponse.json() as typeof direct;
    const mcpResponse=await client.callTool({name:"api_truth_get_observations",arguments:{repositoryId,serviceId,environment,
      expectedCheckpointVersion:"7",maxResults:10}});
    expect(mcpResponse.isError).not.toBe(true);
    const mcpData=(mcpResponse.structuredContent as {ok:true;data:typeof direct}).data;
    for(const data of [direct,portalData,mcpData])expect(data.pin).toEqual(contract.pin);
    expect(portalData).toEqual(direct);expect(mcpData).toEqual(direct);

    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false WHERE tenant_id=$1 AND principal_id=$2`,[tenantId,principalId]);
    expect((await fetch(`${base}/api/observations?repositoryId=${repositoryId}&serviceId=${serviceId}&environment=${environment}&limit=10`)).status)
      .toBe(404);
    expect(await client.callTool({name:"api_truth_get_observations",arguments:{repositoryId,serviceId,environment,maxResults:10}}))
      .toMatchObject({isError:true,structuredContent:{ok:false,error:"NOT_FOUND_OR_DENIED"}});
  }finally{
    await Promise.allSettled([client.close(),server.close()]);
    portal.closeAllConnections();portal.close();await once(portal,"close");
  }
});

test("historical selectors and invalid bounds fail before database reads",async()=>{
  await expect(query().readMetadataObservations(context,selection({kind:"revision",revision:snapshot.source.immutable_revision}),{limit:1}))
    .rejects.toMatchObject({code:"INVALID_QUERY_OBSERVATION"});
  await expect(query().readMetadataObservations(context,selection({kind:"environment",environment}),{limit:101}))
    .rejects.toMatchObject({code:"INVALID_QUERY_OBSERVATION"});
  await expect(query().readMetadataObservations(context,selection({kind:"environment",environment}),{limit:1,endpointId:"missing"}))
    .rejects.toMatchObject({code:"QUERY_NOT_FOUND_OR_DENIED"});
});


const exampleService=(readContract=query().readContract)=>createSyntheticExampleService({
  queryReader:{readContract},policies:[{policyId:"customer-summary",tenantId,repositoryId,serviceId,environment,
    policy:{version:"synthetic-examples-1",endpointId:"ep-get",direction:"response",statusCode:200,
      mediaType:"application/json",propertyPaths:["/id"]}}],
});
const exampleRequest=()=>({policyId:"customer-summary",selection:selection({kind:"environment",environment,
  expectedCheckpointVersion:"7"})});

test("synthetic examples use two real authorized environment reads and exact static policy",async()=>{
  const read=vi.fn(query().readContract);
  const result=await exampleService(read).generate(context,exampleRequest());
  expect(result).toMatchObject({status:"generated",kind:"synthetic_example",nonNormative:true,
    scope:{tenantId,repositoryId,serviceId,environment,endpointId:"ep-get",checkpointVersion:"7",
      snapshotId:snapshot.snapshot_id},value:{id:"string"}});
  expect(read).toHaveBeenCalledTimes(2);
  expect(await exampleService().generate(context,{...exampleRequest(),policyId:"not-configured"}))
    .toMatchObject({status:"withheld",diagnostics:[{ruleId:"policy_not_configured",count:1}]});
});

test("revoked catalog grants prevent synthetic example delivery",async()=>{
  await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
    WHERE tenant_id=$1 AND principal_id=$2`,[tenantId,principalId]);
  await expect(exampleService().generate(context,exampleRequest()))
    .rejects.toMatchObject({code:"EXAMPLE_NOT_FOUND_OR_DENIED"});
});

test("grant revocation between authorized example reads prevents delivery",async()=>{
  const actual=query().readContract;let reads=0;
  const read:typeof actual=async(...args)=>{
    const result=await actual(...args);
    if(++reads===1)await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
      WHERE tenant_id=$1 AND principal_id=$2`,[tenantId,principalId]);
    return result;
  };
  await expect(exampleService(read).generate(context,exampleRequest()))
    .rejects.toMatchObject({code:"EXAMPLE_NOT_FOUND_OR_DENIED"});
  expect(reads).toBe(1);
});

test("serving checkpoint advancement between example reads prevents stale delivery",async()=>{
  const actual=query().readContract;let reads=0;
  const read:typeof actual=async(...args)=>{
    const result=await actual(...args);
    if(++reads===1)await database.pool.query(`UPDATE ${schema}.environment_serving_checkpoints
      SET version=8 WHERE tenant_id=$1`,[tenantId]);
    return result;
  };
  await expect(exampleService(read).generate(context,exampleRequest()))
    .rejects.toMatchObject({code:"EXAMPLE_STALE_CONTEXT"});
});
