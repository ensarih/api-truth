import {execFile as execFileCallback} from "node:child_process";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {expect,test,vi} from "vitest";
import {createLocalGitAnalysisPorts} from "../../connectors/git-source/src/analysis-ports.js";
import {createOrchestrationRepository,createOrchestrationWorker,applyOrchestrationMigrations} from "../../packages/orchestration/src/index.js";
import {createQueryReader} from "../../packages/query/src/index.js";
import {applyEnvironmentMigrations} from "../../packages/environment/src/migrations.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {createCatalogTestDatabase,quoteCatalogTestSchema} from "./support/database.js";

const git=promisify(execFileCallback);
const tenantId="tenant-multi-input-reuse",repositoryId="repo-multi-input",serviceId="api";
const principalId="reader",scopeId="source-read",configFingerprint="multi-input-config";
const admin={tenantId,principalId:"admin",capabilities:["configuration.admin"]};
const producer={tenantId,principalId:"provider",producerId:"provider",allowedEventTypes:["branch.updated"],
  allowedRepositories:[repositoryId],allowedServices:[serviceId],deploymentAuthorityGrants:[],capabilities:["event.ingest"]};
const workerIdentity={workerId:"multi-input-worker",instanceId:"one",capabilities:["jobs.execute"]};
const config={fingerprint:configFingerprint,document:{config_version:"1.0.0",
  access_scopes:[{access_scope_id:scopeId,label:"Source"}],
  repositories:[{repository_id:repositoryId,provider:"github",locator:"example/multi-input",
    access_scope_id:scopeId,services:[{service_id:serviceId,root:"services/api",
      analyzer:{adapter_id:"nodejs-routing-controllers",adapter_version:"0.9.0",
        resolution_inputs:[{kind:"type_manifest",path:"services/api/routing-profile.json"}]},
      intended_branches:["main"],environments:[]}]}],inference:{enabled:false},logs:{enabled:false}}};
const branchEvent=(eventId:string,revision:string,prior:string|null,sequence:string)=>({event_version:"1.0.0",
  event_id:eventId,event_type:"branch.updated",producer:{producer_id:"provider",adapter_version:"1"},
  occurred_at:"2026-01-01T00:00:00.000Z",received_at:"2026-01-01T00:00:01.000Z",
  subjects:{repository_id:repositoryId,service_ids:[serviceId]},provider_evidence:{provider:"github",
    provider_reference:`delivery-${sequence}`,order:{kind:"sequence",value:sequence}},
  payload:{branch:"main",prior_revision:prior,new_revision:revision,reference_state:"fast_forward"}});

async function sourceTree(){
  const root=await mkdtemp(join(tmpdir(),"api-truth-query-multi-input-"));
  await git("git",["init","-q","-b","main"],{cwd:root});
  await mkdir(join(root,"services/api"),{recursive:true});
  await writeFile(join(root,"services/api/app.ts"),`import { useExpressServer } from "routing-controllers";
    import { OrdersController } from "./orders"; const app = {}; useExpressServer(app,
      {controllers:[OrdersController],routePrefix:process.env.API_PREFIX});`);
  await writeFile(join(root,"services/api/orders.ts"),`import { JsonController, Get, HttpCode } from "routing-controllers";
    @JsonController("/orders") export class OrdersController { @Get() @HttpCode(200) list(): string { return "ok"; } }`);
  const profile={profile_version:"1.0.0",decorator_modules:["routing-controllers"],
    binding:"declarations_only",route_prefix:""};
  await writeFile(join(root,"services/api/routing-profile.json"),JSON.stringify(profile));
  const commit=async(message:string)=>{
    await git("git",["add","-A"],{cwd:root});
    await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm",message],{cwd:root});
    return (await git("git",["rev-parse","HEAD"],{cwd:root})).stdout.trim();
  };
  const first=await commit("source");
  await writeFile(join(root,"services/api/notes.txt"),"unrelated note 1\n");
  const second=await commit("note one");
  await writeFile(join(root,"services/api/notes.txt"),"unrelated note 2\n");
  const third=await commit("note two");
  return {root,first,second,third};
}

test("multi-input source snapshots remain full-analysis when incomplete and refresh when the manifest changes",async()=>{
  const database=await createCatalogTestDatabase();
  const source=await sourceTree();
  const ports=createLocalGitAnalysisPorts({repositories:[{tenantId,repositoryId,repoPath:source.root}],
    limits:{maxFiles:100,maxBytes:1_000_000,timeoutMs:10_000,maxOutputBytes:1_000_000}});
  const resolvedRequests:Awaited<ReturnType<typeof ports.resolver.resolve>>[]=[];
  const proven={analyzer:ports.analyzer,resolver:{release:(request:unknown)=>ports.resolver.release(request as Parameters<typeof ports.resolver.release>[0]),
    resolve:async(input:Parameters<typeof ports.resolver.resolve>[0])=>{
      const result=await ports.resolver.resolve(input);
      resolvedRequests.push(result);
      if(input.baseRevision!==undefined){
        const changes=(await git("git",["diff","--name-only",input.baseRevision,input.immutableRevision],{cwd:source.root})).stdout.trim();
        if(changes==="services/api/notes.txt")return {...result,changedPaths:[],changedPathsComplete:true};
      }
      return result;
    }}};
  try{
    await applyOrchestrationMigrations(database.pool,{schema:database.schema});
    await applyEnvironmentMigrations(database.pool,{schema:database.schema});
    await applyOpenApiMigrations(database.pool,{schema:database.schema});
    const schema=quoteCatalogTestSchema(database.schema);
    const repository=createOrchestrationRepository(database.pool,{schema:database.schema});
    const worker=createOrchestrationWorker(database.pool,{schema:database.schema});
    await repository.registerConfiguration(admin,config);
    await repository.activateInitialConfiguration(admin,{fingerprint:configFingerprint});
    await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active) VALUES($1,$2,true)`,[tenantId,scopeId]);
    await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants(tenant_id,principal_id,access_scope_id,active) VALUES($1,$2,$3,true)`,[tenantId,principalId,scopeId]);
    const analyze=vi.fn((request:Parameters<typeof ports.analyzer.analyze>[0])=>ports.analyzer.analyze(request));
    const run=async(eventId:string,sequence:string,revision:string,prior:string|null)=>{
      await repository.ingestEvent(producer,branchEvent(eventId,revision,prior,sequence));
      const [claim]=await worker.claimJobs(workerIdentity,{limit:1});
      return worker.runJob(workerIdentity,claim!.lease,{...proven,analyzer:{analyze}});
    };
    await expect(run("branch-1","1",source.first,null)).resolves.toMatchObject({state:"succeeded"});
    const baseline=await database.pool.query<{analyzer_status:string;coverage_status:string;resolution_inputs_fingerprint:string|null;diagnostics:unknown}>(
      `SELECT association.analyzer_status,snapshot.document->'coverage'->>'status' AS coverage_status,
         association.resolution_inputs_fingerprint,snapshot.document->'diagnostics' AS diagnostics
       FROM ${schema}.orchestration_revision_snapshots association JOIN ${schema}.catalog_snapshots snapshot
         ON snapshot.tenant_id=association.tenant_id AND snapshot.snapshot_id=association.snapshot_id
       WHERE association.tenant_id=$1 AND association.immutable_revision=$2`,[tenantId,source.first]);
    expect(baseline.rows[0]).toMatchObject({analyzer_status:"partial",coverage_status:"incomplete",
      resolution_inputs_fingerprint:expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      diagnostics:expect.arrayContaining([expect.objectContaining({code:"startup_entrypoint_unverified"})])});
    await expect(run("branch-2","2",source.second,source.first)).resolves.toMatchObject({state:"succeeded"});
    // An empty Git diff cannot turn this profile's incomplete base into a reusable complete contract.
    expect(analyze).toHaveBeenCalledTimes(2);
    const rows=await database.pool.query<{association_kind:string;resolution_inputs_fingerprint:string|null}>(
      `SELECT association_kind,resolution_inputs_fingerprint FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1 AND immutable_revision=$2`,[tenantId,source.second]);
    expect(rows.rows).toMatchObject([{association_kind:"analyzed",resolution_inputs_fingerprint:expect.stringMatching(/^sha256:[a-f0-9]{64}$/)}]);
    expect(resolvedRequests[0]!.request.source.source_digest).toBe(resolvedRequests[1]!.request.source.source_digest);
    expect(resolvedRequests[0]!.request.resolution_inputs[1]!.digest)
      .toBe(resolvedRequests[1]!.request.resolution_inputs[1]!.digest);
    const reader=createQueryReader(database.pool,{schema:database.schema});
    const context={tenantId,principalId};
    await expect(reader.readContract(context,{version:"1",tenantId,repositoryId,serviceId,
      selector:{kind:"revision",revision:source.second}})).resolves.toMatchObject({status:"resolved",
        pin:{revision:source.second},snapshot:{source:{immutable_revision:source.second}}});
    await expect(run("branch-3","3",source.third,source.second)).resolves.toMatchObject({state:"succeeded"});
    await expect(reader.readContract(context,{version:"1",tenantId,repositoryId,serviceId,
      selector:{kind:"branch",branch:"main",expectedPointerVersion:"3"}})).resolves.toMatchObject({status:"resolved",
        pin:{revision:source.third,pointerVersion:"3"},snapshot:{source:{immutable_revision:source.third}}});
    expect(analyze).toHaveBeenCalledTimes(3);
    const updatedProfile={profile_version:"1.0.0",decorator_modules:["routing-controllers"],
      binding:"declarations_only",route_prefix:"/v2"};
    await writeFile(join(source.root,"services/api/routing-profile.json"),JSON.stringify(updatedProfile));
    const fourth=(await git("git",["-C",source.root,"add","-A"]),
      await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","profile update"],{cwd:source.root}),
      (await git("git",["rev-parse","HEAD"],{cwd:source.root})).stdout.trim());
    await expect(run("branch-4","4",fourth,source.third)).resolves.toMatchObject({state:"succeeded"});
    expect(analyze).toHaveBeenCalledTimes(4);
    expect(resolvedRequests[2]!.request.resolution_inputs[1]!.digest)
      .not.toBe(resolvedRequests[3]!.request.resolution_inputs[1]!.digest);
    // The selected JSON profile also participates in this analyzer's source-tree digest;
    // both vectors must be fingerprinted even though the distinct manifest digest is explicit.
    const changed=await reader.readContract(context,{version:"1",tenantId,repositoryId,serviceId,
      selector:{kind:"branch",branch:"main",expectedPointerVersion:"4"}});
    expect(changed).toMatchObject({status:"resolved",pin:{revision:fourth,pointerVersion:"4"},
      snapshot:{endpoints:[{application_path:"/v2/orders"}]}});
  }finally{await ports.dispose();await database.cleanup();await rm(source.root,{recursive:true,force:true});}
});
