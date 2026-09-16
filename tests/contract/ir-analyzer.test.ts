import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { parseAnalyzerRequest, parseAnalyzerResult } from "../../packages/ir/src/index.js";

const source = {
  repository_id: "commerce",
  service_id: "orders",
  service_root: "services/orders",
  immutable_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  source_digest: "sha256:source-b",
  access_label: "orders-read",
};

const request = {
  exchange_version: "1.0.0",
  ir_version: "1.0.0",
  request_id: "analysis-request-1",
  analyzer: { analyzer_id: "typescript-express", analyzer_version: "1.2.0" },
  source,
  resolution_inputs: [
    { kind: "source_tree", path: "services/orders", digest: "sha256:tree" },
    { kind: "type_manifest", path: "services/orders/package-lock.json", digest: "sha256:lock" },
  ],
  prior_dependencies: [],
  changed_paths: ["services/orders/src/validation.ts"],
  extraction_mode: "incremental",
  limits: { timeout_ms: 30000, max_files: 1000, max_output_bytes: 5000000 },
  execution_policy: { network_access: false, side_effects: "none" },
} as const;

let snapshot: Record<string, any>;
beforeAll(async () => {
  snapshot = JSON.parse(await readFile(fileURLToPath(new URL("../fixtures/ir/express-snapshot.json", import.meta.url)), "utf8"));
});

const analyzerResult = () => ({
  exchange_version: "1.0.0",
  ir_version: snapshot.ir_version,
  identity_version: snapshot.identity_version,
  request_id: request.request_id,
  result_id: "analysis-result-1",
  snapshot_id: snapshot.snapshot_id,
  analyzer: snapshot.analyzer,
  source,
  status: "partial",
  completed_at: snapshot.created_at,
  coverage: structuredClone(snapshot.coverage),
  evidence: structuredClone(snapshot.evidence),
  schemas: structuredClone(snapshot.schemas),
  endpoints: structuredClone(snapshot.endpoints),
  claims: structuredClone(snapshot.claims),
  dependencies: structuredClone(snapshot.dependencies),
  diagnostics: structuredClone(snapshot.diagnostics),
  reproducibility_fingerprint: "sha256:analysis-inputs",
});

describe("analyzer exchange", () => {
  test("accepts a controlled immutable request with explicit resolution inputs", () => {
    expect(parseAnalyzerRequest(request)).toMatchObject({ ok: true });
  });

  test("rejects implicit side effects and mutable branch input", () => {
    const candidate = structuredClone(request) as Record<string, any>;
    candidate.source.branch = "main";
    candidate.execution_policy.network_access = true;
    expect(parseAnalyzerRequest(candidate).ok).toBe(false);
  });

  test("rejects path traversal and absolute project paths", () => {
    const candidate = structuredClone(request) as Record<string, any>;
    candidate.source.service_root = "../../outside";
    candidate.resolution_inputs[0].path = "/etc";
    candidate.changed_paths = ["../../../secret"];
    expect(parseAnalyzerRequest(candidate).ok).toBe(false);
  });

  test("rejects a mutable branch name as the immutable revision", () => {
    const candidate = structuredClone(request) as Record<string, any>;
    candidate.source.immutable_revision = "main";
    expect(parseAnalyzerRequest(candidate).ok).toBe(false);
  });

  test("accepts an explicitly tagged immutable Maven classpath locator", () => {
    const candidate = structuredClone(request) as Record<string, any>;
    candidate.resolution_inputs.push({
      kind: "classpath",
      locator: { scheme: "maven", coordinate: "org.example:orders-api:1.2.3" },
      digest: "sha256:classpath",
    });
    expect(parseAnalyzerRequest(candidate)).toMatchObject({ ok: true });
  });

  test("accepts a partial result using the canonical endpoint/evidence schemas", () => {
    const result = parseAnalyzerResult(analyzerResult());
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.coverage.status).toBe("incomplete");
  });

  test("rejects unsupported exchange and IR versions", () => {
    const candidate = { ...analyzerResult(), exchange_version: "2.0.0", ir_version: "0.9.0" };
    expect(parseAnalyzerResult(candidate).ok).toBe(false);
  });

  test("rejects dangling analyzer endpoint/evidence references", () => {
    const candidate = analyzerResult();
    candidate.claims[0].subject.endpoint_id = "missing";
    candidate.claims[0].evidence_ids = ["missing"];
    const result = parseAnalyzerResult(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.dangling_reference")).toBe(true);
  });

  test("rejects a failed result that claims complete coverage", () => {
    const candidate = analyzerResult();
    candidate.status = "failed";
    candidate.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
    const result = parseAnalyzerResult(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.inconsistent_coverage")).toBe(true);
  });
});
