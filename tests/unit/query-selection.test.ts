import { expect, test } from "vitest";
import { parseQuerySelection, projectEnvironmentSelection, QuerySelectionError } from "../../packages/query/src/index.js";

const input = (selector: object = { kind: "environment", environment: "uat" }) => ({
  version: "1", tenantId: "tenant-a", repositoryId: "commerce", serviceId: "orders", selector,
});
const view = (overrides: Record<string, unknown> = {}) => ({
  repositoryId: "commerce", serviceId: "orders", environment: "uat",
  configFingerprint: "config-a", checkpointVersion: "42", reconciliationRequired: false,
  deployment: "deployed", contract: "resolved", snapshotId: "snapshot-a",
  active: [{ artifactId: "artifact-a", revision: "revision-a", snapshotId: "snapshot-a" }],
  ...overrides,
});
const code = (operation: () => unknown, expected: string) => {
  expect(operation).toThrowError(QuerySelectionError);
  try { operation(); } catch (error) { expect((error as QuerySelectionError).code).toBe(expected); }
};

test("requires explicit version, tenant, repository, service and selector kind", () => {
  expect(parseQuerySelection(input())).toEqual(input());
  expect(parseQuerySelection(input({ kind: "branch", branch: "main" })).selector)
    .toEqual({ kind: "branch", branch: "main" });
  expect(parseQuerySelection(input({ kind: "revision", revision: "abc123" })).selector)
    .toEqual({ kind: "revision", revision: "abc123" });
  for (const bad of [
    { ...input(), version: undefined }, { ...input(), tenantId: "" },
    { ...input(), selector: {} }, { ...input(), selector: { kind: "production" } },
    { ...input(), selector: { kind: "environment" } },
    { ...input(), selector: { kind: "branch", branch: "" } },
    { ...input(), selector: { kind: "revision", revision: "" } },
    { ...input(), extra: true }, { ...input(), selector: { kind: "environment", environment: "uat", extra: true } },
    { ...input(), repositoryId: "a".repeat(513) },
    { ...input(), serviceId: "orders\nother" },
  ]) code(() => parseQuerySelection(bad), "INVALID_QUERY_SELECTION");
});

test("rejects accessors, sparse arrays, prototypes and dangerous values without invoking them", () => {
  let invoked = false;
  const getter = Object.defineProperty({}, "tenantId", { enumerable: true, get() { invoked = true; return "tenant-a"; } });
  code(() => parseQuerySelection(getter), "INVALID_QUERY_SELECTION");
  expect(invoked).toBe(false);
  code(() => parseQuerySelection(Object.assign(Object.create({ version: "1" }), input())), "INVALID_QUERY_SELECTION");
  code(() => parseQuerySelection({ ...input(), selector: [] }), "INVALID_QUERY_SELECTION");
  code(() => parseQuerySelection({ ...input(), selector: Object.defineProperty({}, "kind", { get() { invoked = true; return "environment"; } }) }), "INVALID_QUERY_SELECTION");
  expect(invoked).toBe(false);
});

test("a single fully resolved deployed environment yields a detached immutable pin", () => {
  const source = view();
  const selected = projectEnvironmentSelection(input(), source);
  expect(selected).toEqual({ status: "resolved", selector: input(),
    pin: { snapshotId: "snapshot-a", revision: "revision-a", configFingerprint: "config-a", checkpointVersion: "42" } });
  source.active[0]!.snapshotId = "changed";
  expect(selected.status === "resolved" && selected.pin.snapshotId).toBe("snapshot-a");
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected.selector)).toBe(true);
  expect(selected.status === "resolved" && Object.isFrozen(selected.pin)).toBe(true);
});

test("all other environment states expose no usable snapshot", () => {
  const cases = [
    [view({ deployment: "unknown", contract: "unavailable", active: [] }), "unknown"],
    [view({ deployment: "confirmed_not_deployed", contract: "unavailable", active: [] }), "unavailable"],
    [view({ deployment: "transitional", contract: "ambiguous", active: [
      { artifactId: "artifact-a", revision: "revision-a", snapshotId: "snapshot-a" },
      { artifactId: "artifact-b", revision: "revision-b", snapshotId: "snapshot-b" },
    ] }), "transitional"],
    [view({ contract: "pending_analysis", snapshotId: undefined }), "unavailable"],
    [view({ reconciliationRequired: true }), "unknown"],
    [view({ checkpointVersion: undefined }), "unknown"],
    [view({ active: [] }), "unavailable"],
    [view({ active: [{ artifactId: "artifact-a", revision: "revision-a", snapshotId: "another" }] }), "unavailable"],
    [view({ active: [{ artifactId: "artifact-a", snapshotId: "snapshot-a" }] }), "unavailable"],
  ] as const;
  for (const [environment, status] of cases) {
    const selected = projectEnvironmentSelection(input(), environment);
    expect(selected.status).toBe(status);
    expect(selected).not.toHaveProperty("pin");
    expect(selected).not.toHaveProperty("snapshotId");
  }
});

test("requires the environment view to match the explicit selector scope", () => {
  code(() => projectEnvironmentSelection(input({ kind: "branch", branch: "main" }), view()), "QUERY_SELECTOR_KIND_MISMATCH");
  code(() => projectEnvironmentSelection(input(), view({ repositoryId: "other" })), "QUERY_SELECTION_MISMATCH");
  code(() => projectEnvironmentSelection(input(), view({ environment: "production" })), "QUERY_SELECTION_MISMATCH");
});

test("malformed environment views cannot produce a pin", () => {
  let invoked = false;
  const accessor = Object.defineProperty(view(), "snapshotId", { enumerable: true,
    get() { invoked = true; return "snapshot-a"; } });
  code(() => projectEnvironmentSelection(input(), accessor), "INVALID_ENVIRONMENT_VIEW");
  expect(invoked).toBe(false);
  for (const active of [[{ artifactId: "artifact-a", revision: "revision-a", snapshotId: "snapshot-a" },
    { artifactId: "artifact-b", revision: "revision-b", snapshotId: "snapshot-b" }],
    [{ artifactId: "artifact-a", revision: "revision-a", snapshotId: "snapshot-a", extra: "x" }]]) {
    const selected = projectEnvironmentSelection(input(), view({ active }));
    expect(selected.status).toBe("unavailable");
    expect(selected).not.toHaveProperty("pin");
  }
});

test("optional expected pointer and checkpoint versions must be canonical decimals", () => {
  expect(parseQuerySelection(input({ kind: "branch", branch: "main", expectedPointerVersion: "2" })).selector)
    .toEqual({ kind: "branch", branch: "main", expectedPointerVersion: "2" });
  expect(parseQuerySelection(input({ kind: "environment", environment: "uat", expectedCheckpointVersion: "42" })).selector)
    .toEqual({ kind: "environment", environment: "uat", expectedCheckpointVersion: "42" });
  for (const version of ["", "0", "01", "-1", "1.0", "9".repeat(20)]) {
    code(() => parseQuerySelection(input({ kind: "branch", branch: "main", expectedPointerVersion: version })),
      "INVALID_QUERY_SELECTION");
    code(() => parseQuerySelection(input({ kind: "environment", environment: "uat", expectedCheckpointVersion: version })),
      "INVALID_QUERY_SELECTION");
  }
});

test("preflight projection with stale expected checkpoint has no pin", () => {
  const selected = projectEnvironmentSelection(input({ kind: "environment", environment: "uat",
    expectedCheckpointVersion: "41" }), view());
  expect(selected.status).toBe("unknown");
  expect(selected).not.toHaveProperty("pin");
});
