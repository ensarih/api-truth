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
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createObservedCaptureAssociationStore} from "../../packages/orchestration/src/observed-captures.js";
import {createObservedCaptureVerificationStore} from "../../packages/orchestration/src/observed-capture-verifications.js";
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
const serviceRoot = "services/orders";
const handler = "exports.readOrder = function () { return 200; };\n";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const signerDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));

test("real Git bytes, external signed pin and PG capture records compose without catalog promotion", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "api-truth-capture-lifecycle-repo-"));
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

  const materializedRoot = await mkdtemp(join(tmpdir(), "api-truth-capture-lifecycle-owned-"));
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
  expect(await readdir(materializedRoot)).toEqual(beforeTrees);

  const scope = {tenantId: "tenant-capture-lifecycle", repositoryId: "repo-capture-lifecycle",
    serviceId: "orders", immutableRevision: revision, sourceDigest, environment: "uat"};
  const receiptPayload = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: scope.repositoryId,
    service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
    environment: scope.environment, session_id: "synthetic-runtime-session", captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: [{method: "GET", application_path: "/orders/{id}",
      controller: "orders", operation_id: "readOrder", export_name: "readOrder",
      handler_path: "api/controllers/orders.js", handler_digest: hash(handler), mock_mode: false}]}));
  const receiptText = JSON.stringify({payload: receiptPayload.toString("base64"),
    signature: sign(null, receiptPayload, keys.privateKey).toString("base64")});
  const resolver = createRuntimeCapturePinResolver({binding: {scope, artifactRef: "capture:lifecycle-receipt",
    configuredKeyRef: "key:lifecycle-signer", expectedReceiptDigest: hash(receiptText),
    expectedSignerSpkiDigest: signerDigest, policyVersion: "runtime-capture-pin-1"},
    authorize: async () => true, readReceipt: async () => receiptText, readKey: async () => publicKey});

  const database = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(database.schema);
  try {
    await applyOrchestrationMigrations(database.pool, {schema: database.schema});
    const associationStore = createObservedCaptureAssociationStore(database.pool, {schema: database.schema,
      preflightAuthorize: async selected => selected.tenantId === scope.tenantId,
      transactionAuthorize: async () => true, pinResolver: resolver});
    const associated = await associationStore.append(scope);
    const verificationPort = createProtectedCaptureVerificationPort({repoPath, serviceRoot, scope,
      expectedCaptureIdentityDigest: associated.captureIdentityDigest, pinResolver: resolver,
      authorize: async selected => selected.tenantId === scope.tenantId,
      readReceipt: async () => receiptText, readKey: async () => publicKey,
      limits: {maxFiles: 20, maxBytes: 100_000, timeoutMs: 10_000}});
    const verificationStore = createObservedCaptureVerificationStore(database.pool, {schema: database.schema,
      preflightAuthorize: async selected => selected.tenantId === scope.tenantId,
      transactionAuthorize: async () => true, verificationPort});
    const request = {scope, captureIdentityDigest: associated.captureIdentityDigest};
    const stored = await verificationStore.append(request);
    const replay = await verificationStore.append(request);
    expect(stored).toMatchObject({outcome: "inserted", captureIdentityDigest: associated.captureIdentityDigest,
      verifierProfileVersion: "protected-handler-bytes-1", handlerCount: 1,
      resultDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)});
    expect(replay).toEqual({...stored, outcome: "existing"});

    const parentRows = await database.pool.query<{tenant_id: string; capture_identity_digest: string;
      repository_id: string; service_id: string; immutable_revision: string; source_digest: string;
      environment: string; receipt_digest: string; signer_spki_digest: string; count: string}>(
      `SELECT tenant_id,capture_identity_digest,repository_id,service_id,immutable_revision,source_digest,
         environment,receipt_digest,signer_spki_digest,count(*) OVER()::text AS count
       FROM ${schema}.orchestration_observed_capture_associations`);
    expect(parentRows.rows).toEqual([{tenant_id: scope.tenantId, capture_identity_digest: associated.captureIdentityDigest,
      repository_id: scope.repositoryId, service_id: scope.serviceId, immutable_revision: revision,
      source_digest: sourceDigest, environment: scope.environment, receipt_digest: hash(receiptText),
      signer_spki_digest: signerDigest, count: "1"}]);
    const verifiedRows = await database.pool.query<{capture_identity_digest: string; source_digest: string;
      receipt_digest: string; signer_spki_digest: string; handler_count: number; result_digest: string; count: string}>(
      `SELECT capture_identity_digest,source_digest,receipt_digest,signer_spki_digest,handler_count,result_digest,
         count(*) OVER()::text AS count FROM ${schema}.orchestration_observed_capture_verifications`);
    expect(verifiedRows.rows).toEqual([{capture_identity_digest: associated.captureIdentityDigest,
      source_digest: sourceDigest, receipt_digest: hash(receiptText), signer_spki_digest: signerDigest,
      handler_count: 1, result_digest: stored.resultDigest, count: "1"}]);
    const catalog = await database.pool.query<{snapshots: string; revision_links: string; branches: string}>(
      `SELECT (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
         (SELECT count(*)::text FROM ${schema}.orchestration_revision_snapshots) AS revision_links,
         (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS branches`);
    expect(catalog.rows).toEqual([{snapshots: "0", revision_links: "0", branches: "0"}]);
    await expect(readFile(markerPath)).rejects.toThrow();
    expect(await readdir(materializedRoot)).toEqual(beforeTrees);
  } finally { await database.cleanup(); }
});
