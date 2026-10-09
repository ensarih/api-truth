import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { buildSyntheticReferenceFixture } from "../../connectors/reference/src/fixture.js";

const workflow = new URL("../../.github/workflows/reference-synthetic.yml", import.meta.url);

test("fixture driver selects only exact configured branches and orders baseline before changes", () => {
  const fixture = buildSyntheticReferenceFixture("main");
  expect(fixture.map((item) => item.fact.kind)).toEqual(["baseline", "pull_request", "pull_request", "branch",
    "deployment_attempt", "serving_observation", "reconciliation"]);
  expect(fixture.map((item) => item.fact.event_id)).toEqual([
    "synthetic-baseline", "synthetic-pr-open", "synthetic-pr-merged", "synthetic-branch",
    "synthetic-deploy-attempt", "synthetic-serving", "synthetic-reconcile",
  ]);
  expect(() => buildSyntheticReferenceFixture("release/1")).toThrow("UNCONFIGURED_BRANCH");
  expect(() => buildSyntheticReferenceFixture("feature/x")).toThrow("UNCONFIGURED_BRANCH");
});

test("workflow is read only, pins actions, and skips fork PRs", async () => {
  const body = await readFile(workflow, "utf8");
  expect(body).toContain("contents: read");
  expect(body).toContain("pull_request:");
  expect(body).not.toContain("pull_request_target:");
  expect(body).toContain("github.event.pull_request.head.repo.fork == false");
  expect(body).toContain("persist-credentials: false");
  expect(body).not.toMatch(/secrets\.|id-token: write|contents: write|deployments: write/);
  expect(body).toMatch(/actions\/checkout@[0-9a-f]{40}/);
  expect(body).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
  expect(body).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
  expect(body).toContain("npm ci");
  expect(body).toContain("node connectors/reference/fixture-driver.mjs");
});

test("Node driver emits only synthetic, ordered events and refuses other branches", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { parseEvent } = await import("../../packages/ir/src/index.js");
  const directory = await mkdtemp(join(tmpdir(), "api-truth-workflow-"));
  try {
    const entry = new URL("../../connectors/reference/fixture-driver.mjs", import.meta.url).pathname;
    const output = join(directory, "events.json");
    const success = spawnSync(process.execPath, [entry, "--branch", "main", "--output", output], { encoding: "utf8" });
    expect(success.status).toBe(0);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    expect(artifact.demonstration_only).toBe(true);
    expect(artifact.events).toHaveLength(7);
    expect(artifact.events.every((event: unknown) => parseEvent(event).ok)).toBe(true);
    expect(artifact.events.map((event: any) => event.event_type)).toEqual([
      "repository.baseline_requested", "pull_request.updated", "pull_request.updated", "branch.updated",
      "deployment.changed", "deployment.changed", "reconciliation.requested",
    ]);
    expect(artifact.events.map((event: any) => event.event_id)).toEqual([
      "synthetic-baseline", "synthetic-pr-open", "synthetic-pr-merged", "synthetic-branch",
      "synthetic-deploy-attempt", "synthetic-serving", "synthetic-reconcile",
    ]);
    expect(artifact.events.map((event: any) => event.provider_evidence.order.value)).toEqual(["1","2","3","4","5","6","7"]);
    expect(artifact.events.filter((event: any) => event.event_type === "deployment.changed")
      .every((event: any) => event.payload.environment === "uat")).toBe(true);
    expect(artifact.events[4].payload.change_kind).toBe("attempt");
    expect(artifact.events[5].payload.change_kind).toBe("serving_observation");
    const rejected = spawnSync(process.execPath, [entry, "--branch", "release/1", "--output", join(directory, "rejected.json")],
      { encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toBe("UNCONFIGURED_BRANCH\n");
    await expect(readFile(join(directory, "rejected.json"), "utf8")).rejects.toMatchObject({code:"ENOENT"});
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
