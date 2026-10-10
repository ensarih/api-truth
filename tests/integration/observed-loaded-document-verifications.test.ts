import {execFile as execFileCallback} from "node:child_process";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {promisify} from "node:util";
import {afterEach, expect, test, vi} from "vitest";
import {supportedRouterDigest} from "../../analyzers/nodejs/src/runtime-binding.js";
import {digestServiceTree, readServiceTree} from "../../analyzers/nodejs/src/source.js";
import {materializeGitSource} from "../../connectors/git-source/src/index.js";
import {createProtectedCaptureVerificationPort} from "../../connectors/git-source/src/protected-capture-verification.js";
import {createProtectedSwaggerLoadedDocumentPort, type ProtectedSwaggerLoadedDocument} from "../../connectors/git-source/src/protected-swagger-loaded-document.js";
import type {ProtectedDocumentLoadObservation} from "../../connectors/git-source/src/protected-document-load.js";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {parseStrictYaml} from "../../analyzers/nodejs/src/strict-yaml.js";
import {createObservedCaptureAssociationStore} from "../../packages/orchestration/src/observed-captures.js";
import {createObservedCaptureVerificationStore} from "../../packages/orchestration/src/observed-capture-verifications.js";
import {applyOrchestrationMigrations} from "../../packages/orchestration/src/migrations.js";
import {createObservedLoadedDocumentVerificationStore} from "../../packages/orchestration/src/observed-loaded-document-verifications.js";
import {createCatalogTestDatabase, quoteCatalogTestSchema} from "./support/database.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));});
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const serviceRoot = "services/orders", documentPath = `${serviceRoot}/api/swagger/swagger.yaml`;
const document = `swagger: '2.0'\ninfo: {title: Example, version: '1'}\nbasePath: /api/v1\npaths:\n  /orders/{id}:\n    x-swagger-router-controller: orders\n    get:\n      operationId: readOrder\n      responses:\n        '200': {description: ok}\n`;
const handler = `exports.readOrder = function(req, res) { return res.status(200).json({ok:true}); };\n`;
const app = `const express = require("express");\nconst SwaggerExpress = require("swagger-express-mw");\nconst app = express();\nSwaggerExpress.create({appRoot: __dirname}, function(error, middleware) {\n  if (error) throw error;\n  middleware.register(app);\n});\n`;
const manifest = {type: "commonjs", scripts: {start: "NODE_ENV=test node app.js"}, engines: {node: "22.19.0"},
  dependencies: {"swagger-express-mw": "0.7.0"}};
const lock = {lockfileVersion: 3, packages: {"": {dependencies: manifest.dependencies},
  "node_modules/swagger-express-mw": {version: "0.7.0", dependencies: {"swagger-node-runner": "^0.7.0"}},
  "node_modules/swagger-node-runner": {version: "0.7.0", dependencies: {bagpipes: "^0.1.0", config: "^1.16.0", sway: "^1.0.0"}},
  "node_modules/bagpipes": {version: "0.1.2"}, "node_modules/config": {version: "1.31.0"}, "node_modules/sway": {version: "1.0.0"}}};
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const signerDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));

async function sourceFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "api-truth-loaded-proof-repo-")); roots.push(repoPath);
  await execFile("git", ["init", "-q", "-b", "main"], {cwd: repoPath});
  const files: Record<string, string> = {[`${serviceRoot}/app.js`]: app,
    [`${serviceRoot}/api/controllers/orders.js`]: handler, [`${serviceRoot}/package.json`]: JSON.stringify(manifest),
    [`${serviceRoot}/package-lock.json`]: JSON.stringify(lock), [documentPath]: document};
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(repoPath, path)), {recursive: true}); await writeFile(join(repoPath, path), contents);
  }
  await execFile("git", ["add", "-A"], {cwd: repoPath});
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {cwd: repoPath});
  const revision = (await execFile("git", ["rev-parse", "HEAD"], {cwd: repoPath})).stdout.trim();
  const tree = await materializeGitSource({repoPath, revision, serviceRoot, limits: {maxFiles: 30, maxBytes: 100_000}});
  let sourceDigest: string;
  try {const selected = await readServiceTree(tree.projectRoot, serviceRoot, 30, () => undefined);
    sourceDigest = digestServiceTree(selected.files, selected.root, selected.opaqueConfiguration);}
  finally {await tree.dispose();}
  return {repoPath, revision, sourceDigest, files};
}

async function endToEnd(db: Awaited<ReturnType<typeof createCatalogTestDatabase>>) {
  const source = await sourceFixture();
  const scope = {tenantId: "tenant-loaded-proof", repositoryId: "repository-loaded-proof", serviceId: "orders",
    immutableRevision: source.revision, sourceDigest: source.sourceDigest, environment: "test"};
  const receiptPayload = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: scope.repositoryId,
    service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
    environment: scope.environment, session_id: "loaded-session", captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: supportedRouterDigest, runtime_fingerprint: `sha256:${"c".repeat(64)}`,
    bindings: [{method: "GET", application_path: "/api/v1/orders/{id}", controller: "orders",
      operation_id: "readOrder", export_name: "readOrder", handler_path: "api/controllers/orders.js",
      handler_digest: hash(handler), mock_mode: false}]}));
  const receiptText = JSON.stringify({payload: receiptPayload.toString("base64"),
    signature: sign(null, receiptPayload, keys.privateKey).toString("base64")});
  const authorize = vi.fn(async () => true);
  const pinResolver = createRuntimeCapturePinResolver({binding: {scope, artifactRef: "capture:loaded-proof-receipt",
    configuredKeyRef: "key:loaded-proof-signer", expectedReceiptDigest: hash(receiptText),
    expectedSignerSpkiDigest: signerDigest, policyVersion: "runtime-capture-pin-1"}, authorize,
    readReceipt: async () => receiptText, readKey: async () => publicKey});
  const associationStore = createObservedCaptureAssociationStore(db.pool, {schema: db.schema,
    preflightAuthorize: async () => true, transactionAuthorize: async () => true, pinResolver});
  const association = await associationStore.append(scope);
  const handlerBytesPort = createProtectedCaptureVerificationPort({repoPath: source.repoPath, serviceRoot, scope,
    expectedCaptureIdentityDigest: association.captureIdentityDigest, pinResolver, authorize,
    readReceipt: async () => receiptText, readKey: async () => publicKey,
    limits: {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10_000}});
  const parentStore = createObservedCaptureVerificationStore(db.pool, {schema: db.schema,
    preflightAuthorize: async () => true, transactionAuthorize: async () => true, verificationPort: handlerBytesPort});
  await parentStore.append({scope, captureIdentityDigest: association.captureIdentityDigest});
  const rawDocumentSha256 = hash(source.files[documentPath]!);
  const observation: ProtectedDocumentLoadObservation = {kind: "unsigned_runtime_document_load", profileVersion: "swagger-document-load-capture-1",
    source: {repositoryId: scope.repositoryId, serviceId: scope.serviceId, immutableRevision: scope.immutableRevision,
      sourceDigest: scope.sourceDigest, environment: scope.environment, sessionId: "loaded-session"},
    framework: {nodeVersion: "22.19.0", routerDigest: supportedRouterDigest, runnerDigest: hash("runner"),
      swayDigest: hash("sway"), jsonRefsDigest: hash("jsonrefs"), pathLoaderDigest: hash("pathloader")},
    document: {path: "api/swagger/swagger.yaml" as const, rawSha256: rawDocumentSha256,
      canonicalValueSha256: hash(canonicalJsonStringify(parseDocument(document)))},
    bindings: [{method: "GET", application_path: "/api/v1/orders/{id}", controller: "orders", operation_id: "readOrder",
      export_name: "readOrder", handler_path: "api/controllers/orders.js", handler_digest: hash(handler), mock_mode: false as const}]};
  const payload = Buffer.from(canonicalJsonStringify({scope, observation}));
  const envelope = JSON.stringify({purpose: "api-truth:swagger-document-load-observation-1", payload: payload.toString("base64"),
    signature: sign(null, Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"), payload]), keys.privateKey).toString("base64")});
  const loadBinding = {scope, artifactRef: "capture:loaded-proof-load", configuredKeyRef: "key:loaded-proof-load-signer",
    expectedEnvelopeDigest: hash(envelope), expectedSignerSpkiDigest: signerDigest, expectedObservation: observation};
  const loadedPort = createProtectedSwaggerLoadedDocumentPort({documentLoad: {binding: loadBinding, authorize,
    readArtifact: async () => envelope, readKey: async () => publicKey},
    correspondence: {repoPath: source.repoPath, serviceRoot, scope, expectedCaptureIdentityDigest: association.captureIdentityDigest,
      pinResolver, authorize, readReceipt: async () => receiptText, readKey: async () => publicKey,
      limits: {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10_000}, documentPath,
      expectedRawDocumentSha256: rawDocumentSha256}});
  return {scope, association, loadedPort, binding: {scope, captureIdentityDigest: association.captureIdentityDigest,
    loadArtifactRef: loadBinding.artifactRef, loadConfiguredKeyRef: loadBinding.configuredKeyRef,
    loadEnvelopeDigest: loadBinding.expectedEnvelopeDigest, loadSignerSpkiDigest: loadBinding.expectedSignerSpkiDigest}};
}

// Kept local so the test hashes the strict YAML value without using an analyzer projection.
function parseDocument(text: string): unknown {return parseStrictYaml(text);}

test("actual Git, signed load, handler verification and PG association compose without contract promotion", async () => {
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const fixture = await endToEnd(db);
    const store = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: fixture.binding, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: fixture.loadedPort});
    const request = {scope: fixture.scope, captureIdentityDigest: fixture.association.captureIdentityDigest};
    const querySpy = vi.spyOn(db.pool, "query").mockClear();
    const [first, simultaneous] = await Promise.all([store.append(request), store.append(request)]);
    const lookupSql = querySpy.mock.calls.map(([query]) => typeof query === "string" ? query : "");
    expect(lookupSql.some(sql => sql.includes(`FROM ${schema}.orchestration_observed_capture_associations`))).toBe(true);
    expect(lookupSql.some(sql => sql.includes(`FROM ${schema}.orchestration_observed_capture_verifications`))).toBe(true);
    querySpy.mockRestore();
    expect(first).toMatchObject({verifierProfileVersion: "swagger-loaded-document-1",
      captureIdentityDigest: fixture.association.captureIdentityDigest, handlerCount: 1, matchCount: 1,
      unobservedDiagnosticCount: 0, resultDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)});
    expect([first.outcome, simultaneous.outcome].sort()).toEqual(["existing", "inserted"]);
    const replay = await store.append(request);
    expect(replay).toMatchObject({...first, outcome: "existing"});
    const verifiedProof = await fixture.loadedPort.verify() as ProtectedSwaggerLoadedDocument;
    const conflicting = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: fixture.binding, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => ({...verifiedProof,
        document: {...verifiedProof.document, digest: hash("conflicting document identity")}})}});
    await expect(conflicting.append(request)).rejects.toMatchObject({code: "LOADED_DOCUMENT_VERIFICATION_CONFLICT"});
    const alternateBinding = {...fixture.binding, loadArtifactRef: "capture:loaded-proof-load-alternate",
      loadConfiguredKeyRef: "key:loaded-proof-load-alternate", loadEnvelopeDigest: hash("alternate load envelope")};
    const alternateProof = {...verifiedProof, loadArtifactRef: alternateBinding.loadArtifactRef,
      loadConfiguredKeyRef: alternateBinding.loadConfiguredKeyRef, loadEnvelopeDigest: alternateBinding.loadEnvelopeDigest};
    const alternate = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: alternateBinding, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => alternateProof}});
    const alternateResult = await alternate.append(request);
    expect(alternateResult.outcome).toBe("inserted");
    expect(alternateResult.loadIdentityDigest).not.toBe(first.loadIdentityDigest);
    const rows = await db.pool.query(`SELECT * FROM ${schema}.orchestration_observed_loaded_document_verifications`);
    expect(rows.rows).toHaveLength(2);
    const saved = JSON.stringify(rows.rows);
    expect(saved).not.toContain("readOrder"); expect(saved).not.toContain("/orders/{id}");
    expect(saved).not.toContain("responses:"); expect(saved).not.toContain("BEGIN PUBLIC KEY");
    expect(saved).toContain("capture:loaded-proof-load");
    await expect(db.pool.query(`INSERT INTO ${schema}.orchestration_observed_loaded_document_verifications
      (tenant_id,load_identity_digest,capture_identity_digest,parent_verifier_profile_version,verifier_profile_version,
       repository_id,service_id,immutable_revision,source_digest,environment,load_artifact_ref,load_configured_key_ref,
       load_envelope_digest,load_signer_spki_digest,service_root,session_id,document_raw_sha256,
       document_canonical_value_sha256,document_digest,result_digest,handler_count,match_count,unobserved_diagnostic_count)
      SELECT tenant_id,$1,$2,parent_verifier_profile_version,verifier_profile_version,repository_id,service_id,
        immutable_revision,source_digest,environment,load_artifact_ref,load_configured_key_ref,load_envelope_digest,
        load_signer_spki_digest,service_root,session_id,document_raw_sha256,document_canonical_value_sha256,
        document_digest,result_digest,handler_count,match_count,unobserved_diagnostic_count
      FROM ${schema}.orchestration_observed_loaded_document_verifications
      WHERE tenant_id=$3 AND load_identity_digest=$4`,
    [hash("invalid parent identity"), hash("not-associated"), fixture.scope.tenantId, first.loadIdentityDigest]))
      .rejects.toMatchObject({code: "23503"});
    const catalog = await db.pool.query<{snapshots: string; branches: string}>(`SELECT
      (SELECT count(*)::text FROM ${schema}.catalog_snapshots) AS snapshots,
      (SELECT count(*)::text FROM ${schema}.catalog_branch_pointers) AS branches`);
    expect(catalog.rows).toEqual([{snapshots: "0", branches: "0"}]);
    const countBeforeFinalizers = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count
      FROM ${schema}.orchestration_observed_loaded_document_verifications`);
    expect(countBeforeFinalizers.rows).toEqual([{count: "2"}]);
    const finalizers = [
      {suffix: "deny", callback: async () => false},
      {suffix: "throw", callback: async () => {throw Error("private finalizer canary");}},
    ] as const;
    for (const {suffix, callback} of finalizers) {
      const stagedBinding = {...fixture.binding, loadArtifactRef: `capture:finalize-${suffix}`,
        loadConfiguredKeyRef: `key:finalize-${suffix}`, loadEnvelopeDigest: hash(`finalize-${suffix}`)};
      const stagedProof = {...verifiedProof, loadArtifactRef: stagedBinding.loadArtifactRef,
        loadConfiguredKeyRef: stagedBinding.loadConfiguredKeyRef, loadEnvelopeDigest: stagedBinding.loadEnvelopeDigest};
      const staged = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
        binding: stagedBinding, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
        verificationPort: {verify: async () => stagedProof}, transactionFinalize: callback});
      await expect(staged.append(request)).rejects.toMatchObject({code: suffix === "deny"
        ? "LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED" : "LOADED_DOCUMENT_VERIFICATION_STORAGE_ERROR"});
    }
    const countAfterFinalizers = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count
      FROM ${schema}.orchestration_observed_loaded_document_verifications`);
    expect(countAfterFinalizers.rows).toEqual([{count: "2"}]);
    await expect(db.pool.query(`UPDATE ${schema}.orchestration_observed_loaded_document_verifications
      SET handler_count=2 WHERE tenant_id=$1`, [fixture.scope.tenantId])).rejects.toThrow();
    await expect(db.pool.query(`DELETE FROM ${schema}.orchestration_observed_loaded_document_verifications`)).rejects.toThrow();
  } finally {await db.cleanup();}
});

test("denial, absent parent, unverified port result, and transaction revocation leave no loaded summary", async () => {
  let accessorCalled = false;
  const malformed = Object.defineProperty({schema: "loaded_verification_bad"}, "preflightAuthorize", {
    get() {accessorCalled = true; throw Error("private accessor canary");}, enumerable: true,
  });
  expect(() => createObservedLoadedDocumentVerificationStore({} as never, malformed as never))
    .toThrow(expect.objectContaining({code: "INVALID_LOADED_DOCUMENT_VERIFICATION_REQUEST"}));
  expect(accessorCalled).toBe(false);
  const db = await createCatalogTestDatabase();
  const schema = quoteCatalogTestSchema(db.schema);
  try {
    await applyOrchestrationMigrations(db.pool, {schema: db.schema});
    const fixture = await endToEnd(db);
    const verify = vi.fn(() => fixture.loadedPort.verify());
    const wrongScope = {...fixture.scope, serviceId: "other-service"};
    const scoped = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: fixture.binding, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify}});
    const scopeQuerySpy = vi.spyOn(db.pool, "query").mockClear();
    await expect(scoped.append({scope: wrongScope, captureIdentityDigest: fixture.association.captureIdentityDigest}))
      .rejects.toMatchObject({code: "INVALID_LOADED_DOCUMENT_VERIFICATION_REQUEST"});
    expect(scopeQuerySpy).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    scopeQuerySpy.mockRestore();
    const denied = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: fixture.binding, preflightAuthorize: async () => false, transactionAuthorize: async () => true,
      verificationPort: {verify}});
    const querySpy = vi.spyOn(db.pool, "query").mockClear();
    const connectSpy = vi.spyOn(db.pool, "connect").mockClear();
    await expect(denied.append({scope: fixture.scope, captureIdentityDigest: fixture.association.captureIdentityDigest}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED"});
    expect(verify).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled(); expect(connectSpy).not.toHaveBeenCalled();
    querySpy.mockRestore(); connectSpy.mockRestore();
    const missingId = hash("missing parent");
    const missing = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: {...fixture.binding, captureIdentityDigest: missingId}, preflightAuthorize: async () => true,
      transactionAuthorize: async () => true, verificationPort: {verify}});
    await expect(missing.append({scope: fixture.scope, captureIdentityDigest: missingId}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED"});
    await expect(denied.append({scope: fixture.scope, captureIdentityDigest: missingId}))
      .rejects.toMatchObject({code: "INVALID_LOADED_DOCUMENT_VERIFICATION_REQUEST"});
    const revoked = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: fixture.binding, preflightAuthorize: async () => true, transactionAuthorize: async () => false,
      verificationPort: {verify}});
    await expect(revoked.append({scope: fixture.scope, captureIdentityDigest: fixture.association.captureIdentityDigest}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED"});
    const unverified = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: fixture.binding, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: async () => ({kind: "fake loaded proof", sessionId: "private-canary"})}});
    await expect(unverified.append({scope: fixture.scope, captureIdentityDigest: fixture.association.captureIdentityDigest}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_VERIFICATION_UNVERIFIED"});
    const rows = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count
      FROM ${schema}.orchestration_observed_loaded_document_verifications`);
    expect(rows.rows).toEqual([{count: "0"}]);

    // A recorded capture association without its byte-verification summary is not a valid parent.
    await db.pool.query(`DROP TRIGGER orchestration_observed_capture_verifications_immutable
      ON ${schema}.orchestration_observed_capture_verifications`);
    await db.pool.query(`DELETE FROM ${schema}.orchestration_observed_capture_verifications
      WHERE tenant_id=$1 AND capture_identity_digest=$2 AND verifier_profile_version='protected-handler-bytes-1'`,
    [fixture.scope.tenantId, fixture.association.captureIdentityDigest]);
    const parentMissingVerify = vi.fn(() => fixture.loadedPort.verify());
    const parentMissing = createObservedLoadedDocumentVerificationStore(db.pool, {schema: db.schema,
      binding: fixture.binding, preflightAuthorize: async () => true, transactionAuthorize: async () => true,
      verificationPort: {verify: parentMissingVerify}});
    await expect(parentMissing.append({scope: fixture.scope, captureIdentityDigest: fixture.association.captureIdentityDigest}))
      .rejects.toMatchObject({code: "LOADED_DOCUMENT_VERIFICATION_UNAUTHORIZED"});
    expect(parentMissingVerify).not.toHaveBeenCalled();
    const afterMissingParent = await db.pool.query<{count: string}>(`SELECT count(*)::text AS count
      FROM ${schema}.orchestration_observed_loaded_document_verifications`);
    expect(afterMissingParent.rows).toEqual([{count: "0"}]);
  } finally {await db.cleanup();}
});
