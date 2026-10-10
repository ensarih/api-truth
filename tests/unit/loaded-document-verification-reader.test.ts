import {expect, test, vi} from "vitest";
import type {Pool} from "pg";
import {createLoadedDocumentVerificationReadStore, type LoadedDocumentVerificationReadOptions}
  from "../../packages/query/src/loaded-document-verification-reader.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const scope = {tenantId: "tenant", repositoryId: "repository", serviceId: "service", environment: "test",
  immutableRevision: "a".repeat(40), sourceDigest: digest("b")};
const principal = {tenantId: scope.tenantId, principalId: "reader"};
const request = () => ({loadIdentityDigest: digest("d"), configActivationCheckpoint: "1", expectedPin: {
  tenantId: scope.tenantId, repositoryId: scope.repositoryId, serviceId: scope.serviceId, environment: scope.environment,
  snapshotId: "snapshot", revision: scope.immutableRevision, configFingerprint: digest("e"), checkpointVersion: "1"}});
function options(): LoadedDocumentVerificationReadOptions {
  return {schema: "test_schema", tenantId: scope.tenantId,
    bindings: [{scope, serviceRoot: "services/api", captureIdentityDigest: digest("c"), loadIdentityDigest: digest("d")}],
    authorizeManager: vi.fn(async () => ({...principal, capabilities: ["swagger.document.verify.read"]})),
    authorizeRead: vi.fn(async () => true)};
}

test("hostile read bindings are rejected without evaluating configuration getters or proxy traps", () => {
  const connect = vi.fn(), getter = vi.fn(), trap = vi.fn();
  const configured = options(); Object.defineProperty(configured, "bindings", {get: getter});
  for (const raw of [configured, new Proxy(options(), {ownKeys: trap, get: trap, getPrototypeOf: trap})])
    expect(() => createLoadedDocumentVerificationReadStore({connect} as unknown as Pool, raw))
      .toThrow("Invalid loaded-document read configuration");
  expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
});

test("hostile pins and principal anchors cannot trigger authentication or database work", async () => {
  const connect = vi.fn(), getter = vi.fn(), configured = options();
  const store = createLoadedDocumentVerificationReadStore({connect} as unknown as Pool, configured);
  const raw = request(); Object.defineProperty(raw.expectedPin, "snapshotId", {get: getter});
  await expect(store.readForPrincipal({}, principal, raw)).rejects.toMatchObject({code: "INVALID_LOADED_DOCUMENT_READ_REQUEST"});
  const anchor = {...principal}; Object.defineProperty(anchor, "principalId", {get: getter});
  await expect(store.readForPrincipal({}, anchor, request())).rejects.toMatchObject({code: "LOADED_DOCUMENT_READ_UNAUTHORIZED"});
  expect(getter).not.toHaveBeenCalled(); expect(configured.authorizeManager).not.toHaveBeenCalled();
  expect(configured.authorizeRead).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
});

test("hostile authentication output never executes identity getters or reaches protected metadata", async () => {
  const connect = vi.fn(), getter = vi.fn();
  const identity = {...principal, capabilities: ["swagger.document.verify.read"]};
  Object.defineProperty(identity, "principalId", {get: getter});
  const configured = {...options(), authorizeManager: vi.fn(async () => identity)};
  const store = createLoadedDocumentVerificationReadStore({connect} as unknown as Pool, configured);
  await expect(store.readForPrincipal({}, principal, request())).rejects.toMatchObject({code: "LOADED_DOCUMENT_READ_UNAUTHORIZED"});
  expect(getter).not.toHaveBeenCalled(); expect(configured.authorizeRead).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
});

test("separate controlled captures may share a checkout while duplicate load bindings are rejected", async () => {
  const connect = vi.fn(), base = options();
  const second = {...base.bindings[0]!, captureIdentityDigest: digest("f"), loadIdentityDigest: digest("a")};
  const authenticate = vi.fn(async () => undefined);
  const store = createLoadedDocumentVerificationReadStore({connect} as unknown as Pool,
    {...base, bindings: [base.bindings[0]!, second], authorizeManager: authenticate});
  await expect(store.readForPrincipal({}, principal, {...request(), loadIdentityDigest: second.loadIdentityDigest}))
    .rejects.toMatchObject({code: "LOADED_DOCUMENT_READ_UNAUTHORIZED"});
  expect(authenticate.mock.calls).toHaveLength(1); expect(connect).not.toHaveBeenCalled();
  expect(() => createLoadedDocumentVerificationReadStore({connect} as unknown as Pool,
    {...base, bindings: [base.bindings[0]!, {...second, loadIdentityDigest: base.bindings[0]!.loadIdentityDigest}]}))
    .toThrow("Invalid loaded-document read configuration");
});
