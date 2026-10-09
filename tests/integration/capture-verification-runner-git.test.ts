import {execFile as execFileCallback} from "node:child_process";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {promisify} from "node:util";
import {afterEach, expect, test, vi} from "vitest";
import {digestServiceTree, readServiceTree} from "../../analyzers/nodejs/src/source.js";
import {materializeGitSource} from "../../connectors/git-source/src/index.js";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {createProtectedCaptureVerificationPort} from "../../connectors/git-source/src/protected-capture-verification.js";
import {createAccessPolicyStore} from "../../packages/catalog/src/index.js";
import {applyOrchestrationMigrations, createOrchestrationRepository} from "../../packages/orchestration/src/index.js";
import {createObservedCaptureAssociationStore} from "../../packages/orchestration/src/observed-captures.js";
import {createCaptureVerificationAdmissionStore} from "../../packages/orchestration/src/capture-verification-admission.js";
import {createCaptureVerificationRunner} from "../../packages/orchestration/src/capture-verification-runner.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";

const scratch = vi.hoisted(() => ({root: undefined as string | undefined}));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {...actual, tmpdir: () => scratch.root ?? actual.tmpdir()};
});
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => {
  scratch.root = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const tenantId = "capture-runner-tenant", principalId = "capture-runner-worker";
const repositoryId = "repository", serviceId = "orders", environment = "uat", serviceRoot = "services/orders";
const handler = "exports.readOrder = function () { return 200; };\n";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const signerDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));

test("real Git, signed external capture, admission and runner commit one capture-only result", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "api-truth-capture-runner-repo-"));
  roots.push(repoPath);
  const markerPath = join(repoPath, "source-executed");
  await execFile("git", ["init", "-q", "-b", "main"], {cwd: repoPath});
  const files: Record<string, string> = {
    [`${serviceRoot}/api/controllers/orders.js`]: handler,
    [`${serviceRoot}/index.js`]: `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'executed');\n`,
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(repoPath, path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, contents);
  }
  await execFile("git", ["add", "-A"], {cwd: repoPath});
  await execFile("git", ["-c", "user.name=Capture Test", "-c", "user.email=capture@example.invalid",
    "commit", "-qm", "synthetic protected capture source"], {cwd: repoPath});
  const revision = (await execFile("git", ["rev-parse", "HEAD"], {cwd: repoPath})).stdout.trim();
  const materializedRoot = await mkdtemp(join(tmpdir(), "api-truth-capture-runner-owned-"));
  roots.push(materializedRoot);
  scratch.root = materializedRoot;
  const beforeTrees = await readdir(materializedRoot);
  const tree = await materializeGitSource({repoPath, revision, serviceRoot,
    limits: {maxFiles: 20, maxBytes: 100_000}});
  let sourceDigest: string;
  try {
    const source = await readServiceTree(tree.projectRoot, serviceRoot, 20, () => undefined);
    sourceDigest = digestServiceTree(source.files, source.root, source.opaqueConfiguration);
  } finally { await tree.dispose(); }
  const scope = {tenantId, repositoryId, serviceId, environment,
    immutableRevision: revision, sourceDigest};
  const receiptPayload = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: repositoryId,
    service_id: serviceId, immutable_revision: revision, source_digest: sourceDigest, environment,
    session_id: "synthetic-runtime-session", captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: hash("fingerprint"),
    bindings: [{method: "GET", application_path: "/orders/{id}", controller: "orders",
      operation_id: "readOrder", export_name: "readOrder", handler_path: "api/controllers/orders.js",
      handler_digest: hash(handler), mock_mode: false}]}));
  const receiptText = JSON.stringify({payload: receiptPayload.toString("base64"),
    signature: sign(null, receiptPayload, keys.privateKey).toString("base64")});
  const artifactRef = "capture:runner-receipt", configuredKeyRef = "key:runner-signer";
  const resolver = createRuntimeCapturePinResolver({binding: {scope, artifactRef, configuredKeyRef,
    expectedReceiptDigest: hash(receiptText), expectedSignerSpkiDigest: signerDigest,
    policyVersion: "runtime-capture-pin-1"}, authorize: async () => true,
  readReceipt: async () => receiptText, readKey: async () => publicKey});

  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const access = createAccessPolicyStore(db.pool, {schema: db.schema});
    for (const scopeId of ["source-access", "environment-access"]) {
      await access.putScope({tenantId}, {scopeId, active: true});
      await access.putGrant({tenantId}, {principalId, scopeId, active: true});
    }
    const orchestration = createOrchestrationRepository(db.pool, {schema: db.schema});
    const admin = {tenantId, principalId: "admin", capabilities: ["configuration.admin"]};
    await orchestration.registerConfiguration(admin, {fingerprint: "config-a", document: {config_version: "1.0.0",
      access_scopes: ["source-access", "environment-access"].map(access_scope_id =>
        ({access_scope_id, label: access_scope_id})),
      repositories: [{repository_id: repositoryId, provider: "github", locator: "sample/repository",
        access_scope_id: "source-access", services: [{service_id: serviceId, root: serviceRoot,
          analyzer: {adapter_id: "typescript", adapter_version: "1"}, intended_branches: ["main"],
          environments: [{name: environment, intended_branch: "main",
            deployment_authority: {adapter_id: "deployment", access_scope_id: "environment-access"}}]}]}],
      inference: {enabled: false}, logs: {enabled: false}}});
    await orchestration.activateInitialConfiguration(admin, {fingerprint: "config-a"});
    await db.pool.query(`CREATE TABLE ${schema}.trusted_capture_execute (
      tenant_id text NOT NULL,principal_id text NOT NULL,config_fingerprint text NOT NULL,
      checkpoint_version bigint NOT NULL,allowed boolean NOT NULL,
      PRIMARY KEY(tenant_id,principal_id,config_fingerprint,checkpoint_version))`);
    await db.pool.query(`INSERT INTO ${schema}.trusted_capture_execute VALUES ($1,$2,'config-a',1,true)`,
      [tenantId, principalId]);
    const authorizeCapture = async (client: import("pg").PoolClient, binding: {tenantId: string;
      principalId: string; configFingerprint: string; checkpointVersion: string}) => {
      const grant = await client.query<{allowed: boolean}>(`SELECT allowed FROM trusted_capture_execute
        WHERE tenant_id=$1 AND principal_id=$2 AND config_fingerprint=$3 AND checkpoint_version=$4 FOR SHARE`,
      [binding.tenantId, binding.principalId, binding.configFingerprint, binding.checkpointVersion]);
      return grant.rows.length === 1 && grant.rows[0]!.allowed;
    };
    const association = await createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
      preflightAuthorize: async selected => selected.tenantId === tenantId,
      transactionAuthorize: async () => true, pinResolver: resolver}).append(scope);
    const admission = await createCaptureVerificationAdmissionStore(db.pool, {schema: db.schema,
      tenantId, principalId, preflightAuthorize: async () => true, authorizeCapture})
      .admit({captureIdentityDigest: association.captureIdentityDigest});
    let verifiedCalls = 0;
    const runner = createCaptureVerificationRunner(db.pool, {schema: db.schema, tenantId, principalId,
      workerId: "runner-worker", instanceId: "runner-instance", allowedRepositories: [repositoryId],
      allowedServices: [serviceId], preflightAuthorize: async () => true, authorizeCapture,
      verificationPortFactory: async binding => {
        expect(binding).toMatchObject({jobId: admission.jobId, captureIdentityDigest: association.captureIdentityDigest,
          immutableRevision: revision, sourceDigest, serviceRoot, artifactRef, configuredKeyRef,
          receiptDigest: hash(receiptText), signerSpkiDigest: signerDigest});
        const port = createProtectedCaptureVerificationPort({repoPath, serviceRoot, scope,
          expectedCaptureIdentityDigest: association.captureIdentityDigest, pinResolver: resolver,
          authorize: async selected => selected.tenantId === tenantId,
          readReceipt: async () => receiptText, readKey: async () => publicKey,
          limits: {maxFiles: 20, maxBytes: 100_000, timeoutMs: 10_000}});
        return {verify: async () => { verifiedCalls += 1; return port.verify(); }};
      }});
    const result = await runner.runOne();
    expect(result).toMatchObject({kind: "succeeded", jobId: admission.jobId,
      receipt: {outcome: "inserted", captureIdentityDigest: association.captureIdentityDigest,
        handlerCount: 1, resultDigest: expect.stringMatching(/^sha256:/)}});
    expect(verifiedCalls).toBe(1);
    const rows = await db.pool.query<{state: string; capture_identity_digest: string;
      verification_result_digest: string; result_digest: string}>(`SELECT lifecycle.state,
      verification.capture_identity_digest,lifecycle.verification_result_digest,verification.result_digest
      FROM ${schema}.orchestration_capture_verification_job_state lifecycle
      JOIN ${schema}.orchestration_observed_capture_verifications verification
        ON verification.tenant_id=lifecycle.tenant_id
        AND verification.capture_identity_digest=lifecycle.verification_capture_identity_digest
        AND verification.verifier_profile_version=lifecycle.verification_profile_version`);
    expect(rows.rows).toEqual([{state: "succeeded", capture_identity_digest: association.captureIdentityDigest,
      verification_result_digest: expect.stringMatching(/^sha256:/),
      result_digest: expect.stringMatching(/^sha256:/)}]);
    expect(rows.rows[0]!.verification_result_digest).toBe(rows.rows[0]!.result_digest);
    const ordinary = await db.pool.query<{snapshots: string; revisions: string; pointers: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
        (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots) AS revisions,
        (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS pointers`);
    expect(ordinary.rows).toEqual([{snapshots: "0", revisions: "0", pointers: "0"}]);
    expect((await execFile("git", ["ls-files"], {cwd: repoPath})).stdout).not.toContain("receipt");
    await expect(readFile(markerPath)).rejects.toThrow();
    expect(await readdir(materializedRoot)).toEqual(beforeTrees);
  } finally { await db.cleanup(); }
});
