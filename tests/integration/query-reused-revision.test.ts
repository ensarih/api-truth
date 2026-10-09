import {execFile as execFileCallback} from "node:child_process";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {expect, test} from "vitest";
import {createLocalGitAnalysisPorts} from "../../connectors/git-source/src/analysis-ports.js";
import {applyOrchestrationMigrations, createOrchestrationRepository,
  createOrchestrationWorker} from "../../packages/orchestration/src/index.js";
import {applyEnvironmentMigrations} from "../../packages/environment/src/migrations.js";
import {applyOpenApiMigrations} from "../../packages/openapi/src/migrations.js";
import {createQueryReader, readQueryContractWithClient} from "../../packages/query/src/index.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";

const git = promisify(execFileCallback);
const tenantId = "tenant-reused-source";
const repositoryId = "source-repo";
const serviceId = "source-api";
const principalId = "reader";
const sourceScope = "source-read";
const deploymentScope = "deploy-read";
const configFingerprint = "reused-source-config";
const configured = {fingerprint: configFingerprint, document: {
  config_version: "1.0.0", access_scopes: [
    {access_scope_id: sourceScope, label: "Source"},
    {access_scope_id: deploymentScope, label: "Deployment"},
  ],
  repositories: [{repository_id: repositoryId, provider: "github", locator: "example/source",
    access_scope_id: sourceScope,
    services: [{service_id: serviceId, root: "services/api",
      analyzer: {adapter_id: "typescript-express", adapter_version: "0.6.0", ir_version: "1.0.0"},
      intended_branches: ["main"], environments: [{name: "uat", intended_branch: "main",
        deployment_authority: {adapter_id: "deploy", access_scope_id: deploymentScope}}]}]}],
  inference: {enabled: false}, logs: {enabled: false},
}};
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const producer = {tenantId, principalId: "provider", producerId: "provider",
  allowedEventTypes: ["branch.updated"], allowedRepositories: [repositoryId],
  allowedServices: [serviceId], deploymentAuthorityGrants: [], capabilities: ["event.ingest"]};
const workerIdentity = {workerId: "source-worker", instanceId: "one", capabilities: ["jobs.execute"]};
const context = {tenantId, principalId};
const selection = (selector: object) => ({version: "1", tenantId, repositoryId, serviceId, selector});
const branchEvent = (revision: string, priorRevision: string | null, sequence: string) => ({
  event_version: "1.0.0", event_id: `branch-${sequence}`, event_type: "branch.updated",
  producer: {producer_id: "provider", adapter_version: "1"},
  occurred_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:01.000Z",
  subjects: {repository_id: repositoryId, service_ids: [serviceId]},
  provider_evidence: {provider: "github", provider_reference: `delivery-${sequence}`,
    order: {kind: "sequence", value: sequence}},
  payload: {branch: "main", prior_revision: priorRevision, new_revision: revision,
    reference_state: "fast_forward"},
});

async function sourceRepository() {
  const root = await mkdtemp(join(tmpdir(), "api-truth-query-reused-"));
  await git("git", ["init", "-q", "-b", "main"], {cwd: root});
  await mkdir(join(root, "services/api"), {recursive: true});
  await writeFile(join(root, "services/api/index.ts"),
    "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => { res.status(200).type('application/json').json({ok:true}); });\n");
  const commit = async (message: string) => {
    await git("git", ["add", "-A"], {cwd: root});
    await git("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message], {cwd: root});
    return (await git("git", ["rev-parse", "HEAD"], {cwd: root})).stdout.trim();
  };
  const firstRevision = await commit("source");
  await writeFile(join(root, "services/api/notes.txt"), "Unrelated non-source note.\n");
  const secondRevision = await commit("note");
  await writeFile(join(root, "services/api/notes.txt"), "Another unrelated non-source note.\n");
  const thirdRevision = await commit("note updated");
  return {root, firstRevision, secondRevision, thirdRevision};
}

test("authorized revision, branch and serving reads follow an exact complete source reuse association", async () => {
  const database = await createCatalogTestDatabase();
  const source = await sourceRepository();
  const ports = createLocalGitAnalysisPorts({repositories: [{tenantId, repositoryId, repoPath: source.root}],
    limits: {maxFiles: 100, maxBytes: 1_000_000, timeoutMs: 10_000, maxOutputBytes: 1_000_000}});
  // The source connector intentionally withholds a complete change list. This fixture knows the only
  // commit delta is an ignored text note, so it supplies the existing D08 source-reuse proof explicitly.
  const provenPorts = {analyzer: ports.analyzer, resolver: {
    release: (request: unknown) => ports.resolver.release(request as Parameters<typeof ports.resolver.release>[0]),
    resolve: async (input: Parameters<typeof ports.resolver.resolve>[0]) => {
      const result = await ports.resolver.resolve(input);
      if (input.baseRevision !== undefined) {
        const diff = await git("git", ["diff", "--name-only", input.baseRevision, input.immutableRevision], {cwd: source.root});
        expect(diff.stdout.trim()).toBe("services/api/notes.txt");
        return {...result, changedPaths: [], changedPathsComplete: true};
      }
      return result;
    },
  }};
  try {
    await applyOrchestrationMigrations(database.pool, {schema: database.schema});
    await applyEnvironmentMigrations(database.pool, {schema: database.schema});
    await applyOpenApiMigrations(database.pool, {schema: database.schema});
    const schema = quoteCatalogTestSchema(database.schema);
    const repository = createOrchestrationRepository(database.pool, {schema: database.schema});
    const worker = createOrchestrationWorker(database.pool, {schema: database.schema});
    await repository.registerConfiguration(admin, configured);
    await repository.activateInitialConfiguration(admin, {fingerprint: configFingerprint});
    for (const scopeId of [sourceScope, deploymentScope]) {
      await database.pool.query(`INSERT INTO ${schema}.access_scopes (tenant_id,access_scope_id,active)
        VALUES ($1,$2,true)`, [tenantId, scopeId]);
      await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants
        (tenant_id,principal_id,access_scope_id,active) VALUES ($1,$2,$3,true)`, [tenantId, principalId, scopeId]);
    }
    await repository.ingestEvent(producer, branchEvent(source.firstRevision, null, "1"));
    const [first] = await worker.claimJobs(workerIdentity, {limit: 1});
    const firstOutcome = await worker.runJob(workerIdentity, first!.lease, provenPorts);
    expect(firstOutcome.state).toBe("succeeded");
    const firstPointer = await database.pool.query<{snapshot_id: string}>(
      `SELECT snapshot_id FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1 AND branch='main'`, [tenantId]);
    const snapshotId = firstPointer.rows[0]!.snapshot_id;
    const initialSnapshot = await database.pool.query<{analyzer_status: string; document: {
      diagnostics: Array<{code: string}>}}>(`SELECT analyzer_status,document FROM ${schema}.catalog_snapshots
        WHERE tenant_id=$1 AND snapshot_id=$2`, [tenantId,snapshotId]);
    expect(initialSnapshot.rows[0]?.analyzer_status).toBe("success");
    await repository.ingestEvent(producer, branchEvent(source.secondRevision, source.firstRevision, "2"));
    const [second] = await worker.claimJobs(workerIdentity, {limit: 1});
    const secondOutcome = await worker.runJob(workerIdentity, second!.lease, provenPorts);
    expect(secondOutcome).toMatchObject({state: "succeeded"});
    const secondPointer = await database.pool.query<{snapshot_id: string}>(
      `SELECT snapshot_id FROM ${schema}.catalog_branch_pointers WHERE tenant_id=$1 AND branch='main'`, [tenantId]);
    expect(secondPointer.rows[0]?.snapshot_id).toBe(snapshotId);
    const reused = await database.pool.query<{association_kind: string; analyzer_status: string;
      resolution_inputs_fingerprint: string | null}>(
      `SELECT association_kind,analyzer_status,resolution_inputs_fingerprint
       FROM ${schema}.orchestration_revision_snapshots WHERE tenant_id=$1 AND immutable_revision=$2`,
      [tenantId, source.secondRevision]);
    expect(reused.rows).toMatchObject([{association_kind: "reused", analyzer_status: "success",
      resolution_inputs_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)}]);
    const reader = createQueryReader(database.pool, {schema: database.schema});
    const revision = selection({kind: "revision", revision: source.secondRevision});
    const revised = await reader.readContract(context, revision);
    expect(revised).toMatchObject({status: "resolved", pin: {snapshotId,
      revision: source.firstRevision, selectedRevision: source.secondRevision}, snapshot: {source: {immutable_revision: source.firstRevision},
      coverage: {status: "complete"}}});
    const branch = selection({kind: "branch", branch: "main", expectedPointerVersion: "2"});
    expect(await reader.readContract(context, branch)).toMatchObject({status: "resolved",
      pin: {snapshotId, revision: source.firstRevision, selectedRevision: source.secondRevision,
        pointerVersion: "2"}});
    await database.pool.query(`UPDATE ${schema}.orchestration_branch_checkpoints SET desired_revision=$3
      WHERE tenant_id=$1 AND branch=$2`, [tenantId,"main","queued-new-revision"]);
    await expect(reader.readContract(context, branch)).rejects.toMatchObject({code: "QUERY_STALE_SELECTION"});
    await database.pool.query(`UPDATE ${schema}.orchestration_branch_checkpoints SET desired_revision=$3
      WHERE tenant_id=$1 AND branch=$2`, [tenantId,"main",source.secondRevision]);

    for (const eventId of ["serving", "attempt"]) {
      await database.pool.query(`INSERT INTO ${schema}.orchestration_events
        (tenant_id,producer_id,event_id,event_sha256,event_type,repository_id,service_ids,document,
         adapter_version,provider,provider_reference,active_config_fingerprint)
        VALUES ($1,'deploy',$2,$3,'deployment.changed',$4,ARRAY[$5],$6,'1','test',$2,$7)`,
      [tenantId,eventId,`sha256:${"a".repeat(64)}`,repositoryId,serviceId,JSON.stringify({}),configFingerprint]);
    }
    await database.pool.query(`INSERT INTO ${schema}.environment_serving_observations
      (tenant_id,producer_id,event_id,repository_id,service_id,environment,observation_id,
       source_authority_id,source_access_label,effective_order,completeness,serving_status,inventory,
       active_config_fingerprint,disposition)
      VALUES ($1,'deploy','serving',$2,$3,'uat','observation-1','inventory',$4,'1','complete','known',$5,$6,'applied')`,
      [tenantId,repositoryId,serviceId,sourceScope,
        JSON.stringify([{artifact_id: "artifact-a", revision: {state: "known", revision: source.secondRevision}}]),configFingerprint]);
    await database.pool.query(`INSERT INTO ${schema}.environment_serving_checkpoints
      (tenant_id,repository_id,service_id,environment,current_producer_id,current_event_id,version)
      VALUES ($1,$2,$3,'uat','deploy','serving',7)`, [tenantId,repositoryId,serviceId]);
    await database.pool.query(`INSERT INTO ${schema}.environment_deployment_attempts
      (tenant_id,producer_id,event_id,repository_id,service_id,environment,deployment_id,attempt_state,
       effective_order,artifact_id,revision_state,revision,active_config_fingerprint)
      VALUES ($1,'deploy','attempt',$2,$3,'uat','deploy-1','succeeded',
        '1','artifact-a','known',$4,$5)`, [tenantId,repositoryId,serviceId,source.secondRevision,configFingerprint]);
    await database.pool.query(`INSERT INTO ${schema}.environment_artifact_bindings
      (tenant_id,repository_id,service_id,artifact_id,revision,first_producer_id,first_event_id)
      VALUES ($1,$2,$3,'artifact-a',$4,'deploy','attempt')`,
    [tenantId,repositoryId,serviceId,source.secondRevision]);
    const environment = selection({kind: "environment", environment: "uat", expectedCheckpointVersion: "7"});
    expect(await reader.readContract(context, environment)).toMatchObject({status: "resolved",
      pin: {snapshotId, revision: source.firstRevision, selectedRevision: source.secondRevision,
        checkpointVersion: "7"}, publication: {status: "absent"}});
    expect(await reader.readMetadataObservations(context, environment, {limit: 10}))
      .toMatchObject({status: "unknown"});
    expect(await reader.readOperationCandidates(context, environment, {intentQuery: "health"}))
      .toMatchObject({status: "unknown", reason: "invalid_input"});
    const client=await database.pool.connect();
    try{
      await client.query("BEGIN");
      expect(await readQueryContractWithClient(client,{schema:database.schema},context,environment))
        .toMatchObject({status:"unknown"});
    }finally{await client.query("ROLLBACK");client.release();}
    await repository.ingestEvent(producer, branchEvent(source.thirdRevision, source.secondRevision, "3"));
    const [third] = await worker.claimJobs(workerIdentity, {limit: 1});
    const thirdOutcome = await worker.runJob(workerIdentity, third!.lease, provenPorts);
    expect(thirdOutcome).toMatchObject({state: "succeeded"});
    const chained = await database.pool.query<{base_selected_revision: string; association_kind: string}>(
      `SELECT result.base_selected_revision,association.association_kind
       FROM ${schema}.orchestration_revision_snapshots association
       JOIN ${schema}.orchestration_job_results result ON result.tenant_id=association.tenant_id
         AND result.job_id=association.producing_job_id
       WHERE association.tenant_id=$1 AND association.immutable_revision=$2`, [tenantId, source.thirdRevision]);
    expect(chained.rows).toMatchObject([{base_selected_revision: source.secondRevision, association_kind: "reused"}]);
    expect(await reader.readContract(context, selection({kind: "revision", revision: source.thirdRevision})))
      .toMatchObject({status: "resolved",pin:{snapshotId,revision:source.firstRevision,
        selectedRevision:source.thirdRevision}});
    expect(await reader.readContract(context, selection({kind: "branch",branch:"main",expectedPointerVersion:"3"})))
      .toMatchObject({status: "resolved",pin:{snapshotId,revision:source.firstRevision,
        selectedRevision:source.thirdRevision,pointerVersion:"3"}});
    // Pre-fingerprint associations remain eligible when every older authority fact still agrees.
    await database.pool.query(`ALTER TABLE ${schema}.orchestration_revision_snapshots DISABLE TRIGGER
      orchestration_revision_snapshots_immutable`);
    await database.pool.query(`UPDATE ${schema}.orchestration_revision_snapshots
      SET resolution_inputs_fingerprint=NULL WHERE tenant_id=$1 AND immutable_revision=$2`,
    [tenantId,source.thirdRevision]);
    await database.pool.query(`ALTER TABLE ${schema}.orchestration_revision_snapshots ENABLE TRIGGER
      orchestration_revision_snapshots_immutable`);
    expect(await reader.readContract(context, selection({kind:"revision",revision:source.thirdRevision})))
      .toMatchObject({status:"resolved",pin:{selectedRevision:source.thirdRevision}});
    // Immutable result corruption must not turn an old snapshot into a selected revision.
    await database.pool.query(`ALTER TABLE ${schema}.orchestration_job_results DISABLE TRIGGER
      orchestration_job_results_immutable`);
    await database.pool.query(`UPDATE ${schema}.orchestration_job_results
      SET plan_document=jsonb_set(plan_document,'{service,target_revision}',to_jsonb('wrong-revision'::text))
      WHERE tenant_id=$1 AND job_id=(SELECT producing_job_id FROM ${schema}.orchestration_revision_snapshots
        WHERE tenant_id=$1 AND immutable_revision=$2)`, [tenantId,source.thirdRevision]);
    await database.pool.query(`ALTER TABLE ${schema}.orchestration_job_results ENABLE TRIGGER
      orchestration_job_results_immutable`);
    await expect(reader.readContract(context, selection({kind:"revision",revision:source.thirdRevision})))
      .rejects.toMatchObject({code:"QUERY_STORAGE_ERROR"});
    await database.pool.query(`UPDATE ${schema}.principal_scope_grants SET active=false
      WHERE tenant_id=$1 AND principal_id=$2 AND access_scope_id=$3`, [tenantId,principalId,sourceScope]);
    for (const selected of [revision, branch, environment,
      selection({kind:"revision",revision:source.thirdRevision})])
      await expect(reader.readContract(context, selected)).rejects.toMatchObject({code: "QUERY_NOT_FOUND_OR_DENIED"});
  } finally {
    await ports.dispose();
    await database.cleanup();
    await rm(source.root, {recursive: true, force: true});
  }
});
