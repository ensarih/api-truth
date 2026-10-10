import {readFile} from "node:fs/promises";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {applyEnvironmentMigrations} from "../../packages/environment/src/index.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/index.js";
import {applyObservationMigrations,compileFieldPresenceStoragePolicy} from "../../packages/observations/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";
import {createFieldPresenceMaintenanceStore,type FieldPresenceMaintenanceManager} from "../../packages/observations/src/field-presence-maintenance-store.js";
import {createFieldPresenceMaintenanceRunner} from "../../packages/observations/src/field-presence-maintenance-runner.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";

const tenant="tenant-maintenance",repository="commerce",service="orders",environment="uat",policyId="owner-fields";
const config="sha256:"+"c".repeat(64),sourceDigest="sha256:"+"d".repeat(64);
const importId="550e8400-e29b-4d4a-a716-446655440000";
const recordId="550e8400-e29b-4d4a-a716-446655440001",otherRecordId="550e8400-e29b-4d4a-a716-446655440002";
let database:CatalogTestDatabase,schema:string,fingerprint:string;
const policy=(revision="1",ttlSeconds=60,maxLiveRecords=1)=>compileFieldPresenceStoragePolicy({
  version:"field-presence-storage-1",policyId,ownerPolicyRevision:revision,optIn:true,tenantId:tenant,
  repositoryId:repository,serviceId:service,environment,configFingerprint:config,configActivationCheckpoint:"1",
  endpointId:"ep-create",direction:"request",mediaType:"application/json",propertyPaths:["/count"],ttlSeconds,maxLiveRecords});
const insertPolicy=async(revision="1",ttl=60,budget=1,selector?:{direction:"response";statusCode:number})=>{
  const compiled=compileFieldPresenceStoragePolicy({...policy(revision,ttl,budget).policy,...selector});
  await database.pool.query(`INSERT INTO ${schema}.observation_field_presence_policy_revisions
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,config_fingerprint,
     config_activation_checkpoint,endpoint_id,direction,media_type,status_code,property_paths,ttl_seconds,max_live_records,owner_access_scope_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'ep-create',$11,'application/json',$12,ARRAY['/count'],$9,$10,'owner')`,
    [tenant,repository,service,environment,policyId,revision,compiled.fingerprint,config,ttl,budget,compiled.policy.direction,compiled.policy.statusCode??null]);
  return compiled.fingerprint;
};
const insertPresence=(options:{recordId?:string;importId?:string;fields?:unknown;revision?:string;fingerprint?:string;digest?:string}={})=>
  database.pool.query(`INSERT INTO ${schema}.observation_field_presence_results
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,source_digest,presence_fields)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT DO NOTHING`,
    [tenant,repository,service,environment,policyId,options.revision??"1",options.fingerprint??fingerprint,options.importId??importId,
      options.recordId??recordId,options.digest??sourceDigest,JSON.stringify(options.fields??[{path:"/count",state:"present"}])]);

beforeEach(async()=>{
  database=await createCatalogTestDatabase();schema=quoteCatalogTestSchema(database.schema);
  await applyOrchestrationMigrations(database.pool,{schema:database.schema});
  await applyEnvironmentMigrations(database.pool,{schema:database.schema});
  await applyObservationMigrations(database.pool,{schema:database.schema});
  await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active) VALUES($1,'owner',true)`,[tenant]);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_configurations
    (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES($1,$2,'1.0.0',$3,'{}'::jsonb,'fixture-owner')`,[tenant,config,"sha256:"+"a".repeat(64)]);
  const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  snapshot.config.config_fingerprint=config;snapshot.source.source_digest=sourceDigest;
  snapshot.endpoints.find(endpoint=>endpoint.endpoint_id==="ep-create")!.request_bodies[0]!.schema={type:"object",properties:{count:{type:"integer"}}};
  await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,identity_version,
     config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'partial',$6,$7,$8,$9,$10,ARRAY['owner'],$11::jsonb)`,
    [tenant,snapshot.snapshot_id,repository,service,snapshot.source.immutable_revision,snapshot.ir_version,snapshot.identity_version,
      config,snapshotIdentitySha256(snapshot),snapshotContentSha256(snapshot),JSON.stringify(snapshot)]);
  fingerprint=await insertPolicy();
  await database.pool.query(`INSERT INTO ${schema}.observation_field_presence_policy_heads
    (tenant_id,repository_id,service_id,environment,policy_id,current_owner_policy_revision,current_policy_fingerprint,enabled)
    VALUES($1,$2,$3,$4,$5,1,$6,true)`,[tenant,repository,service,environment,policyId,fingerprint]);
  await database.pool.query(`INSERT INTO ${schema}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'fixture-source','1',clock_timestamp()-interval '40 seconds',
     clock_timestamp()-interval '30 seconds','metadata-only-1','[]'::jsonb)`,
    [tenant,repository,service,environment,importId,snapshot.snapshot_id,snapshot.source.immutable_revision,config]);
  for(const id of [recordId,otherRecordId]) await database.pool.query(`INSERT INTO ${schema}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-create','fixture-mapping','POST',201,'metadata_only','metadata-only-1')`,
    [tenant,repository,service,environment,importId,id]);
});
afterEach(async()=>{await database.cleanup();});

const credential=Object.freeze({opaque:"maintenance-credential"});
const binding={tenantId:tenant,repositoryId:repository,serviceId:service,environment,policyId,ownerAccessScopeId:"owner"};
const request=()=>({tenantId:tenant,repositoryId:repository,serviceId:service,environment,policyId,limit:10});
const manager=async(input:unknown)=>input===credential?{tenantId:tenant,principalId:"maintainer",capabilities:["observations.presence.cleanup"]}:undefined;
const maintenance=(authorizeManager:FieldPresenceMaintenanceManager=manager)=>createFieldPresenceMaintenanceStore(database.pool,
  {schema:database.schema,bindings:[binding],authorizeManager});
const grant=()=>database.pool.query(`INSERT INTO ${schema}.principal_scope_grants(tenant_id,principal_id,access_scope_id,active)
  VALUES($1,'maintainer','owner',true)`,[tenant]);

test("cleanup denies credentials before connecting and missing owner grants before deletion",async()=>{
  await insertPresence();
  const connect=vi.spyOn(database.pool,"connect");
  await expect(maintenance().cleanup(undefined,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED"});
  expect(connect).not.toHaveBeenCalled();connect.mockRestore();
  await expect(maintenance().cleanup(credential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED"});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(1);
});

test("cleanup keeps live rows, removes disabled rows within its batch limit and preserves immutable metadata",async()=>{
  await grant();
  const secondFingerprint=await insertPolicy("2",60,3);
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET current_owner_policy_revision=2,
    current_policy_fingerprint=$1`,[secondFingerprint]);
  await insertPresence({revision:"2",fingerprint:secondFingerprint});
  await insertPresence({revision:"2",fingerprint:secondFingerprint,recordId:otherRecordId});
  expect(await maintenance().cleanup(credential,request())).toEqual({removed:0});
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
  expect(await maintenance().cleanup(credential,{...request(),limit:1})).toEqual({removed:1});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(1);
  expect(await maintenance().cleanup(credential,request())).toEqual({removed:1});
  expect(await maintenance().cleanup(credential,request())).toEqual({removed:0});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_tombstones`)).rows[0].count).toBe(2);
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_records`)).rows[0].count).toBe(2);
  await expect(insertPresence({revision:"2",fingerprint:secondFingerprint})).rejects.toThrow();
});

test("cleanup uses database expiry and permanent tombstones without requiring serving/config reader grants",async()=>{
  await grant();
  const expiredImport="550e8400-e29b-4d4a-a716-446655440003";
  await database.pool.query(`INSERT INTO ${schema}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    SELECT tenant_id,repository_id,service_id,environment,$2::uuid,snapshot_id,revision,config_fingerprint,checkpoint_version,
      source_id,source_version,clock_timestamp()-interval '60 seconds',clock_timestamp()-interval '58 seconds',policy_version,safe_manifest
    FROM ${schema}.observation_imports WHERE import_id=$1::uuid`,[importId,expiredImport]);
  await database.pool.query(`INSERT INTO ${schema}.observation_records
    SELECT tenant_id,repository_id,service_id,environment,$2::uuid,record_id,status,reason,endpoint_id,mapping_id,method,status_code,
      completeness,policy_version FROM ${schema}.observation_records WHERE import_id=$1::uuid AND record_id=$3::uuid`,[importId,expiredImport,recordId]);
  await insertPresence({importId:expiredImport});
  await database.pool.query("SELECT pg_sleep(2.2)");
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(),bindings:[binding],
    credentialForBinding:async()=>credential});
  try{expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:1,failed:0});}
  finally{await runner.stop();}
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(0);
  expect((await database.pool.query(`SELECT reason FROM ${schema}.observation_field_presence_tombstones`)).rows[0].reason).toBe("expired");
  await expect(insertPresence({importId:expiredImport})).rejects.toThrow();
});


test("cleanup authorization deadline suppresses late manager identities and invokes no database",async()=>{
  let resolveManager:(value:unknown)=>void=()=>{};
  const repository=maintenance(()=>new Promise<unknown>(resolve=>{resolveManager=resolve;}));
  const connect=vi.spyOn(database.pool,"connect");
  vi.useFakeTimers();
  try{
    const result=repository.cleanup(credential,request());
    const assertion=expect(result).rejects.toMatchObject({code:"FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED"});
    await vi.advanceTimersByTimeAsync(10_001);await assertion;
    resolveManager({tenantId:tenant,principalId:"maintainer",capabilities:["observations.presence.cleanup"]});
    await Promise.resolve();expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
  expect(connect).not.toHaveBeenCalled();connect.mockRestore();
});

test("cleanup detaches host scope bindings and rejects inert-identity violations",async()=>{
  await grant();await insertPresence();
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
  const configured=[{...binding}],repository=createFieldPresenceMaintenanceStore(database.pool,
    {schema:database.schema,bindings:configured,authorizeManager:manager});
  configured[0]!.ownerAccessScopeId="ungranted";configured[0]!.environment="other";configured.length=0;
  expect(await repository.cleanup(credential,request())).toEqual({removed:1});
  let getterCalls=0;
  const invalid=createFieldPresenceMaintenanceStore(database.pool,{schema:database.schema,bindings:[binding],
    authorizeManager:async()=>({tenantId:tenant,get principalId(){getterCalls++;return "maintainer";},capabilities:["observations.presence.cleanup"]})});
  await expect(invalid.cleanup(credential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED"});
  expect(getterCalls).toBe(0);
});

test("cleanup revoked owner authority preserves derived rows and rejects invalid limits",async()=>{
  await grant();await insertPresence();
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
  await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false`);
  await expect(maintenance().cleanup(credential,request())).rejects.toMatchObject({code:"FIELD_PRESENCE_MAINTENANCE_UNAUTHORIZED"});
  for(const limit of [0,101,1.5,"10"])
    await expect(maintenance().cleanup(credential,{...request(),limit})).rejects.toMatchObject({code:"FIELD_PRESENCE_MAINTENANCE_INVALID_REQUEST"});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(1);
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_tombstones`)).rows[0].count).toBe(0);
});


test("a cleanup batch rolls back earlier deletions and tombstones when a later operation fails",async()=>{
  await grant();const secondFingerprint=await insertPolicy("2",60,3);
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET current_owner_policy_revision=2,
    current_policy_fingerprint=$1`,[secondFingerprint]);
  await insertPresence({revision:"2",fingerprint:secondFingerprint});
  await insertPresence({revision:"2",fingerprint:secondFingerprint,recordId:otherRecordId});
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
  const client=await database.pool.connect(),originalQuery=client.query.bind(client);
  let deletes=0;
  const query=vi.spyOn(client,"query").mockImplementation(((text:string,...parameters:unknown[])=>{
    if(text.includes("SELECT observation_field_presence_delete")&&++deletes===2)
      return Promise.reject(new Error("PRIVATE_SQL_CANARY"));
    return (originalQuery as any)(text,...parameters);
  }) as typeof client.query);
  const connect=vi.spyOn(database.pool,"connect").mockImplementation((async()=>client) as typeof database.pool.connect);
  try{
    await expect(maintenance().cleanup(credential,request())).rejects.toMatchObject({
      code:"FIELD_PRESENCE_MAINTENANCE_STORAGE_ERROR",message:"FIELD_PRESENCE_MAINTENANCE_STORAGE_ERROR"});
    expect(deletes).toBe(2);
  }finally{query.mockRestore();connect.mockRestore();}
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(2);
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_tombstones`)).rows[0].count).toBe(0);
});

test("concurrent cleanup calls delete a disabled generation exactly once",async()=>{
  await grant();await insertPresence();
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
  const repository=maintenance();
  const results=await Promise.all([repository.cleanup(credential,request()),repository.cleanup(credential,request())]);
  expect(results.map(result=>result.removed).sort()).toEqual([0,1]);
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_tombstones`)).rows[0].count).toBe(1);
});

test("cleanup removes superseded rows and releases the policy-wide budget for the current generation",async()=>{
  await grant();await insertPresence();const secondFingerprint=await insertPolicy("2",60,1);
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET current_owner_policy_revision=2,
    current_policy_fingerprint=$1`,[secondFingerprint]);
  await expect(insertPresence({revision:"2",fingerprint:secondFingerprint,recordId:otherRecordId})).rejects.toThrow();
  expect(await maintenance().cleanup(credential,request())).toEqual({removed:1});
  await insertPresence({revision:"2",fingerprint:secondFingerprint,recordId:otherRecordId});
  expect(await maintenance().cleanup(credential,request())).toEqual({removed:0});
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(1);
});


test("configured runner preserves live rows, removes a disabled batch once and keeps metadata/tombstones",async()=>{
  await grant();await insertPresence();
  const summaries:unknown[]=[];
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(),bindings:[binding],batchLimit:1,
    credentialForBinding:async configured=>{expect(configured).toEqual(binding);return credential;},
    onSummary:summary=>{summaries.push(summary);}});
  try{
    expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:1,failed:0});
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(1);
    await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
    expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:1,failed:0});
    expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:1,failed:0});
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(0);
    expect((await database.pool.query(`SELECT reason FROM ${schema}.observation_field_presence_tombstones`)).rows).toEqual([{reason:"deleted"}]);
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_records`)).rows[0].count).toBe(2);
    expect(summaries).toHaveLength(3);
    expect(JSON.stringify(summaries)).not.toMatch(/tenant-maintenance|owner-fields|maintenance-credential/);
  }finally{await runner.stop();}
});

test("runner credentials and revoked owner grants cannot authorize deletion; a restored grant enables retry",async()=>{
  await grant();await insertPresence();
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
  let supplied:unknown={opaque:"wrong-credential"};
  const runner=createFieldPresenceMaintenanceRunner({maintenance:maintenance(),bindings:[binding],
    credentialForBinding:async()=>supplied});
  const preserved=async()=>{
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(1);
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_tombstones`)).rows[0].count).toBe(0);
  };
  try{
    const connect=vi.spyOn(database.pool,"connect");
    expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:0,failed:1});
    expect(connect).not.toHaveBeenCalled();connect.mockRestore();await preserved();
    supplied=credential;
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false`);
    expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:0,failed:1});await preserved();
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=true`);
    expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:1,failed:0});
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`)).rows[0].count).toBe(0);
  }finally{await runner.stop();}
});
