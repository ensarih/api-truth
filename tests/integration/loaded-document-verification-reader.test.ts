import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {snapshotContentSha256,snapshotIdentitySha256} from "../../packages/catalog/src/canonical.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyEnvironmentMigrations,createEnvironmentRepository} from "../../packages/environment/src/index.js";
import {type ContractSnapshot} from "../../packages/ir/src/index.js";
import {applyOrchestrationMigrations,createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createLoadedDocumentVerificationAdmissionStore} from "../../packages/orchestration/src/loaded-document-verification-admission.js";
import {createLoadedDocumentVerificationRunner} from "../../packages/orchestration/src/loaded-document-verification-runner.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {createLoadedDocumentVerificationReadStore,type LoadedDocumentReadAuthorizer,
  type LoadedDocumentReadManager} from "../../packages/query/src/loaded-document-verification-reader.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema,type CatalogTestDatabase} from "./support/database.js";
import {createLoadedDocumentProofFixture,loadedDocumentServiceRoot} from "./support/loaded-document-proof-fixture.js";

const tenantId="tenant-loaded-read",principalId="loaded-reader",repositoryId="repository",serviceId="orders",environment="test";
const repositoryScope="repository-read",deploymentScope="deployment-read",contractScope="contract-read",sourceScope="source-read";
const importCredential=Object.freeze({opaque:"read-manager-token"});
const scopes=[repositoryScope,deploymentScope,contractScope,sourceScope];
const admin={tenantId,principalId:"admin",capabilities:["configuration.admin"]};
const sourceRoot=loadedDocumentServiceRoot;
const sourceDigest=(text:string)=>`sha256:${createHash("sha256").update(text).digest("hex")}`;
import {createHash} from "node:crypto";
const hash=sourceDigest;
const configDocument=(fingerprint:string)=>({config_version:"1.0.0",
  access_scopes:scopes.map(access_scope_id=>({access_scope_id,label:access_scope_id})),
  repositories:[{repository_id:repositoryId,provider:"github",locator:"public/example",access_scope_id:repositoryScope,
    services:[{service_id:serviceId,root:sourceRoot,analyzer:{adapter_id:"openapi_document",adapter_version:"0.2.0"},
      intended_branches:["main"],environments:[{name:environment,intended_branch:"main",
        deployment_authority:{adapter_id:"deployment",access_scope_id:deploymentScope}}]}]}],
  inference:{enabled:false},logs:{enabled:false}});
const event=(eventId:string,payload:unknown)=>({event_version:"1.0.0",event_id:eventId,event_type:"deployment.changed",
  producer:{producer_id:"deployment",adapter_version:"1"},occurred_at:"2026-10-09T00:00:00.000Z",received_at:"2026-10-09T00:00:01.000Z",
  subjects:{repository_id:repositoryId,service_ids:[serviceId],environment},provider_evidence:{provider:"deployment",provider_reference:eventId},payload});
let database:CatalogTestDatabase,root:string,fixture:Awaited<ReturnType<typeof createLoadedDocumentProofFixture>>;
let configFingerprint:string,activationCheckpoint="1",pin:{snapshotId:string;revision:string;configFingerprint:string;checkpointVersion:string};
let loadedReadAuth:LoadedDocumentReadAuthorizer;
const schema=()=>quoteCatalogTestSchema(database.schema);
const expectedPin=()=>({tenantId,repositoryId,serviceId,environment,...pin});
const authorizeManager:LoadedDocumentReadManager=(credential)=>credential===importCredential
  ?Promise.resolve({tenantId,principalId,capabilities:["swagger.document.verify.read"]}):Promise.resolve(undefined);
const readStore=(authorizeRead:LoadedDocumentReadAuthorizer=async()=>true)=>createLoadedDocumentVerificationReadStore(database.pool,{schema:database.schema,
  tenantId,bindings:[{scope:fixture.scope,serviceRoot:sourceRoot,captureIdentityDigest:fixture.association.captureIdentityDigest,
    loadIdentityDigest:loadedIdentity}],authorizeManager,authorizeRead});
let loadedIdentity:string;

beforeEach(async()=>{
  database=await createCatalogTestDatabase();root=await mkdtemp(join(tmpdir(),"loaded-document-read-repo-"));
  try{
    await applyOrchestrationMigrations(database.pool,{schema:database.schema});
    await applyEnvironmentMigrations(database.pool,{schema:database.schema});
    await applyOpenApiMigrations(database.pool,{schema:database.schema});
    const access=createAccessPolicyStore(database.pool,{schema:database.schema});
    for(const scopeId of scopes){await access.putScope({tenantId},{scopeId,active:true});await access.putGrant({tenantId},{principalId,scopeId,active:true});}
    const placeholder={tenantId,repositoryId,serviceId,environment,immutableRevision:"a".repeat(40),sourceDigest:`sha256:${"b".repeat(64)}`};
    fixture=await createLoadedDocumentProofFixture(database.pool,database.schema,placeholder,root,async()=>true);
    const orchestration=createOrchestrationRepository(database.pool,{schema:database.schema});
    const registered=await orchestration.registerConfiguration(admin,{fingerprint:`sha256:${"c".repeat(64)}`,
      document:configDocument(`sha256:${"c".repeat(64)}`)});
    configFingerprint=registered.fingerprint;
    await orchestration.activateInitialConfiguration(admin,{fingerprint:configFingerprint});
    const snapshot=JSON.parse(await readFile(new URL("../fixtures/ir/express-snapshot.json",import.meta.url),"utf8")) as ContractSnapshot;
    snapshot.config.config_fingerprint=configFingerprint;snapshot.source.immutable_revision=fixture.scope.immutableRevision;
    snapshot.source.source_digest=fixture.scope.sourceDigest;snapshot.source.repository_id=repositoryId;
    snapshot.service.repository_id=repositoryId;
    for(const evidence of snapshot.evidence){evidence.source.source_id=repositoryId;
      evidence.source_version=fixture.scope.immutableRevision;evidence.access_label=contractScope;}
    await database.pool.query(`INSERT INTO ${schema()}.catalog_snapshots
      (tenant_id,snapshot_id,repository_id,service_id,immutable_revision,analyzer_status,ir_version,identity_version,
       config_fingerprint,identity_sha256,content_sha256,required_scope_ids,document)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [tenantId,snapshot.snapshot_id,repositoryId,serviceId,fixture.scope.immutableRevision,
        snapshot.coverage.status==="complete"?"success":"partial",snapshot.ir_version,snapshot.identity_version,
        configFingerprint,snapshotIdentitySha256(snapshot),
        snapshotContentSha256(snapshot),[contractScope],JSON.stringify(snapshot)]);
    const envRepo=createEnvironmentRepository(database.pool,{schema:database.schema});
    await orchestration.ingestEvent({tenantId,principalId:"deployment",producerId:"deployment",allowedEventTypes:["deployment.changed"],
      allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
      adapterId:"deployment",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]},
      event("loaded-read-attempt",{change_kind:"attempt",deployment_id:"loaded-read-attempt",environment,attempt_state:"succeeded",
        effective_order:"1",artifact_id:"artifact-loaded-read",revision:{state:"known",revision:fixture.scope.immutableRevision}}));
    await envRepo.recordAttempt({workerId:"environment-worker",instanceId:"loaded-read",capabilities:["jobs.execute"]},
      {tenantId,producerId:"deployment",eventId:"loaded-read-attempt"});
    await orchestration.ingestEvent({tenantId,principalId:"deployment",producerId:"deployment",allowedEventTypes:["deployment.changed"],
      allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[{repositoryId,serviceId,environment,
        adapterId:"deployment",sourceAuthorityIds:["inventory"]}],capabilities:["event.ingest"]},
      event("loaded-read-serving",{change_kind:"serving_observation",observation_id:"loaded-read-serving",environment,
        source:{authority_id:"inventory",reference:"loaded-read-serving",access_label:sourceScope},completeness:"complete",
        effective_order:"1",serving_state:{status:"known",inventory:[{artifact_id:"artifact-loaded-read",
          revision:{state:"known",revision:fixture.scope.immutableRevision}}]}}));
    await envRepo.recordServingObservation({workerId:"environment-worker",instanceId:"loaded-read",capabilities:["jobs.execute"]},
      {tenantId,producerId:"deployment",eventId:"loaded-read-serving"});
    const query=await createQueryReader(database.pool,{schema:database.schema}).readContract({tenantId,principalId},
      {version:"1",tenantId,repositoryId,serviceId,selector:{kind:"environment",environment}});
    if(query.status!=="resolved")throw new Error("Expected current service selection");
    pin={snapshotId:query.pin.snapshotId,revision:query.pin.revision,configFingerprint:query.pin.configFingerprint,
      checkpointVersion:query.pin.checkpointVersion!};
    const admission=createLoadedDocumentVerificationAdmissionStore(database.pool,{schema:database.schema,tenantId,
      principalId,bindings:[{scope:fixture.scope,serviceRoot:sourceRoot,captureIdentityDigest:fixture.association.captureIdentityDigest,
        loadArtifactRef:fixture.loadBinding.loadArtifactRef,loadConfiguredKeyRef:fixture.loadBinding.loadConfiguredKeyRef,
        loadEnvelopeDigest:fixture.loadBinding.loadEnvelopeDigest,loadSignerSpkiDigest:fixture.loadBinding.loadSignerSpkiDigest}],
      preflightAuthorize:async()=>true,authorizeLoadedDocument:async()=>true});
    const admitted=await admission.admit({captureIdentityDigest:fixture.association.captureIdentityDigest});
    loadedIdentity=admitted.loadIdentityDigest;activationCheckpoint="1";
    const runner=createLoadedDocumentVerificationRunner(database.pool,{schema:database.schema,tenantId,principalId,
      workerId:"loaded-reader-worker",instanceId:"loaded-reader-instance",allowedRepositories:[repositoryId],
      allowedServices:[serviceId],preflightAuthorize:async()=>true,authorizeLoadedDocument:async()=>true,
      verificationPortFactory:async()=>fixture.loadedPort});
    const run=await runner.runOne();if(run.kind!=="succeeded")throw new Error("Expected completed loaded-document verification");
    await database.pool.query(`CREATE TABLE ${schema()}.trusted_loaded_document_read_grants
      (tenant_id text NOT NULL,principal_id text NOT NULL,load_identity_digest text NOT NULL,
       source_allowed boolean NOT NULL,environment_allowed boolean NOT NULL,artifact_allowed boolean NOT NULL,
       source_digest text NOT NULL,config_activation_checkpoint bigint NOT NULL,
       PRIMARY KEY(tenant_id,principal_id,load_identity_digest))`);
    await database.pool.query(`INSERT INTO ${schema()}.trusted_loaded_document_read_grants VALUES($1,$2,$3,true,true,true,$4,1)`,
      [tenantId,principalId,loadedIdentity,fixture.scope.sourceDigest]);
    loadedReadAuth=async(client,binding)=>{
      const result=await client.query(`SELECT source_allowed,environment_allowed,artifact_allowed,source_digest,
        config_activation_checkpoint::text FROM trusted_loaded_document_read_grants WHERE tenant_id=$1
        AND principal_id=$2 AND load_identity_digest=$3 FOR SHARE`,[binding.scope.tenantId,binding.principalId,binding.loadIdentityDigest]);
      const grant=result.rows[0];return result.rows.length===1&&grant.source_allowed===true&&grant.environment_allowed===true
        &&grant.artifact_allowed===true&&grant.source_digest===binding.scope.sourceDigest
        &&grant.config_activation_checkpoint===binding.configActivationCheckpoint;
    };
  }catch(error){await database.cleanup();await rm(root,{recursive:true,force:true});throw error;}
});
afterEach(async()=>{await database.cleanup();await rm(root,{recursive:true,force:true});});

test("reads current controlled-load verification metadata only, without requiring logs opt-in",async()=>{
  const before=await database.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.load_identity_digest) FROM ${schema()}.orchestration_observed_loaded_document_verifications row) AS summaries,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.job_id) FROM ${schema()}.orchestration_loaded_document_verification_job_state row) AS states,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.job_id) FROM ${schema()}.orchestration_loaded_document_verification_results row) AS results,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.environment) FROM ${schema()}.environment_serving_checkpoints row) AS checkpoints,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.snapshot_id) FROM ${schema()}.catalog_branch_pointers row) AS pointers`);
  const store=readStore(loadedReadAuth);
  const result=await store.readForPrincipal(importCredential,{tenantId,principalId},
    {loadIdentityDigest:loadedIdentity,expectedPin:expectedPin(),configActivationCheckpoint:activationCheckpoint});
  expect(result).toMatchObject({status:"resolved",kind:"controlled_loaded_swagger_document_verification",nonNormative:true,
    pin:{...pin,tenantId,repositoryId,serviceId,environment,sourceDigest:fixture.scope.sourceDigest,configActivationCheckpoint:"1"},
    verification:{profileVersion:"swagger-loaded-document-1",loadIdentityDigest:loadedIdentity,
      captureIdentityDigest:fixture.association.captureIdentityDigest,handlerCount:1,matchCount:1,unobservedDiagnosticCount:0},
    document:{path:"api/swagger/swagger.yaml",rawSha256:expect.stringMatching(/^sha256:/),
      canonicalValueSha256:expect.stringMatching(/^sha256:/)}});
  const text=JSON.stringify(result);
  expect(text).not.toContain(fixture.loadBinding.loadArtifactRef);
  expect(text).not.toContain(fixture.loadBinding.loadConfiguredKeyRef);
  expect(text).not.toContain("readOrder");expect(text).not.toContain("orders/{id}");
  const after=await database.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.load_identity_digest) FROM ${schema()}.orchestration_observed_loaded_document_verifications row) AS summaries,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.job_id) FROM ${schema()}.orchestration_loaded_document_verification_job_state row) AS states,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.job_id) FROM ${schema()}.orchestration_loaded_document_verification_results row) AS results,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.environment) FROM ${schema()}.environment_serving_checkpoints row) AS checkpoints,
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.snapshot_id) FROM ${schema()}.catalog_branch_pointers row) AS pointers`);
  expect(after.rows[0]).toEqual(before.rows[0]);
});

test("principal anchor mismatch and manager denial fail before storage",async()=>{
  const connect=vi.spyOn(database.pool,"connect");
  const store=readStore(loadedReadAuth);
  await expect(store.readForPrincipal(importCredential,{tenantId,principalId:"other"},
    {loadIdentityDigest:loadedIdentity,expectedPin:expectedPin(),configActivationCheckpoint:activationCheckpoint}))
    .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_UNAUTHORIZED"});
  expect(connect).not.toHaveBeenCalled();connect.mockRestore();
  const denied=readStore(async()=>false);
  await expect(denied.readForPrincipal(importCredential,{tenantId,principalId},
    {loadIdentityDigest:loadedIdentity,expectedPin:expectedPin(),configActivationCheckpoint:activationCheckpoint}))
    .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_UNAUTHORIZED"});
});

test("stale pin or activation epoch is withheld",async()=>{
  const store=readStore(loadedReadAuth);
  await expect(store.readForPrincipal(importCredential,{tenantId,principalId},
    {loadIdentityDigest:loadedIdentity,expectedPin:{...expectedPin(),checkpointVersion:"999"},configActivationCheckpoint:"1"}))
    .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_STALE"});
  await expect(store.readForPrincipal(importCredential,{tenantId,principalId},
    {loadIdentityDigest:loadedIdentity,expectedPin:expectedPin(),configActivationCheckpoint:"2"}))
    .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_STALE"});
});

test.each([sourceScope,deploymentScope])("configured %s source grant revocation is checked under the read transaction",async(scopeId)=>{
  const access=createAccessPolicyStore(database.pool,{schema:database.schema});
  await access.putGrant({tenantId},{principalId,scopeId,active:false});
  const store=readStore(loadedReadAuth);
  await expect(store.readForPrincipal(importCredential,{tenantId,principalId},
    {loadIdentityDigest:loadedIdentity,expectedPin:expectedPin(),configActivationCheckpoint:activationCheckpoint}))
    .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_UNAUTHORIZED"});
});

test.each(["source_allowed","environment_allowed","artifact_allowed"] as const)(
  "an independently revoked %s grant withholds the controlled-load summary",async(flag)=>{
    await database.pool.query(`UPDATE ${schema()}.trusted_loaded_document_read_grants SET ${flag}=false
      WHERE tenant_id=$1 AND principal_id=$2 AND load_identity_digest=$3`,[tenantId,principalId,loadedIdentity]);
    await expect(readStore(loadedReadAuth).readForPrincipal(importCredential,{tenantId,principalId},
      {loadIdentityDigest:loadedIdentity,expectedPin:expectedPin(),configActivationCheckpoint:activationCheckpoint}))
      .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_UNAUTHORIZED"});
  });

test("a configuration activation epoch switchback does not revive an older loaded job",async()=>{
  await database.pool.query(`UPDATE ${schema()}.orchestration_active_configurations SET checkpoint_version=3
    WHERE tenant_id=$1 AND config_fingerprint=$2`,[tenantId,configFingerprint]);
  await database.pool.query(`UPDATE ${schema()}.trusted_loaded_document_read_grants SET config_activation_checkpoint=3
    WHERE tenant_id=$1 AND principal_id=$2 AND load_identity_digest=$3`,[tenantId,principalId,loadedIdentity]);
  await expect(readStore(loadedReadAuth).readForPrincipal(importCredential,{tenantId,principalId},
    {loadIdentityDigest:loadedIdentity,expectedPin:expectedPin(),configActivationCheckpoint:"3"}))
    .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_UNAVAILABLE"});
});

test("an admitted but unfinished loaded-document job has no readable verification summary",async()=>{
  const admission=createLoadedDocumentVerificationAdmissionStore(database.pool,{schema:database.schema,tenantId,
    principalId,bindings:[{scope:fixture.scope,serviceRoot:sourceRoot,captureIdentityDigest:fixture.association.captureIdentityDigest,
      loadArtifactRef:`${fixture.loadBinding.loadArtifactRef}-pending`,loadConfiguredKeyRef:fixture.loadBinding.loadConfiguredKeyRef,
      loadEnvelopeDigest:fixture.loadBinding.loadEnvelopeDigest,loadSignerSpkiDigest:fixture.loadBinding.loadSignerSpkiDigest}],
    preflightAuthorize:async()=>true,authorizeLoadedDocument:async()=>true});
  const pending=await admission.admit({captureIdentityDigest:fixture.association.captureIdentityDigest});
  const reader=createLoadedDocumentVerificationReadStore(database.pool,{schema:database.schema,tenantId,
    bindings:[{scope:fixture.scope,serviceRoot:sourceRoot,captureIdentityDigest:fixture.association.captureIdentityDigest,
      loadIdentityDigest:pending.loadIdentityDigest}],authorizeManager,authorizeRead:async()=>true});
  await expect(reader.readForPrincipal(importCredential,{tenantId,principalId},
    {loadIdentityDigest:pending.loadIdentityDigest,expectedPin:expectedPin(),configActivationCheckpoint:activationCheckpoint}))
    .rejects.toMatchObject({code:"LOADED_DOCUMENT_READ_UNAVAILABLE"});
});
