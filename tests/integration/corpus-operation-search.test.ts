import {readFile} from "node:fs/promises";
import {afterEach, beforeEach, expect, test} from "vitest";
import {parseContractSnapshot,type ContractSnapshot,type InstallationConfig} from "../../packages/ir/src/index.js";
import {deriveEndpointIdentity} from "../../packages/ir/src/identity.js";
import {snapshotContentSha256, snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {applyEnvironmentMigrations} from "../../packages/environment/src/migrations.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {canonicalOrchestrationHash} from "../../packages/orchestration/src/canonical.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema, type CatalogTestDatabase} from "./support/database.js";

const tenantId="tenant-corpus", principalId="corpus-reader", environment="uat";
const fingerprint="sha256:config-a";
const serviceSpecs=[
  {repositoryId:"commerce",serviceId:"orders",scope:"orders-repo",label:"stored order"},
  {repositoryId:"finance",serviceId:"invoices",scope:"invoices-repo",label:"stored invoice"},
  {repositoryId:"private",serviceId:"secrets",scope:"secrets-repo",label:"stored secret"},
] as const;
let database:CatalogTestDatabase;
const context=()=>({tenantId,principalId});
const request=(intentQuery:string,limit=20)=>({tenantId,environment,intentQuery,limit});
const schema=()=>quoteCatalogTestSchema(database.schema);

const documentSnapshot=async(spec:(typeof serviceSpecs)[number]):Promise<ContractSnapshot>=>{
  const base=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  const snapshot=structuredClone(base);
  snapshot.snapshot_id=`snapshot-${spec.serviceId}`;
  snapshot.service.repository_id=spec.repositoryId;
  snapshot.service.service_id=spec.serviceId;
  snapshot.source.repository_id=spec.repositoryId;
  snapshot.source.immutable_revision=`revision-${spec.serviceId}`;
  snapshot.coverage={status:"complete",analyzed_roots:["src"],diagnostic_ids:[]};
  snapshot.endpoints=[structuredClone(base.endpoints[0]!)];
  const endpoint=snapshot.endpoints[0]!;
  endpoint.endpoint_id=`endpoint-${spec.serviceId}`;
  endpoint.identity=deriveEndpointIdentity({identity_version:endpoint.identity.identity_version,
    service_id:spec.serviceId,method:endpoint.identity.method,application_path:endpoint.application_path,
    selectors:endpoint.identity.selectors});
  endpoint.evidence_ids=[`route-${spec.serviceId}`];
  endpoint.parameters=[];
  endpoint.responses=[{status:{kind:"exact",code:200},content:[]}];
  endpoint.security={alternatives:[]};
  snapshot.schemas={};
  snapshot.dependencies=[];
  snapshot.editorial_reviews=[];
  snapshot.export_eligibility=[];
  snapshot.diagnostics=[];
  snapshot.evidence=[{evidence_id:`route-${spec.serviceId}`,source:{kind:"api_document",source_id:spec.repositoryId},
    source_version:snapshot.source.immutable_revision,location:{pointer:"/paths/~1api~1orders/get"},
    method:"type_declaration",scope:{service_id:spec.serviceId,snapshot_id:snapshot.snapshot_id,
      endpoint_id:endpoint.endpoint_id,revision:snapshot.source.immutable_revision},
    limitations:[],access_label:spec.serviceId==="invoices"?"invoice-evidence":"contract-read"},
    {evidence_id:`summary-${spec.serviceId}`,source:{kind:"api_document",source_id:spec.repositoryId},
      source_version:snapshot.source.immutable_revision,location:{pointer:"/paths/~1api~1orders/get/summary"},
      method:"type_declaration",scope:{service_id:spec.serviceId,snapshot_id:snapshot.snapshot_id,
        endpoint_id:endpoint.endpoint_id,revision:snapshot.source.immutable_revision},
      limitations:[],access_label:spec.serviceId==="invoices"?"invoice-evidence":"contract-read"}];
  snapshot.claims=[{claim_id:`route-claim-${spec.serviceId}`,subject:{service_id:spec.serviceId,endpoint_id:endpoint.endpoint_id},
    predicate:"route.declaration",value:{method:"GET",path:endpoint.application_path},verification:"declared",
    evidence_ids:[`route-${spec.serviceId}`]},
    {claim_id:`summary-claim-${spec.serviceId}`,subject:{service_id:spec.serviceId,endpoint_id:endpoint.endpoint_id},
      predicate:"operation.summary",value:`Read ${spec.label} by identifier.`,verification:"declared",
      evidence_ids:[`summary-${spec.serviceId}`]}];
  return snapshot;
};

const seedScope=async(scopeId:string,granted=true)=>{
  await database.pool.query(`INSERT INTO ${schema()}.access_scopes(tenant_id,access_scope_id,active) VALUES($1,$2,true)`,[tenantId,scopeId]);
  if(granted)await database.pool.query(`INSERT INTO ${schema()}.principal_scope_grants(tenant_id,principal_id,access_scope_id,active)
    VALUES($1,$2,$3,true)`,[tenantId,principalId,scopeId]);
};
const seedService=async(spec:(typeof serviceSpecs)[number],index:number,oversized=false)=>{
  const snapshot=await documentSnapshot(spec);
  const parsed=parseContractSnapshot(snapshot);
  if(!parsed.ok)throw new Error(JSON.stringify(parsed.error));
  await database.pool.query(`INSERT INTO ${schema()}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,
      identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'success',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
  [tenantId,snapshot.snapshot_id,spec.repositoryId,spec.serviceId,snapshot.source.immutable_revision,
    snapshot.ir_version,snapshot.identity_version,fingerprint,snapshotIdentitySha256(snapshot),
    snapshotContentSha256(snapshot),["contract-read"],JSON.stringify(oversized?{
      ...snapshot,diagnostics:[{diagnostic_id:"oversized",message:"x".repeat(4*1024*1024)}],
    }:snapshot)]);
  const attempt=`attempt-${spec.serviceId}`,serving=`serving-${spec.serviceId}`,artifact=`artifact-${spec.serviceId}`;
  for(const eventId of [attempt,serving])await database.pool.query(`INSERT INTO ${schema()}.orchestration_events
    (tenant_id,producer_id,event_id,event_sha256,event_type,repository_id,service_ids,document,
      adapter_version,provider,provider_reference,active_config_fingerprint)
    VALUES($1,'deploy',$2,$3,'deployment.changed',$4,ARRAY[$5],$6,'1','test',$2,$7)`,
  [tenantId,eventId,`sha256:${String(index+1).repeat(64)}`,spec.repositoryId,spec.serviceId,"{}",fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_serving_observations
    (tenant_id,producer_id,event_id,repository_id,service_id,environment,observation_id,
      source_authority_id,source_access_label,effective_order,completeness,serving_status,inventory,
      active_config_fingerprint,disposition)
    VALUES($1,'deploy',$2,$3,$4,$5,$2,'inventory','source-read','1','complete','known',$6,$7,'applied')`,
  [tenantId,serving,spec.repositoryId,spec.serviceId,environment,
    JSON.stringify([{artifact_id:artifact,revision:{state:"known",revision:snapshot.source.immutable_revision}}]),fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_serving_checkpoints
    (tenant_id,repository_id,service_id,environment,current_producer_id,current_event_id,version)
    VALUES($1,$2,$3,$4,'deploy',$5,$6)`,
  [tenantId,spec.repositoryId,spec.serviceId,environment,serving,index+7]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_deployment_attempts
    (tenant_id,producer_id,event_id,repository_id,service_id,environment,deployment_id,attempt_state,
      effective_order,artifact_id,revision_state,revision,active_config_fingerprint)
    VALUES($1,'deploy',$2,$3,$4,$5,$2,'succeeded','1',$6,'known',$7,$8)`,
  [tenantId,attempt,spec.repositoryId,spec.serviceId,environment,artifact,snapshot.source.immutable_revision,fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.environment_artifact_bindings
    (tenant_id,repository_id,service_id,artifact_id,revision,first_producer_id,first_event_id)
    VALUES($1,$2,$3,$4,$5,'deploy',$6)`,
  [tenantId,spec.repositoryId,spec.serviceId,artifact,snapshot.source.immutable_revision,attempt]);
};

const setup=async(extraServices=0,oversizedServiceId?:string,oversizedConfiguration=false)=>{
  database=await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool,{schema:database.schema});
  await applyEnvironmentMigrations(database.pool,{schema:database.schema});
  for(const scope of ["deployment-read","source-read","contract-read","invoice-evidence",
    ...serviceSpecs.map(spec=>spec.scope)])
    await seedScope(scope,scope!=="secrets-repo");
  const document:InstallationConfig={config_version:"1.0.0",access_scopes:["deployment-read","source-read","contract-read","invoice-evidence",
    ...serviceSpecs.map(spec=>spec.scope)].map(access_scope_id=>({access_scope_id,label:access_scope_id})),
    repositories:serviceSpecs.map(spec=>({repository_id:spec.repositoryId,provider:"github",
      locator:`example/${spec.repositoryId}`,access_scope_id:spec.scope,services:[{service_id:spec.serviceId,
        root:`services/${spec.serviceId}`,analyzer:{adapter_id:"typescript",adapter_version:"1"},
        intended_branches:["main"],environments:[{name:environment,intended_branch:"main",
          deployment_authority:{adapter_id:"deploy",access_scope_id:"deployment-read"}}]}]})),
    inference:{enabled:false},logs:{enabled:false}};
  const template=document.repositories[0]!.services[0]!;
  for(let index=0;index<extraServices;index++)document.repositories[0]!.services.push({
    ...structuredClone(template),service_id:`synthetic-${String(index).padStart(3,"0")}`,
    root:`services/synthetic-${index}`});
  await database.pool.query(`INSERT INTO ${schema()}.orchestration_configurations
    (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES($1,$2,'1.0.0',$3,$4,'admin')`,
  [tenantId,fingerprint,canonicalOrchestrationHash(document),JSON.stringify(oversizedConfiguration
    ?{...document,oversized_test_value:"x".repeat(4*1024*1024)}:document)]);
  await database.pool.query(`INSERT INTO ${schema()}.orchestration_active_configurations
    (tenant_id,config_fingerprint,checkpoint_version) VALUES($1,$2,1)`,[tenantId,fingerprint]);
  for(let index=0;index<serviceSpecs.length;index++)await seedService(serviceSpecs[index]!,index,
    serviceSpecs[index]!.serviceId===oversizedServiceId);
};
beforeEach(async()=>{await setup();});
afterEach(async()=>{await database.cleanup();});

test("returns independently pinned lexical candidates across authorized services",async()=>{
  const result=await createQueryReader(database.pool,{schema:database.schema})
    .searchOperationCandidatesAcrossServices(context(),request("stored",2));
  expect(result).toMatchObject({status:"candidates",matchMode:"keyword",scope:"visible_authorized_services",
    complete:true,truncated:false});
  if(result.status!=="candidates")throw new Error("missing candidates");
  expect(result.candidates.map(item=>[item.repositoryId,item.serviceId,item.endpointId,item.pin.checkpointVersion]))
    .toEqual([["commerce","orders","endpoint-orders","7"],["finance","invoices","endpoint-invoices","8"]]);
  expect(JSON.stringify(result)).not.toContain("secrets");
  expect(result.candidates.every(item=>item.selector.selector.kind==="environment"
    &&item.selector.selector.expectedCheckpointVersion===item.pin.checkpointVersion)).toBe(true);
});

test("no match is scoped to the complete visible authorized corpus",async()=>{
  const reader=createQueryReader(database.pool,{schema:database.schema});
  expect(await reader.searchOperationCandidatesAcrossServices(context(),request("nebula")))
    .toMatchObject({status:"no_match",scope:"visible_authorized_services",matchMode:"keyword"});
  await database.pool.query(`UPDATE ${schema()}.environment_serving_checkpoints SET reconciliation_required=true
    WHERE tenant_id=$1 AND repository_id='finance'`,[tenantId]);
  expect(await reader.searchOperationCandidatesAcrossServices(context(),request("nebula")))
    .toMatchObject({status:"unknown",reason:"incomplete_scan"});
});

test("revoked endpoint evidence scope omits that service without identifiers or counts",async()=>{
  await database.pool.query(`UPDATE ${schema()}.principal_scope_grants SET active=false
    WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id='invoice-evidence'`,[tenantId,principalId]);
  const result=await createQueryReader(database.pool,{schema:database.schema})
    .searchOperationCandidatesAcrossServices(context(),request("stored"));
  expect(result).toMatchObject({status:"candidates",complete:true,truncated:false});
  if(result.status!=="candidates")throw new Error("missing candidate");
  expect(result.candidates.map(item=>item.serviceId)).toEqual(["orders"]);
  expect(JSON.stringify(result)).not.toContain("invoices");
  expect(JSON.stringify(result)).not.toContain("secrets");
});

test("authorized service cap marks lexical candidates incomplete",async()=>{
  await database.cleanup();
  await setup(19);
  const result=await createQueryReader(database.pool,{schema:database.schema})
    .searchOperationCandidatesAcrossServices(context(),request("stored"));
  expect(result).toMatchObject({status:"candidates",complete:false,incompleteReason:"scan_limit"});
  if(result.status!=="candidates")throw new Error("missing candidate");
  expect(result.candidates.map(item=>item.serviceId)).toEqual(["orders"]);
  expect(JSON.stringify(result)).not.toContain("invoices");
  expect(JSON.stringify(result)).not.toContain("secrets");
});

test("corpus query timeout is tightened before each nested database query",async()=>{
  const timeouts:number[]=[];
  const pool={connect:async()=>{
    const client=await database.pool.connect();
    const rawQuery=client.query.bind(client);
    const wrapped=new Proxy(client,{get(target,property){
      if(property==="query")return async(...args:unknown[])=>{
        const [sql,values]=args;
        if(typeof sql==="string"&&sql.includes("set_config('statement_timeout'"))
          timeouts.push(Number.parseInt(String((values as unknown[]|undefined)?.[0]??"0"),10));
        else if(typeof sql==="string"&&/^SELECT active\.config_fingerprint/.test(sql))
          await new Promise(resolve=>setTimeout(resolve,15));
        return (rawQuery as (...queryArgs:unknown[])=>Promise<unknown>)(...args);
      };
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?value.bind(target):value;
    }});
    return wrapped;
  }};
  const result=await createQueryReader(pool as never,{schema:database.schema})
    .searchOperationCandidatesAcrossServices(context(),request("stored"));
  expect(result.status).toBe("candidates");
  expect(timeouts.length).toBeGreaterThan(10);
  expect(timeouts.every((timeout,index)=>index===0||timeout<=timeouts[index-1]!)).toBe(true);
  expect(timeouts.at(-1)).toBeLessThan(timeouts[0]!);
});

test("corpus search reads and validates the active configuration only once per transaction",async()=>{
  let activeConfigurationReads=0;
  const pool={connect:async()=>{
    const client=await database.pool.connect();
    const rawQuery=client.query.bind(client);
    return new Proxy(client,{get(target,property){
      if(property==="query")return async(...args:unknown[])=>{
        if(typeof args[0]==="string"&&args[0].includes("FROM orchestration_active_configurations active"))
          activeConfigurationReads++;
        return (rawQuery as (...queryArgs:unknown[])=>Promise<unknown>)(...args);
      };
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?value.bind(target):value;
    }});
  }};
  const result=await createQueryReader(pool as never,{schema:database.schema})
    .searchOperationCandidatesAcrossServices(context(),request("stored"));
  expect(result.status).toBe("candidates");
  expect(activeConfigurationReads).toBe(1);
});

test("an oversized authorized snapshot returns a generic scan limit without materializing its document",async()=>{
  await database.cleanup();
  await setup(0,"orders");
  const omittedOversizedDocument:boolean[]=[];
  const pool={connect:async()=>{
    const client=await database.pool.connect();
    const rawQuery=client.query.bind(client);
    return new Proxy(client,{get(target,property){
      if(property==="query")return async(...args:unknown[])=>{
        const result=await (rawQuery as (...queryArgs:unknown[])=>Promise<{rows?:unknown[]} >)(...args);
        if(typeof args[0]==="string"&&args[0].includes("FROM catalog_snapshots snapshot")){
          const row=result.rows?.[0] as {document?:unknown;document_bytes?:string}|undefined;
          if(row?.document_bytes!==undefined)omittedOversizedDocument.push(row.document===null
            &&Number(row.document_bytes)>4*1024*1024);
        }
        return result;
      };
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?value.bind(target):value;
    }});
  }};
  const result=await createQueryReader(pool as never,{schema:database.schema})
    .searchOperationCandidatesAcrossServices(context(),request("stored"));
  expect(result).toMatchObject({status:"unknown",reason:"scan_limit"});
  expect(JSON.stringify(result)).not.toContain("xxxxx");
  expect(omittedOversizedDocument).toEqual([true]);
});

test("an oversized active configuration is rejected before its document reaches the reader",async()=>{
  await database.cleanup();
  await setup(0,undefined,true);
  const rows:unknown[]=[];
  const pool={connect:async()=>{
    const client=await database.pool.connect();
    const rawQuery=client.query.bind(client);
    return new Proxy(client,{get(target,property){
      if(property==="query")return async(...args:unknown[])=>{
        const result=await (rawQuery as (...queryArgs:unknown[])=>Promise<{rows?:unknown[]} >)(...args);
        if(typeof args[0]==="string"&&args[0].includes("FROM orchestration_active_configurations active"))
          rows.push((result.rows?.[0] as {document?:unknown;document_bytes?:string}|undefined));
        return result;
      };
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?value.bind(target):value;
    }});
  }};
  const result=await createQueryReader(pool as never,{schema:database.schema})
    .searchOperationCandidatesAcrossServices(context(),request("stored"));
  expect(result).toMatchObject({status:"unknown",reason:"scan_limit"});
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({document:null});
  expect(Number((rows[0] as {document_bytes:string}).document_bytes)).toBeGreaterThan(4*1024*1024);
});

test("invalid and hostile requests fail before acquiring a database connection",async()=>{
  const reader=createQueryReader({connect:()=>{throw new Error("database touched");}} as never,{schema:database.schema});
  for(const input of [null,{tenantId,environment,intentQuery:"x",limit:0},
    {tenantId,environment,intentQuery:"secret=canary"},{tenantId,environment,intentQuery:"orders",extra:true},
    Object.defineProperty({tenantId,environment},"intentQuery",{get(){throw new Error("getter touched");},enumerable:true})]){
    await expect(reader.searchOperationCandidatesAcrossServices(context(),input))
      .rejects.toMatchObject({code:"INVALID_QUERY_SEARCH"});
  }
});
