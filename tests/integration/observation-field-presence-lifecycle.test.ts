import {generateKeyPairSync,sign} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach,beforeEach,expect,test} from "vitest";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations,createEnvironmentRepository} from "../../packages/environment/src/index.js";
import {canonicalJsonStringify,parseContractSnapshot,type ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyObservationMigrations,createObservationStore,createFieldPresenceOwnerPolicyStore,
  createFieldPresenceImportStore,createFieldPresenceQueryStore,createFieldPresenceMaintenanceStore,
  createFieldPresenceMaintenanceRunner} from "../../packages/observations/src/index.js";
import {createSignedFieldPresenceFileReader} from "../../connectors/observation-file/src/field-presence.js";
import type {FieldPresenceImportReadPort} from "../../packages/observations/src/field-presence-import-store.js";
import {applyOrchestrationMigrations,createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";

const tenantId="tenant-presence-flow",repositoryId="commerce",serviceId="orders",environment="prod";
const policyId="order-response",ownerAccessScopeId="owner-policy",importAccessScopeId="presence-import",readAccessScopeId="presence-read";
const importId="550e8400-e29b-4d4a-a716-446655440000",recordId="550e8400-e29b-4d4a-a716-446655440001";
const scopes=["repository-read","deployment-read","contract-read","source-read",ownerAccessScopeId,importAccessScopeId,readAccessScopeId];
const principalScopes:Readonly<Record<string,readonly string[]>>={
  owner:[...scopes.slice(0,4),ownerAccessScopeId],
  "metadata-importer":scopes.slice(0,4),
  "presence-importer":[...scopes.slice(0,4),ownerAccessScopeId,importAccessScopeId],
  reader:[...scopes.slice(0,4),ownerAccessScopeId,readAccessScopeId],
  janitor:[ownerAccessScopeId],
};
const credentials={owner:Object.freeze({secret:"owner"}),metadata:Object.freeze({secret:"metadata"}),
  presence:Object.freeze({secret:"presence"}),reader:Object.freeze({secret:"reader"}),janitor:Object.freeze({secret:"janitor"})};
let database:CatalogTestDatabase,snapshot:ContractSnapshot;
let pin:{tenantId:string;repositoryId:string;serviceId:string;environment:string;snapshotId:string;revision:string;
  configFingerprint:string;checkpointVersion:string};
let windowStart:string,windowEnd:string,sourceRoot:string|undefined;
const schema=()=>quoteCatalogTestSchema(database.schema);
const context=(principalId:string)=>({tenantId,principalId});
const event=(eventId:string,payload:unknown)=>({event_version:"1.0.0",event_id:eventId,event_type:"deployment.changed",
  producer:{producer_id:"deploy",adapter_version:"1"},occurred_at:"2026-10-09T00:00:00.000Z",received_at:"2026-10-09T00:00:01.000Z",
  subjects:{repository_id:repositoryId,service_ids:[serviceId],environment},provider_evidence:{provider:"deploy",provider_reference:eventId},payload});
const configuration=(fingerprint:string)=>({config_version:"1.0.0",access_scopes:scopes.map(access_scope_id=>({access_scope_id,label:access_scope_id})),
  repositories:[{repository_id:repositoryId,provider:"github",locator:"acme/commerce",access_scope_id:scopes[0],services:[{
    service_id:serviceId,root:"services/orders",analyzer:{adapter_id:"typescript",adapter_version:"1"},intended_branches:["main"],
    environments:[{name:environment,intended_branch:"main",deployment_authority:{adapter_id:"deploy",access_scope_id:scopes[1]}}]}]}],
  inference:{enabled:false},logs:{enabled:true,adapter_id:"gateway-log",credential:{secret_ref:{scheme:"env",locator:"GATEWAY_TOKEN"}}}});
const storagePolicy=(fingerprint:string)=>({version:"field-presence-storage-1",policyId,ownerPolicyRevision:"1",optIn:true,
  tenantId,repositoryId,serviceId,environment,configFingerprint:fingerprint,configActivationCheckpoint:"1",endpointId:"ep-get",
  direction:"response" as const,mediaType:"application/json",statusCode:200,propertyPaths:["/id"],ttlSeconds:3600,maxLiveRecords:5});
const ownerBinding=()=>({tenantId,repositoryId,serviceId,environment,policyId,ownerAccessScopeId});
const importBinding=()=>({...ownerBinding(),importAccessScopeId});
const queryBinding=()=>({...ownerBinding(),readAccessScopeId});
const ownerManager=async(credential:unknown)=>credential===credentials.owner
  ?{tenantId,principalId:"owner",capabilities:["observations.policy.manage"]}:undefined;
const exactPin=()=>({tenantId,repositoryId,serviceId,environment,snapshotId:pin.snapshotId,revision:pin.revision,
  configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion});
const policyRequest=()=>({policy:storagePolicy(pin.configFingerprint),expectedOwnerRevision:"0",
  expectedPin:{snapshotId:pin.snapshotId,revision:pin.revision,checkpointVersion:pin.checkpointVersion}});
const metadataRequest=()=>({importId,expectedPin:exactPin()});

beforeEach(async()=>{
  database=await createCatalogTestDatabase();
  await applyOrchestrationMigrations(database.pool,{schema:database.schema});
  await applyEnvironmentMigrations(database.pool,{schema:database.schema});
  await applyOpenApiMigrations(database.pool,{schema:database.schema});
  await applyObservationMigrations(database.pool,{schema:database.schema});
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  for(const scopeId of scopes)await access.putScope({tenantId},{scopeId,active:true});
  for(const [principalId,allowedScopes] of Object.entries(principalScopes))
    for(const scopeId of allowedScopes)await access.putGrant({tenantId},{principalId,scopeId,active:true});
  snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
  const fingerprint="sha256:"+"c".repeat(64);snapshot.config.config_fingerprint=fingerprint;
  snapshot.source.source_digest="sha256:"+"d".repeat(64);
  const response=snapshot.endpoints.find(endpoint=>endpoint.endpoint_id==="ep-get")!.responses[0]!.content[0]!;
  response.schema={type:"object",properties:{id:{type:"string"}}};
  expect(parseContractSnapshot(snapshot).ok).toBe(true);
  const orchestration=createOrchestrationRepository(database.pool,{schema:database.schema});
  await orchestration.registerConfiguration({tenantId,principalId:"admin",capabilities:["configuration.admin"]},
    {fingerprint,document:configuration(fingerprint)});
  await orchestration.activateInitialConfiguration({tenantId,principalId:"admin",capabilities:["configuration.admin"]},{fingerprint});
  await database.pool.query(`INSERT INTO ${schema()}.catalog_snapshots
    (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,identity_version,
     config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
    VALUES($1,$2,$3,$4,$5,'partial',$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [tenantId,snapshot.snapshot_id,repositoryId,serviceId,snapshot.source.immutable_revision,snapshot.ir_version,snapshot.identity_version,
      fingerprint,snapshotIdentitySha256(snapshot),snapshotContentSha256(snapshot),["contract-read","source-read"],JSON.stringify(snapshot)]);
  const orchestrator= createOrchestrationRepository(database.pool,{schema:database.schema});
  const eventAuth={tenantId,principalId:"deployment",producerId:"deploy",allowedEventTypes:["deployment.changed"],
    allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
      adapterId:"deploy",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]};
  await orchestrator.ingestEvent(eventAuth,event("flow-attempt",{change_kind:"attempt",deployment_id:"flow-attempt",environment,
    attempt_state:"succeeded",effective_order:"1",artifact_id:"flow-artifact",revision:{state:"known",revision:snapshot.source.immutable_revision}}));
  const env=createEnvironmentRepository(database.pool,{schema:database.schema}),worker={workerId:"environment-worker",
    instanceId:"field-presence-lifecycle",capabilities:["jobs.execute"]};
  await env.recordAttempt(worker,{tenantId,producerId:"deploy",eventId:"flow-attempt"});
  await orchestrator.ingestEvent(eventAuth,event("flow-serving",{change_kind:"serving_observation",observation_id:"flow-serving",environment,
    source:{authority_id:"inventory",reference:"flow-serving",access_label:"source-read"},completeness:"complete",effective_order:"1",
    serving_state:{status:"known",inventory:[{artifact_id:"flow-artifact",revision:{state:"known",revision:snapshot.source.immutable_revision}}]}}));
  await env.recordServingObservation(worker,{tenantId,producerId:"deploy",eventId:"flow-serving"});
  const selected=await createQueryReader(database.pool,{schema:database.schema}).readContract(context("reader"),
    {version:"1",tenantId,repositoryId,serviceId,selector:{kind:"environment",environment}});
  if(selected.status!=="resolved")throw new Error("Expected current lifecycle pin");
  pin={tenantId,repositoryId,serviceId,environment,snapshotId:selected.pin.snapshotId,revision:selected.pin.revision,
    configFingerprint:selected.pin.configFingerprint,checkpointVersion:selected.pin.checkpointVersion!};
  const start=(await database.pool.query<{at:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()-interval '20 seconds') AS at")).rows[0]!.at;
  const end=(await database.pool.query<{at:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()-interval '10 seconds') AS at")).rows[0]!.at;
  windowStart=start.toISOString();windowEnd=end.toISOString();
});
afterEach(async()=>{
  try{await database.cleanup();}finally{
    if(sourceRoot){const owned=sourceRoot;sourceRoot=undefined;
      expect(owned.startsWith(join(tmpdir(),"api-truth-presence-capture-"))).toBe(true);
      await rm(owned,{recursive:true,force:true});}
  }
});

test.each(["memory","signed_file","tampered_signed_file","wrong_source_digest_signed_file"] as const)(
  "%s: owner approval, metadata/presence import, read, disable and cleanup compose without persisting values",async mode=>{
  const owners=createFieldPresenceOwnerPolicyStore(database.pool,{schema:database.schema,bindings:[ownerBinding()],authorizeManager:ownerManager});
  const approved=await owners.approve(credentials.owner,policyRequest());
  expect(approved).toMatchObject({status:"approved",ownerPolicyRevision:"1",enabled:true});
  expect(await owners.approve(credentials.owner,policyRequest())).toMatchObject({status:"existing",ownerPolicyRevision:"1",enabled:true});
  const mapping={tenantId,repositoryId,serviceId,environment,snapshotId:pin.snapshotId,revision:pin.revision,
    configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion,mappingId:"gateway-orders",
    publicOrigin:"https://api.example.test",publicPathTemplate:"/public/v2/orders/{orderId}",
    applicationPathTemplate:"/api/orders/:orderId",method:"GET",routingEvidenceIds:["routing-evidence-1"]};
  // Independent synthetic capture uses known fixture facts, not the read request or persisted parent to fabricate an attestation.
  const sourceFixture=Object.freeze({attestation:Object.freeze({tenantId,repositoryId,serviceId,environment,snapshotId:pin.snapshotId,revision:pin.revision,
    sourceDigest:snapshot.source.source_digest,configFingerprint:pin.configFingerprint,checkpointVersion:pin.checkpointVersion,
    importId,recordId,endpointId:"ep-get",direction:"response",mediaType:"application/json",statusCode:200,
    sourceId:"gateway-log",sourceVersion:"log-version-1",windowStart,windowEnd}),
    payloadText:'{"id":"PRIVATE_VALUE_CANARY"}',payloadCompleteness:"complete_unredacted"});
  const fixtureKey=JSON.stringify([tenantId,repositoryId,serviceId,environment,importId,recordId,pin.snapshotId,pin.revision,
    pin.configFingerprint,pin.checkpointVersion,sourceFixture.attestation.sourceId,sourceFixture.attestation.sourceVersion,
    sourceFixture.attestation.windowStart,sourceFixture.attestation.windowEnd]);
  const sourceFixtures=new Map([[fixtureKey,sourceFixture]]);
  const metadata=createObservationStore(database.pool,{schema:database.schema,
    authorizeImporter:async credential=>credential===credentials.metadata
      ?{tenantId,principalId:"metadata-importer",capabilities:["observations.import"]}:undefined,
    readBatch:async()=>({attestation:{revision:pin.revision,sourceId:"gateway-log",sourceVersion:"log-version-1",windowStart,windowEnd},
      mappings:[mapping],records:[{recordId,raw:{url:"https://api.example.test/public/v2/orders/123",method:"GET",statusCode:200,
        revision:pin.revision,body:{id:"PRIVATE_VALUE_CANARY"},headers:{authorization:"PRIVATE_VALUE_CANARY"}}}]})});
  expect(await metadata.importBatch(credentials.metadata,metadataRequest())).toEqual({outcome:"inserted",imported:1});
  expect(await metadata.importBatch(credentials.metadata,metadataRequest())).toEqual({outcome:"existing",imported:1});
  let readSource:FieldPresenceImportReadPort=async(_identity,request)=>{
    const key=JSON.stringify([request.binding.tenantId,request.binding.repositoryId,request.binding.serviceId,request.binding.environment,
      request.importId,request.recordId,request.expectedPin.snapshotId,request.expectedPin.revision,request.expectedPin.configFingerprint,
      request.expectedPin.checkpointVersion,request.source.sourceId,request.source.sourceVersion,request.source.windowStart,request.source.windowEnd]);
    expect(request.selector).toEqual({endpointId:"ep-get",direction:"response",mediaType:"application/json",statusCode:200});
    const exact=sourceFixtures.get(key);if(!exact)throw new Error("NO_MATCHING_CAPTURE_FIXTURE");return exact;
  };
  if(mode!=="memory"){
    sourceRoot=await mkdtemp(join(tmpdir(),"api-truth-presence-capture-"));
    const keypair=generateKeyPairSync("ed25519");
    const captured=mode==="wrong_source_digest_signed_file"
      ?{...sourceFixture,attestation:{...sourceFixture.attestation,sourceDigest:"sha256:"+"e".repeat(64)}}:sourceFixture;
    const payload={version:"field-presence-source-1",...captured};
    const signature=sign(null,Buffer.from(`api-truth:field-presence-source-1\n${canonicalJsonStringify(payload)}`),keypair.privateKey).toString("base64");
    const signed=mode==="tampered_signed_file"?{...payload,payloadText:'{"id":"TAMPERED_CANARY"}'}:payload;
    await writeFile(join(sourceRoot,`${importId}.${recordId}.presence.json`),JSON.stringify({payload:signed,signature}),{flag:"wx",mode:0o600});
    readSource=await createSignedFieldPresenceFileReader({root:sourceRoot,
      publicKeyPem:keypair.publicKey.export({type:"spki",format:"pem"}).toString(),sourceId:"gateway-log",
      bindings:[{tenantId,repositoryId,serviceId,environment}]});
  }
  const importer=createFieldPresenceImportStore(database.pool,{schema:database.schema,bindings:[importBinding()],
    authorizeManager:async credential=>credential===credentials.presence
      ?{tenantId,principalId:"presence-importer",capabilities:["observations.presence.import"]}:undefined,
    readObservation:readSource});
  const importRequest={policyId,ownerPolicyRevision:"1",importId,recordId,expectedPin:exactPin()};
  if(mode==="tampered_signed_file"||mode==="wrong_source_digest_signed_file"){
    await expect(importer.importObservation(credentials.presence,importRequest))
      .rejects.toMatchObject({code:"FIELD_PRESENCE_IMPORT_SOURCE_INVALID",message:"FIELD_PRESENCE_IMPORT_SOURCE_INVALID"});
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]!.count).toBe(0);
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_records`)).rows[0]!.count).toBe(1);
    return;
  }
  expect(await importer.importObservation(credentials.presence,importRequest)).toEqual({status:"inserted",fieldCount:1});
  expect(await importer.importObservation(credentials.presence,importRequest)).toEqual({status:"existing",fieldCount:1});
  const readers=createFieldPresenceQueryStore(database.pool,{schema:database.schema,bindings:[queryBinding()],
    authorizeManager:async credential=>credential===credentials.reader
      ?{tenantId,principalId:"reader",capabilities:["observations.presence.read"]}:undefined});
  const readerRequest={policyId,ownerPolicyRevision:"1",expectedPin:exactPin(),limit:10};
  const result=await readers.readForPrincipal(credentials.reader,{tenantId,principalId:"reader"},readerRequest);
  expect(result).toMatchObject({status:"resolved",kind:"observed_field_presence",nonNormative:true,
    pin:{...exactPin(),sourceDigest:snapshot.source.source_digest},policy:{policyId,ownerPolicyRevision:"1",endpointId:"ep-get",
      direction:"response",mediaType:"application/json",statusCode:200,propertyPaths:["/id"]},
    records:[{importId,recordId,fields:[{path:"/id",state:"present"}]}],truncated:false});
  expect(JSON.stringify(result)).not.toContain("PRIVATE_VALUE_CANARY");
  const persisted=await database.pool.query(`SELECT row_to_json(result)::text AS result FROM ${schema()}.observation_field_presence_results result`);
  expect(persisted.rows).toHaveLength(1);expect(JSON.stringify(persisted.rows)).not.toContain("PRIVATE_VALUE_CANARY");
  const meta=await database.pool.query(`SELECT row_to_json(item)::text AS item FROM ${schema()}.observation_records item`);
  expect(meta.rows).toHaveLength(1);expect(JSON.stringify(meta.rows)).not.toContain("PRIVATE_VALUE_CANARY");
  const persistedImports=await database.pool.query(`SELECT row_to_json(item)::text AS item FROM ${schema()}.observation_imports item`);
  expect(persistedImports.rows).toHaveLength(1);expect(JSON.stringify(persistedImports.rows)).not.toContain("PRIVATE_VALUE_CANARY");

  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  await access.putGrant({tenantId},{principalId:"reader",scopeId:readAccessScopeId,active:false});
  await expect(readers.readForPrincipal(credentials.reader,{tenantId,principalId:"reader"},readerRequest))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_UNAUTHORIZED"});
  await access.putGrant({tenantId},{principalId:"reader",scopeId:readAccessScopeId,active:true});
  expect((await readers.readForPrincipal(credentials.reader,{tenantId,principalId:"reader"},readerRequest)).records).toHaveLength(1);
  await expect(owners.disable(credentials.owner,{tenantId,repositoryId,serviceId,environment,policyId,expectedOwnerRevision:"1"}))
    .resolves.toMatchObject({status:"disabled",enabled:false});
  await expect(readers.readForPrincipal(credentials.reader,{tenantId,principalId:"reader"},readerRequest))
    .rejects.toMatchObject({code:"FIELD_PRESENCE_QUERY_STALE"});
  const maintenance=createFieldPresenceMaintenanceStore(database.pool,{schema:database.schema,bindings:[ownerBinding()],
    authorizeManager:async credential=>credential===credentials.janitor
      ?{tenantId,principalId:"janitor",capabilities:["observations.presence.cleanup"]}:undefined});
  const runner=createFieldPresenceMaintenanceRunner({maintenance,bindings:[ownerBinding()],batchLimit:10,
    credentialForBinding:async()=>credentials.janitor});
  try{expect(await runner.runOnce()).toEqual({status:"completed",attempted:1,succeeded:1,failed:0});}
  finally{await runner.stop();}
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_field_presence_results`)).rows[0]!.count).toBe(0);
  expect((await database.pool.query(`SELECT reason FROM ${schema()}.observation_field_presence_tombstones`)).rows)
    .toEqual([{reason:"deleted"}]);
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_imports`)).rows[0]!.count).toBe(1);
  expect((await database.pool.query(`SELECT count(*)::int AS count FROM ${schema()}.observation_records`)).rows[0]!.count).toBe(1);
});
