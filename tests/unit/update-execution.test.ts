import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import { contractSnapshotFromAnalyzerResult } from "../../packages/catalog/src/index.js";
import {
  parseAnalyzerResult,
  type AnalyzerRequest,
  type AnalyzerResult,
  type ContractSnapshot,
} from "../../packages/ir/src/index.js";
import {
  executeUpdate,
  parseContractDifferenceSet,
  planUpdate,
  UpdateError,
  type AnalysisKey,
  type UpdatePlan,
} from "../../packages/updates/src/index.js";

const baseRevision = "a".repeat(40);
const targetRevision = "b".repeat(40);
const configFingerprint = "execution-config-v1";
const roots: string[] = [];

const digest = (files: Record<string, string>): string => `sha256:${createHash("sha256").update(
  Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, text]) => `${path}\0${text}`)
    .join("\0"),
).digest("hex")}`;

const makeRoot = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-update-execution-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
};

const request = (
  immutableRevision: string,
  sourceDigest: string,
  requestId: string,
  changedPaths: string[],
  extractionMode: AnalyzerRequest["extraction_mode"],
): AnalyzerRequest => ({
  exchange_version: "1.0.0",
  ir_version: "1.0.0",
  request_id: requestId,
  analyzer: ANALYZER,
  source: {
    repository_id: "habitats",
    service_id: "aviary",
    service_root: ".",
    immutable_revision: immutableRevision,
    source_digest: sourceDigest,
    access_label: "execution-fixture-read",
  },
  resolution_inputs: [{ kind: "source_tree", path: ".", digest: sourceDigest }],
  prior_dependencies: [],
  changed_paths: changedPaths,
  extraction_mode: extractionMode,
  limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
  execution_policy: { network_access: false, side_effects: "none" },
});

const analysisKey = (snapshot: ContractSnapshot): AnalysisKey => ({
  analyzer: structuredClone(snapshot.analyzer),
  analyzer_exchange_version: "1.0.0",
  ir_version: snapshot.ir_version,
  identity_version: snapshot.identity_version,
  config_version: snapshot.config.config_version,
  config_fingerprint: snapshot.config.config_fingerprint,
});

const updatePlan = (
  baseSnapshot: ContractSnapshot,
  sourceDigest: string,
  changedPaths: string[],
  targetAnalysis: Partial<AnalysisKey> = {},
): UpdatePlan => planUpdate({
  base_snapshot: baseSnapshot,
  base_analysis_key: analysisKey(baseSnapshot),
  target: {
    repository_id: baseSnapshot.service.repository_id,
    service_id: baseSnapshot.service.service_id,
    service_root: baseSnapshot.service.root,
    immutable_revision: targetRevision,
    source_digest: sourceDigest,
    analysis_key: { ...analysisKey(baseSnapshot), ...targetAnalysis },
  },
  changed_paths: changedPaths,
  changed_paths_complete: true,
});

const baseFiles = {
  "app.ts": `import express from "express";
const app = express();
app.get("/legacy", (_req, res) => res.status(200).type("application/json").json({ legacy: true }));
app.post("/birds", (_req, res) => res.status(201).type("application/json").json({ created: true }));`,
};
const successFiles = {
  "app.ts": `import express from "express";
const app = express();
throw new Error("source modules must never execute");
app.post("/birds", (_req, res) => res.status(202).type("application/json").json({ accepted: true }));`,
};
const partialFiles = {
  "app.ts": `import express from "express";
const app = express();
throw new Error("source modules must never execute");
app.post("/birds", (_req, res) => res.status(202).type("application/json").json({ accepted: true }));
app.get(process.env.UNKNOWN_ROUTE, (_req, res) => res.status(200).type("application/json").json({ hidden: true }));`,
};

let baseSnapshot: ContractSnapshot;
let successRoot: string;
let successRequest: AnalyzerRequest;
let successResult: AnalyzerResult;
let successPlan: UpdatePlan;

beforeAll(async () => {
  const baseRoot = await makeRoot(baseFiles);
  successRoot = await makeRoot(successFiles);
  const baseResult = await createAnalyzer({ projectRoot: baseRoot }).analyze(
    request(baseRevision, digest(baseFiles), "execution-base", [], "baseline"),
  );
  baseSnapshot = contractSnapshotFromAnalyzerResult(baseResult, configFingerprint).snapshot;
  successRequest = request(
    targetRevision,
    digest(successFiles),
    "execution-target",
    ["app.ts"],
    "fallback_full_service",
  );
  successResult = await createAnalyzer({ projectRoot: successRoot }).analyze(successRequest);
  successPlan = updatePlan(baseSnapshot, digest(successFiles), ["app.ts"]);
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("D07 safe update execution", () => {
  test("reuses the exact base snapshot and deterministic empty difference set without analyzer access", async () => {
    const plan = updatePlan(baseSnapshot, baseSnapshot.source.source_digest, []);
    const reuseRequest = request(
      targetRevision,
      baseSnapshot.source.source_digest,
      "execution-reuse",
      [],
      "baseline",
    );
    const analyze = vi.fn();

    const first = await executeUpdate({
      plan,
      request: reuseRequest,
      base_snapshot: baseSnapshot,
      config_fingerprint: configFingerprint,
    }, { analyze });
    const second = await executeUpdate({
      plan,
      request: reuseRequest,
      base_snapshot: baseSnapshot,
      config_fingerprint: configFingerprint,
    }, { analyze });

    expect(analyze).not.toHaveBeenCalled();
    expect(first.target_snapshot).toEqual(baseSnapshot);
    expect(first.target_snapshot).not.toBe(baseSnapshot);
    expect(first.analyzer_result).toBeUndefined();
    expect(first.differences.differences).toEqual([]);
    expect(first.differences).toEqual(second.differences);
    expect(parseContractDifferenceSet(first.differences)).toMatchObject({ ok: true });
  });

  test("runs the real analyzer once in full-service fallback and does not merge base facts", async () => {
    const real = createAnalyzer({ projectRoot: successRoot });
    const analyze = vi.fn((candidate: AnalyzerRequest) => real.analyze(candidate));
    const callerRequestBefore = structuredClone(successRequest);

    const output = await executeUpdate({
      plan: successPlan,
      request: successRequest,
      base_snapshot: baseSnapshot,
      config_fingerprint: configFingerprint,
    }, { analyze });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      extraction_mode: "fallback_full_service",
      changed_paths: ["app.ts"],
    }));
    expect(output.analyzer_result?.status).toBe("success");
    expect(output.target_snapshot.coverage.status).toBe("complete");
    expect(output.target_snapshot.config.config_fingerprint).toBe(configFingerprint);
    expect(output.target_snapshot.endpoints.map((endpoint) => endpoint.application_path)).toEqual(["/birds"]);
    expect(output.target_snapshot.evidence.every((item) => item.source_version === targetRevision)).toBe(true);
    expect(output.differences.differences).toContainEqual(expect.objectContaining({
      kind: "endpoint.removed",
      subject: expect.objectContaining({ endpoint_id: expect.any(String) }),
    }));
    expect(successRequest).toEqual(callerRequestBefore);
  });

  test("detaches the public analyzer result from the adapter-owned result graph", async () => {
    const adapterOwned = structuredClone(successResult);
    const output = await executeUpdate({
      plan: successPlan,
      request: successRequest,
      base_snapshot: baseSnapshot,
      config_fingerprint: configFingerprint,
    }, { analyze: async () => adapterOwned });
    const publicResult = output.analyzer_result!;
    const before = JSON.stringify(publicResult);

    expect(publicResult).not.toBe(adapterOwned);
    expect(publicResult.source).not.toBe(adapterOwned.source);
    expect(publicResult.evidence).not.toBe(adapterOwned.evidence);
    expect(publicResult.evidence[0]).not.toBe(adapterOwned.evidence[0]);

    adapterOwned.request_id = "mutated-after-return";
    adapterOwned.source.access_label = "private-mutated-label";
    adapterOwned.evidence[0]!.location.path = "private/after-return.ts";
    adapterOwned.endpoints.splice(0);

    expect(JSON.stringify(publicResult)).toBe(before);
    expect(parseAnalyzerResult(publicResult)).toMatchObject({ ok: true });
    expect(output.target_snapshot.endpoints).toHaveLength(1);
    expect(output.differences.target.immutable_revision).toBe(targetRevision);
  });

  test("rejects a matching result after the adapter mutates its detached request", async () => {
    const callerInput = {
      plan: structuredClone(successPlan),
      request: structuredClone(successRequest),
      base_snapshot: structuredClone(baseSnapshot),
      config_fingerprint: configFingerprint,
    };
    const callerBefore = structuredClone(callerInput);
    const changedRevision = "c".repeat(40);
    const changedDigest = `sha256:${"9".repeat(64)}`;
    const analyze = vi.fn(async (invoked: AnalyzerRequest) => {
      invoked.request_id = "adapter-mutated-request";
      invoked.analyzer.analyzer_id = "adapter-mutated-analyzer";
      invoked.analyzer.analyzer_version = "9.0.0";
      invoked.source.immutable_revision = changedRevision;
      invoked.source.source_digest = changedDigest;
      const result = structuredClone(successResult);
      result.request_id = invoked.request_id;
      result.analyzer = structuredClone(invoked.analyzer);
      result.source.immutable_revision = changedRevision;
      result.source.source_digest = changedDigest;
      result.evidence = result.evidence.map((item) => ({
        ...item,
        source_version: changedRevision,
        scope: { ...item.scope, revision: changedRevision },
      }));
      return result;
    });

    await expect(executeUpdate(callerInput, { analyze })).rejects.toMatchObject({
      code: "UPDATE_EXECUTION_FAILED",
      message: "Update execution failed",
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(callerInput).toEqual(callerBefore);
  });

  test.each(["exchange_version", "ir_version"] as const)(
    "rejects adapter mutation of %s even when its returned result matches",
    async (field) => {
      const analyze = vi.fn(async (invoked: AnalyzerRequest) => {
        (invoked as Record<string, unknown>)[field] = "9.0.0";
        const result = structuredClone(successResult);
        (result as unknown as Record<string, unknown>)[field] = "9.0.0";
        return result;
      });
      await expect(executeUpdate({
        plan: successPlan,
        request: successRequest,
        base_snapshot: baseSnapshot,
        config_fingerprint: configFingerprint,
      }, { analyze })).rejects.toMatchObject({ code: "UPDATE_EXECUTION_FAILED" });
      expect(analyze).toHaveBeenCalledTimes(1);
    },
  );

  test("uses immutable expectations when an adapter closure mutates caller-owned plan and base data", async () => {
    const callerInput = {
      plan: structuredClone(successPlan),
      request: structuredClone(successRequest),
      base_snapshot: structuredClone(baseSnapshot),
      config_fingerprint: configFingerprint,
    };
    const changedRevision = "c".repeat(40);
    const changedDigest = `sha256:${"8".repeat(64)}`;
    const analyze = vi.fn(async () => {
      callerInput.plan.service.target_revision = changedRevision;
      callerInput.plan.service.target_source_digest = changedDigest;
      callerInput.plan.analysis.target.analyzer.analyzer_version = "9.0.0";
      callerInput.base_snapshot.source.immutable_revision = changedRevision;
      callerInput.base_snapshot.analyzer.analyzer_version = "9.0.0";
      const result = structuredClone(successResult);
      result.analyzer.analyzer_version = "9.0.0";
      result.source.immutable_revision = changedRevision;
      result.source.source_digest = changedDigest;
      result.evidence = result.evidence.map((item) => ({
        ...item,
        source_version: changedRevision,
        scope: { ...item.scope, revision: changedRevision },
      }));
      return result;
    });

    await expect(executeUpdate(callerInput, { analyze })).rejects.toMatchObject({
      code: "UPDATE_EXECUTION_FAILED",
    });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  test("keeps a real full-service partial result visibly partial without proving deletions", async () => {
    const partialRoot = await makeRoot(partialFiles);
    const partialDigest = digest(partialFiles);
    const partialRequest = request(
      targetRevision,
      partialDigest,
      "execution-partial",
      ["app.ts"],
      "fallback_full_service",
    );
    const output = await executeUpdate({
      plan: updatePlan(baseSnapshot, partialDigest, ["app.ts"]),
      request: partialRequest,
      base_snapshot: baseSnapshot,
      config_fingerprint: configFingerprint,
    }, createAnalyzer({ projectRoot: partialRoot }));

    expect(output.analyzer_result?.status).toBe("partial");
    expect(output.target_snapshot.coverage.status).toBe("incomplete");
    expect(output.differences.differences.some((difference) => difference.kind === "endpoint.removed")).toBe(false);
    expect(output.differences.differences).toContainEqual(expect.objectContaining({
      kind: "endpoint.absence_unconfirmed",
    }));
  });

  test.each([
    ["base snapshot", (input: Record<string, any>) => {
      input.base_snapshot.snapshot_id = "wrong";
      for (const item of input.base_snapshot.evidence) {
        if (item.scope.snapshot_id !== undefined) item.scope.snapshot_id = "wrong";
      }
    }, "UPDATE_SCOPE_MISMATCH"],
    ["request repository", (input: Record<string, any>) => { input.request.source.repository_id = "wrong"; }, "UPDATE_SCOPE_MISMATCH"],
    ["request revision", (input: Record<string, any>) => { input.request.source.immutable_revision = "c".repeat(40); }, "UPDATE_SCOPE_MISMATCH"],
    ["request digest", (input: Record<string, any>) => { input.request.source.source_digest = `sha256:${"9".repeat(64)}`; }, "UPDATE_SCOPE_MISMATCH"],
    ["request analyzer", (input: Record<string, any>) => { input.request.analyzer.analyzer_version = "9.0.0"; }, "UPDATE_ANALYSIS_MISMATCH"],
    ["request exchange", (input: Record<string, any>) => {
      input.plan = updatePlan(baseSnapshot, digest(successFiles), ["app.ts"], { analyzer_exchange_version: "9.0.0" });
    }, "UPDATE_ANALYSIS_MISMATCH"],
    ["target IR version", (input: Record<string, any>) => {
      input.plan = updatePlan(baseSnapshot, digest(successFiles), ["app.ts"], { ir_version: "9.0.0" });
    }, "UPDATE_ANALYSIS_MISMATCH"],
    ["target identity version", (input: Record<string, any>) => {
      input.plan = updatePlan(baseSnapshot, digest(successFiles), ["app.ts"], { identity_version: "9.0.0" });
    }, "UPDATE_ANALYSIS_MISMATCH"],
    ["target config version", (input: Record<string, any>) => {
      input.plan = updatePlan(baseSnapshot, digest(successFiles), ["app.ts"], { config_version: "9.0.0" });
    }, "UPDATE_ANALYSIS_MISMATCH"],
    ["resolution digest", (input: Record<string, any>) => {
      input.request.resolution_inputs[0].digest = `sha256:${"9".repeat(64)}`;
    }, "UPDATE_SCOPE_MISMATCH"],
    ["request changed paths", (input: Record<string, any>) => { input.request.changed_paths = []; }, "UPDATE_ANALYSIS_MISMATCH"],
    ["request mode", (input: Record<string, any>) => { input.request.extraction_mode = "baseline"; }, "UPDATE_ANALYSIS_MISMATCH"],
    ["config fingerprint", (input: Record<string, any>) => { input.config_fingerprint = "wrong"; }, "UPDATE_ANALYSIS_MISMATCH"],
  ])("rejects a mismatched %s before analyzer access", async (_label, mutate, code) => {
    const input: Record<string, any> = {
      plan: structuredClone(successPlan),
      request: structuredClone(successRequest),
      base_snapshot: structuredClone(baseSnapshot),
      config_fingerprint: configFingerprint,
    };
    mutate(input);
    const analyze = vi.fn();

    await expect(executeUpdate(input, { analyze })).rejects.toMatchObject({ code });
    expect(analyze).not.toHaveBeenCalled();
  });

  test.each([
    ["request", (result: AnalyzerResult) => { result.request_id = "wrong"; }],
    ["repository", (result: AnalyzerResult) => { result.source.repository_id = "wrong"; }],
    ["service", (result: AnalyzerResult) => { result.source.service_id = "wrong"; }],
    ["root", (result: AnalyzerResult) => { result.source.service_root = "wrong"; }],
    ["revision", (result: AnalyzerResult) => { result.source.immutable_revision = "c".repeat(40); }],
    ["digest", (result: AnalyzerResult) => { result.source.source_digest = `sha256:${"9".repeat(64)}`; }],
    ["analyzer", (result: AnalyzerResult) => { result.analyzer.analyzer_version = "9.0.0"; }],
    ["identity", (result: AnalyzerResult) => { (result as any).identity_version = "9.0.0"; }],
  ])("rejects a mismatched analyzer result %s with a safe execution error", async (_label, mutate) => {
    const result = structuredClone(successResult);
    mutate(result);
    const analyze = vi.fn(async () => result);

    let thrown: unknown;
    try {
      await executeUpdate({
        plan: successPlan,
        request: successRequest,
        base_snapshot: baseSnapshot,
        config_fingerprint: configFingerprint,
      }, { analyze });
    } catch (error) {
      thrown = error;
    }
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(UpdateError);
    expect(thrown).toMatchObject({
      code: "UPDATE_EXECUTION_FAILED",
      message: "Update execution failed",
      retryable: true,
    });
    expect(JSON.stringify(thrown)).not.toContain("wrong");
  });

  test("rejects a valid failed analyzer result as ineligible", async () => {
    const failed = structuredClone(successResult);
    failed.status = "failed";
    failed.coverage = {
      status: "incomplete",
      analyzed_roots: ["."],
      unresolved_roots: ["."],
      reason: "fixture failure",
      diagnostic_ids: ["diag-execution-failed"],
    };
    failed.diagnostics = [{
      diagnostic_id: "diag-execution-failed",
      code: "fixture.failed",
      severity: "error",
      message: "private failure details",
      affected_endpoint_ids: [],
      evidence_ids: [],
    }];

    await expect(executeUpdate({
      plan: successPlan,
      request: successRequest,
      base_snapshot: baseSnapshot,
      config_fingerprint: configFingerprint,
    }, { analyze: async () => failed })).rejects.toMatchObject({
      code: "UPDATE_EXECUTION_FAILED",
      message: "Update execution failed",
    });
  });

  test("wraps thrown adapter details without exposing the cause", async () => {
    const secret = "/private/source/password.ts";
    let thrown: unknown;
    try {
      await executeUpdate({
        plan: successPlan,
        request: successRequest,
        base_snapshot: baseSnapshot,
        config_fingerprint: configFingerprint,
      }, { analyze: async () => { throw new Error(secret); } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "UPDATE_EXECUTION_FAILED",
      message: "Update execution failed",
      retryable: true,
    });
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(Object.keys(thrown as object)).not.toContain("cause");
  });
});
