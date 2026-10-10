import {afterEach,beforeEach,expect,test} from "vitest";
import {applyEnvironmentMigrations} from "../../packages/environment/src/migrations.js";
import {applyObservationMigrations} from "../../packages/observations/src/migrations.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";

const tenant="tenant-field-policy",repository="shop",service="orders",environment="prod",scope="logs-owner";
const configFingerprint="sha256:"+"c".repeat(64),configDigest="sha256:"+"a".repeat(64);
let database:CatalogTestDatabase,schema:string;
const revisionSql=`INSERT INTO ${"SCHEMA"}.observation_field_presence_policy_revisions
  (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint,
   config_fingerprint,config_activation_checkpoint,endpoint_id,direction,media_type,status_code,property_paths,
   ttl_seconds,max_live_records,owner_access_scope_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ep-create',$10,$11,$12,$13,$14,$15,$16)`;
type RevisionOptions={revision?:string;fingerprint?:string;config?:string;epoch?:number;direction?:string;mediaType?:string;
  statusCode?:number|null;paths?:string[];ttl?:number;budget?:number;ownerScope?:string;policyId?:string;repository?:string};
const insertRevision=async(options:RevisionOptions={})=>{
  const value={revision:"1",fingerprint:"sha256:"+"b".repeat(64),config:configFingerprint,epoch:7,direction:"request",
    mediaType:"application/json",statusCode:null,paths:["/customer/id"],ttl:3600,budget:50,ownerScope:scope,
    policyId:"order-contract",repository,...options};
  await database.pool.query(revisionSql.replaceAll("SCHEMA",schema),[tenant,value.repository,service,environment,value.policyId,
    value.revision,value.fingerprint,value.config,value.epoch,value.direction,value.mediaType,value.statusCode,value.paths,
    value.ttl,value.budget,value.ownerScope]);
};
const headSql=`INSERT INTO ${"SCHEMA"}.observation_field_presence_policy_heads
  (tenant_id,repository_id,service_id,environment,policy_id,current_owner_policy_revision,current_policy_fingerprint,enabled)
  VALUES($1,$2,$3,$4,'order-contract',$5,$6,$7)`;

beforeEach(async()=>{
  database=await createCatalogTestDatabase();schema=quoteCatalogTestSchema(database.schema);
  await applyOrchestrationMigrations(database.pool,{schema:database.schema});
  await applyEnvironmentMigrations(database.pool,{schema:database.schema});
  await applyObservationMigrations(database.pool,{schema:database.schema});
  await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active) VALUES($1,$2,true)`,[tenant,scope]);
  await database.pool.query(`INSERT INTO ${schema}.orchestration_configurations
    (tenant_id,config_fingerprint,config_version,document_sha256,document,registrar_principal_id)
    VALUES($1,$2,'1.0.0',$3,'{}'::jsonb,'owner')`,[tenant,configFingerprint,configDigest]);
});
afterEach(async()=>{await database.cleanup();});

test("applies the owner-policy migration idempotently and rejects checksum drift",async()=>{
  await applyObservationMigrations(database.pool,{schema:database.schema});
  const rows=await database.pool.query(`SELECT version FROM ${schema}.observation_schema_migrations ORDER BY version`);
  expect(rows.rows.map(row=>row.version)).toEqual(["0001_metadata_imports","0002_field_presence_owner_policies","0003_field_presence_retention","0004_scoped_record_lookup"]);
  await database.pool.query(`UPDATE ${schema}.observation_schema_migrations SET checksum_sha256=$1 WHERE version='0002_field_presence_owner_policies'`,
    ["sha256:"+"f".repeat(64)]);
  await expect(applyObservationMigrations(database.pool,{schema:database.schema})).rejects.toMatchObject({code:"OBSERVATION_STORAGE_ERROR"});
});

test("stores an explicitly scoped immutable policy revision and matching head",async()=>{
  const fingerprint="sha256:"+"b".repeat(64);
  await insertRevision({fingerprint});
  await database.pool.query(headSql.replaceAll("SCHEMA",schema),[tenant,repository,service,environment,"1",fingerprint,true]);
  await insertRevision({policyId:"order:contract",repository:"shop:blue",fingerprint:"sha256:"+"e".repeat(64)});
  const rows=await database.pool.query(`SELECT policy_id,owner_policy_revision::text,policy_fingerprint,config_fingerprint,
    config_activation_checkpoint::text,endpoint_id,direction,media_type,property_paths,ttl_seconds,max_live_records,
    owner_access_scope_id FROM ${schema}.observation_field_presence_policy_revisions`);
  expect(rows.rows).toEqual(expect.arrayContaining([{policy_id:"order-contract",owner_policy_revision:"1",policy_fingerprint:fingerprint,
    config_fingerprint:configFingerprint,config_activation_checkpoint:"7",endpoint_id:"ep-create",direction:"request",
    media_type:"application/json",property_paths:["/customer/id"],ttl_seconds:3600,max_live_records:50,owner_access_scope_id:scope}]));
  const columns=await database.pool.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema=$1 AND table_name IN ('observation_field_presence_policy_revisions','observation_field_presence_policy_heads')`,
    [database.schema]);
  expect(columns.rows.some(row=>["document","payload","body","raw","value_hash"].includes(row.column_name))).toBe(false);
  await expect(database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_revisions SET ttl_seconds=7200
    WHERE tenant_id=$1`,[tenant])).rejects.toThrow();
});

test("head permits opt-out and monotone revision replacement but never same-generation re-enable or replay",async()=>{
  const first="sha256:"+"b".repeat(64),second="sha256:"+"c".repeat(64);
  await insertRevision({fingerprint:first});
  await database.pool.query(headSql.replaceAll("SCHEMA",schema),[tenant,repository,service,environment,"1",first,true]);
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=false
    WHERE tenant_id=$1 AND policy_id='order-contract'`,[tenant]);
  await expect(database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET enabled=true
    WHERE tenant_id=$1 AND policy_id='order-contract'`,[tenant])).rejects.toThrow();
  await expect(insertRevision({fingerprint:first,paths:["/customer/name"]})).rejects.toThrow();
  await insertRevision({revision:"2",fingerprint:second,paths:["/customer/name"]});
  await database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET current_owner_policy_revision=2,
    current_policy_fingerprint=$1,enabled=true WHERE tenant_id=$2 AND policy_id='order-contract'`,[second,tenant]);
  await expect(database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET current_owner_policy_revision=1,
    current_policy_fingerprint=$1 WHERE tenant_id=$2 AND policy_id='order-contract'`,[first,tenant])).rejects.toThrow();
  await expect(database.pool.query(`UPDATE ${schema}.observation_field_presence_policy_heads SET policy_id='replacement'
    WHERE tenant_id=$1 AND policy_id='order-contract'`,[tenant])).rejects.toThrow();
  await expect(database.pool.query(`DELETE FROM ${schema}.observation_field_presence_policy_heads WHERE tenant_id=$1`,[tenant])).rejects.toThrow();
  await expect(database.pool.query(`DELETE FROM ${schema}.observation_field_presence_policy_revisions WHERE tenant_id=$1`,[tenant])).rejects.toThrow();
});

test("rejects wrong-scope references, mismatched heads, and malformed policy limits or selectors",async()=>{
  const fingerprint="sha256:"+"b".repeat(64);
  await expect(insertRevision({ownerScope:"missing-scope"})).rejects.toThrow();
  await expect(insertRevision({config:"sha256:"+"d".repeat(64)})).rejects.toThrow();
  await insertRevision();
  await expect(database.pool.query(headSql.replaceAll("SCHEMA",schema),[tenant,repository,service,environment,"2",fingerprint,true])).rejects.toThrow();
  const invalidPaths=[["/customer/id","/customer/id"],["/"],["/__proto__"],["/*"],["/customer/email"],
    ["/customer/e~1mail"],["/bad\u0001"],[`/${"x".repeat(129)}`],["/bad~2escape"],
    [Array.from({length:13},()=>"x").reduce((path,part)=>`${path}/${part}`,"")]];
  for(const [index,paths] of invalidPaths.entries())
    await expect(insertRevision({revision:String(index+2),fingerprint:`sha256:${String(index+1).repeat(64)}`,paths})).rejects.toThrow();
  await expect(insertRevision({revision:"8",fingerprint:"sha256:"+"8".repeat(64),ttl:59})).rejects.toThrow();
  await expect(insertRevision({revision:"9",fingerprint:"sha256:"+"9".repeat(64),budget:10001})).rejects.toThrow();
  await expect(insertRevision({revision:"10",fingerprint:"sha256:"+"a".repeat(64),epoch:0})).rejects.toThrow();
  await expect(insertRevision({revision:"11",fingerprint:"sha256:"+"c".repeat(64),direction:"response"})).rejects.toThrow();
  await expect(insertRevision({revision:"12",fingerprint:"sha256:"+"d".repeat(64),statusCode:201})).rejects.toThrow();
  await expect(insertRevision({revision:"13",fingerprint:"sha256:"+"e".repeat(64),paths:Array.from({length:33},(_,i)=>`/field${String(i).padStart(2,"0")}`)})).rejects.toThrow();
  await expect(insertRevision({revision:"14",fingerprint:"sha256:"+"f".repeat(64),paths:["/z","/a"]})).rejects.toThrow();
  await expect(insertRevision({revision:"15",fingerprint:"sha256:"+"1".repeat(64),mediaType:"text/plain"})).rejects.toThrow();
  await expect(insertRevision({revision:"16",fingerprint:"sha256:"+"2".repeat(64),mediaType:"application/json; charset=utf-8"})).rejects.toThrow();
  await insertRevision({policyId:"boundary-ttl-low",ttl:60,budget:1});
  await insertRevision({policyId:"boundary-ttl-high",ttl:2592000,budget:10000});
  await insertRevision({policyId:"boundary-paths",paths:Array.from({length:32},(_,i)=>`/field${String(i).padStart(2,"0")}`)});
  await expect(insertRevision({revision:"18",fingerprint:"sha256:"+"4".repeat(64),ttl:2592001})).rejects.toThrow();
  await expect(insertRevision({revision:"19",fingerprint:"sha256:"+"5".repeat(64),budget:0})).rejects.toThrow();
  await expect(insertRevision({revision:"20",fingerprint:"sha256:"+"6".repeat(64),mediaType:"application/"+"x".repeat(120)})).rejects.toThrow();
  await expect(insertRevision({revision:"21",fingerprint:"sha256:"+"7".repeat(64),paths:[["/field-a","/field-b"]] as unknown as string[]})).rejects.toThrow();
});


test("record ambiguity lookup uses a scoped record index across imports",async()=>{
  const client=await database.pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan=off");
    const result=await client.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${schema}.observation_records
      WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment=$4
        AND record_id=$5::uuid AND import_id<>$6::uuid LIMIT 1`,
      [tenant,repository,service,environment,"550e8400-e29b-4d4a-a716-446655440001","550e8400-e29b-4d4a-a716-446655440000"]);
    const plan=result.rows[0]["QUERY PLAN"][0].Plan;
    const flattened:Record<string,unknown>[]=[];
    const visit=(node:Record<string,unknown>)=>{flattened.push(node);
      for(const child of (node.Plans??[]) as Record<string,unknown>[])visit(child);};
    visit(plan);
    const scan=flattened.find(node=>node["Index Name"]==="observation_records_scoped_record_idx");
    expect(scan).toBeDefined();
    expect(scan?.["Index Cond"]).toContain("record_id");
    await client.query("ROLLBACK");
  }finally{await client.query("ROLLBACK").catch(()=>undefined);client.release();}
});
