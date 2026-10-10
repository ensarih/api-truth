import {readFile} from "node:fs/promises";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations,createEnvironmentRepository} from "../../packages/environment/src/index.js";
import {type ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyObservationMigrations} from "../../packages/observations/src/migrations.js";
import {applyOrchestrationMigrations,createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";
import {createFieldPresenceImportStore,type FieldPresenceImportManager,type FieldPresenceImportReadPort} from "../../packages/observations/src/field-presence-import-store.js";

const tenantId="tenant-field-import",principalId="importer",repositoryId="commerce",serviceId="orders",environment="prod";
const policyId="order-fields",ownerAccessScopeId="owner-policy-read",importAccessScopeId="presence-import";
const importId="550e8400-e29b-4d4a-a716-446655440000",recordId="550e8400-e29b-4d4a-a716-446655440001";
const importCredential=Object.freeze({opaque:"import-secret"});
const scopes=["repository-read","deployment-read","contract-read","source-read",ownerAccessScopeId,importAccessScopeId];
const context={tenantId,principalId};
let database:CatalogTestDatabase,snapshot:ContractSnapshot,pin:{snapshotId:string;revision:string;configFingerprint:string;checkpointVersion:string};
let sourceWindowStart:string,sourceWindowEnd:string;
const schema=()=>quoteCatalogTestSchema(database.schema);
const event=(eventId:string,payload:unknown)=>({event_version:"1.0.0",event_id:eventId,event_type:"deployment.changed",
  producer:{producer_id:"deploy",adapter_version:"1"},occurred_at:"2026-10-09T00:00:00.000Z",received_at:"2026-10-09T00:00:01.000Z",
  subjects:{repository_id:repositoryId,service_ids:[serviceId],environment},provider_evidence:{provider:"deploy",provider_reference:eventId},payload});
const configFor=(configFingerprint:string,logsEnabled=true)=>({config_version:"1.0.0",access_scopes:scopes.map(access_scope_id=>({access_scope_id,label:access_scope_id})),
  repositories:[{repository_id:repositoryId,provider:"github",locator:"acme/commerce",access_scope_id:scopes[0],services:[{
    service_id:serviceId,root:"services/orders",analyzer:{adapter_id:"typescript",adapter_version:"1"},intended_branches:["main"],
    environments:[{name:environment,intended_branch:"main",deployment_authority:{adapter_id:"deploy",access_scope_id:scopes[1]}}]}]}],
  inference:{enabled:false},logs:{enabled:logsEnabled,adapter_id:"gateway-log",credential:{secret_ref:{scheme:"env",locator:"GATEWAY_TOKEN"}}}});
const configuredPolicy=(configFingerprint:string)=>({version:"field-presence-storage-1",policyId,ownerPolicyRevision:"1",optIn:true,
  tenantId,repositoryId,serviceId,environment,configFingerprint,configActivationCheckpoint:"1",endpointId:"ep-create",direction:"request",
  mediaType:"application/json",propertyPaths:["/id"],ttlSeconds:3600,maxLiveRecords:5});
const importBinding=()=>({tenantId,repositoryId,serviceId,environment,policyId,ownerAccessScopeId,importAccessScopeId});
const request=()=>({policyId,ownerPolicyRevision:"1",importId,recordId,expectedPin:{tenantId,repositoryId,serviceId,environment,...pin}});
const identity=(enabled=true)=>(credential:unknown,_binding:unknown,_signal:AbortSignal)=>credential===importCredential&&enabled
  ?Promise.resolve({tenantId,principalId,capabilities:["observations.presence.import"]}):Promise.resolve(undefined);
const validBody=()=>({attestation:{tenantId,repositoryId,serviceId,environment,snapshotId:snapshot.snapshot_id,
  revision:snapshot.source.immutable_revision,sourceDigest:snapshot.source.source_digest,configFingerprint:snapshot.config.config_fingerprint,
  checkpointVersion:pin.checkpointVersion,importId,recordId,endpointId:"ep-create",direction:"request",mediaType:"application/json",
  sourceId:"gateway-log",sourceVersion:"source-7",windowStart:sourceWindowStart,windowEnd:sourceWindowEnd},
  payloadText:"{\"id\":\"PRIVATE_CANARY\"}",payloadCompleteness:"complete_unredacted"});
const manager=():FieldPresenceImportManager=>identity();
const readerPort=async():Promise<unknown>=>validBody();
const store=(readObservation:FieldPresenceImportReadPort=readerPort,authorizeManager:FieldPresenceImportManager=manager())=>
  createFieldPresenceImportStore(database.pool,{schema:database.schema,bindings:[importBinding()],authorizeManager,readObservation});

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
    event("import-attempt",{change_kind:"attempt",deployment_id:"import-attempt",environment,attempt_state:"succeeded",
      effective_order:"1",artifact_id:"artifact-import",revision:{state:"known",revision:snapshot.source.immutable_revision}}));
  const envRepo=createEnvironmentRepository(database.pool,{schema:database.schema});
  const worker={workerId:"environment-worker",instanceId:"presence-import-test",capabilities:["jobs.execute"]};
  await envRepo.recordAttempt(worker,{tenantId,producerId:"deploy",eventId:"import-attempt"});
  await orchestration.ingestEvent({tenantId,principalId:"deploy",producerId:"deploy",allowedEventTypes:["deployment.changed"],
    allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
      adapterId:"deploy",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]},
    event("import-serving",{change_kind:"serving_observation",observation_id:"import-serving",environment,
      source:{authority_id:"inventory",reference:"import-serving",access_label:scopes[3]},completeness:"complete",effective_order:"1",
      serving_state:{status:"known",inventory:[{artifact_id:"artifact-import",revision:{state:"known",revision:snapshot.source.immutable_revision}}]}}));
  await envRepo.recordServingObservation(worker,{tenantId,producerId:"deploy",eventId:"import-serving"});
  const selected=await createQueryReader(database.pool,{schema:database.schema}).readContract(context,
    {version:"1",tenantId,repositoryId,serviceId,selector:{kind:"environment",environment}});
  if(selected.status!=="resolved")throw new Error("Expected pinned import test snapshot");
  pin={snapshotId:selected.pin.snapshotId,revision:selected.pin.revision,configFingerprint:selected.pin.configFingerprint,
    checkpointVersion:selected.pin.checkpointVersion!};
  const compiled=await import("../../packages/observations/src/field-presence-storage-policy.js").then(module=>
    module.compileFieldPresenceStoragePolicy(configuredPolicy(snapshot.config.config_fingerprint)));
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
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'gateway-log','source-7',date_trunc('milliseconds',$10::timestamptz),date_trunc('milliseconds',$11::timestamptz),
     'metadata-only-1','[]'::jsonb)`,[tenantId,repositoryId,serviceId,environment,importId,snapshot.snapshot_id,
      snapshot.source.immutable_revision,snapshot.config.config_fingerprint,pin.checkpointVersion,
      (await database.pool.query<{value:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()-interval '20 seconds') AS value")).rows[0]!.value,
      (await database.pool.query<{value:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()-interval '10 seconds') AS value")).rows[0]!.value]);
  const times=await database.pool.query<{start:Date;end:Date}>(`SELECT window_start AS start,window_end AS end FROM ${schema()}.observation_imports WHERE import_id=$1`,[importId]);
  sourceWindowStart=times.rows[0]!.start.toISOString();sourceWindowEnd=times.rows[0]!.end.toISOString();
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-1','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,importId,recordId]);
});
afterEach(async()=>{await database.cleanup();});

test("imports only selected field states and never persists body values",async()=>{
  const reads=vi.fn(readerPort);
  await expect(store(reads).importObservation(importCredential,request())).resolves.toMatchObject({status:"inserted",fieldCount:1});
  expect(reads).toHaveBeenCalledTimes(1);
  const rows=await database.pool.query(`SELECT source_digest,presence_fields,source_window_end,expires_at FROM ${schema()}.observation_field_presence_results`);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]?.presence_fields).toEqual([{path:"/id",state:"present"}]);
  expect(JSON.stringify(rows.rows)).not.toContain("PRIVATE_CANARY");
});

test("unauthenticated imports fail before DB connection or source read",async()=>{
  const connect=vi.spyOn(database.pool,"connect"),reads=vi.fn(readerPort);
  await expect(store(reads,async()=>undefined).importObservation(importCredential,request()))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_UNAUTHORIZED"});
  expect(connect).not.toHaveBeenCalled();expect(reads).not.toHaveBeenCalled();
  connect.mockRestore();
});

test("wrong exact source-parent attestation rejects before persistence",async()=>{
  for(const change of [
    (body:any)=>{body.attestation.tenantId="other-tenant";},
    (body:any)=>{body.attestation.importId="550e8400-e29b-4d4a-a716-446655440099";},
    (body:any)=>{body.attestation.recordId="550e8400-e29b-4d4a-a716-446655440099";},
    (body:any)=>{body.attestation.snapshotId="snapshot-other";},
    (body:any)=>{body.attestation.revision="revision-other";},
    (body:any)=>{body.attestation.configFingerprint="sha256:"+"e".repeat(64);},
    (body:any)=>{body.attestation.checkpointVersion="2";},
    (body:any)=>{body.attestation.sourceDigest="sha256:"+"e".repeat(64);},
    (body:any)=>{body.attestation.endpointId="ep-get";},
    (body:any)=>{body.attestation.direction="response";},
    (body:any)=>{body.attestation.mediaType="application/problem+json";},
    (body:any)=>{body.attestation.sourceId="other-source";},
    (body:any)=>{body.attestation.sourceVersion="source-other";},
    (body:any)=>{body.attestation.windowStart="2026-10-08T00:00:00.000Z";},
    (body:any)=>{body.attestation.windowEnd="2026-10-09T00:00:11.000Z";},
  ]){
    const read=()=>{const body=validBody();change(body);return Promise.resolve(body);};
    await expect(store(read).importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_SOURCE_INVALID"});
  }
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]?.count).toBe(0);
});

test("exact safe retries are idempotent and changed body presence conflicts",async()=>{
  const repository=store();
  await expect(repository.importObservation(importCredential,request())).resolves.toMatchObject({status:"inserted"});
  await expect(repository.importObservation(importCredential,request())).resolves.toMatchObject({status:"existing"});
  const different=store(async()=>({...validBody(),payloadText:"{}"}));
  await expect(different.importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_CONFLICT"});
});

test("duplicate record UUID across imports fails closed before source read",async()=>{
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    SELECT tenant_id,repository_id,service_id,environment,'550e8400-e29b-4d4a-a716-446655440002',snapshot_id,revision,config_fingerprint,
      checkpoint_version,source_id,source_version,window_start,window_end,policy_version,safe_manifest FROM ${schema()}.observation_imports WHERE import_id=$1`,[importId]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,'550e8400-e29b-4d4a-a716-446655440002',$5,'confirmed','ep-create','mapping-1','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,recordId]);
  const read=vi.fn(readerPort);
  await expect(store(read).importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_PARENT_INVALID"});
  expect(read).not.toHaveBeenCalled();
});

test("infinite and sub-millisecond source windows are rejected before body access",async()=>{
  const malformedImport="550e8400-e29b-4d4a-a716-446655440004",malformedRecord="550e8400-e29b-4d4a-a716-446655440005";
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'gateway-log','source-7','infinity','infinity','metadata-only-1','[]'::jsonb)`,
    [tenantId,repositoryId,serviceId,environment,malformedImport,snapshot.snapshot_id,snapshot.source.immutable_revision,
      snapshot.config.config_fingerprint,pin.checkpointVersion]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-3','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,malformedImport,malformedRecord]);
  const read=vi.fn(readerPort);
  await expect(store(read).importObservation(importCredential,{...request(),importId:malformedImport,recordId:malformedRecord}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_PARENT_INVALID"});
  expect(read).not.toHaveBeenCalled();
  const preciseImport="550e8400-e29b-4d4a-a716-446655440006",preciseRecord="550e8400-e29b-4d4a-a716-446655440007";
  await database.pool.query(`INSERT INTO ${schema()}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'gateway-log','source-7',
      date_trunc('milliseconds',clock_timestamp()-interval '20 seconds')+interval '1 microsecond',
      date_trunc('milliseconds',clock_timestamp()-interval '10 seconds'),'metadata-only-1','[]'::jsonb)`,
    [tenantId,repositoryId,serviceId,environment,preciseImport,snapshot.snapshot_id,snapshot.source.immutable_revision,
      snapshot.config.config_fingerprint,pin.checkpointVersion]);
  await database.pool.query(`INSERT INTO ${schema()}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-4','POST',201,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,preciseImport,preciseRecord]);
  await expect(store(read).importObservation(importCredential,{...request(),importId:preciseImport,recordId:preciseRecord}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_PARENT_INVALID"});
  expect(read).not.toHaveBeenCalled();
});

test("a policy disable during source read prevents insertion",async()=>{
  let repository!:ReturnType<typeof store>;
  const read=async()=>{
    await database.pool.query(`UPDATE ${schema()}.observation_field_presence_policy_heads SET enabled=false`);
    return validBody();
  };
  repository=store(read);
  await expect(repository.importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_STALE"});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]?.count).toBe(0);
});


test("response source records require and preserve the exact selected status",async()=>{
  const responsePolicyId="customer-response",responseRecordId="550e8400-e29b-4d4a-a716-446655440003";
  const responsePolicy={...configuredPolicy(snapshot.config.config_fingerprint),policyId:responsePolicyId,endpointId:"ep-get",
    direction:"response" as const,statusCode:200};
  const compiled=(await import("../../packages/observations/src/field-presence-storage-policy.js"))
    .compileFieldPresenceStoragePolicy(responsePolicy);
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
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-get','mapping-2','GET',200,'metadata_only','metadata-only-1')`,
    [tenantId,repositoryId,serviceId,environment,importId,responseRecordId]);
  const binding={...importBinding(),policyId:responsePolicyId};
  const responseRead:FieldPresenceImportReadPort=async(_identity,sourceRequest)=>({attestation:{tenantId,repositoryId,serviceId,environment,
    snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,sourceDigest:snapshot.source.source_digest,
    configFingerprint:snapshot.config.config_fingerprint,checkpointVersion:pin.checkpointVersion,importId,recordId:responseRecordId,
    endpointId:"ep-get",direction:"response",mediaType:"application/json",statusCode:200,sourceId:"gateway-log",sourceVersion:"source-7",
    windowStart:sourceWindowStart,windowEnd:sourceWindowEnd},payloadText:'{"id":"PRIVATE_CANARY"}',payloadCompleteness:"complete_unredacted"});
  const responseStore=createFieldPresenceImportStore(database.pool,{schema:database.schema,bindings:[binding],authorizeManager:manager(),readObservation:responseRead});
  await expect(responseStore.importObservation(importCredential,{...request(),policyId:responsePolicyId,recordId:responseRecordId}))
    .resolves.toMatchObject({status:"inserted",fieldCount:1});
  const wrongStatus=createFieldPresenceImportStore(database.pool,{schema:database.schema,bindings:[binding],authorizeManager:manager(),
    readObservation:async(...args)=>{const result=await responseRead(...args) as {attestation:Record<string,unknown>};
      return {...result,attestation:{...result.attestation,statusCode:201}};}});
  await expect(wrongStatus.importObservation(importCredential,{...request(),policyId:responsePolicyId,recordId:responseRecordId}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_SOURCE_INVALID"});
});

test("revoking the import grant during body read prevents persistence",async()=>{
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  const read=async()=>{await access.putGrant({tenantId},{principalId,scopeId:importAccessScopeId,active:false});return validBody();};
  await expect(store(read).importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_UNAUTHORIZED"});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]?.count).toBe(0);
});

test("advancing the active configuration checkpoint during body read prevents persistence",async()=>{
  const orchestration=createOrchestrationRepository(database.pool,{schema:database.schema});
  const nextFingerprint="sha256:"+"e".repeat(64);
  const read=async()=>{
    await orchestration.registerConfiguration({tenantId,principalId:"admin",capabilities:["configuration.admin"]},
      {fingerprint:nextFingerprint,document:configFor(nextFingerprint)});
    await orchestration.activateConfigurationByCas({tenantId,principalId:"admin",capabilities:["configuration.admin"]},
      {fingerprint:nextFingerprint,expectedCheckpointVersion:"1",providerEvidence:{provider:"control-plane",provider_reference:"presence-import-config-change"}});
    return validBody();
  };
  await expect(store(read).importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_STALE"});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]?.count).toBe(0);
});

test("final manager authorization is required after body read",async()=>{
  let calls=0;
  const authorizer:FieldPresenceImportManager=async()=>{
    calls++;
    return calls===1?{tenantId,principalId,capabilities:["observations.presence.import"]}:undefined;
  };
  const read=vi.fn(readerPort);
  await expect(store(read,authorizer).importObservation(importCredential,request()))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_UNAUTHORIZED"});
  expect(calls).toBe(2);expect(read).toHaveBeenCalledTimes(1);
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]?.count).toBe(0);
});

test("source read deadline aborts and ignores a late body result",async()=>{
  let signal!:AbortSignal;
  const read:FieldPresenceImportReadPort=async(_identity,_request,sourceSignal)=>{
    signal=sourceSignal;
    return new Promise(resolve=>setTimeout(()=>resolve(validBody()),10_500));
  };
  await expect(store(read).importObservation(importCredential,request()))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_SOURCE_INVALID"});
  expect(signal.aborted).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,600));
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]?.count).toBe(0);
});

test("a full policy budget reached during source read blocks the final insert",async()=>{
  let sourceWriteError:unknown;
  const read=async()=>{
    try {
    const fingerprint=(await database.pool.query<{policy_fingerprint:string}>(`SELECT current_policy_fingerprint AS policy_fingerprint FROM ${schema()}.observation_field_presence_policy_heads
      WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4 AND policy_id=$5`,
      [tenantId,repositoryId,serviceId,environment,policyId])).rows[0]!.policy_fingerprint;
    for(let index=10;index<15;index++){
      const otherRecordId=`550e8400-e29b-4d4a-a716-4466554400${index}`;
      await database.pool.query(`INSERT INTO ${schema()}.observation_records
        (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
        VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','mapping-budget','POST',201,'metadata_only','metadata-only-1')`,
        [tenantId,repositoryId,serviceId,environment,importId,otherRecordId]);
      await database.pool.query(`INSERT INTO ${schema()}.observation_field_presence_results
        (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,
         source_digest,presence_fields,source_window_end,expires_at)
        VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'[{"path":"/id","state":"present"}]'::jsonb,NULL,NULL)`,
        [tenantId,repositoryId,serviceId,environment,policyId,fingerprint,importId,otherRecordId,snapshot.source.source_digest]);
    }} catch(error) {sourceWriteError=error;throw error;}
    return validBody();
  };
  await expect(store(read).importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_STORAGE_ERROR"});
  expect(sourceWriteError).toBeUndefined();
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]?.count).toBe(5);
});


test("source grant revocation during the unlocked source read prevents persistence",async()=>{
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  const read=async()=>{await access.putGrant({tenantId},{principalId,scopeId:"source-read",active:false});return validBody();};
  await expect(store(read).importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_UNAUTHORIZED"});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0].count).toBe(0);
});

test("a serving checkpoint change during source read prevents persistence",async()=>{
  const read=async()=>{
    await database.pool.query(`UPDATE ${schema()}.environment_serving_checkpoints SET version=version+1
      WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4`,[tenantId,repositoryId,serviceId,environment]);
    return validBody();
  };
  await expect(store(read).importObservation(importCredential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_STALE"});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0].count).toBe(0);
});

test("host bindings are detached and the same policy ID can be used in distinct environments",async()=>{
  const first=importBinding(),configured=[first,{...first,environment:"uat"}];
  const read=vi.fn<FieldPresenceImportReadPort>(readerPort);
  const repository=createFieldPresenceImportStore(database.pool,{schema:database.schema,bindings:configured,
    authorizeManager:manager(),readObservation:read});
  first.ownerAccessScopeId="ungranted";first.environment="other";configured.length=0;
  await expect(repository.importObservation(importCredential,request())).resolves.toMatchObject({status:"inserted"});
  expect(read.mock.calls[0]![1].binding.environment).toBe(environment);
  expect(read.mock.calls[0]![1].binding.ownerAccessScopeId).toBe(ownerAccessScopeId);
});
