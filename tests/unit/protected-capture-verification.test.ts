import {execFile as execFileCallback} from "node:child_process";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {afterEach, expect, test, vi} from "vitest";
import {materializeGitSource} from "../../connectors/git-source/src/index.js";
import {createRuntimeCapturePinResolver} from "../../connectors/git-source/src/runtime-capture-pin.js";
import {createProtectedCaptureVerificationPort} from "../../connectors/git-source/src/protected-capture-verification.js";
import {digestServiceTree, readServiceTree} from "../../analyzers/nodejs/src/source.js";

const scratch = vi.hoisted(() => ({root: undefined as string | undefined}));
const cleanupGate = vi.hoisted(() => ({wait: undefined as (() => Promise<void>) | undefined,
  entered: undefined as (() => void) | undefined}));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {...actual, tmpdir: () => scratch.root ?? actual.tmpdir()};
});
vi.mock("../../connectors/git-source/src/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../connectors/git-source/src/index.js")>();
  return {...actual, materializeGitSource: async (...args: Parameters<typeof actual.materializeGitSource>) => {
    const tree = await actual.materializeGitSource(...args);
    return {...tree, dispose: async () => {
      if (cleanupGate.wait) {
        cleanupGate.entered?.();
        await cleanupGate.wait();
      }
      await tree.dispose();
    }};
  }};
});
const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { scratch.root = undefined; cleanupGate.wait = undefined; cleanupGate.entered = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const handler = "exports.readOrder = function () { return 200; };\n";
const sourceRoot = "services/orders";
const keys = generateKeyPairSync("ed25519");
const keyText = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const keyDigest = hash(keys.publicKey.export({type: "spki", format: "der"}));
async function repository(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "api-truth-protected-capture-test-")); roots.push(root);
  await execFile("git", ["init", "-q", "-b", "main"], {cwd: root});
  const files = {"services/orders/api/controllers/orders.js": handler,
    "services/orders/index.js": `require('node:fs').writeFileSync(${JSON.stringify(join(root, "source-executed"))}, 'bad');\n`, ...extra};
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), {recursive: true});
    await writeFile(join(root, path), value);
  }
  await execFile("git", ["add", "-A"], {cwd: root});
  await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], {cwd: root});
  const revision = (await execFile("git", ["rev-parse", "HEAD"], {cwd: root})).stdout.trim();
  const tree = await materializeGitSource({repoPath: root, revision, serviceRoot: sourceRoot,
    limits: {maxFiles: 20, maxBytes: 100_000}});
  let sourceDigest: string;
  try {
    const source = await readServiceTree(tree.projectRoot, sourceRoot, 20, () => undefined);
    sourceDigest = digestServiceTree(source.files, source.root, source.opaqueConfiguration);
  } finally { await tree.dispose(); }
  const scope = {tenantId: "tenant", repositoryId: "repository", serviceId: "orders", immutableRevision: revision,
    sourceDigest, environment: "test"};
  return {root, revision, scope};
}
function signed(scope: Awaited<ReturnType<typeof repository>>["scope"], session = "session-1", handlerDigest = hash(handler)) {
  const bytes = Buffer.from(JSON.stringify({version: "1.0.0", repository_id: scope.repositoryId,
    service_id: scope.serviceId, immutable_revision: scope.immutableRevision, source_digest: scope.sourceDigest,
    environment: scope.environment, session_id: session, captured_at: "2026-10-08T16:00:00.000Z",
    node_version: "22.19.0", router_digest: "sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416",
    runtime_fingerprint: `sha256:${"c".repeat(64)}`, bindings: [{method: "GET", application_path: "/orders/{id}",
      controller: "orders", operation_id: "readOrder", export_name: "readOrder",
      handler_path: "api/controllers/orders.js", handler_digest: handlerDigest, mock_mode: false}]}));
  return JSON.stringify({payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64")});
}
function configured(repo: Awaited<ReturnType<typeof repository>>, text: string,
  changes: Record<string, unknown> = {}) {
  const selected = (changes.scope ?? repo.scope) as typeof repo.scope;
  const binding = {scope: selected, artifactRef: "capture:receipt-1", configuredKeyRef: "key:approved-1",
    expectedReceiptDigest: hash(text), expectedSignerSpkiDigest: keyDigest, policyVersion: "runtime-capture-pin-1" as const};
  const pinResolver = createRuntimeCapturePinResolver({binding, authorize: async () => true,
    readReceipt: async () => text, readKey: async () => keyText});
  const expectedCaptureIdentityDigest = hash(JSON.stringify("placeholder"));
  return {repoPath: repo.root, serviceRoot: sourceRoot, scope: selected,
    expectedCaptureIdentityDigest, pinResolver, authorize: async () => true,
    readReceipt: async () => text, readKey: async () => keyText,
    limits: {maxFiles: 20, maxBytes: 100_000, timeoutMs: 10_000}, ...changes};
}
async function port(repo: Awaited<ReturnType<typeof repository>>, text: string, changes: Record<string, unknown> = {}) {
  const config = configured(repo, text, changes);
  const pin = await config.pinResolver.resolve(config.scope);
  return createProtectedCaptureVerificationPort({...config, expectedCaptureIdentityDigest: pin.identityDigest});
}

test("checks protected signed handler bytes from immutable Git without source execution or worktree residue", async () => {
  const repo = await repository();
  scratch.root = await mkdtemp(join(tmpdir(), "api-truth-protected-owned-")); roots.push(scratch.root);
  const text = signed(repo.scope);
  const verifier = await port(repo, text);
  const before = new Set(await readdir(scratch.root));
  const result = await verifier.verify();
  expect(result).toMatchObject({kind: "verified_handler_bytes", scope: repo.scope,
    handlers: [{method: "GET", handlerPath: "api/controllers/orders.js", handlerDigest: hash(handler)}]});
  expect(result.captureIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(result.limitations).toContain("Document operation correspondence and deployment are unverified");
  expect(await readdir(scratch.root)).toEqual([...before]);
  await expect(readFile(join(repo.root, "source-executed"))).rejects.toThrow();
});

test("stale handler bytes and source context are withheld", async () => {
  const repo = await repository();
  scratch.root = await mkdtemp(join(tmpdir(), "api-truth-protected-failure-owned-")); roots.push(scratch.root);
  await expect((await port(repo, signed(repo.scope, "session-1", hash("different")))).verify())
    .rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNVERIFIED"});
  const wrong = {...repo.scope, sourceDigest: `sha256:${"e".repeat(64)}`};
  const verifier = await port(repo, signed(wrong), {scope: wrong});
  await expect(verifier.verify()).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNVERIFIED"});
  expect(await readdir(scratch.root)).toEqual([]);
});

test("mutable protected receipt/key and final pin or authorization changes withhold output", async () => {
  const repo = await repository();
  const text = signed(repo.scope);
  await expect((await port(repo, text, {readReceipt: async () => signed(repo.scope, "other")})).verify())
    .rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNVERIFIED"});
  const attacker = generateKeyPairSync("ed25519").publicKey.export({type: "spki", format: "pem"}).toString();
  await expect((await port(repo, text, {readKey: async () => attacker})).verify())
    .rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNVERIFIED"});
  let active = true;
  await expect((await port(repo, text, {authorize: async () => {
    const current = active; active = false; return current;
  }})).verify()).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNAUTHORIZED"});
  const config = configured(repo, text);
  const firstPin = await config.pinResolver.resolve(repo.scope);
  let calls = 0;
  const changing = createProtectedCaptureVerificationPort({...config,
    expectedCaptureIdentityDigest: firstPin.identityDigest,
    pinResolver: {resolve: async () => ++calls === 1 ? firstPin : {...firstPin, sessionId: "changed-session"}}});
  await expect(changing.verify()).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNVERIFIED"});
});

test("protected callback deadline and hostile configuration fail closed", async () => {
  const repo = await repository();
  const text = signed(repo.scope);
  const config = configured(repo, text);
  const pin = await config.pinResolver.resolve(repo.scope);
  let observedSignal: AbortSignal | undefined;
  const stalled = createProtectedCaptureVerificationPort({...config, expectedCaptureIdentityDigest: pin.identityDigest,
    limits: {...config.limits, timeoutMs: 20},
    authorize: async (_scope, signal) => { observedSignal = signal; return new Promise<boolean>(() => undefined); }});
  await expect(stalled.verify()).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNAUTHORIZED"});
  expect(observedSignal?.aborted).toBe(true);
  const trap = vi.fn(() => { throw Error("private-canary"); });
  expect(() => createProtectedCaptureVerificationPort(new Proxy({...config,
    expectedCaptureIdentityDigest: pin.identityDigest}, {getOwnPropertyDescriptor: trap})))
    .toThrowError("Invalid protected capture configuration");
  expect(trap).not.toHaveBeenCalled();
});

test("committed receipt poison is never treated as protected capture", async () => {
  const repo = await repository({"services/orders/api-truth.runtime-binding.json": "source-controlled-receipt"});
  await expect((await port(repo, signed(repo.scope))).verify())
    .rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNVERIFIED"});
});

test("two distinct signed captures at one revision keep distinct identities", async () => {
  const repo = await repository();
  const first = await (await port(repo, signed(repo.scope, "session-1"))).verify();
  const second = await (await port(repo, signed(repo.scope, "session-2"))).verify();
  expect(first.captureIdentityDigest).not.toBe(second.captureIdentityDigest);
  expect(first.scope).toEqual(second.scope);
});

test("bounded concurrent sessions reject excess work and release reservation after failure", async () => {
  const repo = await repository();
  const text = signed(repo.scope);
  const config = configured(repo, text);
  const pin = await config.pinResolver.resolve(repo.scope);
  let release: ((allowed: boolean) => void) | undefined;
  let entered: (() => void) | undefined;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const verifier = createProtectedCaptureVerificationPort({...config, expectedCaptureIdentityDigest: pin.identityDigest,
    limits: {...config.limits, maxSessions: 1},
    authorize: async () => { entered?.(); return new Promise<boolean>(resolve => { release = resolve; }); }});
  const first = verifier.verify();
  await enteredPromise;
  await expect(verifier.verify()).rejects.toMatchObject({code: "PROTECTED_CAPTURE_BUSY"});
  release?.(false);
  await expect(first).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNAUTHORIZED"});
  const third = verifier.verify();
  await expect(verifier.verify()).rejects.toMatchObject({code: "PROTECTED_CAPTURE_BUSY"});
  release?.(false);
  await expect(third).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNAUTHORIZED"});
});

test("revocation while owned tree is being disposed withholds handler metadata", async () => {
  const repo = await repository();
  const text = signed(repo.scope);
  let allowed = true;
  const verifier = await port(repo, text, {authorize: async () => allowed});
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { cleanupGate.entered = resolve; });
  cleanupGate.wait = () => waiting;
  const pending = verifier.verify();
  await entered;
  allowed = false;
  release?.();
  await expect(pending).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNAUTHORIZED"});
});


test("a decoded-text digest cannot attest BOM-bearing handler bytes", async () => {
  const repo = await repository({"services/orders/api/controllers/orders.js": "\uFEFF" + handler});
  scratch.root = await mkdtemp(join(tmpdir(), "api-truth-protected-bom-owned-")); roots.push(scratch.root);
  // The source kernel strips the BOM for parsing; byte proof must still hash the committed file.
  const verifier = await port(repo, signed(repo.scope));
  await expect(verifier.verify()).rejects.toMatchObject({code: "PROTECTED_CAPTURE_UNVERIFIED"});
  expect(await readdir(scratch.root)).toEqual([]);
});
