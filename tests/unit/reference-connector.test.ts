import { expect, test } from "vitest";
import { parseEvent } from "../../packages/ir/src/index.js";
import { normalizeLocalFact, ReferenceAdapterError } from "../../connectors/reference/src/adapter.js";

const configuration = () => ({ config_version: "1.0.0", access_scopes: [{ access_scope_id: "public", label: "Public" }],
  repositories: [{ repository_id: "repo", provider: "github", locator: "synthetic/repo", access_scope_id: "public",
    services: [{ service_id: "orders", root: "services/orders", analyzer: { adapter_id: "typescript", adapter_version: "1" },
      intended_branches: ["main", "release/*"], environments: [{ name: "uat", intended_branch: "main",
        deployment_authority: { adapter_id: "deploy", access_scope_id: "public" } }] }] }] });
const context = (deployment = false) => ({ tenantId: "tenant", principalId: "fixture", producerId: deployment ? "deploy" : "source",
  allowedEventTypes: deployment ? ["deployment.changed"] : ["branch.updated", "pull_request.updated", "reconciliation.requested", "repository.baseline_requested"],
  allowedRepositories: ["repo"], allowedServices: ["orders"], capabilities: ["event.ingest"],
  deploymentAuthorityGrants: deployment ? [{ repositoryId: "repo", serviceId: "orders", environment: "uat",
    adapterId: "deploy", sourceAuthorityIds: ["inventory"] }] : [] });
const base = () => ({ adapter_version: "1.0.0", event_id: "event-1", occurred_at: "2026-01-01T00:00:00Z",
  received_at: "2026-01-01T00:00:01Z", provider_reference: "delivery-1", sequence: "1",
  repository_id: "repo", service_id: "orders" });
const branch = () => ({ ...base(), kind: "branch" as const, branch: "main", prior_revision: null,
  new_revision: "a".repeat(40), reference_state: "created" });
const normalize = (fact: unknown, deployment = false, previousEvent?: unknown) =>
  normalizeLocalFact(fact, { configuration: configuration(), context: context(deployment),
    ...(previousEvent === undefined ? {} : { previousEvent }),
    knownArtifacts: deployment ? [{ artifact_id: "artifact-1", revision: "a".repeat(40) }] : [] });

test("normalizes configured branch and PR facts to validated events without deployment claims", () => {
  const event = normalize(branch());
  expect(parseEvent(event).ok).toBe(true);
  expect(event.event_type).toBe("branch.updated");
  expect(event.payload).toEqual({ branch: "main", prior_revision: null,
    new_revision: "a".repeat(40), reference_state: "created" });
  const pr = normalize({ ...base(), kind: "pull_request", pull_request_id: "42", state: "open",
    base_branch: "main", base_revision: "a".repeat(40), head_branch: "feature/one",
    head_revision: "b".repeat(40) });
  expect(pr.event_type).toBe("pull_request.updated");
  expect(parseEvent(pr).ok).toBe(true);
});

test("exact branch selection rejects wildcard matches and foreign PR bases", () => {
  expect(() => normalize({ ...branch(), branch: "release/1" })).toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...base(), kind: "pull_request", pull_request_id: "42", state: "open",
    base_branch: "other", base_revision: "a", head_branch: "feature", head_revision: "b" })).toThrowError(ReferenceAdapterError);
});

test("deployment attempt cannot become serving evidence and unknown artifacts fail", () => {
  const attempt = { ...base(), kind: "deployment_attempt", environment: "uat", deployment_id: "d1",
    attempt_state: "succeeded", effective_order: "1", artifact_id: "artifact-1", revision: "a".repeat(40) };
  const event = normalize(attempt, true);
  expect(event.event_type).toBe("deployment.changed");
  expect(event.payload).toMatchObject({ change_kind: "attempt", attempt_state: "succeeded" });
  expect(event.payload).not.toHaveProperty("serving_state");
  expect(() => normalize({ ...attempt, artifact_id: "missing" }, true)).toThrowError(ReferenceAdapterError);
});

test("authoritative serving observation and bounded reconciliation normalize exactly", () => {
  const observed = normalize({ ...base(), kind: "serving_observation", environment: "uat", observation_id: "o1",
    effective_order: "1", authority_id: "inventory", reference: "snapshot-1", access_label: "public",
    completeness: "complete", inventory: [{ artifact_id: "artifact-1", revision: "a".repeat(40) }] }, true);
  expect(observed.payload).toMatchObject({ change_kind: "serving_observation", serving_state: { status: "known" } });
  expect(parseEvent(observed).ok).toBe(true);
  const reconcile = normalize({ ...base(), kind: "reconciliation", environments: ["uat"],
    provider_snapshot_reference: "snapshot-1" });
  expect(reconcile.event_type).toBe("reconciliation.requested");
  expect(reconcile.payload).toEqual({ scope: { service_ids: ["orders"], environments: ["uat"] },
    provider_snapshot_reference: "snapshot-1" });
});

test("malformed, unauthorized, duplicate, and stale facts fail closed", () => {
  expect(() => normalize({ ...branch(), adapter_version: "2.0.0" })).toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...branch(), extra: true })).toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...branch(), new_revision: "x".repeat(513) })).toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...branch(), service_id: "other" })).toThrowError(ReferenceAdapterError);
  const prior = normalize(branch());
  expect(() => normalize(branch(), false, prior)).toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...branch(), event_id: "event-2", sequence: "0" }, false, prior)).toThrowError(ReferenceAdapterError);
});

test("local CLI accepts one plain JSON command and emits only the validated envelope", async () => {
  const { Readable, Writable } = await import("node:stream");
  const { runLocalAdapterCli } = await import("../../connectors/reference/src/cli.js");
  const capture = () => {
    let value = "";
    return { stream: new Writable({ write(chunk, _encoding, callback) { value += String(chunk); callback(); } }),
      value: () => value };
  };
  const success = capture();
  const errors = capture();
  const policy = { configuration: configuration(), context: context(), knownArtifacts: [] };
  expect(await runLocalAdapterCli(Readable.from([JSON.stringify(branch())]), success.stream, errors.stream, policy)).toBe(0);
  expect(parseEvent(JSON.parse(success.value())).ok).toBe(true);
  expect(errors.value()).toBe("");
  expect(JSON.parse(success.value())).not.toHaveProperty("receipt");
  const invalid = capture();
  expect(await runLocalAdapterCli(Readable.from([JSON.stringify({ ...branch(), context: context() })]),
    success.stream, invalid.stream, policy)).toBe(1);
  expect(invalid.value()).toBe("INVALID_INPUT\n");
});

test("serving state needs an authorized source and cannot infer absence from partial inventory", () => {
  const observation = { ...base(), kind: "serving_observation", environment: "uat", observation_id: "o1",
    effective_order: "1", authority_id: "inventory", reference: "snapshot-1", access_label: "public",
    completeness: "complete", inventory: [] };
  expect((normalize(observation, true).payload as any).serving_state).toEqual({ status: "known", inventory: [] });
  expect(() => normalize({ ...observation, completeness: "incomplete" }, true)).toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...observation, authority_id: "untrusted" }, true)).toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...observation, inventory: [{ artifact_id: "missing", revision: "a".repeat(40) }] }, true))
    .toThrowError(ReferenceAdapterError);
});

test("stale provider sequence and inconsistent replay fail even with a new event ID", () => {
  const prior = normalize(branch());
  expect(() => normalize({ ...branch(), event_id: "event-2", sequence: "1", new_revision: "b".repeat(40) }, false, prior))
    .toThrowError(ReferenceAdapterError);
  expect(() => normalize({ ...branch(), event_id: "event-2", sequence: "2" }, false, prior)).not.toThrow();
});

test("local CLI bounds stdin and never accepts policy from the fact stream", async () => {
  const { Readable, Writable } = await import("node:stream");
  const { runLocalAdapterCli } = await import("../../connectors/reference/src/cli.js");
  let out = "";
  let error = "";
  const output = new Writable({ write(chunk, _encoding, callback) { out += String(chunk); callback(); } });
  const errors = new Writable({ write(chunk, _encoding, callback) { error += String(chunk); callback(); } });
  const policy = { configuration: configuration(), context: context(), knownArtifacts: [] };
  expect(await runLocalAdapterCli(Readable.from(["x".repeat(65 * 1024)]), output, errors, policy)).toBe(1);
  expect(out).toBe("");
  expect(error).toBe("INVALID_INPUT\n");
});


test("rollback target revision must be present in the host artifact manifest", () => {
  const attempt = { ...base(), kind: "deployment_attempt", environment: "uat", deployment_id: "rollback-1",
    attempt_state: "rollback_requested", effective_order: "2", artifact_id: "artifact-1",
    revision: "a".repeat(40), target_revision: "a".repeat(40) };
  expect(normalize(attempt, true).payload).toMatchObject({ change_kind: "attempt", target_revision: "a".repeat(40) });
  expect(() => normalize({ ...attempt, target_revision: "b".repeat(40) }, true)).toThrowError(ReferenceAdapterError);
});

test("Node 24 direct CLI entry formats one fact using a separate local policy file", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "api-truth-reference-"));
  try {
    const policyPath = join(directory, "policy.json");
    await writeFile(policyPath, JSON.stringify({ configuration: configuration(), context: context(), knownArtifacts: [] }));
    const entry = new URL("../../connectors/reference/cli.mjs", import.meta.url);
    const result = spawnSync(process.execPath, [entry.pathname, policyPath],
      { input: JSON.stringify(branch()), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseEvent(JSON.parse(result.stdout)).ok).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("baseline fact remains branchless and cannot imply deployment", () => {
  const event = normalize({ ...base(), kind: "baseline", immutable_revision: "a".repeat(40) });
  expect(event.event_type).toBe("repository.baseline_requested");
  expect(event.payload).toEqual({ immutable_revision: "a".repeat(40), service_ids: ["orders"] });
  expect(event.subjects).not.toHaveProperty("environment");
});

test("hostile getters, toJSON, proxies, and symbols are rejected before execution", () => {
  let calls = 0;
  const getter = { ...branch(), get new_revision() { calls++; return "a".repeat(40); } };
  expect(() => normalize(getter)).toThrowError(ReferenceAdapterError);
  expect(calls).toBe(0);
  const withToJson = { ...branch(), toJSON() { calls++; return branch(); } };
  expect(() => normalize(withToJson)).toThrowError(ReferenceAdapterError);
  expect(calls).toBe(0);
  const proxy = new Proxy(branch(), { get(target, key) { calls++; return Reflect.get(target, key); } });
  expect(() => normalize(proxy)).toThrowError(ReferenceAdapterError);
  expect(calls).toBe(0);
  const withSymbol = Object.assign(branch(), { [Symbol("hidden")]: "x" });
  expect(() => normalize(withSymbol)).toThrowError(ReferenceAdapterError);
});

test("direct CLI rejects a nonregular policy path", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "api-truth-policy-dir-"));
  try {
    const entry = new URL("../../connectors/reference/cli.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [entry, directory],
      { input: JSON.stringify(branch()), encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("INVALID_INPUT\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("prior event must identify the same branch, PR, deployment, or reconciliation stream", () => {
  const priorBranch = normalize(branch());
  const wrongBranch = structuredClone(priorBranch);
  (wrongBranch.payload as any).branch = "other";
  expect(() => normalize({ ...branch(), event_id: "event-2", sequence: "2" }, false, wrongBranch))
    .toThrowError(ReferenceAdapterError);

  const prFact = { ...base(), kind: "pull_request", pull_request_id: "42", state: "open",
    base_branch: "main", base_revision: "a", head_branch: "feature", head_revision: "b" };
  const priorPr = normalize(prFact);
  const wrongPr = structuredClone(priorPr);
  (wrongPr.payload as any).pull_request_id = "other";
  expect(() => normalize({ ...prFact, event_id: "event-2", sequence: "2" }, false, wrongPr))
    .toThrowError(ReferenceAdapterError);

  const attempt = { ...base(), kind: "deployment_attempt", environment: "uat", deployment_id: "d1",
    attempt_state: "pending", effective_order: "1", artifact_id: "artifact-1", revision: "a".repeat(40) };
  const priorAttempt = normalize(attempt, true);
  const wrongDeployment = structuredClone(priorAttempt);
  (wrongDeployment.payload as any).deployment_id = "d-other";
  expect(() => normalize({ ...attempt, event_id: "event-2", sequence: "2", effective_order: "2" }, true, wrongDeployment))
    .toThrowError(ReferenceAdapterError);

  const reconcile = { ...base(), kind: "reconciliation", environments: ["uat"], provider_snapshot_reference: "snap-1" };
  const priorReconcile = normalize(reconcile);
  const wrongScope = structuredClone(priorReconcile);
  (wrongScope.payload as any).scope.environments = [];
  expect(() => normalize({ ...reconcile, event_id: "event-2", sequence: "2" }, false, wrongScope))
    .toThrowError(ReferenceAdapterError);
});
