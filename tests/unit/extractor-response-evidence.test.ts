import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";

test("serialization yields distinct endpoint-scoped evidence for shared handlers, never for registration alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-response-evidence-"));
  try {
    await writeFile(join(root, "app.ts"), `import express from "express";
      const app = express();
      function shared(_request, response) { response.status(200).type("application/json").json({}); }
      function silent(_request, _response) {}
      app.get("/first", shared);
      app.get("/second", shared);
      app.get("/silent", silent);`);
    const result = await createAnalyzer({ projectRoot: root }).analyze({
      exchange_version: "1.0.0", ir_version: "1.0.0", request_id: "shared-response", analyzer: ANALYZER,
      source: { repository_id: "commerce", service_id: "orders", service_root: ".",
        immutable_revision: "a".repeat(40), source_digest: "pending", access_label: "read" },
      resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
      prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
      limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
      execution_policy: { network_access: false, side_effects: "none" },
    });
    const first = result.endpoints.find((endpoint) => endpoint.application_path === "/first")!;
    const second = result.endpoints.find((endpoint) => endpoint.application_path === "/second")!;
    const silent = result.endpoints.find((endpoint) => endpoint.application_path === "/silent")!;
    const scoped = (endpointId: string) => result.evidence.filter((item) => item.scope.endpoint_id === endpointId);
    const firstProof = scoped(first.endpoint_id);
    const secondProof = scoped(second.endpoint_id);
    expect(firstProof).toHaveLength(1);
    expect(secondProof).toHaveLength(1);
    expect(firstProof[0]!.evidence_id).not.toBe(secondProof[0]!.evidence_id);
    expect(firstProof[0]!.location).toEqual(secondProof[0]!.location);
    expect(first.evidence_ids).toContain(firstProof[0]!.evidence_id);
    expect(second.evidence_ids).toContain(secondProof[0]!.evidence_id);
    expect(scoped(silent.endpoint_id)).toEqual([]);
    expect(silent.evidence_ids.every((id) => result.evidence.find((item) => item.evidence_id === id)
      ?.scope.endpoint_id === undefined)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
