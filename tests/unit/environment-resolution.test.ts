import { expect, test } from "vitest";
import { resolveEnvironment } from "../../packages/environment/src/index.js";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);

const known = (artifactId: string, revision: string) => ({ artifact_id: artifactId,
  revision: { state: "known" as const, revision } });
const complete = (...inventory: ReturnType<typeof known>[]) => ({
  completeness: "complete" as const,
  serving_state: { status: "known" as const, inventory },
});

test("a branch tip and a failed deployment attempt do not establish environment availability", () => {
  const facts = {
    branchRevision: revisionB,
    latestAttempt: { deploymentId: "deploy-2", state: "failed" as const },
    artifactBindings: [{ artifactId: "artifact-a", revision: revisionA }],
    revisionSnapshots: [{ revision: revisionA, snapshotId: "snapshot-a" }],
  };
  expect(resolveEnvironment(facts)).toMatchObject({ deployment: "unknown", contract: "unavailable",
    latestAttempt: { deploymentId: "deploy-2", state: "failed" } });
});

test("UAT can resolve its deployed revision while production remains unknown or confirmed absent", () => {
  const facts = { artifactBindings: [{ artifactId: "artifact-a", revision: revisionA }],
    revisionSnapshots: [{ revision: revisionA, snapshotId: "snapshot-a" }] };
  expect(resolveEnvironment({ ...facts, observation: complete(known("artifact-a", revisionA)) }))
    .toMatchObject({ deployment: "deployed", contract: "resolved", snapshotId: "snapshot-a" });
  expect(resolveEnvironment(facts)).toMatchObject({ deployment: "unknown", contract: "unavailable" });
  expect(resolveEnvironment({ ...facts, observation: complete() }))
    .toMatchObject({ deployment: "confirmed_not_deployed", contract: "unavailable" });
});

test("failed partial rollout retains the observed mixed set and does not restore the old contract", () => {
  const result = resolveEnvironment({
    observation: complete(known("artifact-a", revisionA), known("artifact-b", revisionB)),
    latestAttempt: { deploymentId: "deploy-b", state: "failed" },
    artifactBindings: [
      { artifactId: "artifact-a", revision: revisionA },
      { artifactId: "artifact-b", revision: revisionB },
    ],
    revisionSnapshots: [
      { revision: revisionA, snapshotId: "snapshot-a" },
      { revision: revisionB, snapshotId: "snapshot-b" },
    ],
  });
  expect(result).toMatchObject({ deployment: "transitional", contract: "ambiguous",
    latestAttempt: { state: "failed" } });
  expect(result).not.toHaveProperty("snapshotId");
  expect(result.active).toEqual([
    { artifactId: "artifact-a", revision: revisionA, snapshotId: "snapshot-a" },
    { artifactId: "artifact-b", revision: revisionB, snapshotId: "snapshot-b" },
  ]);
});

test("rollback request does not change the selected contract until complete serving evidence arrives", () => {
  const facts = {
    latestAttempt: { deploymentId: "rollback-a", state: "rollback_requested" as const },
    artifactBindings: [
      { artifactId: "artifact-a", revision: revisionA },
      { artifactId: "artifact-b", revision: revisionB },
    ],
    revisionSnapshots: [
      { revision: revisionA, snapshotId: "snapshot-a" },
      { revision: revisionB, snapshotId: "snapshot-b" },
    ],
  };
  expect(resolveEnvironment({ ...facts, observation: complete(known("artifact-b", revisionB)) }))
    .toMatchObject({ deployment: "deployed", contract: "resolved", snapshotId: "snapshot-b" });
  expect(resolveEnvironment({ ...facts, observation: complete(known("artifact-a", revisionA)) }))
    .toMatchObject({ deployment: "deployed", contract: "resolved", snapshotId: "snapshot-a" });
});

test("unknown and incomplete observations never select an old or partial contract", () => {
  const facts = { artifactBindings: [{ artifactId: "artifact-a", revision: revisionA }],
    revisionSnapshots: [{ revision: revisionA, snapshotId: "snapshot-a" }] };
  expect(resolveEnvironment({ ...facts, observation: { completeness: "incomplete",
    serving_state: { status: "unknown", reason: "partial rollout" } } }))
    .toMatchObject({ deployment: "unknown", contract: "unavailable" });
  const partial = resolveEnvironment({ ...facts, observation: {
    completeness: "transitional", serving_state: { status: "known", inventory: [known("artifact-a", revisionA)] },
  } });
  expect(partial).toMatchObject({ deployment: "transitional", contract: "ambiguous" });
  expect(partial).not.toHaveProperty("snapshotId");
});

test("exact artifact binding and analyzed revision are both required for a resolved contract", () => {
  const observation = complete(known("artifact-b", revisionB));
  expect(resolveEnvironment({ observation, artifactBindings: [],
    revisionSnapshots: [{ revision: revisionB, snapshotId: "snapshot-b" }] }))
    .toMatchObject({ deployment: "deployed", contract: "pending_binding" });
  expect(resolveEnvironment({ observation, artifactBindings: [{ artifactId: "artifact-b", revision: revisionB }],
    revisionSnapshots: [] })).toMatchObject({ deployment: "deployed", contract: "pending_analysis" });
  expect(resolveEnvironment({ observation, artifactBindings: [{ artifactId: "artifact-b", revision: revisionA }],
    revisionSnapshots: [{ revision: revisionA, snapshotId: "snapshot-a" }] }))
    .toMatchObject({ deployment: "deployed", contract: "pending_binding" });
});

test("unknown revision and conflicting bindings fail closed", () => {
  const unknownRevision = resolveEnvironment({
    observation: { completeness: "complete", serving_state: { status: "known", inventory: [{
      artifact_id: "artifact-a", revision: { state: "unknown", reason: "build reference unavailable" },
    }] } },
    artifactBindings: [{ artifactId: "artifact-a", revision: revisionA }],
    revisionSnapshots: [{ revision: revisionA, snapshotId: "snapshot-a" }],
  });
  expect(unknownRevision).toMatchObject({ deployment: "deployed", contract: "pending_binding" });
  expect(unknownRevision).not.toHaveProperty("snapshotId");

  const conflicting = resolveEnvironment({
    observation: complete(known("artifact-a", revisionA)),
    artifactBindings: [
      { artifactId: "artifact-a", revision: revisionA },
      { artifactId: "artifact-a", revision: revisionB },
    ],
    revisionSnapshots: [{ revision: revisionA, snapshotId: "snapshot-a" }],
  });
  expect(conflicting).toMatchObject({ contract: "pending_binding" });
  expect(conflicting).not.toHaveProperty("snapshotId");
});

test("conflicting revision snapshots remain pending and projections detach from input", () => {
  const bindings = [{ artifactId: "artifact-a", revision: revisionA }];
  const result = resolveEnvironment({ observation: complete(known("artifact-a", revisionA)),
    artifactBindings: bindings,
    revisionSnapshots: [
      { revision: revisionA, snapshotId: "snapshot-a" },
      { revision: revisionA, snapshotId: "snapshot-other" },
    ] });
  bindings[0]!.artifactId = "mutated";
  expect(result).toMatchObject({ deployment: "deployed", contract: "pending_analysis",
    active: [{ artifactId: "artifact-a", revision: revisionA }] });
  expect(result).not.toHaveProperty("snapshotId");
  expect(Object.isFrozen(result.active)).toBe(true);
});
