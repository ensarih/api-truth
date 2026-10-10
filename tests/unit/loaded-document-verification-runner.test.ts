import {expect, test, vi} from "vitest";
import type {Pool} from "pg";
import {createLoadedDocumentVerificationRunner, type LoadedDocumentVerificationRunnerOptions}
  from "../../packages/orchestration/src/loaded-document-verification-runner.js";

function options(): LoadedDocumentVerificationRunnerOptions {
  return {schema: "test_schema", tenantId: "tenant", principalId: "principal", workerId: "worker",
    instanceId: "instance", allowedRepositories: ["repository"], allowedServices: ["service"],
    preflightAuthorize: async () => false, authorizeLoadedDocument: vi.fn(async () => true),
    verificationPortFactory: vi.fn(async () => ({verify: vi.fn(async () => undefined)}))};
}

test("execution preflight denial never opens storage or the protected verifier", async () => {
  const connect = vi.fn(() => {throw new Error("private storage details");});
  const configured = options();
  const runner = createLoadedDocumentVerificationRunner({connect} as unknown as Pool, configured);
  await expect(runner.runOne()).rejects.toMatchObject({code: "LOADED_DOCUMENT_RUNNER_UNAUTHORIZED"});
  expect(connect).not.toHaveBeenCalled();
  expect(configured.authorizeLoadedDocument).not.toHaveBeenCalled();
  expect(configured.verificationPortFactory).not.toHaveBeenCalled();
});

test("hostile host configuration is rejected without executing getters or proxy traps", () => {
  const connect = vi.fn();
  const getter = vi.fn(() => "tenant");
  const trap = vi.fn(() => {throw Error("private");});
  const configured = options();
  Object.defineProperty(configured, "tenantId", {get: getter});
  for (const raw of [configured, new Proxy(options(), {ownKeys: trap, get: trap, getPrototypeOf: trap})]) {
    expect(() => createLoadedDocumentVerificationRunner({connect} as unknown as Pool, raw))
      .toThrow("Invalid loaded-document runner configuration");
  }
  expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
