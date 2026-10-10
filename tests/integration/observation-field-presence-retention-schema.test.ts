import {readFile} from "node:fs/promises";
import {afterEach,beforeEach,expect,test} from "vitest";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {applyEnvironmentMigrations} from "../../packages/environment/src/index.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/index.js";
import {applyObservationMigrations,compileFieldPresenceStoragePolicy} from "../../packages/observations/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";
import type {ContractSnapshot} from "../../packages/ir/src/index.js";

const tenant="tenant-retention",repository="commerce",service="orders",environment="uat",policyId="owner-fields";
const config="sha256:"+"c".repeat(64),sourceDigest="sha256:"+"d".repeat(64);
const importId="550e8400-e29b-4d4a-a716-446655440000";
const recordId="550e8400-e29b-4d4a-a716-446655440001",otherRecordId="550e8400-e29b-4d4a-a716-446655440002";
let database:CatalogTestDatabase,schema:string,fingerprint:string;
const key=[tenant,repository,service,environment,policyId,"1",importId,recordId];
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
const removePresence=()=>database.pool.query(`SELECT ${schema}.observation_field_presence_delete($1,$2,$3,$4,$5,$6::bigint,$7::uuid,$8::uuid) AS removed`,key);

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

test("DB expiry uses the source window end and exact retry never restarts retention",async()=>{
  await insertPresence();
  const before=await database.pool.query(`SELECT extract(epoch FROM result.expires_at-import.window_end)::integer AS lifetime,
    extract(epoch FROM result.expires_at-result.created_at)::integer AS remaining,result.expires_at,result.created_at
    FROM ${schema}.observation_field_presence_results result JOIN ${schema}.observation_imports import
    USING(tenant_id,repository_id,service_id,environment,import_id)`);
  expect(before.rows[0].lifetime).toBe(60);
  expect(before.rows[0].remaining).toBeLessThanOrEqual(30);
  expect(before.rows[0].remaining).toBeGreaterThan(0);
  await insertPresence();
  const after=await database.pool.query(`SELECT expires_at,created_at FROM ${schema}.observation_field_presence_results`);
  expect(after.rows[0]).toEqual({expires_at:before.rows[0].expires_at,created_at:before.rows[0].created_at});
  await expect(insertPresence({fields:[{path:"/count",state:"absent"}]})).rejects.toThrow();
});

test("serializes policy-wide budget across concurrent inserts",async()=>{
  const attempts=await Promise.allSettled([insertPresence(),insertPresence({recordId:otherRecordId})]);
  expect(attempts.filter(attempt=>attempt.status==="fulfilled")).toHaveLength(1);
  const rows=await database.pool.query(`SELECT count(*)::int AS count FROM ${schema}.observation_field_presence_results`);
  expect(rows.rows[0].count).toBe(1);
});

test("explicit deletion creates an immutable tombstone and prevents resurrection",async()=>{
  await insertPresence();
  await expect(database.pool.query(`DELETE FROM ${schema}.observation_field_presence_results`)).rejects.toThrow();
  expect((await removePresence()).rows[0].removed).toBe(true);
  expect((await removePresence()).rows[0].removed).toBe(false);
  await expect(insertPresence()).rejects.toThrow();
  await expect(database.pool.query(`DELETE FROM ${schema}.observation_field_presence_tombstones`)).rejects.toThrow();
  const metadata=await database.pool.query(`SELECT (SELECT count(*)::int FROM ${schema}.observation_imports) AS imports,
    (SELECT count(*)::int FROM ${schema}.observation_records) AS records`);
  expect(metadata.rows[0]).toEqual({imports:1,records:2});
});

test("disabled generations disappear immediately and old rows still consume the policy-wide budget",async()=>{
  await insertPresence();
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false`);
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_live_results`)).rows).toHaveLength(0);
  await expect(insertPresence()).rejects.toThrow();
  const next=await insertPolicy("2");
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads
    SET current_owner_policy_revision=2,current_policy_fingerprint=$1,enabled=true`,[next]);
  await expect(insertPresence({recordId:otherRecordId,revision:"2",fingerprint:next})).rejects.toThrow();
  await removePresence();
  await insertPresence({recordId:otherRecordId,revision:"2",fingerprint:next});
  expect((await database.pool.query(`SELECT owner_policy_revision::text FROM ${schema}.observation_field_presence_live_results`)).rows)
    .toEqual([{owner_policy_revision:"2"}]);
});

test("rejects copied values, missing selected paths and wrong source lineage",async()=>{
  for(const fields of [[{path:"/count",state:"present",value:"PRIVATE_CANARY"}],[],[{path:"/other",state:"present"}],
    [{path:"/count",state:"unknown"}],[{path:"/count",state:"present"},{path:"/count",state:"present"}]])
    await expect(insertPresence({fields})).rejects.toThrow();
  await expect(insertPresence({digest:"sha256:"+"f".repeat(64)})).rejects.toThrow();
  await insertPresence();
  await expect(database.pool.query(`UPDATE ${schema}.observation_field_presence_results SET presence_fields='[]'::jsonb`)).rejects.toThrow();
  const rows=await database.pool.query(`SELECT row_to_json(result)::text AS result FROM ${schema}.observation_field_presence_results result`);
  expect(JSON.stringify(rows.rows)).not.toContain("PRIVATE_CANARY");
});

test("rejects a client-supplied expiry and transactional deletion rolls back atomically",async()=>{
  await expect(database.pool.query(`INSERT INTO ${schema}.observation_field_presence_results
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,import_id,record_id,
     source_digest,presence_fields,expires_at)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'[{"path":"/count","state":"present"}]',clock_timestamp()+interval '1 year')`,
    [tenant,repository,service,environment,policyId,fingerprint,importId,recordId,sourceDigest])).rejects.toThrow();
  await insertPresence();
  const client=await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT ${schema}.observation_field_presence_delete($1,$2,$3,$4,$5,$6::bigint,$7::uuid,$8::uuid)`,key);
    await client.query("ROLLBACK");
  } finally {client.release();}
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_results`)).rows).toHaveLength(1);
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_tombstones`)).rows).toHaveLength(0);
});


const alternateImport=async(offsetSeconds:number)=>{
  const id="550e8400-e29b-4d4a-a716-446655440010";
  await database.pool.query(`INSERT INTO ${schema}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    SELECT tenant_id,repository_id,service_id,environment,$1,snapshot_id,revision,config_fingerprint,checkpoint_version,
      source_id,source_version,clock_timestamp()+make_interval(secs=>$2)-interval '10 seconds',
      clock_timestamp()+make_interval(secs=>$2),policy_version,safe_manifest FROM ${schema}.observation_imports WHERE import_id=$3`,
    [id,offsetSeconds,importId]);
  await database.pool.query(`INSERT INTO ${schema}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    SELECT tenant_id,repository_id,service_id,environment,$1,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version
      FROM ${schema}.observation_records WHERE import_id=$2 AND record_id=$3`,[id,importId,recordId]);
  return id;
};

test("rejects already expired and future source windows using database time",async()=>{
  const expired=await alternateImport(-120);
  await expect(insertPresence({importId:expired})).rejects.toThrow();
  // A second independent scope keeps immutable source rows untouched.
  await database.pool.query(`INSERT INTO ${schema}.observation_imports
    (tenant_id,repository_id,service_id,environment,import_id,snapshot_id,revision,config_fingerprint,checkpoint_version,
     source_id,source_version,window_start,window_end,policy_version,safe_manifest)
    SELECT tenant_id,repository_id,service_id,environment,'550e8400-e29b-4d4a-a716-446655440020',snapshot_id,revision,config_fingerprint,checkpoint_version,
      source_id,source_version,clock_timestamp(),clock_timestamp()+interval '30 seconds',policy_version,safe_manifest
      FROM ${schema}.observation_imports WHERE import_id=$1`,[importId]);
  await database.pool.query(`INSERT INTO ${schema}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    SELECT tenant_id,repository_id,service_id,environment,'550e8400-e29b-4d4a-a716-446655440020',record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version
      FROM ${schema}.observation_records WHERE import_id=$1 AND record_id=$2`,[importId,recordId]);
  await expect(insertPresence({importId:"550e8400-e29b-4d4a-a716-446655440020"})).rejects.toThrow();
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_results`)).rows).toHaveLength(0);
});

test("live view expires without client time and expiry deletion leaves a replay blocker",async()=>{
  const expiring=await alternateImport(-55);
  await insertPresence({importId:expiring});
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_live_results`)).rows).toHaveLength(1);
  await database.pool.query("SELECT pg_sleep(5.2)");
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_live_results`)).rows).toHaveLength(0);
  await database.pool.query(`SELECT ${schema}.observation_field_presence_delete($1,$2,$3,$4,$5,$6::bigint,$7::uuid,$8::uuid)`,
    [tenant,repository,service,environment,policyId,"1",expiring,recordId]);
  expect((await database.pool.query(`SELECT reason FROM ${schema}.observation_field_presence_tombstones`)).rows).toEqual([{reason:"expired"}]);
  await expect(insertPresence({importId:expiring})).rejects.toThrow();
});


test("rejects a confirmed parent from a different endpoint",async()=>{
  const wrong="550e8400-e29b-4d4a-a716-446655440003";
  await database.pool.query(`INSERT INTO ${schema}.observation_records
    (tenant_id,repository_id,service_id,environment,import_id,record_id,status,endpoint_id,mapping_id,method,status_code,completeness,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,'confirmed','ep-get','fixture-mapping','GET',200,'metadata_only','metadata-only-1')`,
    [tenant,repository,service,environment,importId,wrong]);
  await expect(insertPresence({recordId:wrong})).rejects.toThrow();
});

test("response policy requires the metadata parent's exact status",async()=>{
  const next=await insertPolicy("2",60,1,{direction:"response",statusCode:200});
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads
    SET current_owner_policy_revision=2,current_policy_fingerprint=$1`,[next]);
  await expect(insertPresence({revision:"2",fingerprint:next})).rejects.toThrow();
  const matching=await insertPolicy("3",60,1,{direction:"response",statusCode:201});
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads
    SET current_owner_policy_revision=3,current_policy_fingerprint=$1`,[matching]);
  await insertPresence({revision:"3",fingerprint:matching});
});

test("deletion and concurrent exact retry cannot deadlock or resurrect a generation",async()=>{
  await insertPresence();
  const [retry,deletion]=await Promise.allSettled([insertPresence(),removePresence()]);
  expect(deletion.status).toBe("fulfilled");
  if(deletion.status==="fulfilled")expect(deletion.value.rows[0].removed).toBe(true);
  if(retry.status==="rejected")expect(retry.reason.code).toBe("55000");
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_results`)).rows).toHaveLength(0);
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_tombstones`)).rows).toHaveLength(1);
  await expect(insertPresence()).rejects.toThrow();
});

test("retention migration is idempotent and rejects its own checksum drift",async()=>{
  await applyObservationMigrations(database.pool,{schema:database.schema});
  await database.pool.query(`UPDATE ${schema}.observation_schema_migrations SET checksum_sha256=$1
    WHERE version='0003_field_presence_retention'`,["sha256:"+"f".repeat(64)]);
  await expect(applyObservationMigrations(database.pool,{schema:database.schema})).rejects.toMatchObject({code:"OBSERVATION_STORAGE_ERROR"});
});

test("cannot poison an unwritten parent generation with a standalone tombstone",async()=>{
  await expect(database.pool.query(`INSERT INTO ${schema}.observation_field_presence_tombstones
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,import_id,record_id,reason)
    VALUES($1,$2,$3,$4,$5,$6::bigint,$7::uuid,$8::uuid,'deleted')`,key)).rejects.toThrow();
  await insertPresence();
});

test("standalone tombstone cannot commit while its matching presence row remains",async()=>{
  await insertPresence();
  await expect(database.pool.query(`INSERT INTO ${schema}.observation_field_presence_tombstones
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,import_id,record_id,reason)
    VALUES($1,$2,$3,$4,$5,$6::bigint,$7::uuid,$8::uuid,'deleted')`,key)).rejects.toThrow();
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_tombstones`)).rows).toHaveLength(0);
  expect((await database.pool.query(`SELECT * FROM ${schema}.observation_field_presence_live_results`)).rows).toHaveLength(1);
  expect((await removePresence()).rows[0].removed).toBe(true);
});
