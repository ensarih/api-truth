import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { createApiTruthMcpServer } from "../../apps/mcp/src/server.js";
import { createPortalServer } from "../../apps/portal/src/server.js";
import { ANALYZER } from "../../analyzers/typescript/src/index.js";
import {createConfiguredAnalyzer} from "../../analyzers/host/src/index.js";
import { createReferenceEventBridge } from "../../connectors/reference/src/bridge.js";
import { normalizeLocalFact } from "../../connectors/reference/src/adapter.js";
import { buildSyntheticReferenceFixture } from "../../connectors/reference/src/fixture.js";
import { createAccessPolicyStore, contractSnapshotFromAnalyzerResult } from "../../packages/catalog/src/index.js";
import { applyEnvironmentMigrations, createEnvironmentInboxWorker, createEnvironmentReconciler,
  createEnvironmentReconciliationWorker, createEnvironmentRepository, createEnvironmentViewRepository }
  from "../../packages/environment/src/index.js";
import type { AnalyzerRequest } from "../../packages/ir/src/index.js";
import { applyOpenApiMigrations, createOpenApiPublicationStore } from "../../packages/openapi/src/index.js";
import { applyOrchestrationMigrations, createOrchestrationRepository,
  createOrchestrationWorker } from "../../packages/orchestration/src/index.js";
import { createQueryReader } from "../../packages/query/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const tenantId = "synthetic";
const repositoryId = "synthetic-repo";
const serviceId = "synthetic-orders";
const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);
const revisionD = "d".repeat(40);
const configFingerprint = "analyzer-backed-lifecycle-config";
const reader = {tenantId, principalId: "architect"};
const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
const workerIdentity = {workerId: "lifecycle-worker", instanceId: "local", capabilities: ["jobs.execute"]};
const authHeader = {authorization: "Bearer analyzer-backed-lifecycle"};
const environmentKey = {kind: "environment" as const, repositoryId, serviceId, environment: "uat"};

const source = (path: string) => `import express from "express";
  const app = express();
  function requireApiKey(req, res, next) {
    if (req.get("X-API-Key") !== "synthetic-private-key") return res.status(401).end();
    next();
  }
  app.get("${path}", requireApiKey,
    (_request, response) => response.status(200).type("application/json").json({}));`;

const analyzeRevision = async (revision: string, path: string,
  extractionMode: "baseline" | "fallback_full_service" = "baseline") => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-analyzer-lifecycle-"));
  await writeFile(join(root, "app.ts"), source(path));
  const raw: AnalyzerRequest = {
    exchange_version: "1.0.0", ir_version: "1.0.0", request_id: `lifecycle-${revision}`,
    analyzer: ANALYZER,
    source: {repository_id: repositoryId, service_id: serviceId, service_root: ".",
      immutable_revision: revision, source_digest: "pending", access_label: "synthetic"},
    resolution_inputs: [{kind: "source_tree", path: ".", digest: "pending"}],
    prior_dependencies: [], changed_paths: [], extraction_mode: extractionMode,
    limits: {timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000},
    execution_policy: {network_access: false, side_effects: "none"},
  };
  try {
    const analyzer = createConfiguredAnalyzer({projectRoot: root,selection:{adapter_id:ANALYZER.analyzer_id,adapter_version:ANALYZER.analyzer_version,ir_version:"1.0.0"}});
    const result = await analyzer.analyze(raw);
    const request: AnalyzerRequest = {...raw,
      source: {...raw.source, source_digest: result.source.source_digest},
      resolution_inputs: [{kind: "source_tree", path: ".", digest: result.source.source_digest}]};
    expect(result.status).toBe("success");
    expect(result.coverage.status).toBe("complete");
    expect(result.endpoints[0]?.security.state).toBe("declared");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
    expect((await analyzer.analyze(request)).snapshot_id).toBe(result.snapshot_id);
    return {root, analyzer, result, request};
  } catch (error) { await rm(root, {recursive: true, force: true}); throw error; }
};

test("analyzed guarded source remains pinned through PR, UAT, publication, failure and access revocation", async () => {
  const database = await createCatalogTestDatabase();
  const sourceRoots: string[] = [];
  try {
    await applyOrchestrationMigrations(database.pool, {schema: database.schema});
    await applyEnvironmentMigrations(database.pool, {schema: database.schema});
    await applyOpenApiMigrations(database.pool, {schema: database.schema});
    const steps = buildSyntheticReferenceFixture("main");
    const configuration = structuredClone(steps[0]!.policy.configuration) as {repositories: Array<{
      services: Array<{root: string; analyzer: {adapter_id: string; adapter_version: string}}>}>};
    configuration.repositories[0]!.services[0]!.root = ".";
    configuration.repositories[0]!.services[0]!.analyzer = {
      adapter_id: ANALYZER.analyzer_id, adapter_version: ANALYZER.analyzer_version};
    const orchestration = createOrchestrationRepository(database.pool, {schema: database.schema});
    await orchestration.registerConfiguration(admin, {fingerprint: configFingerprint, document: configuration});
    await orchestration.activateInitialConfiguration(admin, {fingerprint: configFingerprint});
    const access = createAccessPolicyStore(database.pool, {schema: database.schema});
    const original = await analyzeRevision(revisionA, "/orders");
    sourceRoots.push(original.root);
    const merged = await analyzeRevision(revisionB, "/orders-v2", "fallback_full_service");
    sourceRoots.push(merged.root);
    const candidate = await analyzeRevision(revisionC, "/orders-v3", "fallback_full_service");
    sourceRoots.push(candidate.root);
    expect(original.result.snapshot_id).not.toBe(merged.result.snapshot_id);
    expect(original.result.endpoints[0]?.identity.route_key).not.toBe(merged.result.endpoints[0]?.identity.route_key);
    expect(candidate.result.endpoints[0]?.identity.route_key).not.toBe(merged.result.endpoints[0]?.identity.route_key);
    for (const result of [original.result, merged.result, candidate.result]) {
      for (const scopeId of contractSnapshotFromAnalyzerResult(result, configFingerprint).requiredScopeIds) {
        await access.putScope({tenantId}, {scopeId, active: true});
        await access.putGrant({tenantId}, {principalId: reader.principalId, scopeId, active: true});
      }
    }
    const initialBranch = {...steps[3]!.fact, event_id: "lifecycle-initial-branch",
      provider_reference: "lifecycle-initial-branch", sequence: "1", prior_revision: null,
      new_revision: revisionA, reference_state: "created"};
    const staleBranch = {...steps[3]!.fact, event_id: "lifecycle-stale-branch",
      provider_reference: "lifecycle-stale-branch", sequence: "3", prior_revision: revisionB,
      new_revision: revisionA, reference_state: "rewritten"};
    const candidatePr = {...steps[1]!.fact, event_id: "lifecycle-candidate-pr",
      provider_reference: "lifecycle-candidate-pr", sequence: "8", pull_request_id: "synthetic-pr-c",
      base_revision: revisionB, head_revision: revisionC};
    const candidateArtifact = {artifact_id: "synthetic-artifact-c", revision: revisionC};
    const failedArtifact = {artifact_id: "synthetic-artifact-d", revision: revisionD};
    const rolloutPolicy: Record<string, unknown> = {...steps[4]!.policy,
      knownArtifacts: [...steps[4]!.policy.knownArtifacts as Array<{artifact_id: string; revision: string}>,
        candidateArtifact, failedArtifact]};
    const candidateAttempt = {...steps[4]!.fact, event_id: "lifecycle-candidate-attempt",
      provider_reference: "lifecycle-candidate-attempt", sequence: "9", effective_order: "9",
      deployment_id: "synthetic-deploy-c", artifact_id: candidateArtifact.artifact_id,
      revision: revisionC};
    const candidateServing = {...steps[5]!.fact, event_id: "lifecycle-candidate-serving",
      provider_reference: "lifecycle-candidate-serving", sequence: "10", effective_order: "10",
      observation_id: "lifecycle-candidate-serving", reference: "lifecycle-inventory-c",
      inventory: [candidateArtifact]};
    const failedRollout = {...steps[4]!.fact, event_id: "lifecycle-failed-rollout",
      provider_reference: "lifecycle-failed-rollout", sequence: "11", effective_order: "11",
      deployment_id: "synthetic-deploy-d", attempt_state: "failed",
      artifact_id: failedArtifact.artifact_id, revision: revisionD};
    const mixedServing = {...steps[5]!.fact, event_id: "lifecycle-mixed-serving",
      provider_reference: "lifecycle-mixed-serving", sequence: "12", effective_order: "12",
      observation_id: "lifecycle-mixed-serving", reference: "lifecycle-inventory-mixed",
      inventory: [{artifact_id: "synthetic-artifact-b", revision: revisionB}, candidateArtifact]};
    const rollbackRequest = {...steps[4]!.fact, event_id: "lifecycle-rollback-request",
      provider_reference: "lifecycle-rollback-request", sequence: "13", effective_order: "13",
      deployment_id: "synthetic-rollback-b", attempt_state: "rollback_requested"};
    const rollbackConfirmed = {...steps[5]!.fact, event_id: "lifecycle-rollback-confirmed",
      provider_reference: "lifecycle-rollback-confirmed", sequence: "14", effective_order: "14",
      observation_id: "lifecycle-rollback-confirmed", reference: "lifecycle-inventory-rollback"};
    const reconcile = {...steps[6]!.fact, event_id: "lifecycle-reconcile",
      provider_reference: "lifecycle-reconcile", sequence: "15"};
    const deliveries = [...steps, {fact: initialBranch, policy: steps[3]!.policy},
      {fact: staleBranch, policy: steps[3]!.policy}, {fact: candidatePr, policy: steps[1]!.policy},
      {fact: candidateAttempt, policy: rolloutPolicy}, {fact: candidateServing, policy: rolloutPolicy},
      {fact: failedRollout, policy: rolloutPolicy}, {fact: mixedServing, policy: rolloutPolicy},
      {fact: rollbackRequest, policy: rolloutPolicy}, {fact: rollbackConfirmed, policy: rolloutPolicy},
      {fact: reconcile, policy: steps[6]!.policy}];
    const bridge = createReferenceEventBridge(orchestration, {
      async verify(raw) {
        const item = deliveries.find(delivery => delivery.fact.event_id === raw);
        if (!item) throw new Error("Unknown local delivery");
        const verifiedFactJson = JSON.stringify(item.fact);
        return {verifiedFactJson,
          verifiedFactSha256: createHash("sha256").update(verifiedFactJson).digest("hex"),
          context: (item.policy as Record<string, unknown>).context,
          knownArtifacts: (item.policy as Record<string, unknown>).knownArtifacts,
          provider: "github", providerReference: item.fact.provider_reference as string};
      },
    });
    const worker = createOrchestrationWorker(database.pool, {schema: database.schema});
    const runJob = async (kind: string, prepared: typeof original) => {
      const [claim] = await worker.claimJobs(workerIdentity, {limit: 1});
      expect(claim?.kind).toBe(kind);
      let analyzedSnapshotId: string | undefined;
      const outcome = await worker.runJob(workerIdentity, claim!.lease, {
        resolver: {resolve: async () => ({request: prepared.request, changedPaths: [], changedPathsComplete: false})},
        analyzer: {analyze: async input => {
          const analyzed = await prepared.analyzer.analyze(input);
          analyzedSnapshotId = analyzed.snapshot_id;
          return analyzed;
        }},
      });
      expect(outcome).toMatchObject({state: "succeeded"});
      expect(analyzedSnapshotId).toBe(prepared.result.snapshot_id);
    };

    expect(await bridge.deliver("synthetic-baseline")).toMatchObject({disposition: "scheduled"});
    await runJob("baseline_analysis", original);
    expect(await bridge.deliver("lifecycle-initial-branch")).toMatchObject({disposition: "scheduled"});
    await runJob("branch_analysis", original);
    const schema = quoteCatalogTestSchema(database.schema);
    const branchRows = async () => (await database.pool.query<{snapshot_id: string; pointer_version: string}>(
      `SELECT snapshot_id,pointer_version::text FROM ${schema}.catalog_branch_pointers
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND branch='main'`,
      [tenantId, repositoryId, serviceId])).rows;
    expect(await branchRows()).toEqual([{snapshot_id: original.result.snapshot_id, pointer_version: "1"}]);
    expect(await bridge.deliver("synthetic-pr-open")).toMatchObject({disposition: "scheduled"});
    await runJob("pr_preview_analysis", merged);
    expect(await branchRows()).toEqual([{snapshot_id: original.result.snapshot_id, pointer_version: "1"}]);
    expect(await bridge.deliver("synthetic-pr-merged")).toMatchObject({outcome: "accepted"});
    expect(await branchRows()).toEqual([{snapshot_id: original.result.snapshot_id, pointer_version: "1"}]);
    expect(await bridge.deliver("synthetic-branch")).toMatchObject({disposition: "scheduled"});
    await runJob("branch_analysis", merged);
    expect(await branchRows()).toEqual([{snapshot_id: merged.result.snapshot_id, pointer_version: "2"}]);
    expect(await bridge.deliver("synthetic-branch")).toMatchObject({outcome: "duplicate"});
    expect(await bridge.deliver("lifecycle-stale-branch")).toMatchObject({disposition: "ignored_stale"});
    expect(await branchRows()).toEqual([{snapshot_id: merged.result.snapshot_id, pointer_version: "2"}]);
    const branchJobs = await database.pool.query<{count: string}>(
      `SELECT count(*)::text AS count FROM ${schema}.orchestration_jobs
       WHERE tenant_id=$1 AND kind='branch_analysis'`, [tenantId]);
    expect(branchJobs.rows).toEqual([{count: "2"}]);
    expect(await bridge.deliver("lifecycle-candidate-pr")).toMatchObject({disposition: "scheduled"});
    await runJob("pr_preview_analysis", candidate);
    expect(await branchRows()).toEqual([{snapshot_id: merged.result.snapshot_id, pointer_version: "2"}]);

    const publications = createOpenApiPublicationStore(database.pool, {schema: database.schema});
    const branchPreparation = await publications.prepareBranch(reader,
      {kind: "branch", repositoryId, serviceId, branch: "main"});
    expect(branchPreparation.publishable).toBe(true);
    const publishedBranch = await publications.publish(reader, branchPreparation, {state: "absent"});
    expect(new TextDecoder().decode(publishedBranch.bytes)).toContain("/orders-v2");

    const environment = createEnvironmentRepository(database.pool, {schema: database.schema});
    const inbox = createEnvironmentInboxWorker(database.pool, {schema: database.schema}, environment);
    const view = createEnvironmentViewRepository(database.pool, {schema: database.schema});
    expect(await bridge.deliver("synthetic-deploy-attempt")).toMatchObject({outcome: "accepted"});
    expect(await bridge.deliver("synthetic-serving")).toMatchObject({outcome: "accepted"});
    expect(await inbox.drain(workerIdentity)).toMatchObject([{state: "delivered"}, {state: "delivered"}]);
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "deployed", contract: "resolved", snapshotId: merged.result.snapshot_id});
    const environmentPreparation = await publications.prepareEnvironment(reader, environmentKey);
    expect(environmentPreparation.publishable).toBe(true);
    const publishedUat = await publications.publish(reader, environmentPreparation, {state: "absent"});
    expect(publishedUat.bytes).toEqual(publishedBranch.bytes);

    const query = createQueryReader(database.pool, {schema: database.schema});
    const selected = {version: "1" as const, tenantId, repositoryId, serviceId,
      selector: {kind: "environment" as const, environment: "uat"}};
    const beforeCandidate = await query.readContract(reader, selected);
    expect(beforeCandidate).toMatchObject({status: "resolved", pin: {snapshotId: merged.result.snapshot_id,
      revision: revisionB, configFingerprint}, publication: {status: "current",
      publicationId: publishedUat.publicationId}});
    expect(await bridge.deliver("lifecycle-candidate-attempt")).toMatchObject({outcome: "accepted"});
    expect(await bridge.deliver("lifecycle-candidate-serving")).toMatchObject({outcome: "accepted"});
    expect(await inbox.drain(workerIdentity)).toMatchObject([{state: "delivered"}, {state: "delivered"}]);
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "deployed", contract: "resolved", snapshotId: candidate.result.snapshot_id,
        active: [{artifactId: candidateArtifact.artifact_id, revision: revisionC}]});
    const candidatePreparation = await publications.prepareEnvironment(reader, environmentKey);
    expect(candidatePreparation.publishable).toBe(true);
    if (!publishedUat.pointerVersion) throw new Error("Expected a current UAT publication pointer");
    const publishedCandidate = await publications.publish(reader, candidatePreparation,
      {state: "present", pointerVersion: publishedUat.pointerVersion});
    expect(new TextDecoder().decode(publishedCandidate.bytes)).toContain("/orders-v3");
    expect(await query.readContract(reader, selected)).toMatchObject({status: "resolved",
      pin: {snapshotId: candidate.result.snapshot_id, revision: revisionC},
      publication: {status: "current", publicationId: publishedCandidate.publicationId}});
    expect(await bridge.deliver("lifecycle-failed-rollout")).toMatchObject({outcome: "accepted"});
    expect(await inbox.drain(workerIdentity)).toMatchObject([{state: "delivered"}]);
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "deployed", contract: "resolved", snapshotId: candidate.result.snapshot_id,
        latestAttempt: {deploymentId: "synthetic-deploy-d", state: "failed"}});
    const afterFailure = await query.readContract(reader, selected);
    expect(afterFailure).toMatchObject({status: "resolved", pin: {snapshotId: candidate.result.snapshot_id,
      revision: revisionC}, publication: {status: "current", publicationId: publishedCandidate.publicationId}});
    expect(await bridge.deliver("lifecycle-mixed-serving")).toMatchObject({outcome: "accepted"});
    expect(await inbox.drain(workerIdentity)).toMatchObject([{state: "delivered"}]);
    const mixed = await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"});
    expect(mixed).toMatchObject({deployment: "transitional", contract: "ambiguous",
      active: [{artifactId: "synthetic-artifact-b", revision: revisionB},
        {artifactId: candidateArtifact.artifact_id, revision: revisionC}]});
    expect(mixed).not.toHaveProperty("snapshotId");
    expect(await query.readContract(reader, selected)).toMatchObject({status: "transitional"});
    await expect(publications.readCurrent(reader, environmentKey)).rejects.toMatchObject({code: "STALE_POINTER"});
    if (!publishedCandidate.pointerVersion) throw new Error("Expected candidate publication pointer");
    await expect(publications.publish(reader, candidatePreparation,
      {state: "present", pointerVersion: publishedCandidate.pointerVersion}))
      .rejects.toMatchObject({code: "STALE_POINTER"});
    expect((await publications.readPublication(reader, publishedCandidate.publicationId)).bytes)
      .toEqual(publishedCandidate.bytes);
    expect(await bridge.deliver("lifecycle-rollback-request")).toMatchObject({outcome: "accepted"});
    expect(await inbox.drain(workerIdentity)).toMatchObject([{state: "delivered"}]);
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "transitional", contract: "ambiguous",
        latestAttempt: {deploymentId: "synthetic-rollback-b", state: "rollback_requested"}});
    expect(await bridge.deliver("lifecycle-rollback-confirmed")).toMatchObject({outcome: "accepted"});
    expect(await inbox.drain(workerIdentity)).toMatchObject([{state: "delivered"}]);
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "deployed", contract: "resolved", snapshotId: merged.result.snapshot_id});

    expect(await bridge.deliver("lifecycle-reconcile")).toMatchObject({outcome: "accepted"});
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "unknown", contract: "unavailable", reconciliationRequired: true});
    const repairedFact = {...rollbackConfirmed, event_id: "lifecycle-serving-repaired",
      provider_reference: "lifecycle-serving-repaired", sequence: "16", effective_order: "16",
      observation_id: "lifecycle-serving-repaired", reference: "lifecycle-inventory-repaired"};
    const repaired = createEnvironmentReconciler({environment, orchestration,
      provider: {observe: async () => normalizeLocalFact(repairedFact,
        {configuration: rolloutPolicy.configuration, context: rolloutPolicy.context,
          knownArtifacts: rolloutPolicy.knownArtifacts})},
      workerIdentity, eventContext: rolloutPolicy.context});
    expect(await createEnvironmentReconciliationWorker(database.pool, {schema: database.schema}, repaired)
      .drain(workerIdentity)).toMatchObject([{state: "resolved"}]);
    expect(await inbox.drain(workerIdentity)).toMatchObject([{eventId: "lifecycle-serving-repaired",
      state: "delivered"}]);
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "deployed", contract: "resolved", snapshotId: merged.result.snapshot_id,
        reconciliationRequired: false});
    const missedFact = {...repairedFact, event_id: "lifecycle-missed-serving",
      provider_reference: "lifecycle-missed-serving", sequence: "17", effective_order: "17",
      observation_id: "lifecycle-missed-serving", reference: "lifecycle-inventory-after-loss"};
    const periodic = createEnvironmentReconciler({environment, orchestration,
      provider: {observe: async () => normalizeLocalFact(missedFact,
        {configuration: rolloutPolicy.configuration, context: rolloutPolicy.context,
          knownArtifacts: rolloutPolicy.knownArtifacts})},
      workerIdentity, eventContext: rolloutPolicy.context});
    await database.pool.query(`UPDATE ${schema}.environment_serving_checkpoints
      SET updated_at=clock_timestamp()-interval '2 seconds' WHERE tenant_id=$1`, [tenantId]);
    expect(await createEnvironmentReconciliationWorker(database.pool,
      {schema: database.schema, reconcileAfterMs: 1_000}, periodic).drain(workerIdentity))
      .toMatchObject([{state: "resolved"}]);
    expect(await inbox.drain(workerIdentity)).toMatchObject([{eventId: "lifecycle-missed-serving",
      state: "delivered"}]);
    const latestObservation = await database.pool.query<{current_event_id: string}>(
      `SELECT current_event_id FROM ${schema}.environment_serving_checkpoints
       WHERE tenant_id=$1 AND repository_id=$2 AND service_id=$3 AND environment='uat'`,
      [tenantId, repositoryId, serviceId]);
    expect(latestObservation.rows).toEqual([{current_event_id: "lifecycle-missed-serving"}]);
    expect(await view.getEnvironment(reader, {repositoryId, serviceId, environment: "uat"}))
      .toMatchObject({deployment: "deployed", contract: "resolved", snapshotId: merged.result.snapshot_id});

    const afterRollback = await query.readContract(reader, selected);
    expect(afterRollback).toMatchObject({status: "resolved", pin: {snapshotId: merged.result.snapshot_id,
      revision: revisionB}});
    const restoredPreparation = await publications.prepareEnvironment(reader, environmentKey);
    expect(restoredPreparation.publishable).toBe(true);
    await expect(publications.publish(reader, restoredPreparation,
      {state: "present", pointerVersion: publishedUat.pointerVersion}))
      .rejects.toMatchObject({code: "STALE_POINTER"});
    expect((await publications.readPublication(reader, publishedCandidate.publicationId)).bytes)
      .toEqual(publishedCandidate.bytes);
    const republished = await publications.publish(reader, restoredPreparation,
      {state: "present", pointerVersion: publishedCandidate.pointerVersion});
    expect(republished.bytes).toEqual(publishedUat.bytes);
    const current = await query.readContract(reader, selected);
    expect(current).toMatchObject({status: "resolved", pin: {snapshotId: merged.result.snapshot_id,
      revision: revisionB, configFingerprint}, publication: {status: "current",
      publicationId: republished.publicationId}});

    const mcp = createApiTruthMcpServer({query, authenticate: async () => reader});
    const mcpClient = new Client({name: "analyzer-backed-lifecycle", version: "1.0.0"});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const portal = createPortalServer({authenticate: async request =>
      request.headers.authorization === authHeader.authorization ? reader : undefined, query});
    portal.listen(0, "127.0.0.1");
    await once(portal, "listening");
    const address = portal.address();
    if (!address || typeof address === "string") throw new Error("Missing portal port");
    const base = `http://127.0.0.1:${address.port}`;
    const contractUrl = `${base}/api/contract?repositoryId=${repositoryId}&serviceId=${serviceId}&kind=environment&value=uat`;
    const exportUrl = `${base}/api/openapi/${republished.publicationId}?repositoryId=${repositoryId}&serviceId=${serviceId}`;
    const historicalKey = {tenantId, repositoryId, serviceId, publicationId: republished.publicationId};
    try {
      const direct = await query.readContract(reader, selected);
      if (direct.status !== "resolved") throw new Error("Expected resolved contract");
      const portalResponse = await fetch(contractUrl, {headers: authHeader});
      expect(portalResponse.status).toBe(200);
      const portalContract = await portalResponse.json() as {selector: unknown; pin: unknown; publication: unknown};
      expect(portalContract.selector).toEqual(direct.selector);
      expect(portalContract.pin).toEqual(direct.pin);
      expect(portalContract.publication).toEqual(direct.publication);
      const mcpResponse = await mcpClient.callTool({name: "api_truth_get_contract", arguments: {
        repositoryId, serviceId, view: {kind: "environment", environment: "uat"}}});
      expect(mcpResponse.isError).not.toBe(true);
      const mcpContract = mcpResponse.structuredContent as {ok: true;
        data: {selector: unknown; pin: unknown; publication: unknown}};
      expect(mcpContract.data.selector).toEqual(direct.selector);
      expect(mcpContract.data.pin).toEqual(direct.pin);
      expect(mcpContract.data.publication).toEqual(direct.publication);
      const exported = await query.readPublication(reader, historicalKey);
      expect(exported).toMatchObject({publicationId: republished.publicationId, pin: direct.pin});
      expect(exported.bytes).toEqual(republished.bytes);
      const downloaded = await fetch(exportUrl, {headers: authHeader});
      expect(downloaded.status).toBe(200);
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(exported.bytes);

      await access.putGrant({tenantId}, {principalId: reader.principalId, scopeId: "synthetic", active: false});
      await expect(query.readContract(reader, selected)).rejects.toMatchObject({code: "QUERY_NOT_FOUND_OR_DENIED"});
      expect((await fetch(contractUrl, {headers: authHeader})).status).toBe(404);
      expect(await mcpClient.callTool({name: "api_truth_get_contract", arguments: {
        repositoryId, serviceId, view: {kind: "environment", environment: "uat"}}}))
        .toMatchObject({isError: true, structuredContent: {ok: false, error: "NOT_FOUND_OR_DENIED"}});
      await expect(query.readPublication(reader, historicalKey))
        .rejects.toMatchObject({code: "QUERY_NOT_FOUND_OR_DENIED"});
      expect((await fetch(exportUrl, {headers: authHeader})).status).toBe(404);
    } finally {
      await Promise.allSettled([mcpClient.close(), mcp.close()]);
      portal.closeAllConnections();
      portal.close();
      await once(portal, "close");
    }
  } finally {
    await database.cleanup();
    await Promise.all(sourceRoots.map(root => rm(root, {recursive: true, force: true})));
  }
});
