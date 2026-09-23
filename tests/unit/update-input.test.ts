import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { ContractSnapshot } from "../../packages/ir/src/index.js";
import {
  UpdateError,
  parseUpdatePlanningInput,
  validateUpdatePlanningInput,
} from "../../packages/updates/src/index.js";

let baseSnapshot: ContractSnapshot;

beforeAll(async () => {
  baseSnapshot = JSON.parse(await readFile(
    fileURLToPath(new URL("../fixtures/ir/express-snapshot.json", import.meta.url)),
    "utf8",
  )) as ContractSnapshot;
});

const analysisKey = () => ({
  analyzer: structuredClone(baseSnapshot.analyzer),
  analyzer_exchange_version: "1.0.0" as const,
  ir_version: baseSnapshot.ir_version,
  identity_version: baseSnapshot.identity_version,
  config_version: baseSnapshot.config.config_version,
  config_fingerprint: baseSnapshot.config.config_fingerprint,
});

const input = () => ({
  base_snapshot: structuredClone(baseSnapshot),
  base_analysis_key: analysisKey(),
  target: {
    repository_id: baseSnapshot.service.repository_id,
    service_id: baseSnapshot.service.service_id,
    service_root: baseSnapshot.service.root,
    immutable_revision: "b".repeat(40),
    source_digest: `sha256:${"1".repeat(64)}`,
    analysis_key: analysisKey(),
  },
  changed_paths: ["services/orders/src/routes.ts"],
  changed_paths_complete: true,
});

describe("D07 planning input boundary", () => {
  test("accepts one preselected service and immutable target", () => {
    expect(parseUpdatePlanningInput(input())).toMatchObject({ ok: true });
    expect(validateUpdatePlanningInput(input())).toMatchObject({
      target: { service_id: "orders", immutable_revision: "b".repeat(40) },
    });
  });

  test.each([
    ["mutable revision", () => { const value = input(); value.target.immutable_revision = "main"; return value; }],
    ["uppercase digest", () => { const value = input(); value.target.source_digest = `sha256:${"A".repeat(64)}`; return value; }],
    ["short digest", () => { const value = input(); value.target.source_digest = "sha256:1234"; return value; }],
    ["absolute root", () => { const value = input(); value.target.service_root = "/srv/orders"; return value; }],
    ["root traversal", () => { const value = input(); value.target.service_root = "../orders"; return value; }],
  ])("rejects %s before planning", (_label, candidate) => {
    expect(parseUpdatePlanningInput(candidate()).ok).toBe(false);
    expect(() => validateUpdatePlanningInput(candidate())).toThrowError(
      expect.objectContaining({ code: "INVALID_UPDATE_INPUT" }),
    );
  });

  test("distinguishes scope and recorded analysis mismatches", () => {
    const scope = input();
    scope.target.service_id = "billing";
    expect(() => validateUpdatePlanningInput(scope)).toThrowError(
      expect.objectContaining({ code: "UPDATE_SCOPE_MISMATCH" }),
    );

    const analysis = input();
    analysis.base_analysis_key.analyzer.analyzer_version = "different";
    expect(() => validateUpdatePlanningInput(analysis)).toThrowError(
      expect.objectContaining({ code: "UPDATE_ANALYSIS_MISMATCH" }),
    );
  });

  test("contains hostile input as a safe validation error", () => {
    const planted = "secret://source-and-credential";
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error(planted); },
    });
    let caught: unknown;
    try {
      validateUpdatePlanningInput(hostile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpdateError);
    expect(caught).toMatchObject({ code: "INVALID_UPDATE_INPUT" });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(planted);
  });
});
