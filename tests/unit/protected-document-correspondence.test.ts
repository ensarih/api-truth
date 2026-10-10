import {execFile as execFileCallback} from "node:child_process";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {promisify} from "node:util";
import {afterEach, expect, test, vi} from "vitest";
import {materializeGitSource} from "../../connectors/git-source/src/index.js";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {createProtectedSwaggerDocumentCorrespondencePort} from "../../connectors/git-source/src/protected-swagger-document-correspondence.js";
import {canonicalJsonStringify} from "../../packages/ir/src/index.js";
import {parseStrictYaml} from "../../analyzers/nodejs/src/strict-yaml.js";
import {digestServiceTree, readServiceTree} from "../../analyzers/nodejs/src/source.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const serviceRoot = "services/orders";
const documentPath = `${serviceRoot}/api/swagger/swagger.yaml`;
const handler = "exports.readOrder = function(req, res) { return res.status(200).json({ok:true}); };\n";
const keypair = generateKeyPairSync("ed25519");
const keyText = keypair.publicKey.export({type: "spki", format: "pem"}).toString();
const signerDigest = hash(keypair.publicKey.export({type: "spki", format: "der"}));
const document = `swagger: '2.0'
info: {title: Example, version: '1'}
basePath: /api/v1
paths:
  /orders/{id}:
    x-swagger-router-controller: orders
    get:
      operationId: readOrder
      responses:
        '200': {description: ok}
`;
const entry = `const express = require("express");
const SwaggerExpress = require("swagger-express-mw");
const app = express();
SwaggerExpress.create({appRoot: __dirname}, function(error, middleware) {
  if (error) throw error;
  middleware.register(app);
});\n`;
const manifest = {type: "commonjs", scripts: {start: "NODE_ENV=test node app.js"}, engines: {node: "22.19.0"},
  dependencies: {"swagger-express-mw": "0.7.0"}};
const lock = {lockfileVersion: 3, packages: {"": {dependencies: manifest.dependencies},
  "node_modules/swagger-express-mw": {version: "0.7.0", dependencies: {"swagger-node-runner": "^0.7.0"}},
  "node_modules/swagger-node-runner": {version: "0.7.0", dependencies: {bagpipes: "^0.1.0", config: "^1.16.0", sway: "^1.0.0"}},
  "node_modules/bagpipes": {version: "0.1.2"}, "node_modules/config": {version: "1.31.0"},
  "node_modules/sway": {version: "1.0.0"}}};

async function repository(overrides: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-correspondence-")); roots.push(root);
  await execFile("git", ["init", "-q", "-b", "main"], {cwd: root});
  const files = {[`${serviceRoot}/app.js`]: entry,
    [`${serviceRoot}/api/controllers/orders.js`]: handler,
    [`${serviceRoot}/package.json`]: JSON.stringify(manifest),
    [`${serviceRoot}/package-lock.json`]: JSON.stringify(lock),
    [documentPath]: document, ...overrides};
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), value);
  }
  await execFile("git", ["add", "-A"], {cwd: root});
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {cwd: root});
  const revision = (await execFile("git", ["rev-parse", "HEAD"], {cwd: root})).stdout.trim();
  const tree = await materializeGitSource({repoPath: root, revision, serviceRoot, limits: {maxFiles: 30, maxBytes: 100_000}});
  let sourceDigest: string;
  try {
    const source = await readServiceTree(tree.projectRoot, serviceRoot, 30, () => undefined);
    sourceDigest = digestServiceTree(source.files, source.root, source.opaqueConfiguration);
  } finally { await tree.dispose(); }
  const scope = {tenantId: "tenant", repositoryId: "repository", serviceId: "orders", immutableRevision: revision,
    sourceDigest, environment: "test"};
  return {root, scope, rawDocumentSha256: hash(files[documentPath] ?? "")};
}
type Fixture = Awaited<ReturnType<typeof repository>>;
function signed(scope: Fixture["scope"], changes: Record<string, unknown> = {}) {
  const binding = {method: "GET", application_path: "/api/v1/orders/{id}", controller: "orders",
    operation_id: "readOrder", export_name: "readOrder", handler_path: "api/controllers/orders.js",
    handler_digest: hash(handler), mock_mode: false, ...changes};
  const payload = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: scope.repositoryId,
    service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
    environment: scope.environment, session_id: "session-1", captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: [binding]}));
  return JSON.stringify({payload: payload.toString("base64"), signature: sign(null, payload, keypair.privateKey).toString("base64")});
}
async function port(repo: Fixture, receipt = signed(repo.scope), overrides: Record<string, unknown> = {}) {
  const protectedPorts = {authorize: async () => true, readReceipt: async () => receipt, readKey: async () => keyText};
  const pinResolver = createRuntimeCapturePinResolver({binding: {scope: repo.scope,
    artifactRef: "capture:receipt-1", configuredKeyRef: "key:approved-1", expectedReceiptDigest: hash(receipt),
    expectedSignerSpkiDigest: signerDigest, policyVersion: "runtime-capture-pin-1"}, ...protectedPorts});
  const pin = await pinResolver.resolve(repo.scope);
  return createProtectedSwaggerDocumentCorrespondencePort({repoPath: repo.root, serviceRoot, scope: repo.scope,
    expectedCaptureIdentityDigest: pin.identityDigest, pinResolver, ...protectedPorts,
    documentPath, expectedRawDocumentSha256: repo.rawDocumentSha256,
    limits: {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10_000}, ...overrides});
}

test("signed capture corresponds to one selected Swagger operation in the same immutable source", async () => {
  const repo = await repository({[`${serviceRoot}/do-not-run.js`]: "require('node:fs').writeFileSync('executed', 'bad');"});
  const result = await (await port(repo)).verify();
  expect(result).toMatchObject({kind: "protected_swagger_document_value_correspondence", profileVersion: "swagger-document-value-1",
    scope: repo.scope, sessionId: "session-1", document: {path: documentPath, rawSha256: repo.rawDocumentSha256,
      canonicalValueSha256: hash(canonicalJsonStringify(parseStrictYaml(document)))},
    handlers: [{method:"GET",applicationPath:"/api/v1/orders/{id}",controller:"orders",operationId:"readOrder",
      exportName:"readOrder",handlerPath:"api/controllers/orders.js",handlerDigest:hash(handler)}],
    matches: [{bindingIndex: 0, documentPointer: "/paths/~1orders~1{id}/get", handlerPath: "api/controllers/orders.js"}],
    diagnostics: []});
  expect(result.limitations).toContain("Actual runtime document loading and deployment are unverified");
  expect(await readdir(repo.root)).not.toContain("executed");
});

test.each([
  ["controller", "other"], ["application_path", "/api/v1/other/{id}"],
])("captured %s mismatch remains a diagnostic", async (field, value) => {
  const repo = await repository();
  const result = await (await port(repo, signed(repo.scope, {[field]: value}))).verify();
  expect(result.matches).toEqual([]);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "captured_binding_unmatched", bindingIndex: 0}));
});

test("operation identity mismatch and invalid signed export cannot become a match", async () => {
  const repo = await repository({[documentPath]: document.replace("operationId: readOrder", "operationId: other")});
  const result = await (await port(repo)).verify();
  expect(result.matches).toEqual([]);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "captured_binding_unmatched", bindingIndex: 0}));
  await expect(port(repo, signed(repo.scope, {export_name: "other"}))).rejects.toMatchObject({code: "CAPTURE_RECEIPT_UNVERIFIED"});
});

test("unobserved document operation is retained without asserting runtime absence", async () => {
  const repo = await repository({[documentPath]: document.replace("      operationId: readOrder", "      operationId: readOrder")
    + "  /health:\n    get:\n      operationId: health\n      responses:\n        '200': {description: ok}\n"});
  const result = await (await port(repo)).verify();
  expect(result.matches).toHaveLength(1);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "document_operation_unobserved",
    documentPointer: "/paths/~1health/get"}));
});

test("wrong selected-document bytes and malformed document fail without match", async () => {
  const repo = await repository();
  await expect((await port(repo, signed(repo.scope), {expectedRawDocumentSha256: hash("different")})).verify())
    .rejects.toMatchObject({code: "PROTECTED_DOCUMENT_UNVERIFIED"});
  const malformed = await repository({[documentPath]: "swagger: [\n"});
  await expect((await port(malformed)).verify()).rejects.toMatchObject({code: "PROTECTED_DOCUMENT_UNVERIFIED"});
});

test.each(["\uFEFF" + document, document.replaceAll("\n", "\r\n")])(
  "raw document digest preserves BOM and line-ending bytes", async rawDocument => {
    const repo = await repository({[documentPath]: rawDocument});
    const result = await (await port(repo)).verify();
    expect(result.matches).toHaveLength(1);
    expect(result.document.rawSha256).toBe(hash(Buffer.from(rawDocument)));
    expect(result.document.canonicalValueSha256).toBe(hash(canonicalJsonStringify(parseStrictYaml(document))));
    expect(result.document.digest).toBe(hash(Buffer.concat([
      Buffer.from(`${documentPath}\0`), Buffer.from(rawDocument)])));
  });

test("invalid UTF-8 committed document cannot enter a trusted correspondence scope", async () => {
  await expect(repository({[documentPath]: Buffer.from([0xff, 0xfe, 0xff])})).rejects.toThrow();
});

test("ambiguous route shape and duplicate operation IDs never select a winning operation", async () => {
  const routeCollision = await repository({[documentPath]: document
    + "  /orders/{slug}:\n    x-swagger-router-controller: orders\n    get:\n      operationId: readOther\n      responses:\n        '200': {description: ok}\n"});
  const collision = await (await port(routeCollision)).verify();
  expect(collision.matches).toEqual([]);
  expect(collision.diagnostics).toContainEqual(expect.objectContaining({code: "captured_binding_ambiguous", bindingIndex: 0}));
  const duplicate = await repository({[documentPath]: document
    + "  /health:\n    get:\n      operationId: readOrder\n      responses:\n        '200': {description: ok}\n"});
  const result = await (await port(duplicate)).verify();
  expect(result.matches).toEqual([]);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "document_operation_unresolved",
    documentPointer: "/paths/~1orders~1{id}/get"}));
});

test("unsupported middleware policy, path reference, and external reference cannot certify correspondence", async () => {
  const wrongLock = JSON.parse(JSON.stringify(lock)) as typeof lock;
  wrongLock.packages["node_modules/swagger-node-runner"].version = "0.7.1";
  const locked = await repository({[`${serviceRoot}/package-lock.json`]: JSON.stringify(wrongLock)});
  const result = await (await port(locked)).verify();
  expect(result.matches).toEqual([]);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "middleware_policy_unverified"}));
  const pathRef = await repository({[documentPath]: document.replace("    get:", "    $ref: '#/paths/~1other'\n    get:")});
  const partial = await (await port(pathRef)).verify();
  expect(partial.matches).toEqual([]);
  expect(partial.diagnostics).toContainEqual(expect.objectContaining({code: "document_operation_unresolved"}));
  const operationRef = await repository({[documentPath]: document.replace("    get:",
    "    get:\n      $ref: '#/definitions/Foo'") + "definitions:\n  Foo: {type: object}\n"});
  const operation = await (await port(operationRef)).verify();
  expect(operation.matches).toEqual([]);
  expect(operation.diagnostics).toContainEqual(expect.objectContaining({code: "document_operation_unresolved",
    documentPointer: "/paths/~1orders~1{id}/get"}));
  const remote = await repository({[documentPath]: document + "definitions:\n  Unused: {$ref: 'https://example.invalid/schema'}\n"});
  await expect((await port(remote)).verify()).rejects.toMatchObject({code: "PROTECTED_DOCUMENT_UNVERIFIED"});
});

test("host-bound selection and final authorization reject substitutions without raw error text", async () => {
  const repo = await repository();
  const receipt = signed(repo.scope);
  const valid = await port(repo, receipt);
  const resolved = await valid.verify();
  expect(JSON.stringify(resolved)).not.toContain(receipt);
  await expect(port(repo, receipt, {documentPath: "services/orders/other.yaml"}))
    .rejects.toMatchObject({code: "INVALID_PROTECTED_DOCUMENT_CONFIG"});
  let authorizationCount = 0;
  const revoked = await port(repo, receipt, {authorize: async () => ++authorizationCount < 5});
  await expect(revoked.verify()).rejects.toMatchObject({code: "PROTECTED_DOCUMENT_UNAUTHORIZED"});
  expect(authorizationCount).toBeGreaterThanOrEqual(5);
  const trap = vi.fn(() => {throw Error("private-canary");});
  expect(() => createProtectedSwaggerDocumentCorrespondencePort(new Proxy({} as never,
    {getOwnPropertyDescriptor: trap}))).toThrowError("Invalid protected document configuration");
  expect(trap).not.toHaveBeenCalled();
});

test("trusted constructor values are detached and later pin changes withhold correspondence", async () => {
  const repo = await repository();
  const receipt = signed(repo.scope);
  const mutableScope = {...repo.scope};
  const mutableLimits = {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10_000};
  const verifier = await port(repo, receipt, {scope: mutableScope, limits: mutableLimits});
  mutableScope.sourceDigest = hash("changed");
  mutableLimits.maxFiles = 1;
  expect((await verifier.verify()).matches).toHaveLength(1);

  const protectedPorts = {authorize: async () => true, readReceipt: async () => receipt, readKey: async () => keyText};
  const resolver = createRuntimeCapturePinResolver({binding: {scope: repo.scope,
    artifactRef: "capture:receipt-1", configuredKeyRef: "key:approved-1", expectedReceiptDigest: hash(receipt),
    expectedSignerSpkiDigest: signerDigest, policyVersion: "runtime-capture-pin-1"}, ...protectedPorts});
  const original = await resolver.resolve(repo.scope);
  let calls = 0;
  const changed = await port(repo, receipt, {pinResolver: {resolve: async () => ++calls < 4
    ? original : {...original, sessionId: "changed-session"}}});
  await expect(changed.verify()).rejects.toMatchObject({code: "PROTECTED_DOCUMENT_UNVERIFIED"});
  expect(calls).toBeGreaterThanOrEqual(4);
});


test("outer deadline is handled while inner authorization is pending and releases its session", async () => {
  const repo = await repository();
  const verifier = await port(repo, signed(repo.scope), {
    limits: {maxFiles: 30, maxBytes: 100_000, timeoutMs: 10, maxSessions: 1},
    authorize: async (_scope: unknown, signal: AbortSignal) => new Promise<boolean>(resolve => {
      if (signal.aborted) resolve(false);
      else signal.addEventListener("abort", () => resolve(false), {once: true});
    }),
  });
  await expect(verifier.verify()).rejects.toMatchObject({code: "PROTECTED_DOCUMENT_SOURCE_UNAVAILABLE"});
  await expect(verifier.verify()).rejects.toMatchObject({code: "PROTECTED_DOCUMENT_SOURCE_UNAVAILABLE"});
});
