import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createAnalyzer, ANALYZER } from "../../analyzers/typescript/src/index.js";
import { contractSnapshotFromAnalyzerResult } from "../../packages/catalog/src/index.js";
import {
  deriveEndpointIdentity,
  parseContractSnapshot,
  type AnalyzerRequest,
  type ContractSnapshot,
  type Endpoint,
  type Evidence,
} from "../../packages/ir/src/index.js";
import { parseUpdatePlan, planUpdate } from "../../packages/updates/src/index.js";
import { createUpdatePlanner } from "../../packages/updates/src/planner.js";

const serviceRoot = "services/aviary";
const baseRevision = "a".repeat(40);
const targetRevision = "b".repeat(40);
const baseDigest = `sha256:${"0".repeat(64)}`;
const targetDigest = `sha256:${"1".repeat(64)}`;

const evidence = (
  evidence_id: string,
  path: string,
  method: Evidence["method"] = "deterministic_analysis",
  endpoint_id?: string,
): Evidence => ({
  evidence_id,
  source: { kind: "source_code", source_id: "wildlife" },
  source_version: baseRevision,
  location: { path, symbol: evidence_id },
  method,
  scope: {
    service_id: "aviary",
    snapshot_id: "snapshot-aviary-base",
    ...(endpoint_id === undefined ? {} : { endpoint_id }),
  },
  limitations: [],
  access_label: "fixture-read",
});

const endpoint = (
  endpoint_id: string,
  method: string,
  application_path: string,
  evidence_ids: string[],
  details: Partial<Pick<Endpoint, "parameters" | "request_bodies" | "responses">> = {},
): Endpoint => ({
  endpoint_id,
  identity: deriveEndpointIdentity({
    identity_version: "1.0.0",
    service_id: "aviary",
    method,
    application_path,
    selectors: {},
  }),
  application_path,
  parameters: details.parameters ?? [],
  request_bodies: details.request_bodies ?? [],
  responses: details.responses ?? [{ status: { kind: "exact", code: 204 }, content: [] }],
  security: { alternatives: [] },
  evidence_ids,
});

const baseSnapshot = (withDependencies = true): ContractSnapshot => {
  const alpha = endpoint("endpoint-build-nest", "POST", "/nests", ["ev-alpha-handler"], {
    parameters: [{
      name: "dryRun",
      in: "query",
      presence: { state: "optional", evidence_ids: ["ev-query-presence"] },
      schema: { type: "boolean" },
      serialization: { style: "form" },
    }],
    request_bodies: [{
      media_type: "application/json",
      schema: { $ref: "#/schemas/NestInput" },
      serialization: { format: "json" },
      presence: {
        state: "conditional",
        condition: {
          kind: "predicate",
          operator: "present",
          field: "bird",
          affected_schema_paths: ["/request/body/bird"],
        },
        evidence_ids: ["ev-shared-validator"],
      },
    }],
    responses: [{
      status: { kind: "exact", code: 201 },
      content: [{
        media_type: "application/json",
        schema: { $ref: "#/schemas/BirdView" },
        serialization: { format: "json" },
      }],
      headers: [{ name: "x-nest", schema: { $ref: "#/schemas/NestDetails" } }],
    }],
  });
  const beta = endpoint("endpoint-repair-nest", "PATCH", "/nests/:nestId", ["ev-beta-handler"], {
    parameters: [{
      name: "nestId",
      in: "path",
      presence: { state: "required", evidence_ids: ["ev-shared-validator"] },
      schema: { type: "string" },
      serialization: { style: "simple" },
    }],
    request_bodies: [{
      media_type: "application/json",
      schema: { $ref: "#/schemas/NestInput" },
      serialization: { format: "json" },
      presence: { state: "required", evidence_ids: ["ev-body-presence"] },
    }],
  });
  const dependent = endpoint("endpoint-retire-nest", "DELETE", "/old-nests/:nestId", ["ev-dependent-handler"]);
  const unrelated = endpoint("endpoint-health", "GET", "/health", ["ev-health-handler"]);
  const snapshot: ContractSnapshot = {
    ir_version: "1.0.0",
    identity_version: "1.0.0",
    snapshot_id: "snapshot-aviary-base",
    service: { service_id: "aviary", repository_id: "wildlife", root: serviceRoot },
    source: { repository_id: "wildlife", immutable_revision: baseRevision, source_digest: baseDigest },
    analyzer: { analyzer_id: "fixture-analyzer", analyzer_version: "2.4.0" },
    config: { config_version: "1.0.0", config_fingerprint: "config-aviary-v1" },
    created_at: "2026-09-23T08:00:00Z",
    coverage: { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] },
    evidence: [
      evidence("ev-alpha-handler", "src/routes/build-nest.ts", "deterministic_analysis", alpha.endpoint_id),
      evidence("ev-beta-handler", "src/routes/repair-nest.ts", "deterministic_analysis", beta.endpoint_id),
      evidence("ev-dependent-handler", "src/routes/retire-nest.ts", "deterministic_analysis", dependent.endpoint_id),
      evidence("ev-health-handler", "src/routes/health.ts", "deterministic_analysis", unrelated.endpoint_id),
      evidence("ev-query-presence", "src/query-options.ts", "type_declaration"),
      evidence("ev-body-presence", "src/body-presence.ts", "runtime_validator", beta.endpoint_id),
      evidence("ev-shared-validator", "src/guards/nest-validator.ts", "runtime_validator"),
      evidence("ev-scoped-alpha", "src/scoped-policy.ts", "deterministic_analysis", alpha.endpoint_id),
      evidence("ev-claim", "src/rules/nest-rules.ts", "deterministic_analysis", beta.endpoint_id),
      evidence("ev-eligibility", "src/rules/nest-eligibility.ts", "runtime_validator", beta.endpoint_id),
      evidence("ev-nest-input", "src/dto/nest-input.ts", "type_declaration"),
      evidence("ev-nest-details", "src/dto/nest-details.ts", "type_declaration"),
      evidence("ev-bird-view", "src/dto/bird-view.ts", "type_declaration"),
      evidence("ev-orphan", "src/orphan.ts", "type_declaration"),
    ],
    schemas: {
      NestInput: {
        schema_id: "NestInput",
        schema: {
          type: "object",
          properties: { details: { $ref: "#/schemas/NestDetails" } },
          required: ["details"],
        },
        evidence_ids: ["ev-nest-input"],
      },
      NestDetails: {
        schema_id: "NestDetails",
        schema: {
          type: "object",
          properties: { parent: { $ref: "#/schemas/NestInput" }, label: { type: "string" } },
          required: ["label"],
        },
        evidence_ids: ["ev-nest-details"],
      },
      BirdView: {
        schema_id: "BirdView",
        schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        evidence_ids: ["ev-bird-view"],
      },
    },
    endpoints: [unrelated, beta, dependent, alpha],
    claims: [{
      claim_id: "claim-nest-rule",
      subject: { service_id: "aviary", endpoint_id: beta.endpoint_id, schema_pointer: "/request/body/details" },
      predicate: "nest.rule",
      value: "requires-safe-material",
      verification: "established_by_analysis",
      condition: {
        kind: "business_expression",
        expression: "weather.wind < limit",
        scope: "request.weather",
        affected_schema_paths: ["/request/body/details"],
      },
      evidence_ids: ["ev-claim", "ev-eligibility"],
    }],
    editorial_reviews: [{
      review_id: "review-nest-rule",
      claim_id: "claim-nest-rule",
      state: "accepted",
      reviewer_id: "aviary-owner",
      reviewed_at: "2026-09-23T08:05:00Z",
      explanation: "Rule is backed by deterministic analysis",
    }],
    export_eligibility: [{
      eligibility_id: "eligibility-nest-rule",
      claim_id: "claim-nest-rule",
      status: "eligible",
      scope: {
        service_id: "aviary",
        snapshot_id: "snapshot-aviary-base",
        endpoint_ids: [beta.endpoint_id],
      },
      policy_version: "normative-v1",
      evidence_fingerprint: "fixture-fingerprint",
      basis: { kind: "supported_runtime_validator", evidence_ids: ["ev-eligibility"] },
    }],
    dependencies: withDependencies ? [
      { from_endpoint_id: dependent.endpoint_id, to: { kind: "endpoint", id: alpha.endpoint_id }, evidence_ids: ["ev-dependent-handler"] },
      { from_endpoint_id: alpha.endpoint_id, to: { kind: "schema", id: "NestInput" }, evidence_ids: ["ev-alpha-handler"] },
      { from_endpoint_id: beta.endpoint_id, to: { kind: "evidence", id: "ev-shared-validator" }, evidence_ids: ["ev-beta-handler"] },
    ] : [],
    diagnostics: [],
  };
  expect(parseContractSnapshot(snapshot)).toMatchObject({ ok: true });
  return snapshot;
};

const analysisKey = (snapshot: ContractSnapshot) => ({
  analyzer: structuredClone(snapshot.analyzer),
  analyzer_exchange_version: "1.0.0" as const,
  ir_version: snapshot.ir_version,
  identity_version: snapshot.identity_version,
  config_version: snapshot.config.config_version,
  config_fingerprint: snapshot.config.config_fingerprint,
});

const planningInput = (snapshot: ContractSnapshot, changed_paths: string[]) => ({
  base_snapshot: snapshot,
  base_analysis_key: analysisKey(snapshot),
  target: {
    repository_id: snapshot.service.repository_id,
    service_id: snapshot.service.service_id,
    service_root: snapshot.service.root,
    immutable_revision: targetRevision,
    source_digest: targetDigest,
    analysis_key: analysisKey(snapshot),
  },
  changed_paths,
  changed_paths_complete: true,
});

describe("D07 reverse dependency planning", () => {
  test("fans a shared validator out to direct and endpoint-edge dependents", () => {
    const input = planningInput(baseSnapshot(), [
      `${serviceRoot}/src/guards/nest-validator.ts`,
    ]);
    const plan = planUpdate(input);

    expect(plan.affected_endpoint_ids).toEqual([
      "endpoint-build-nest",
      "endpoint-repair-nest",
      "endpoint-retire-nest",
    ]);
    expect(plan.changed_paths).toEqual([`${serviceRoot}/src/guards/nest-validator.ts`]);
    expect(plan.affected_endpoint_ids).not.toContain("endpoint-health");
    expect(plan).toMatchObject({
      dependency_coverage: "complete",
      action: "analyze_full_service",
      extraction_mode: "fallback_full_service",
      fallback_reasons: ["adapter_incremental_targets_unsupported"],
    });
    expect(parseUpdatePlan(plan)).toMatchObject({ ok: true });
  });

  test("uses every ordinary ownership route when optional dependency edges are absent", () => {
    const snapshot = baseSnapshot(false);
    const cases: Array<[string, string[]]> = [
      ["src/routes/build-nest.ts", ["endpoint-build-nest"]],
      ["src/query-options.ts", ["endpoint-build-nest"]],
      ["src/body-presence.ts", ["endpoint-repair-nest"]],
      ["src/guards/nest-validator.ts", ["endpoint-build-nest", "endpoint-repair-nest"]],
      ["src/scoped-policy.ts", ["endpoint-build-nest"]],
      ["src/rules/nest-rules.ts", ["endpoint-repair-nest"]],
      ["src/rules/nest-eligibility.ts", ["endpoint-repair-nest"]],
      ["src/dto/nest-input.ts", ["endpoint-build-nest", "endpoint-repair-nest"]],
      ["src/dto/nest-details.ts", ["endpoint-build-nest", "endpoint-repair-nest"]],
      ["src/dto/bird-view.ts", ["endpoint-build-nest"]],
    ];

    for (const [path, expected] of cases) {
      const plan = planUpdate(planningInput(snapshot, [`${serviceRoot}/${path}`]));
      expect(plan.affected_endpoint_ids, path).toEqual(expected);
      expect(plan.dependency_coverage, path).toBe("complete");
      expect(plan.fallback_reasons, path).toEqual(["adapter_incremental_targets_unsupported"]);
    }
  });

  test("handles schema cycles and produces stable IDs from reordered graph edges", () => {
    const first = baseSnapshot();
    const second = structuredClone(first);
    second.dependencies.reverse();
    second.dependencies.push(structuredClone(second.dependencies[0]!));
    const changed = [
      `${serviceRoot}/src/dto/nest-details.ts`,
      `${serviceRoot}/src/guards/nest-validator.ts`,
    ];
    const left = planUpdate(planningInput(first, changed));
    const right = planUpdate(planningInput(second, changed));

    expect(left).toEqual(right);
    expect(left.changed_paths).toEqual([
      `${serviceRoot}/src/dto/nest-details.ts`,
      `${serviceRoot}/src/guards/nest-validator.ts`,
    ]);
    expect(left.plan_id).toMatch(/^update-plan-[a-f0-9]{64}$/);
  });

  test("rejects duplicate and unsorted paths at the validated public boundary", () => {
    const snapshot = baseSnapshot();
    expect(() => planUpdate(planningInput(snapshot, [
      `${serviceRoot}/src/guards/nest-validator.ts`,
      `${serviceRoot}/src/guards/nest-validator.ts`,
    ]))).toThrowError(expect.objectContaining({ code: "INVALID_UPDATE_INPUT" }));
    expect(() => planUpdate(planningInput(snapshot, [
      `${serviceRoot}/src/guards/nest-validator.ts`,
      `${serviceRoot}/src/dto/nest-details.ts`,
    ]))).toThrowError(expect.objectContaining({ code: "INVALID_UPDATE_INPUT" }));
  });

  test("rejects a historical base digest at the boundary before ownership planning", () => {
    const historicalDigest = "sha256:source-b";
    const snapshot = baseSnapshot();
    snapshot.source.source_digest = historicalDigest;
    const candidate = planningInput(snapshot, [`${serviceRoot}/src/guards/nest-validator.ts`]);

    let caught: unknown;
    try {
      planUpdate(candidate);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "INVALID_UPDATE_INPUT",
      issues: [{ path: "/base_snapshot/source/source_digest", code: "shape.pattern" }],
    });
    expect(JSON.stringify(caught)).not.toContain(historicalDigest);

    const ownershipBuilder = vi.fn(() => { throw new Error("ownership construction must not run"); });
    const isolatedPlanner = createUpdatePlanner(ownershipBuilder);
    expect(() => isolatedPlanner(candidate)).toThrowError(expect.objectContaining({
      code: "INVALID_UPDATE_INPUT",
    }));
    expect(ownershipBuilder).not.toHaveBeenCalled();
  });

  test("joins opaque dependency target IDs through evidence locations", () => {
    const snapshot = baseSnapshot(false);
    snapshot.dependencies = [{
      from_endpoint_id: "endpoint-health",
      to: { kind: "evidence", id: "ev-nest-input" },
      evidence_ids: ["ev-health-handler"],
    }];
    const plan = planUpdate(planningInput(snapshot, [`${serviceRoot}/src/dto/nest-input.ts`]));

    expect(plan.affected_endpoint_ids).toEqual([
      "endpoint-build-nest",
      "endpoint-health",
      "endpoint-repair-nest",
    ]);
  });

  test("marks orphan and conflicting endpoint-scoped source records incomplete", () => {
    const orphan = planUpdate(planningInput(baseSnapshot(false), [`${serviceRoot}/src/orphan.ts`]));
    expect(orphan.affected_endpoint_ids).toEqual([]);
    expect(orphan.dependency_coverage).toBe("incomplete");
    expect(orphan.fallback_reasons).toEqual([
      "adapter_incremental_targets_unsupported",
      "dependency_index_incomplete",
    ]);

    const ambiguousSnapshot = baseSnapshot(false);
    const shared = ambiguousSnapshot.evidence.find((candidate) => candidate.evidence_id === "ev-shared-validator")!;
    shared.scope.endpoint_id = "endpoint-build-nest";
    const ambiguous = planUpdate(planningInput(
      ambiguousSnapshot,
      [`${serviceRoot}/src/guards/nest-validator.ts`],
    ));
    expect(ambiguous.affected_endpoint_ids).toEqual([
      "endpoint-build-nest",
      "endpoint-repair-nest",
    ]);
    expect(ambiguous.dependency_coverage).toBe("incomplete");
    expect(ambiguous.fallback_reasons).toContain("dependency_index_incomplete");

    const invalidPathSnapshot = baseSnapshot(false);
    invalidPathSnapshot.evidence.find(
      (candidate) => candidate.evidence_id === "ev-scoped-alpha",
    )!.location.path = "../outside.ts";
    const invalidPath = planUpdate(planningInput(
      invalidPathSnapshot,
      [`${serviceRoot}/src/routes/build-nest.ts`],
    ));
    expect(invalidPath.affected_endpoint_ids).toEqual(["endpoint-build-nest"]);
    expect(invalidPath.dependency_coverage).toBe("incomplete");
    expect(invalidPath.fallback_reasons).toContain("dependency_index_incomplete");
  });

  test("maps the D02 validation source to both create and update endpoints", async () => {
    const request: AnalyzerRequest = {
      exchange_version: "1.0.0",
      ir_version: "1.0.0",
      request_id: "d07-d02-baseline",
      analyzer: ANALYZER,
      source: {
        repository_id: "commerce-d02",
        service_id: "orders-d02",
        service_root: ".",
        immutable_revision: baseRevision,
        source_digest: "pending",
        access_label: "fixture-read",
      },
      resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
      prior_dependencies: [],
      changed_paths: [],
      extraction_mode: "baseline",
      limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
      execution_policy: { network_access: false, side_effects: "none" },
    };
    const result = await createAnalyzer({
      projectRoot: resolve("fixtures/typescript/orders/baseline/src"),
    }).analyze(request);
    const snapshot = contractSnapshotFromAnalyzerResult(result, "d02-config").snapshot;
    const post = snapshot.endpoints.find((candidate) => candidate.identity.method === "POST")!;
    const put = snapshot.endpoints.find((candidate) => candidate.identity.method === "PUT")!;
    const input = planningInput(snapshot, ["validation.ts"]);
    input.target.source_digest = targetDigest;
    const plan = planUpdate(input);

    expect(plan.affected_endpoint_ids).toEqual([post.endpoint_id, put.endpoint_id].sort());
    expect(plan.affected_endpoint_ids).toHaveLength(2);
  });
});
