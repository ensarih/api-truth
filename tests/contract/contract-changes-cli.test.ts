import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";

import {
  parseContractChangesOutput,
  type ContractChangesOutput,
} from "../../packages/updates/src/index.js";

const repositoryRoot = resolve(".");
const script = resolve("scripts/contract-changes.ts");
const baseSource = "fixtures/typescript/orders/baseline/src";
const changedSource = "fixtures/typescript/orders/changed/src";
const baseRevision = "a".repeat(40);
const changedRevision = "b".repeat(40);
const documentedArguments = [
  "--base-source", baseSource,
  "--changed-source", changedSource,
  "--service", "orders",
  "--base-revision", baseRevision,
  "--changed-revision", changedRevision,
];
const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
});

const run = (args: readonly string[], cwd = repositoryRoot) => spawnSync(
  process.execPath,
  [script, ...args],
  { cwd, encoding: "utf8", env: { ...process.env, DATABASE_URL: "must-not-be-used" } },
);

const parsedOutput = (stdout: string): ContractChangesOutput => {
  const parsed = parseContractChangesOutput(JSON.parse(stdout));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.value;
};

const walk = (value: unknown, visit: (key: string | undefined, value: unknown) => void, key?: string): void => {
  visit(key, value);
  if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
  else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([childKey, child]) => walk(child, visit, childKey));
  }
};

describe("contract changes CLI", () => {
  test("the documented command emits one canonical safe D02 comparison", () => {
    const first = run(documentedArguments);
    const second = run(documentedArguments);

    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout.endsWith("\n")).toBe(true);
    expect(first.stdout.trim()).not.toContain("\n");
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe(first.stdout);

    const output = parsedOutput(first.stdout);
    expect(Object.keys(output)).toEqual([
      "contract_changes_output_version", "plan", "base", "target", "differences",
    ]);
    expect(output.plan).toMatchObject({
      action: "analyze_full_service",
      extraction_mode: "fallback_full_service",
      dependency_coverage: "incomplete",
    });
    expect(output.plan.fallback_reasons).toContain("adapter_incremental_targets_unsupported");
    expect(output.plan.fallback_reasons).toContain("prior_coverage_incomplete");
    expect(output.base.coverage_status).toBe("incomplete");
    expect(output.target.coverage_status).toBe("incomplete");
    expect(output.differences.comparison_status).toBe("incomplete");
    expect(output.differences.incomplete_reason_codes).toEqual([
      "base_coverage_incomplete", "target_coverage_incomplete",
    ]);

    const addedCancel = output.differences.differences.find((difference) =>
      difference.kind === "endpoint.added"
      && JSON.stringify(difference.after).includes("/api/orders/:orderId/cancel"));
    expect(addedCancel?.compatibility).toBe("non_breaking");

    const priorityChanges = output.differences.differences.filter((difference) =>
      difference.compatibility === "potentially_breaking"
      && JSON.stringify(difference).includes("/request/body/priority"));
    expect(priorityChanges).toHaveLength(2);
    const priorityEndpointIds = priorityChanges.map((difference) => difference.subject.endpoint_id!).sort();
    expect(new Set(priorityEndpointIds).size).toBe(2);
    expect(priorityEndpointIds.every((endpointId) => output.plan.affected_endpoint_ids.includes(endpointId))).toBe(true);

    const unprovedRemovalKinds = new Set([
      "endpoint.removed", "schema.removed", "claim.removed", "parameter.removed",
      "request_body.removed", "response.removed",
    ]);
    expect(output.differences.differences.some((difference) => unprovedRemovalKinds.has(difference.kind))).toBe(false);

    const forbiddenKeys = new Set([
      "service", "service_root", "changed_paths", "source_digest", "base_source_digest",
      "target_source_digest", "config_fingerprint", "evidence", "evidence_ids", "dependencies",
      "location", "access_label", "analyzer_result", "diagnostics", "reproducibility_fingerprint",
      "analyzed_roots", "unresolved_roots",
    ]);
    const forbiddenValues = [
      resolve(baseSource), resolve(changedSource), baseSource, changedSource,
      "validation.ts", "orders-routes.ts", "fixture-read", "local-contract-changes",
    ];
    walk(output, (key, value) => {
      if (key !== undefined) expect(forbiddenKeys.has(key), `forbidden stdout key ${key}`).toBe(false);
      if (typeof value === "string") {
        for (const forbidden of forbiddenValues) {
          expect(value.includes(forbidden), `forbidden stdout value ${forbidden}`).toBe(false);
        }
        expect(/^sha256:[a-f0-9]{64}$/.test(value), "digest leaked to stdout").toBe(false);
      }
    });
  });

  test.each([
    ["missing", documentedArguments.slice(0, -2)],
    ["unknown", [...documentedArguments, "--ir-version", "unsupported-secret-version"]],
    ["duplicate", [...documentedArguments, "--service", "duplicate-secret-service"]],
    ["bad revision", documentedArguments.map((value, index) => index === 7 ? "revision-secret" : value)],
    ["missing source", documentedArguments.map((value, index) => index === 1 ? "missing-secret-root" : value)],
  ])("rejects %s arguments with a stable private failure", (_name, args) => {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("api-truth changes error [INVALID_UPDATE_INPUT]: Update input is invalid\n");
    expect(result.stderr).not.toMatch(/secret|unsupported|revision-secret|missing-secret/);
  });

  test("applies the source boundary without executing source or reading expected.json", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "api-truth-changes-"));
    temporaryRoots.push(temporaryRoot);
    const baseline = join(temporaryRoot, "baseline");
    const changed = join(temporaryRoot, "changed");
    await cp(resolve(baseSource), baseline, { recursive: true });
    await cp(resolve(changedSource), changed, { recursive: true });

    const sideEffectMarker = join(temporaryRoot, "source-executed");
    const sideEffectSource = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sideEffectMarker)}, "executed");\n`;
    await writeFile(join(baseline, "side-effect.ts"), sideEffectSource, "utf8");
    await writeFile(join(changed, "side-effect.ts"), sideEffectSource, "utf8");
    await writeFile(join(temporaryRoot, "expected.json"), "{ hostile invalid json", "utf8");

    const result = run([
      "--base-source", baseline,
      "--changed-source", changed,
      "--service", "orders",
      "--base-revision", baseRevision,
      "--changed-revision", changedRevision,
    ]);
    expect(result.status).toBe(0);
    expect(() => parsedOutput(result.stdout)).not.toThrow();
    await expect(readFile(sideEffectMarker, "utf8")).rejects.toThrow();

    const link = join(temporaryRoot, "source-link");
    await symlink(baseline, link);
    const rejected = run(documentedArguments.map((value, index) => index === 1 ? link : value));
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toBe("api-truth changes error [INVALID_UPDATE_INPUT]: Update input is invalid\n");
    expect(rejected.stderr).not.toContain(temporaryRoot);
  });

  test("keeps complete-to-incomplete coverage differences path-free", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "api-truth-coverage-"));
    temporaryRoots.push(temporaryRoot);
    const baseline = join(temporaryRoot, "complete-base");
    const changed = join(temporaryRoot, "incomplete-target");
    const baseSourceText = [
      'import express from "express";',
      "const app = express();",
      'app.get("/health", (_request, response) => response.status(200).type("application/json").json({ ok: true }));',
      "export default app;",
      "",
    ].join("\n");
    const changedSourceText = [
      baseSourceText,
      'const suffix = "dynamic";',
      'app.get("/dynamic/" + suffix, (_request, response) => response.status(200).type("application/json").json({ ok: true }));',
      "",
    ].join("\n");
    await Promise.all([
      mkdir(baseline, { recursive: true }),
      mkdir(changed, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(baseline, "app.ts"), baseSourceText, "utf8"),
      writeFile(join(changed, "app.ts"), changedSourceText, "utf8"),
    ]);

    const result = run([
      "--base-source", baseline,
      "--changed-source", changed,
      "--service", "coverage-service",
      "--base-revision", baseRevision,
      "--changed-revision", changedRevision,
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = parsedOutput(result.stdout);
    const coverage = output.differences.differences.find((difference) =>
      difference.kind === "analysis.coverage_changed");
    expect(coverage).toMatchObject({
      before: { status: "complete" },
      after: { status: "incomplete", reason: "Unsupported or unresolved analysis constructs" },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("analyzed_roots");
    expect(serialized).not.toContain("unresolved_roots");
    expect(serialized).not.toContain(temporaryRoot);
    expect(serialized).not.toContain("complete-base");
    expect(serialized).not.toContain("incomplete-target");
  });

  test("the CLI source has no database, provider, network, log, model, or build integration", async () => {
    const source = await readFile(script, "utf8");
    expect(source).not.toMatch(/(?:from|import\()\s*["'](?:pg|openai|@google|@anthropic|axios|node:https?|node:net|winston|pino|child_process)/);
    expect(source).not.toMatch(/\b(?:fetch|exec|spawn|console\.(?:log|info)|expected\.json)\b/);
  });
});
