import {execFile as execFileCallback} from "node:child_process";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {promisify} from "node:util";
import type {Pool} from "pg";
import {supportedRouterDigest} from "../../../analyzers/nodejs/src/runtime-binding.js";
import {digestServiceTree, readServiceTree} from "../../../analyzers/nodejs/src/source.js";
import {materializeGitSource} from "../../../connectors/git-source/src/index.js";
import {createProtectedCaptureVerificationPort} from "../../../connectors/git-source/src/protected-capture-verification.js";
import {createProtectedSwaggerLoadedDocumentPort, type ProtectedSwaggerLoadedDocument} from "../../../connectors/git-source/src/protected-swagger-loaded-document.js";
import type {ProtectedDocumentLoadObservation} from "../../../connectors/git-source/src/protected-document-load.js";
import {createRuntimeCapturePinResolver} from "../../../connectors/git-source/src/runtime-capture-pin.js";
import {parseStrictYaml} from "../../../analyzers/nodejs/src/strict-yaml.js";
import {canonicalJsonStringify} from "../../../packages/ir/src/index.js";
import {createObservedCaptureAssociationStore} from "../../../packages/orchestration/src/observed-captures.js";
import {createObservedCaptureVerificationStore} from "../../../packages/orchestration/src/observed-capture-verifications.js";
import type {ObservedCaptureScope} from "../../../packages/orchestration/src/observed-captures.js";

const execFile = promisify(execFileCallback);
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const loadedDocumentServiceRoot = "services/orders";
const documentPath = `${loadedDocumentServiceRoot}/api/swagger/swagger.yaml`;
const document = `swagger: '2.0'\ninfo: {title: Example, version: '1'}\nbasePath: /api/v1\npaths:\n  /orders/{id}:\n    x-swagger-router-controller: orders\n    get:\n      operationId: readOrder\n      responses:\n        '200': {description: ok}\n`;
const handler = `exports.readOrder = function(req, res) { return res.status(200).json({ok:true}); };\n`;
const app = `const express = require("express");\nconst SwaggerExpress = require("swagger-express-mw");\nconst app = express();\nSwaggerExpress.create({appRoot: __dirname}, function(error, middleware) {\n  if (error) throw error;\n  middleware.register(app);\n});\n`;
const manifest = {type: "commonjs", scripts: {start: "NODE_ENV=test node app.js"}, engines: {node: "22.19.0"},
  dependencies: {"swagger-express-mw": "0.7.0"}};
const lock = {lockfileVersion: 3, packages: {"": {dependencies: manifest.dependencies},
  "node_modules/swagger-express-mw": {version: "0.7.0", dependencies: {"swagger-node-runner": "^0.7.0"}},
  "node_modules/swagger-node-runner": {version: "0.7.0", dependencies: {bagpipes: "^0.1.0", config: "^1.16.0", sway: "^1.0.0"}},
  "node_modules/bagpipes": {version: "0.1.2"}, "node_modules/config": {version: "1.31.0"}, "node_modules/sway": {version: "1.0.0"}}};

export async function createLoadedDocumentProofFixture(pool: Pool, schema: string, scope: ObservedCaptureScope,
  repoPath: string, authorize: () => Promise<boolean>) {
  await execFile("git", ["init", "-q", "-b", "main"], {cwd: repoPath});
  const files: Record<string, string> = {[`${loadedDocumentServiceRoot}/app.js`]: app,
    [`${loadedDocumentServiceRoot}/api/controllers/orders.js`]: handler,
    [`${loadedDocumentServiceRoot}/package.json`]: JSON.stringify(manifest),
    [`${loadedDocumentServiceRoot}/package-lock.json`]: JSON.stringify(lock), [documentPath]: document};
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(repoPath, path)), {recursive: true}); await writeFile(join(repoPath, path), contents);
  }
  await execFile("git", ["add", "-A"], {cwd: repoPath});
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {cwd: repoPath});
  const immutableRevision = (await execFile("git", ["rev-parse", "HEAD"], {cwd: repoPath})).stdout.trim();
  const tree = await materializeGitSource({repoPath, revision: immutableRevision, serviceRoot: loadedDocumentServiceRoot,
    limits: {maxFiles: 30, maxBytes: 100_000}});
  let sourceDigest: string;
  try {const selected = await readServiceTree(tree.projectRoot, loadedDocumentServiceRoot, 30, () => undefined);
    sourceDigest = digestServiceTree(selected.files, selected.root, selected.opaqueConfiguration);}
  finally {await tree.dispose();}
  const exactScope = Object.freeze({...scope, immutableRevision, sourceDigest});
  const receiptPayload = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: exactScope.repositoryId,
    service_id: exactScope.serviceId, immutable_revision: exactScope.immutableRevision, source_digest: exactScope.sourceDigest,
    environment: exactScope.environment, session_id: "loaded-session", captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: supportedRouterDigest, runtime_fingerprint: `sha256:${"c".repeat(64)}`,
    bindings: [{method: "GET", application_path: "/api/v1/orders/{id}", controller: "orders",
      operation_id: "readOrder", export_name: "readOrder", handler_path: "api/controllers/orders.js",
      handler_digest: hash(handler), mock_mode: false}]}));
  const keypair = generateKeyPairSync("ed25519");
  const publicKey = keypair.publicKey.export({type: "spki", format: "pem"}).toString();
  const signerDigest = hash(keypair.publicKey.export({type: "spki", format: "der"}));
  const receiptText = JSON.stringify({payload: receiptPayload.toString("base64"),
    signature: sign(null, receiptPayload, keypair.privateKey).toString("base64")});
  const pinResolver = createRuntimeCapturePinResolver({binding: {scope: exactScope, artifactRef: "capture:loaded-capture-receipt",
    configuredKeyRef: "key:loaded-capture-signer", expectedReceiptDigest: hash(receiptText),
    expectedSignerSpkiDigest: signerDigest, policyVersion: "runtime-capture-pin-1"}, authorize,
    readReceipt: async () => receiptText, readKey: async () => publicKey});
  const associationStore = createObservedCaptureAssociationStore(pool, {schema,
    preflightAuthorize: async () => true, transactionAuthorize: async () => true, pinResolver});
  const association = await associationStore.append(exactScope);
  const bytesPort = createProtectedCaptureVerificationPort({repoPath, serviceRoot: loadedDocumentServiceRoot,
    scope: exactScope, expectedCaptureIdentityDigest: association.captureIdentityDigest, pinResolver, authorize,
    readReceipt: async () => receiptText, readKey: async () => publicKey,
    limits: {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10_000}});
  const bytesStore = createObservedCaptureVerificationStore(pool, {schema,
    preflightAuthorize: async () => true, transactionAuthorize: async () => true, verificationPort: bytesPort});
  await bytesStore.append({scope: exactScope, captureIdentityDigest: association.captureIdentityDigest});

  const observation: ProtectedDocumentLoadObservation = {kind: "unsigned_runtime_document_load", profileVersion: "swagger-document-load-capture-1",
    source: {repositoryId: exactScope.repositoryId, serviceId: exactScope.serviceId, immutableRevision: exactScope.immutableRevision,
      sourceDigest: exactScope.sourceDigest, environment: exactScope.environment, sessionId: "loaded-session"},
    framework: {nodeVersion: "22.19.0", routerDigest: supportedRouterDigest, runnerDigest: hash("runner"),
      swayDigest: hash("sway"), jsonRefsDigest: hash("jsonrefs"), pathLoaderDigest: hash("pathloader")},
    document: {path: "api/swagger/swagger.yaml", rawSha256: hash(files[documentPath]!),
      canonicalValueSha256: hash(canonicalJsonStringify(parseStrictYaml(document)))},
    bindings: [{method: "GET", application_path: "/api/v1/orders/{id}", controller: "orders", operation_id: "readOrder",
      export_name: "readOrder", handler_path: "api/controllers/orders.js", handler_digest: hash(handler), mock_mode: false}]};
  const signedPayload = Buffer.from(canonicalJsonStringify({scope: exactScope, observation}));
  const envelope = JSON.stringify({purpose: "api-truth:swagger-document-load-observation-1", payload: signedPayload.toString("base64"),
    signature: sign(null, Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"), signedPayload]), keypair.privateKey).toString("base64")});
  const loadBinding = {scope: exactScope, artifactRef: "capture:loaded-document-envelope", configuredKeyRef: "key:loaded-document-signer",
    expectedEnvelopeDigest: hash(envelope), expectedSignerSpkiDigest: signerDigest, expectedObservation: observation};
  const loadedPort = createProtectedSwaggerLoadedDocumentPort({documentLoad: {binding: loadBinding, authorize,
    readArtifact: async () => envelope, readKey: async () => publicKey}, correspondence: {repoPath,
    serviceRoot: loadedDocumentServiceRoot, scope: exactScope, expectedCaptureIdentityDigest: association.captureIdentityDigest,
    pinResolver, authorize, readReceipt: async () => receiptText, readKey: async () => publicKey,
    limits: {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10_000}, documentPath,
    expectedRawDocumentSha256: hash(files[documentPath]!)} });
  return {scope: exactScope, association, loadedPort, loadBinding: {loadArtifactRef: loadBinding.artifactRef,
    loadConfiguredKeyRef: loadBinding.configuredKeyRef, loadEnvelopeDigest: loadBinding.expectedEnvelopeDigest,
    loadSignerSpkiDigest: loadBinding.expectedSignerSpkiDigest}};
}

export type LoadedDocumentProofFixture = Awaited<ReturnType<typeof createLoadedDocumentProofFixture>>;
export type LoadedDocumentRuntimeProof = ProtectedSwaggerLoadedDocument;
