import {readFile} from "node:fs/promises";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations,createEnvironmentRepository} from "../../packages/environment/src/index.js";
import {parseContractSnapshot,type ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyObservationMigrations} from "../../packages/observations/src/migrations.js";
import {createFieldPresenceOwnerPolicyStore,type FieldPresenceOwnerManager} from "../../packages/observations/src/field-presence-owner-store.js";
import {applyOrchestrationMigrations,createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";

const tenantId="tenant-field-owner",principalId="owner",repositoryId="commerce",serviceId="orders",environment="prod";
const policyId="order-fields",ownerAccessScopeId="owner-policy-read";
const ownerCredential=Object.freeze({opaque:"owner-secret"});
const scopes=["repository-read","deployment-read","contract-read","source-read",ownerAccessScopeId];
const context={tenantId,principalId};
let database:CatalogTestDatabase,snapshot:ContractSnapshot,pin:{snapshotId:string;revision:string;checkpointVersion:string};
const schema=()=>quoteCatalogTestSchema(database.schema);
const event=(eventId:string,payload:unknown)=>({event_version:"1.0.0",event_id:eventId,event_type:"deployment.changed",
  producer:{producer_id:"deploy",adapter_version:"1"},occurred_at:"2026-10-09T00:00:00.000Z",received_at:"2026-10-09T00:00:01.000Z",
  subjects:{repository_id:repositoryId,service_ids:[serviceId],environment},provider_evidence:{provider:"deploy",provider_reference:eventId},payload});
const configFor=(configFingerprint:string)=>({config_version:"1.0.0",access_scopes:scopes.map(access_scope_id=>({access_scope_id,label:access_scope_id})),
  repositories:[{repository_id:repositoryId,provider:"github",locator:"acme/commerce",access_scope_id:scopes[0],services:[{
    service_id:serviceId,root:"services/orders",analyzer:{adapter_id:"typescript",adapter_version:"1"},intended_branches:["main"],
    environments:[{name:environment,intended_branch:"main",deployment_authority:{adapter_id:"deploy",access_scope_id:scopes[1]}}]}]}],
  inference:{enabled:false},logs:{enabled:true,adapter_id:"gateway-log",credential:{secret_ref:{scheme:"env",locator:"GATEWAY_TOKEN"}}}});
const bindings=()=>[{tenantId,repositoryId,serviceId,environment,policyId,ownerAccessScopeId}];
const policy=(ownerPolicyRevision="1",path="/id")=>({version:"field-presence-storage-1",policyId,ownerPolicyRevision,optIn:true,
  tenantId,repositoryId,serviceId,environment,configFingerprint:snapshot.config.config_fingerprint,configActivationCheckpoint:"1",
  endpointId:"ep-create",direction:"request",mediaType:"application/json",propertyPaths:[path],ttlSeconds:3600,maxLiveRecords:5});
const expectedPin=()=>({snapshotId:snapshot.snapshot_id,revision:snapshot.source.immutable_revision,checkpointVersion:pin.checkpointVersion});
const manager=(enabled=true)=>(credential:unknown,bound:unknown,_signal:AbortSignal)=>credential===ownerCredential&&enabled
  ?Promise.resolve({tenantId,principalId,capabilities:["observations.policy.manage"]}):Promise.resolve(undefined);
const store=(authorizeManager:FieldPresenceOwnerManager=manager())=>createFieldPresenceOwnerPolicyStore(database.pool,
  {schema:database.schema,bindings:bindings(),authorizeManager});

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
  const body=snapshot.endpoints.find(item=>item.endpoint_id==="ep-create")!.request_bodies[0]!;
  body.schema={type:"object",properties:{id:{type:"string"}}};
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
  const configuration=configFor(configFingerprint);
  const orchestration=createOrchestrationRepository(database.pool,{schema:database.schema});
  await orchestration.registerConfiguration({tenantId,principalId:"admin",capabilities:["configuration.admin"]},
    {fingerprint:configFingerprint,document:configuration});
  await orchestration.activateInitialConfiguration({tenantId,principalId:"admin",capabilities:["configuration.admin"]},{fingerprint:configFingerprint});
  const snapshotSchema=schema();
  await database.pool.query(`INSERT INTO ${snapshotSchema}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,identity_version,
     config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'partial',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [tenantId,snapshot.snapshot_id,repositoryId,serviceId,snapshot.source.immutable_revision,snapshot.ir_version,snapshot.identity_version,
      configFingerprint,snapshotIdentitySha256(snapshot),snapshotContentSha256(snapshot),[scopes[2]],JSON.stringify(snapshot)]);
  await orchestration.ingestEvent({tenantId,principalId:"deploy",producerId:"deploy",allowedEventTypes:["deployment.changed"],
    allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
      adapterId:"deploy",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]},
    event("owner-attempt",{change_kind:"attempt",deployment_id:"owner-attempt",environment,attempt_state:"succeeded",
      effective_order:"1",artifact_id:"artifact-owner",revision:{state:"known",revision:snapshot.source.immutable_revision}}));
  const envRepo=createEnvironmentRepository(database.pool,{schema:database.schema});
  const worker={workerId:"environment-worker",instanceId:"owner-policy-test",capabilities:["jobs.execute"]};
  await envRepo.recordAttempt(worker,{tenantId,producerId:"deploy",eventId:"owner-attempt"});
  await orchestration.ingestEvent({tenantId,principalId:"deploy",producerId:"deploy",allowedEventTypes:["deployment.changed"],
    allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
      adapterId:"deploy",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]},
    event("owner-serving",{change_kind:"serving_observation",observation_id:"owner-serving",environment,
      source:{authority_id:"inventory",reference:"owner-serving",access_label:scopes[3]},completeness:"complete",effective_order:"1",
      serving_state:{status:"known",inventory:[{artifact_id:"artifact-owner",revision:{state:"known",revision:snapshot.source.immutable_revision}}]}}));
  await envRepo.recordServingObservation(worker,{tenantId,producerId:"deploy",eventId:"owner-serving"});
  const storedSnapshot=await database.pool.query(`SELECT snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,
    ir_version,identity_version,config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document FROM ${snapshotSchema}.catalog_snapshots`);
  expect(storedSnapshot.rows).toHaveLength(1);
  expect(storedSnapshot.rows[0]).toMatchObject({snapshot_id:snapshot.snapshot_id,repository_id:repositoryId,service_id:serviceId,
    immutable_revision:snapshot.source.immutable_revision,analyzer_status:"partial",ir_version:snapshot.ir_version,
    identity_version:snapshot.identity_version,config_fingerprint:snapshot.config.config_fingerprint,
    identity_sha256:snapshotIdentitySha256(snapshot),content_sha256:snapshotContentSha256(snapshot),required_scope_ids:[scopes[2]]});
  expect(parseContractSnapshot(storedSnapshot.rows[0]!.document).ok).toBe(true);
  const reader=createQueryReader(database.pool,{schema:database.schema});
  const byRevision=await reader.readContract(context,{version:"1",tenantId,repositoryId,serviceId,
    selector:{kind:"revision",revision:snapshot.source.immutable_revision}});
  expect(byRevision.status).toBe("resolved");
  const selected=await reader.readContract(context,
    {version:"1",tenantId,repositoryId,serviceId,selector:{kind:"environment",environment}});
  if(selected.status!=="resolved")throw new Error("Expected pinned policy test snapshot");
  pin={snapshotId:selected.pin.snapshotId,revision:selected.pin.revision,checkpointVersion:selected.pin.checkpointVersion!};
});
afterEach(async()=>{await database.cleanup();});

test("rejects unauthenticated manager before connecting or storing a policy",async()=>{
  const repository=store(manager(false)),connect=vi.spyOn(database.pool,"connect");
  await expect(repository.approve(ownerCredential,{policy:policy(),expectedOwnerRevision:"0",expectedPin:expectedPin()}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_UNAUTHORIZED"});
  expect(connect).not.toHaveBeenCalled();
  const rows=await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_policy_revisions`);
  expect(rows.rows[0]?.count).toBe(0);connect.mockRestore();
});

test("manager callback failures and deadlines return fixed authorization errors before connecting",async()=>{
  const connect=vi.spyOn(database.pool,"connect");
  const request={policy:policy(),expectedOwnerRevision:"0",expectedPin:expectedPin()};
  const throwing=store(async()=>{throw new Error("private manager detail");});
  await expect(throwing.approve(ownerCredential,request)).rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_UNAUTHORIZED"});
  let lateResolve:(identity:unknown)=>void=()=>{};
  const timed=store((_credential,_binding,_signal)=>new Promise(resolve=>{lateResolve=resolve;}));
  vi.useFakeTimers();
  try{
    const pending=timed.approve(ownerCredential,request);
    const assertion=expect(pending).rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_UNAUTHORIZED"});
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    lateResolve({tenantId,principalId,capabilities:["observations.policy.manage"]});
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  }finally{vi.useRealTimers();}
  expect(connect).not.toHaveBeenCalled();
  connect.mockRestore();
});

test("approves exact policy scope with owner grant, permits exact retry, and rejects conflicts",async()=>{
  const repository=store();
  const request={policy:policy(),expectedOwnerRevision:"0",expectedPin:expectedPin()};
  await expect(repository.approve(ownerCredential,request)).resolves.toMatchObject({status:"approved",ownerPolicyRevision:"1",enabled:true});
  await expect(repository.approve(ownerCredential,request)).resolves.toMatchObject({status:"existing",ownerPolicyRevision:"1",enabled:true});
  await expect(repository.approve(ownerCredential,{...request,policy:{...policy(),maxLiveRecords:6}}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_CONFLICT"});
  await expect(repository.disable(ownerCredential,{tenantId,repositoryId,serviceId,environment,policyId,expectedOwnerRevision:"1"}))
    .resolves.toMatchObject({status:"disabled",ownerPolicyRevision:"1",enabled:false});
  await expect(repository.approve(ownerCredential,{...request,expectedOwnerRevision:"1"}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_CONFLICT"});
  await expect(repository.approve(ownerCredential,{policy:policy("2"),expectedOwnerRevision:"1",expectedPin:expectedPin()}))
    .resolves.toMatchObject({status:"approved",ownerPolicyRevision:"2",enabled:true});
  const rows=await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_policy_revisions`);
  expect(rows.rows[0]?.count).toBe(2);
});

test("missing or revoked owner grant and stale config epoch/pin deny before callback writes",async()=>{
  const repository=store();
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  await access.putGrant({tenantId},{principalId,scopeId:ownerAccessScopeId,active:false});
  await expect(repository.approve(ownerCredential,{policy:policy(),expectedOwnerRevision:"0",expectedPin:expectedPin()}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_UNAUTHORIZED"});
  await access.putGrant({tenantId},{principalId,scopeId:ownerAccessScopeId,active:true});
  await expect(repository.approve(ownerCredential,{policy:{...policy(),configActivationCheckpoint:"2"},expectedOwnerRevision:"0",expectedPin:expectedPin()}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_STALE"});
  await expect(repository.approve(ownerCredential,{policy:policy(),expectedOwnerRevision:"0",expectedPin:{...expectedPin(),revision:"a".repeat(40)}}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_STALE"});
  await expect(repository.approve(ownerCredential,{policy:policy(),expectedOwnerRevision:"0",expectedPin:{...expectedPin(),checkpointVersion:"0"}}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_INVALID_REQUEST"});
  const rows=await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_policy_revisions`);
  expect(rows.rows[0]?.count).toBe(0);
});

test("manager identity accessors are rejected without invoking them or connecting",async()=>{
  const connect=vi.spyOn(database.pool,"connect");let invoked=false;
  const result=Object.defineProperties({}, {tenantId:{enumerable:true,get(){invoked=true;throw new Error("private");}},
    principalId:{enumerable:true,value:principalId},capabilities:{enumerable:true,value:["observations.policy.manage"]}});
  await expect(store(async()=>result).approve(ownerCredential,
    {policy:policy(),expectedOwnerRevision:"0",expectedPin:expectedPin()}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_UNAUTHORIZED"});
  expect(invoked).toBe(false);expect(connect).not.toHaveBeenCalled();connect.mockRestore();
});

test("approval detaches the policy before the asynchronous manager callback",async()=>{
  let release:(value:unknown)=>void=()=>{};
  const auth:FieldPresenceOwnerManager=()=>new Promise(resolve=>{release=resolve;});
  const repository=store(auth);const originalPolicy=policy();
  const pending=repository.approve(ownerCredential,{policy:originalPolicy,expectedOwnerRevision:"0",expectedPin:expectedPin()});
  await Promise.resolve();
  originalPolicy.propertyPaths[0]="/missing";
  release({tenantId,principalId,capabilities:["observations.policy.manage"]});
  await expect(pending).resolves.toMatchObject({status:"approved",ownerPolicyRevision:"1"});
  const row=await database.pool.query(`SELECT property_paths FROM ${schema()}.observation_field_presence_policy_revisions`);
  expect(row.rows[0]?.property_paths).toEqual(["/id"]);
});

test("unsupported schema paths do not write; concurrent conflicting CAS has one winner",async()=>{
  const repository=store();
  await expect(repository.approve(ownerCredential,{policy:policy("1","/missing"),expectedOwnerRevision:"0",expectedPin:expectedPin()}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_UNSUPPORTED"});
  const attempts=await Promise.allSettled([5,6].map(maxLiveRecords=>repository.approve(ownerCredential,
    {policy:{...policy(),maxLiveRecords},expectedOwnerRevision:"0",expectedPin:expectedPin()})));
  expect(attempts.filter(item=>item.status==="fulfilled")).toHaveLength(1);
  const rejected=attempts.filter((item):item is PromiseRejectedResult=>item.status==="rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({code:"FIELD_PRESENCE_POLICY_CONFLICT"});
  const rows=await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_policy_revisions`);
  expect(rows.rows[0]?.count).toBe(1);
});

test("disable works after reader grants are revoked, but owner grant revocation denies",async()=>{
  const repository=store();
  await repository.approve(ownerCredential,{policy:policy(),expectedOwnerRevision:"0",expectedPin:expectedPin()});
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  for(const scopeId of scopes.filter(item=>item!==ownerAccessScopeId))
    await access.putGrant({tenantId},{principalId,scopeId,active:false});
  await expect(repository.disable(ownerCredential,{tenantId,repositoryId,serviceId,environment,policyId,expectedOwnerRevision:"1"}))
    .resolves.toMatchObject({status:"disabled",ownerPolicyRevision:"1",enabled:false});
  await access.putGrant({tenantId},{principalId,scopeId:ownerAccessScopeId,active:false});
  await expect(repository.disable(ownerCredential,{tenantId,repositoryId,serviceId,environment,policyId,expectedOwnerRevision:"1"}))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_POLICY_UNAUTHORIZED"});
});


test("host owner bindings are detached from later configuration mutations",async()=>{
  const mutable=bindings();let authorizedBinding:unknown;
  const repository=createFieldPresenceOwnerPolicyStore(database.pool,{schema:database.schema,bindings:mutable,
    authorizeManager:async(credential,bound,signal)=>{authorizedBinding=bound;return manager()(credential,bound,signal);}});
  mutable[0]!.ownerAccessScopeId="source-read";mutable[0]!.environment="uat";
  await repository.approve(ownerCredential,{policy:policy(),expectedOwnerRevision:"0",expectedPin:expectedPin()});
  expect(authorizedBinding).toEqual({tenantId,repositoryId,serviceId,environment,policyId,ownerAccessScopeId});
  expect(Object.isFrozen(authorizedBinding)).toBe(true);
  expect((await database.pool.query(`SELECT owner_access_scope_id FROM ${schema()}.observation_field_presence_policy_revisions`)).rows)
    .toEqual([{owner_access_scope_id:ownerAccessScopeId}]);
});
