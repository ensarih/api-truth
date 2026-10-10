import {readFile} from "node:fs/promises";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import type {PoolClient} from "pg";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations,createEnvironmentRepository} from "../../packages/environment/src/index.js";
import {type ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyObservationMigrations} from "../../packages/observations/src/migrations.js";
import {createFieldPresenceImportStore,type FieldPresenceImportManager,type FieldPresenceImportReadPort} from "../../packages/observations/src/field-presence-import-store.js";
import {createFieldPresenceQueryStore,type FieldPresenceQueryManager} from "../../packages/observations/src/field-presence-query-store.js";
import {applyOrchestrationMigrations,createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";

const tenantId="tenant-field-query",principalId="presence-reader",repositoryId="commerce",serviceId="orders",environment="prod";
const policyId="order-fields",ownerAccessScopeId="owner-policy-read",importAccessScopeId="presence-import",readAccessScopeId="presence-read";
const importId="550e8400-e29b-4d4a-a716-446655440000",recordId="550e8400-e29b-4d4a-a716-446655440001";
const importCredential=Object.freeze({opaque:"import-secret"}),readCredential=Object.freeze({opaque:"read-secret"});
const scopes=["repository-read","deployment-read","contract-read","source-read",ownerAccessScopeId,importAccessScopeId,readAccessScopeId];
const context={tenantId,principalId};
let database:CatalogTestDatabase,snapshot:ContractSnapshot,pin:{snapshotId:string;revision:string;configFingerprint:string;checkpointVersion:string};
let sourceWindowStart:string,sourceWindowEnd:string;
const schema=()=>quoteCatalogTestSchema(database.schema);
const event=(eventId:string,payload:unknown)=>({event_version:"1.0.0",event_id:eventId,event_type:"deployment.changed",
  producer:{producer_id:"deploy",adapter_version:"1"},occurred_at:"2026-10-09T00:00:00.000Z",received_at:"2026-10-09T00:00:01.000Z",
  subjects:{repository_id:repositoryId,service_ids:[serviceId],environment},provider_evidence:{provider:"deploy",provider_reference:eventId},payload});
const configFor=(configFingerprint:string)=>({config_version:"1.0.0",access_scopes:scopes.map(access_scope_id=>({access_scope_id,label:access_scope_id})),
  repositories:[{repository_id:repositoryId,provider:"github",locator:"acme/commerce",access_scope_id:scopes[0],services:[{
    service_id:serviceId,root:"services/orders",analyzer:{adapter_id:"typescript",adapter_version:"1"},intended_branches:["main"],
    environments:[{name:environment,intended_branch:"main",deployment_authority:{adapter_id:"deploy",access_scope_id:scopes[1]}}]}]}],
  inference:{enabled:false},logs:{enabled:true,adapter_id:"gateway-log",credential:{secret_ref:{scheme:"env",locator:"GATEWAY_TOKEN"}}}});
const configuredPolicy=(configFingerprint:string)=>({version:"field-presence-storage-1",policyId,ownerPolicyRevision:"1",optIn:true,
  tenantId,repositoryId,serviceId,environment,configFingerprint,configActivationCheckpoint:"1",endpointId:"ep-create",direction:"request" as const,
  mediaType:"application/json",propertyPaths:["/id"],ttlSeconds:3600,maxLiveRecords:5});
const binding=()=>({tenantId,repositoryId,serviceId,environment,policyId,ownerAccessScopeId,importAccessScopeId});
const queryBinding=()=>({tenantId,repositoryId,serviceId,environment,policyId,ownerAccessScopeId,readAccessScopeId});
const request=(limit=100)=>({policyId,ownerPolicyRevision:"1",expectedPin:{tenantId,repositoryId,serviceId,environment,...pin},limit});
const importIdentity:FieldPresenceImportManager=(credential)=>credential===importCredential
  ?Promise.resolve({tenantId,principalId,capabilities:["observations.presence.import"]}):Promise.resolve(undefined);
const readIdentity:FieldPresenceQueryManager=(credential)=>credential===readCredential
  ?Promise.resolve({tenantId,principalId,capabilities:["observations.presence.read"]}):Promise.resolve(undefined);
const validBody=()=>({attestation:{tenantId,repositoryId,serviceId,environment,snapshotId:snapshot.snapshot_id,
  revision:snapshot.source.immutable_revision,sourceDigest:snapshot.source.source_digest,configFingerprint:snapshot.config.config_fingerprint,
  checkpointVersion:pin.checkpointVersion,importId,recordId,endpointId:"ep-create",direction:"request",mediaType:"application/json",
  sourceId:"gateway-log",sourceVersion:"source-7",windowStart:sourceWindowStart,windowEnd:sourceWindowEnd},
  payloadText:'{"id":"PRIVATE_CANARY"}',payloadCompleteness:"complete_unredacted"});
const store=(authorizeManager:FieldPresenceQueryManager=readIdentity)=>createFieldPresenceQueryStore(database.pool,
  {schema:database.schema,bindings:[queryBinding()],authorizeManager});

beforeEach(async()=>{
  database=await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool,{schema:database.schema});
  await applyEnvironmentMigrations(database.pool,{schema:database.schema});
  await applyOpenApiMigrations(database.pool,{schema:database.schema});
  await applyObservationMigrations(database.pool,{schema:database.schema});
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  for(const scopeId of scopes){await access.putScope({tenantId},{scopeId,active:true});await access.putGrant({tenantId},{principalId,scopeId,active:true});}
  snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  const configFingerprint="sha256:"+"c".repeat(64),sourceDigest="sha256:"+"d".repeat(64);
  snapshot.config.config_fingerprint=configFingerprint;snapshot.source.source_digest=sourceDigest;
  snapshot.endpoints.find(item=>item.endpoint_id==="ep-create")!.request_bodies[0]!.schema={type:"object",properties:{id:{type:"string"}}};
  snapshot.endpoints.find(item=>item.endpoint_id==="ep-get")!.responses[0]!.content[0]!.schema={type:"object",properties:{id:{type:"string"}}};
  const orchestration=createOrchestrationRepository(database.pool,{schema:database.schema});
  await orchestration.registerConfiguration({tenantId,principalId:"admin",capabilities:["configuration.admin"]},
    {fingerprint:configFingerprint,document:configFor(configFingerprint)});
  await orchestration.activateInitialConfiguration({tenantId,principalId:"admin",capabilities:["configuration.admin"]},{fingerprint:configFingerprint});
  await database.pool.query(`INSERT INTO ${schema()}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,identity_version,
     config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'partial',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [tenantId,snapshot.snapshot_id,repositoryId,serviceId,snapshot.source.immutable_revision,snapshot.ir_version,snapshot.identity_version,
      configFingerprint,snapshotIdentitySha256(snapshot),snapshotContentSha256(snapshot),[scopes[2]],JSON.stringify(snapshot)]);
  await orchestration.ingestEvent({tenantId,principalId:"deploy",producerId:"deploy",allowedEventTypes:["deployment.changed"],
    allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
      adapterId:"deploy",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]},
    event("query-attempt",{change_kind:"attempt",deployment_id:"query-attempt",environment,attempt_state:"succeeded",
      effective_order:"1",artifact_id:"artifact-query",revision:{state:"known",revision:snapshot.source.immutable_revision}}));
  const envRepo=createEnvironmentRepository(database.pool,{schema:database.schema});
  const worker={workerId:"environment-worker",instanceId:"presence-query-test",capabilities:["jobs.execute"]};
  await envRepo.recordAttempt(worker,{tenantId,producerId:"deploy",eventId:"query-attempt"});
  await orchestration.ingestEvent({tenantId,principalId:"deploy",producerId:"deploy",allowedEventTypes:["deployment.changed"],
    allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
      adapterId:"deploy",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]},
    event("query-serving",{change_kind:"serving_observation",observation_id:"query-serving",environment,
      source:{authority_id:"inventory",reference:"query-serving",access_label:scopes[3]},completeness:"complete",effective_order:"1",
      serving_state:{status:"known",inventory:[{artifact_id:"artifact-query",revision:{state:"known",revision:snapshot.source.immutable_revision}}]}}));
  await envRepo.recordServingObservation(worker,{tenantId,producerId:"deploy",eventId:"query-serving"});
  const selected=await createQueryReader(database.pool,{schema:database.schema}).readContract(context,
    {version:"1",tenantId,repositoryId,serviceId,selector:{kind:"environment",environment}});
  if(selected.status!=="resolved")throw new Error("Expected pinned field presence query snapshot");
  pin={snapshotId:selected.pin.snapshotId,revision:selected.pin.revision,configFingerprint:selected.pin.configFingerprint,
    checkpointVersion:selected.pin.checkpointVersion!};
  const compiled=(await import("../../packages/observations/src/field-presence-storage-policy.js"))
    .compileFieldPresenceStoragePolicy(configuredPolicy(snapshot.config.config_fingerprint));
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_policy_revisions
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,config_fingerprint,
     config_activation_checkpoint,endpoint_id,direction,media_type,status_code,property_paths,ttl_seconds,max_live_records,owner_access_scope_id)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,1,'ep-create','request','application/json',NULL,ARRAY['/id'],3600,5,$8)`,
    [tenantId,repositoryId,serviceId,environment,policyId,compiled.fingerprint,snapshot.config.config_fingerprint,ownerAccessScopeId]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_policy_heads
    (tenant_id,repository_id,service_id,environment,policy_id,current_owner_policy_revision,current_policy_fingerprint,enabled)
    VALUES($1,$2,$3,$4,$5,1,$6,true)`,[tenantId,repositoryId,serviceId,environment,policyId,compiled.fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'gateway-log','source-7',
      date_trunc('milliseconds',clock_timestamp()-interval '20 seconds'),date_trunc('milliseconds',clock_timestamp()-interval '10 seconds'),
      'metadata-only-1','[]'::jsonb)`,[tenantId,repositoryId,serviceId,environment,importId,snapshot.snapshot_id,
      snapshot.source.immutable_revision,snapshot.config.config_fingerprint,pin.checkpointVersion]);
  const times=await database.pool.query<{start:Date;end:Date}>(`SELECT window_start AS start,window_end AS end FROM ${schema()}.observation_imports WHERE import_id=$1`,[importId]);
  sourceWindowStart=times.rows[0]!.start.toISOString();sourceWindowEnd=times.rows[0]!.end.toISOString();
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-1','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,importId,recordId]);
  const sourceRead:FieldPresenceImportReadPort=async()=>validBody();
  await createFieldPresenceImportStore(database.pool,{schema:database.schema,bindings:[binding()],authorizeManager:importIdentity,
    readObservation:sourceRead}).importObservation(importCredential,{policyId,ownerPolicyRevision:"1",importId,recordId,
      expectedPin:{tenantId,repositoryId,serviceId,environment,...pin}});
});
afterEach(async()=>{await database.cleanup();});

test("reads only current authorized value-free field states",async()=>{
  const before=await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`);
  const result=await store().read(readCredential,request());
  expect(result).toMatchObject({status:"resolved",pin,policy:{policyId,ownerPolicyRevision:"1",endpointId:"ep-create",propertyPaths:["/id"]},
    records:[{importId,recordId,scope:{sourceDigest:snapshot.source.source_digest},fields:[{path:"/id",state:"present"}]}],truncated:false});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  const after=await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`);
  expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
});

test("unauthorized read fails before database access",async()=>{
  const connect=vi.spyOn(database.pool,"connect");
  await expect(store(async()=>undefined).read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
  expect(connect).not.toHaveBeenCalled();connect.mockRestore();
});

test("invalid and hostile requests fail before authorization or database access",async()=>{
  const connect=vi.spyOn(database.pool,"connect"),authorize=vi.fn(readIdentity),repository=store(authorize);
  for(const input of [{...request(),limit:0},{...request(),limit:101},{...request(),unexpected:true},
    {...request(),expectedPin:{...request().expectedPin,selectedRevision:"revision-qualified"}},
    {...request(),expectedPin:{...request().expectedPin,pointerVersion:"3"}},
    new Proxy(request(),{ownKeys(){throw new Error("trap");}})])
    await expect(repository.read(readCredential,input)).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_INVALID_REQUEST"});
  expect(authorize).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();connect.mockRestore();
});

test("revoked reader or owner scope denies the read",async()=>{
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  await access.putGrant({tenantId},{principalId,scopeId:readAccessScopeId,active:false});
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
  await access.putGrant({tenantId},{principalId,scopeId:readAccessScopeId,active:true});
  await access.putGrant({tenantId},{principalId,scopeId:ownerAccessScopeId,active:false});
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
});

test("read authorization holds scope-grant locks until the value-free result commits",async()=>{
  let reach!:()=>void,release!:()=>void;
  const atPresenceRead=new Promise<void>(resolve=>{reach=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  const originalConnect=database.pool.connect.bind(database.pool);
  const patchedClients:Array<{client:PoolClient;query:PoolClient["query"]}>=[];
  const connectSpy=vi.spyOn(database.pool,"connect").mockImplementation(async()=>{
    const client=await originalConnect(),originalQuery=client.query;
    patchedClients.push({client,query:originalQuery});
    client.query=((...args:unknown[])=>{
      const first=args[0];const text=typeof first==="string"?first:typeof first==="object"&&first!==null&&"text" in first?String((first as {text:unknown}).text):"";
      if(text.includes("FROM observation_field_presence_results presence")){
        reach();return resume.then(()=>originalQuery.apply(client,args as never));
      }
      return originalQuery.apply(client,args as never);
    }) as typeof client.query;
    return client;
  });
  let pending:Promise<unknown>|undefined;
  try{
    pending=store().read(readCredential,request());
    await Promise.race([atPresenceRead,pending.then(()=>{throw new Error("Read completed before the presence query gate");})]);
    const contender=await originalConnect();
    let inTransaction=false;
    try{
      await contender.query("BEGIN");inTransaction=true;
      await expect(contender.query(`SELECT access_scope_id FROM ${schema()}.principal_scope_grants
        WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=$3 FOR UPDATE NOWAIT`,
        [tenantId,principalId,readAccessScopeId])).rejects.toMatchObject({code:"55P03"});
    }finally{if(inTransaction)await contender.query("ROLLBACK").catch(()=>undefined);contender.release();}
    release();await expect(pending).resolves.toMatchObject({status:"resolved"});
  }finally{
    release();if(pending)await pending.catch(()=>undefined);
    for(const patched of patchedClients)patched.client.query=patched.query;
    connectSpy.mockRestore();
  }
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  await access.putGrant({tenantId},{principalId,scopeId:readAccessScopeId,active:false});
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
});

test("a replaced policy generation never returns rows from its predecessor",async()=>{
  const nextPolicy=(await import("../../packages/observations/src/field-presence-storage-policy.js"))
    .compileFieldPresenceStoragePolicy({...configuredPolicy(snapshot.config.config_fingerprint),ownerPolicyRevision:"2",maxLiveRecords:6});
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_policy_revisions
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,config_fingerprint,
     config_activation_checkpoint,endpoint_id,direction,media_type,status_code,property_paths,ttl_seconds,max_live_records,owner_access_scope_id)
    VALUES($1,$2,$3,$4,$5,2,$6,$7,1,'ep-create','request','application/json',NULL,ARRAY['/id'],3600,6,$8)`,
    [tenantId,repositoryId,serviceId,environment,policyId,nextPolicy.fingerprint,snapshot.config.config_fingerprint,ownerAccessScopeId]);
  await database.pool.query(`UPDATE ${schema()}.observation_field_presence_policy_heads SET current_owner_policy_revision=2,
    current_policy_fingerprint=$1 WHERE tenant_id=$2 AND policy_id=$3`,[nextPolicy.fingerprint,tenantId,policyId]);
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STALE"});
  const current=await store().read(readCredential,{...request(),ownerPolicyRevision:"2"});
  expect(current.records).toEqual([]);
});

test("a disabled policy stops exposing its current records",async()=>{
  await database.pool.query(`UPDATE ${schema()}.observation_field_presence_policy_heads SET enabled=false`);
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STALE"});
});

test("a changed active checkpoint invalidates the requested pin",async()=>{
  await database.pool.query(`UPDATE ${schema()}.orchestration_active_configurations
    SET checkpoint_version=checkpoint_version+1 WHERE tenant_id=$1`,[tenantId]);
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STALE"});
});

test("serving checkpoint is distinct from the configuration activation epoch",async()=>{
  const priorPin={...pin};
  await database.pool.query(`UPDATE ${schema()}.environment_serving_checkpoints SET version=version+1
    WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,[tenantId,repositoryId,serviceId,environment]);
  const selected=await createQueryReader(database.pool,{schema:database.schema}).readContract(context,
    {version:"1",tenantId,repositoryId,serviceId,selector:{kind:"environment",environment}});
  expect(selected.status).toBe("resolved");if(selected.status!=="resolved")return;
  pin={snapshotId:selected.pin.snapshotId,revision:selected.pin.revision,configFingerprint:selected.pin.configFingerprint,
    checkpointVersion:selected.pin.checkpointVersion!};
  const epoch=await database.pool.query<{checkpoint_version:string}>(`SELECT checkpoint_version::text FROM ${schema()}.orchestration_active_configurations
    WHERE tenant_id=$1`,[tenantId]);
  expect(epoch.rows[0]?.checkpoint_version).toBe("1");expect(pin.checkpointVersion).toBe("2");
  await expect(store().read(readCredential,{...request(),expectedPin:{...request().expectedPin,checkpointVersion:priorPin.checkpointVersion}}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STALE"});
  const newerImport="550e8400-e29b-4d4a-a716-446655440008",newerRecord="550e8400-e29b-4d4a-a716-446655440009";
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'gateway-log','source-current',
      date_trunc('milliseconds',clock_timestamp()-interval '20 seconds'),date_trunc('milliseconds',clock_timestamp()-interval '10 seconds'),
      'metadata-only-1','[]'::jsonb)`,[tenantId,repositoryId,serviceId,environment,newerImport,pin.snapshotId,pin.revision,
      pin.configFingerprint,pin.checkpointVersion]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-current','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,newerImport,newerRecord]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_results
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,source_digest,presence_fields)
    SELECT tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,$1,$2,source_digest,presence_fields
    FROM ${schema()}.observation_field_presence_results WHERE tenant_id=$3 AND policy_id=$4 AND import_id=$5::uuid`,
    [newerImport,newerRecord,tenantId,policyId,importId]);
  await expect(store().read(readCredential,request())).resolves.toMatchObject({status:"resolved",pin,
    records:[{importId:newerImport,recordId:newerRecord}]});
});

test("a changed configuration fingerprint cannot read pinned presence",async()=>{
  await expect(store().read(readCredential,{...request(),expectedPin:{...request().expectedPin,
    configFingerprint:"sha256:"+"e".repeat(64)}})).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STALE"});
});

test("a request bound to another configured scope cannot see this policy",async()=>{
  await expect(store().read(readCredential,{...request(),expectedPin:{...request().expectedPin,tenantId:"other-tenant"}}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
});

test("repeated rows are bounded and report truncation",async()=>{
  const secondImport="550e8400-e29b-4d4a-a716-446655440002",secondRecord="550e8400-e29b-4d4a-a716-446655440003";
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    SELECT tenant_id,repository_id,service_id,environment,$2,snapshot_id,revision,config_fingerprint,checkpoint_version,
      source_id,source_version,window_start,window_end,policy_version,safe_manifest FROM ${schema()}.observation_imports WHERE import_id=$1`,[importId,secondImport]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-2','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,secondImport,secondRecord]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_results
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,source_digest,presence_fields)
    SELECT tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,$2,$3,source_digest,presence_fields
    FROM ${schema()}.observation_field_presence_results WHERE import_id=$1`,[importId,secondImport,secondRecord]);
  const result=await store().read(readCredential,request(1));
  expect(result.records).toHaveLength(1);expect(result.truncated).toBe(true);
});

test("expired derived rows are not returned",async()=>{
  const expiringPolicyId="expiring-fields",expiringImportId="550e8400-e29b-4d4a-a716-446655440006";
  const expiringRecordId="550e8400-e29b-4d4a-a716-446655440007";
  const compiled=(await import("../../packages/observations/src/field-presence-storage-policy.js"))
    .compileFieldPresenceStoragePolicy({...configuredPolicy(snapshot.config.config_fingerprint),policyId:expiringPolicyId,ttlSeconds:60});
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_policy_revisions
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,config_fingerprint,
     config_activation_checkpoint,endpoint_id,direction,media_type,status_code,property_paths,ttl_seconds,max_live_records,owner_access_scope_id)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,1,'ep-create','request','application/json',NULL,ARRAY['/id'],60,5,$8)`,
    [tenantId,repositoryId,serviceId,environment,expiringPolicyId,compiled.fingerprint,snapshot.config.config_fingerprint,ownerAccessScopeId]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_policy_heads
    (tenant_id,repository_id,service_id,environment,policy_id,current_owner_policy_revision,current_policy_fingerprint,enabled)
    VALUES($1,$2,$3,$4,$5,1,$6,true)`,[tenantId,repositoryId,serviceId,environment,expiringPolicyId,compiled.fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'gateway-log','expiry-source',
      date_trunc('milliseconds',clock_timestamp()-interval '70 seconds'),
      date_trunc('milliseconds',clock_timestamp()-interval '59 seconds'),'metadata-only-1','[]'::jsonb)`,
    [tenantId,repositoryId,serviceId,environment,expiringImportId,snapshot.snapshot_id,pin.revision,pin.configFingerprint,pin.checkpointVersion]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-expiry','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,expiringImportId,expiringRecordId]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_results
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,source_digest,presence_fields)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'[{"path":"/id","state":"present"}]'::jsonb)`,
    [tenantId,repositoryId,serviceId,environment,expiringPolicyId,compiled.fingerprint,expiringImportId,expiringRecordId,snapshot.source.source_digest]);
  const live=await database.pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results
    WHERE import_id=$1::uuid AND expires_at>clock_timestamp()`,[expiringImportId]);
  expect(live.rows[0]?.count).toBe(1);
  await database.pool.query("SELECT pg_sleep(2.2)");
  const expiringStore=createFieldPresenceQueryStore(database.pool,{schema:database.schema,
    bindings:[queryBinding(),{...queryBinding(),policyId:expiringPolicyId}],authorizeManager:readIdentity});
  await expect(expiringStore.read(readCredential,{...request(),policyId:expiringPolicyId}))
    .resolves.toMatchObject({status:"resolved",records:[],truncated:false});
});

test("duplicate record identity across imports is withheld as ambiguous",async()=>{
  const secondImport="550e8400-e29b-4d4a-a716-446655440004";
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    SELECT tenant_id,repository_id,service_id,environment,$2,snapshot_id,revision,config_fingerprint,checkpoint_version,
      source_id,source_version,window_start,window_end,policy_version,safe_manifest FROM ${schema()}.observation_imports WHERE import_id=$1`,[importId,secondImport]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-2','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,secondImport,recordId]);
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_PARENT_AMBIGUOUS"});
});

test.each([
  {name:"foreign source authority",sourceId:"unconfigured-source",subMillisecond:false,recordId:"550e8400-e29b-4d4a-a716-446655440010"},
  {name:"sub-millisecond source window",sourceId:"gateway-log",subMillisecond:true,recordId:"550e8400-e29b-4d4a-a716-446655440011"},
  {name:"non-v4 record identity",sourceId:"gateway-log",subMillisecond:false,recordId:"550e8400-e29b-11d4-a716-446655440012"},
])("withholds malformed stored lineage: $name",async({sourceId,subMillisecond,recordId:invalidRecordId})=>{
  const extraImport="550e8400-e29b-4d4a-a716-446655440013";
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'source-extra',
      date_trunc('milliseconds',clock_timestamp()-interval '20 seconds') + CASE WHEN $11 THEN interval '1 microsecond' ELSE interval '0' END,
      date_trunc('milliseconds',clock_timestamp()-interval '10 seconds'),'metadata-only-1','[]'::jsonb)`,
    [tenantId,repositoryId,serviceId,environment,extraImport,pin.snapshotId,pin.revision,pin.configFingerprint,pin.checkpointVersion,sourceId,subMillisecond]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-extra','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,extraImport,invalidRecordId]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_results
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,source_digest,presence_fields)
    VALUES($1,$2,$3,$4,$5,1,(SELECT current_policy_fingerprint FROM ${schema()}.observation_field_presence_policy_heads
      WHERE tenant_id=$1 AND policy_id=$5),$6,$7,$8,'[{"path":"/id","state":"present"}]'::jsonb)`,
    [tenantId,repositoryId,serviceId,environment,policyId,extraImport,invalidRecordId,snapshot.source.source_digest]);
  await expect(store().read(readCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STORAGE_ERROR"});
});

test("response reads retain the exact configured status selector",async()=>{
  const responsePolicyId="response-fields",responseRecordId="550e8400-e29b-4d4a-a716-446655440005";
  const compiled=(await import("../../packages/observations/src/field-presence-storage-policy.js"))
    .compileFieldPresenceStoragePolicy({...configuredPolicy(snapshot.config.config_fingerprint),policyId:responsePolicyId,
      endpointId:"ep-get",direction:"response",statusCode:200});
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_policy_revisions
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,config_fingerprint,
     config_activation_checkpoint,endpoint_id,direction,media_type,status_code,property_paths,ttl_seconds,max_live_records,owner_access_scope_id)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,1,'ep-get','response','application/json',200,ARRAY['/id'],3600,5,$8)`,
    [tenantId,repositoryId,serviceId,environment,responsePolicyId,compiled.fingerprint,snapshot.config.config_fingerprint,ownerAccessScopeId]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_policy_heads
    (tenant_id,repository_id,service_id,environment,policy_id,current_owner_policy_revision,current_policy_fingerprint,enabled)
    VALUES($1,$2,$3,$4,$5,1,$6,true)`,[tenantId,repositoryId,serviceId,environment,responsePolicyId,compiled.fingerprint]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-get','mapping-response','GET',200,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,importId,responseRecordId]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_results
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,source_digest,presence_fields)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'[{"path":"/id","state":"absent"}]'::jsonb)`,
    [tenantId,repositoryId,serviceId,environment,responsePolicyId,compiled.fingerprint,importId,responseRecordId,snapshot.source.source_digest]);
  const responseBinding={...queryBinding(),policyId:responsePolicyId};
  const query=createFieldPresenceQueryStore(database.pool,{schema:database.schema,bindings:[queryBinding(),responseBinding],authorizeManager:readIdentity});
  const result=await query.read(readCredential,{...request(),policyId:responsePolicyId});
  expect(result.policy).toMatchObject({direction:"response",statusCode:200});
  expect(result.records).toMatchObject([{recordId:responseRecordId,scope:{direction:"response",statusCode:200},
    fields:[{path:"/id",state:"absent"}]}]);
});
