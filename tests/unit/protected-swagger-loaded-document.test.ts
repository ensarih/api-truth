import {execFile as execFileCallback} from "node:child_process";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {promisify} from "node:util";
import {afterEach, expect, test, vi} from "vitest";
import {createProtectedSwaggerLoadedDocumentPort, ProtectedSwaggerLoadedDocumentError,
  type ProtectedSwaggerLoadedDocumentOptions} from "../../connectors/git-source/src/protected-swagger-loaded-document.js";
import type {ProtectedDocumentLoadObservation} from "../../connectors/git-source/src/protected-document-load.js";
import {supportedRouterDigest} from "../../analyzers/nodejs/src/runtime-binding.js";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {materializeGitSource} from "../../connectors/git-source/src/index.js";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {parseStrictYaml} from "../../analyzers/nodejs/src/strict-yaml.js";
import {digestServiceTree, readServiceTree} from "../../analyzers/nodejs/src/source.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const root = "services/orders", documentPath = `${root}/api/swagger/swagger.yaml`;
const document = `swagger: '2.0'\ninfo: {title: Example, version: '1'}\nbasePath: /api/v1\npaths:\n  /orders/{id}:\n    x-swagger-router-controller: orders\n    get:\n      operationId: readOrder\n      responses:\n        '200': {description: ok}\n  /invoices:\n    x-swagger-router-controller: invoices\n    post:\n      operationId: createInvoice\n      responses:\n        '200': {description: ok}\n  /health:\n    x-swagger-router-controller: orders\n    get:\n      operationId: health\n      responses:\n        '200': {description: ok}\n`;
const handler = `exports.readOrder = function(req, res) { return res.status(200).json({ok:true}); };\n`;
const invoiceHandler = `exports.createInvoice = function(req, res) { return res.status(200).json({ok:true}); };\n`;
const app = `const express = require("express");\nconst SwaggerExpress = require("swagger-express-mw");\nconst app = express();\nSwaggerExpress.create({appRoot: __dirname}, function(error, middleware) {\n  if (error) throw error;\n  middleware.register(app);\n});\n`;
const manifest = {type: "commonjs", scripts: {start: "NODE_ENV=test node app.js"}, engines: {node: "22.19.0"},
  dependencies: {"swagger-express-mw": "0.7.0"}};
const lock = {lockfileVersion: 3, packages: {"": {dependencies: manifest.dependencies},
  "node_modules/swagger-express-mw": {version: "0.7.0", dependencies: {"swagger-node-runner": "^0.7.0"}},
  "node_modules/swagger-node-runner": {version: "0.7.0", dependencies: {bagpipes: "^0.1.0", config: "^1.16.0", sway: "^1.0.0"}},
  "node_modules/bagpipes": {version: "0.1.2"}, "node_modules/config": {version: "1.31.0"}, "node_modules/sway": {version: "1.0.0"}}};
const keypair = generateKeyPairSync("ed25519");
const keyText = keypair.publicKey.export({type: "spki", format: "pem"}).toString();
const signerDigest = hash(keypair.publicKey.export({type: "spki", format: "der"}));

async function fixture(overrides: Record<string, string | Buffer> = {}) {
  const repoPath = await mkdtemp(join(tmpdir(), "api-truth-loaded-swagger-")); roots.push(repoPath);
  await execFile("git", ["init", "-q", "-b", "main"], {cwd: repoPath});
  const files: Record<string, string | Buffer> = {[`${root}/app.js`]: app,
    [`${root}/api/controllers/orders.js`]: handler, [`${root}/api/controllers/invoices.js`]: invoiceHandler,
    [`${root}/package.json`]: JSON.stringify(manifest),
    [`${root}/package-lock.json`]: JSON.stringify(lock), [documentPath]: document, ...overrides};
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repoPath, path)), {recursive: true}); await writeFile(join(repoPath, path), content);
  }
  await execFile("git", ["add", "-A"], {cwd: repoPath});
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {cwd: repoPath});
  const revision = (await execFile("git", ["rev-parse", "HEAD"], {cwd: repoPath})).stdout.trim();
  const tree = await materializeGitSource({repoPath, revision, serviceRoot: root, limits: {maxFiles: 30, maxBytes: 100_000}});
  let sourceDigest: string;
  try {const source = await readServiceTree(tree.projectRoot, root, 30, () => undefined);
    sourceDigest = digestServiceTree(source.files, source.root, source.opaqueConfiguration);}
  finally {await tree.dispose();}
  const scope = {tenantId: "tenant", repositoryId: "repository", serviceId: "orders", immutableRevision: revision,
    sourceDigest, environment: "test"};
  const rawDocument = files[documentPath]!;
  const rawDocumentText = Buffer.isBuffer(rawDocument) ? rawDocument.toString("utf8") : rawDocument;
  const rawDocumentSha256 = hash(rawDocument);
  const binding = {method: "GET", application_path: "/api/v1/orders/{id}", controller: "orders",
    operation_id: "readOrder", export_name: "readOrder", handler_path: "api/controllers/orders.js",
    handler_digest: hash(handler), mock_mode: false};
  const secondBinding = {method: "POST", application_path: "/api/v1/invoices", controller: "invoices",
    operation_id: "createInvoice", export_name: "createInvoice", handler_path: "api/controllers/invoices.js",
    handler_digest: hash(invoiceHandler), mock_mode: false};
  const sessionId = "session-1";
  const receiptPayload = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: scope.repositoryId,
    service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
    environment: scope.environment, session_id: sessionId, captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: [binding, secondBinding]}));
  const receipt = JSON.stringify({payload: receiptPayload.toString("base64"),
    signature: sign(null, receiptPayload, keypair.privateKey).toString("base64")});
  const observation: ProtectedDocumentLoadObservation = {kind: "unsigned_runtime_document_load", profileVersion: "swagger-document-load-capture-1",
    source: {repositoryId: scope.repositoryId, serviceId: scope.serviceId, immutableRevision: scope.immutableRevision,
      sourceDigest: scope.sourceDigest, environment: scope.environment, sessionId},
    framework: {nodeVersion: "22.19.0", routerDigest: supportedRouterDigest, runnerDigest: hash("runner"),
      swayDigest: hash("sway"), jsonRefsDigest: hash("jsonrefs"), pathLoaderDigest: hash("pathloader")},
    document: {path: "api/swagger/swagger.yaml" as const, rawSha256: rawDocumentSha256,
      canonicalValueSha256: hash(canonicalJsonStringify(parseStrictYaml(rawDocumentText)))},
    bindings: [{method: "GET", application_path: binding.application_path, controller: binding.controller,
      operation_id: binding.operation_id, export_name: binding.export_name, handler_path: binding.handler_path,
      handler_digest: binding.handler_digest, mock_mode: false as const},
      {method: "POST", application_path: secondBinding.application_path, controller: secondBinding.controller,
        operation_id: secondBinding.operation_id, export_name: secondBinding.export_name,
        handler_path: secondBinding.handler_path, handler_digest: secondBinding.handler_digest, mock_mode: false as const}]};
  const signedPayload = Buffer.from(canonicalJsonStringify({scope, observation}));
  const envelope = JSON.stringify({purpose: "api-truth:swagger-document-load-observation-1",
    payload: signedPayload.toString("base64"),
    signature: sign(null, Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"), signedPayload]), keypair.privateKey).toString("base64")});
  const authorize = vi.fn(async () => true);
  const readKey = vi.fn(async () => keyText);
  const pinResolver = createRuntimeCapturePinResolver({binding: {scope, artifactRef: "capture:receipt-1",
    configuredKeyRef: "key:approved-1", expectedReceiptDigest: hash(receipt), expectedSignerSpkiDigest: signerDigest,
    policyVersion: "runtime-capture-pin-1"}, authorize, readReceipt: async () => receipt, readKey: async () => keyText});
  const pin = await pinResolver.resolve(scope);
  const options: ProtectedSwaggerLoadedDocumentOptions = {documentLoad: {binding: {scope, artifactRef: "capture:load-1",
    configuredKeyRef: "key:load-1", expectedEnvelopeDigest: hash(envelope), expectedSignerSpkiDigest: signerDigest,
    expectedObservation: observation}, authorize, readArtifact: async () => envelope, readKey},
    correspondence: {repoPath, serviceRoot: root, scope, expectedCaptureIdentityDigest: pin.identityDigest,
      pinResolver, authorize, readReceipt: async () => receipt, readKey: async () => keyText,
      limits: {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10_000}, documentPath,
      expectedRawDocumentSha256: rawDocumentSha256}};
  return {repoPath, scope, options, authorize, observation, envelope, receipt};
}

test("composes signed load and same-session source correspondence, retaining only an unobserved diagnostic", async () => {
  const value = await fixture();
  const result = await createProtectedSwaggerLoadedDocumentPort(value.options).verify();
  expect(result).toMatchObject({kind: "protected_swagger_loaded_document_correspondence", profileVersion: "swagger-loaded-document-1",
    scope: value.scope, serviceRoot: root, sessionId: "session-1", loadArtifactRef: "capture:load-1",
    loadConfiguredKeyRef: "key:load-1", document: {path: documentPath, rawSha256: value.observation.document.rawSha256,
      canonicalValueSha256: value.observation.document.canonicalValueSha256},
    matches: [{bindingIndex: 0, documentPointer: "/paths/~1orders~1{id}/get", handlerPath: "api/controllers/orders.js"},
      {bindingIndex: 1, documentPointer: "/paths/~1invoices/post", handlerPath: "api/controllers/invoices.js"}],
    diagnostics: [{code: "document_operation_unobserved", documentPointer: "/paths/~1health/get"}]});
  expect(value.authorize.mock.calls.length).toBeGreaterThan(4);
  expect(JSON.stringify(result)).not.toContain(value.receipt);
});

test("rejects separate authorization callbacks to close the final recheck gap", async () => {
  const value = await fixture();
  value.options.correspondence.authorize = async () => true;
  expect(() => createProtectedSwaggerLoadedDocumentPort(value.options)).toThrowError(ProtectedSwaggerLoadedDocumentError);
});

test.each(["session", "raw", "canonical", "router"] as const)("rejects load/correspondence %s mismatch", async field => {
  const value = await fixture();
  if (field === "session") value.observation.source.sessionId = "other-session";
  if (field === "raw") value.observation.document.rawSha256 = hash("other raw");
  if (field === "canonical") value.observation.document.canonicalValueSha256 = hash("other parsed document");
  if (field === "router") value.observation.framework.routerDigest = hash("unsupported router");
  const changed = Buffer.from(canonicalJsonStringify({scope: value.scope, observation: value.observation}));
  const envelope = JSON.stringify({purpose: "api-truth:swagger-document-load-observation-1", payload: changed.toString("base64"),
    signature: sign(null, Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"), changed]), keypair.privateKey).toString("base64")});
  value.options.documentLoad.binding.expectedObservation = value.observation;
  value.options.documentLoad.binding.expectedEnvelopeDigest = hash(envelope);
  value.options.documentLoad.readArtifact = async () => envelope;
  await expect(createProtectedSwaggerLoadedDocumentPort(value.options).verify()).rejects.toMatchObject({code: "LOADED_DOCUMENT_UNVERIFIED"});
});

test("rejects a signed load whose full handler list is reordered", async () => {
  const value = await fixture();
  const reversed = {...value.observation, bindings: [...value.observation.bindings].reverse()};
  const payload = Buffer.from(canonicalJsonStringify({scope: value.scope, observation: reversed}));
  const envelope = JSON.stringify({purpose: "api-truth:swagger-document-load-observation-1", payload: payload.toString("base64"),
    signature: sign(null, Buffer.concat([Buffer.from("api-truth:swagger-document-load-observation-1\n"), payload]), keypair.privateKey).toString("base64")});
  value.options.documentLoad.binding.expectedObservation = reversed;
  value.options.documentLoad.binding.expectedEnvelopeDigest = hash(envelope);
  value.options.documentLoad.readArtifact = async () => envelope;
  await expect(createProtectedSwaggerLoadedDocumentPort(value.options).verify()).rejects.toMatchObject({code: "LOADED_DOCUMENT_UNVERIFIED"});
});

test("rechecks the independently stored load artifact after source correspondence", async () => {
  const value = await fixture();
  let reads = 0;
  value.options.documentLoad.readArtifact = async () => ++reads === 1 ? value.envelope : `${value.envelope} `;
  await expect(createProtectedSwaggerLoadedDocumentPort(value.options).verify())
    .rejects.toMatchObject({code: "LOADED_DOCUMENT_UNVERIFIED"});
  expect(reads).toBe(2);
});

test("rejects correspondence results with unsupported document-operation diagnostics", async () => {
  const changed = document.replace("    x-swagger-router-controller: orders\n    get:\n      operationId: health",
    "    x-swagger-pipe: unsupported\n    x-swagger-router-controller: orders\n    get:\n      operationId: health");
  const value = await fixture({[documentPath]: changed});
  await expect(createProtectedSwaggerLoadedDocumentPort(value.options).verify())
    .rejects.toMatchObject({code: "LOADED_DOCUMENT_UNVERIFIED"});
});

test("rejects ambiguous source-to-document route correspondence", async () => {
  const changed = `${document}  /orders/{slug}:\n    x-swagger-router-controller: orders\n    get:\n      operationId: readOther\n      responses:\n        '200': {description: ok}\n`;
  const value = await fixture({[documentPath]: changed});
  await expect(createProtectedSwaggerLoadedDocumentPort(value.options).verify())
    .rejects.toMatchObject({code: "LOADED_DOCUMENT_UNVERIFIED"});
});

test("a shared authority revocation during composition rejects the combined result", async () => {
  const value = await fixture();
  let calls = 0;
  value.options.documentLoad.authorize = value.options.correspondence.authorize = async () => ++calls < 7;
  await expect(createProtectedSwaggerLoadedDocumentPort(value.options).verify()).rejects.toMatchObject({
    code: expect.stringMatching(/UNAUTHORIZED|UNVERIFIED/)});
  expect(calls).toBeGreaterThan(2);
});

test("rejects configuration scope mismatches before calling external ports", async () => {
  const value = await fixture();
  value.authorize.mockClear();
  value.options.correspondence.scope = {...value.scope, tenantId: "other-tenant"};
  await expect(Promise.resolve().then(() => createProtectedSwaggerLoadedDocumentPort(value.options)))
    .rejects.toMatchObject({code: "INVALID_LOADED_DOCUMENT_CONFIG"});
  expect(value.authorize).not.toHaveBeenCalled();
});

test("rejects proxied or accessor-backed configuration without invoking traps or authorization", async () => {
  const value = await fixture();
  value.authorize.mockClear();
  const proxyTrap = vi.fn(() => {throw Error("private proxy canary");});
  expect(() => createProtectedSwaggerLoadedDocumentPort(new Proxy(value.options, {getPrototypeOf: proxyTrap})))
    .toThrowError(ProtectedSwaggerLoadedDocumentError);
  expect(proxyTrap).not.toHaveBeenCalled();
  const accessorScope = {...value.scope};
  Object.defineProperty(accessorScope, "tenantId", {get: () => {throw Error("private accessor canary");}});
  value.options.correspondence.scope = accessorScope as typeof value.scope;
  expect(() => createProtectedSwaggerLoadedDocumentPort(value.options)).toThrowError(ProtectedSwaggerLoadedDocumentError);
  expect(value.authorize).not.toHaveBeenCalled();
});
