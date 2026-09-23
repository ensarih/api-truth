import { createHash } from "node:crypto";
import type { Static } from "@sinclair/typebox";
import { describe, expect, test } from "vitest";
import {
  ClaimConditionAssignmentSchema,
  ContractChangesOutputSchema,
  ContractDifferenceSetSchema,
  UpdateError,
  UpdatePlanSchema,
  parseClaimConditionAssignment,
  parseAnalysisKey,
  parseContractChangesOutput,
  parseContractDifference,
  parseContractDifferenceSet,
  parseUpdatePlan,
  type ClaimConditionAssignment,
  type ContractChangesOutput,
  type ContractDifference,
  type ContractDifferenceSet,
  type UpdatePlan,
} from "../../packages/updates/src/index.js";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");

const analysisKey = {
  analyzer: { analyzer_id: "typescript-express", analyzer_version: "1.2.0" },
  analyzer_exchange_version: "1.0.0",
  ir_version: "1.0.0",
  identity_version: "1.0.0",
  config_version: "1.0.0",
  config_fingerprint: `sha256:${"2".repeat(64)}`,
} as const;

const validPlan = (): UpdatePlan => {
  const content: Omit<UpdatePlan, "plan_id"> = {
    update_plan_version: "1.0.0",
    service: {
      repository_id: "commerce",
      service_id: "orders",
      service_root: "services/orders",
      base_snapshot_id: "snapshot-base",
      base_revision: "a".repeat(40),
      target_revision: "b".repeat(40),
      base_source_digest: `sha256:${"0".repeat(64)}`,
      target_source_digest: `sha256:${"0".repeat(64)}`,
    },
    analysis: { base: analysisKey, target: analysisKey },
    changed_paths: [],
    dependency_coverage: "complete",
    affected_endpoint_ids: [],
    action: "reuse_base_snapshot",
    fallback_reasons: [],
  };
  return { ...content, plan_id: `update-plan-${digest(content)}` };
};

const differenceId = (
  difference: Omit<ContractDifference, "difference_id">,
  metadata: { service_id: string; base_snapshot_id: string; target_snapshot_id: string },
): string => {
  const { compatibility: _compatibility, ...identityDifference } = difference;
  return `difference-${digest({
    version: "1.0.0",
    ...metadata,
    ...identityDifference,
  })}`;
};

const validDifferenceSet = (differences: ContractDifference[] = []): ContractDifferenceSet => {
  const content: Omit<ContractDifferenceSet, "difference_set_id"> = {
    contract_difference_version: "1.0.0",
    service_id: "orders",
    base: { snapshot_id: "snapshot-base", immutable_revision: "a".repeat(40) },
    target: { snapshot_id: "snapshot-base", immutable_revision: "a".repeat(40) },
    comparison_status: "complete",
    incomplete_reason_codes: [],
    differences,
  };
  return { ...content, difference_set_id: `difference-set-${digest(content)}` };
};

const validOutput = (): ContractChangesOutput => ({
  contract_changes_output_version: "1.0.0",
  plan: {
    update_plan_version: "1.0.0",
    plan_id: validPlan().plan_id,
    action: "reuse_base_snapshot",
    dependency_coverage: "complete",
    affected_endpoint_ids: [],
    fallback_reasons: [],
  },
  base: {
    snapshot_id: "snapshot-base",
    immutable_revision: "a".repeat(40),
    analyzer: analysisKey.analyzer,
    ir_version: "1.0.0",
    identity_version: "1.0.0",
    config_version: "1.0.0",
    coverage_status: "complete",
  },
  target: {
    snapshot_id: "snapshot-base",
    immutable_revision: "a".repeat(40),
    analyzer: analysisKey.analyzer,
    ir_version: "1.0.0",
    identity_version: "1.0.0",
    config_version: "1.0.0",
    coverage_status: "complete",
  },
  differences: validDifferenceSet(),
});

type AssignmentFromSchema = Static<typeof ClaimConditionAssignmentSchema>;
const publicAssignment: ClaimConditionAssignment = {} as AssignmentFromSchema;
const schemaAssignment: AssignmentFromSchema = {} as ClaimConditionAssignment;
void publicAssignment;
void schemaAssignment;
void UpdatePlanSchema;
void ContractDifferenceSetSchema;
void ContractChangesOutputSchema;

describe("D07 update contracts", () => {
  test("accepts a minimal canonical plan, difference set, and complete output", () => {
    expect(parseAnalysisKey(analysisKey)).toMatchObject({ ok: true });
    expect(parseUpdatePlan(validPlan())).toEqual({ ok: true, value: validPlan() });
    expect(parseContractDifferenceSet(validDifferenceSet())).toEqual({ ok: true, value: validDifferenceSet() });
    expect(parseContractChangesOutput(validOutput())).toEqual({ ok: true, value: validOutput() });
  });

  test("enforces the exact plan shape, identifiers, labels, set uniqueness, and canonical order", () => {
    const extra = { ...validPlan(), branch: "main" };
    const emptyId = structuredClone(validPlan());
    emptyId.service.service_id = "";
    const duplicate = structuredClone(validPlan());
    duplicate.affected_endpoint_ids = ["endpoint-a", "endpoint-a"];
    const unordered = structuredClone(validPlan());
    unordered.action = "analyze_full_service";
    unordered.extraction_mode = "fallback_full_service";
    unordered.dependency_coverage = "incomplete";
    unordered.affected_endpoint_ids = ["endpoint-z", "endpoint-a"];
    unordered.fallback_reasons = ["config_changed", "adapter_incremental_targets_unsupported"];
    unordered.plan_id = `update-plan-${digest((({ plan_id: _, ...content }) => content)(unordered))}`;

    expect(parseUpdatePlan(extra).ok).toBe(false);
    expect(parseUpdatePlan(emptyId).ok).toBe(false);
    expect(parseUpdatePlan(duplicate).ok).toBe(false);
    expect(parseUpdatePlan(unordered).ok).toBe(false);
  });

  test("rejects invalid difference kinds, labels, duplicate IDs and noncanonical ordering", () => {
    const metadata = {
      service_id: "orders",
      base_snapshot_id: "snapshot-base",
      target_snapshot_id: "snapshot-base",
    };
    const firstWithoutId = {
      kind: "endpoint.added",
      compatibility: "non_breaking",
      subject: {
        service_id: "orders",
        endpoint_id: "endpoint-a",
        fact_kind: "endpoint" as const,
        fact_key: '["endpoint","endpoint-a"]',
      },
      after: { method: "GET" },
    } as const;
    const first = { difference_id: differenceId(firstWithoutId, metadata), ...firstWithoutId };
    const secondWithoutId = {
      ...firstWithoutId,
      subject: {
        ...firstWithoutId.subject,
        endpoint_id: "endpoint-b",
        fact_key: '["endpoint","endpoint-b"]',
      },
    } as const;
    const second = { difference_id: differenceId(secondWithoutId, metadata), ...secondWithoutId };

    expect(parseContractDifference(first)).toMatchObject({ ok: true });

    const invalidKind = { ...first, kind: "endpoint.renamed" };
    const invalidLabel = { ...first, compatibility: "breaking" };
    expect(parseContractDifferenceSet(validDifferenceSet([invalidKind as ContractDifference])).ok).toBe(false);
    expect(parseContractDifferenceSet(validDifferenceSet([invalidLabel as ContractDifference])).ok).toBe(false);
    expect(parseContractDifferenceSet(validDifferenceSet([first, first])).ok).toBe(false);
    expect(parseContractDifferenceSet(validDifferenceSet([second, first])).ok).toBe(false);
  });

  test("requires each taxonomy kind to use its exact canonical fact tuple and matching subject", () => {
    const base = {
      difference_id: "deliberately-not-a-valid-content-hash",
      kind: "parameter.changed" as const,
      compatibility: "potentially_breaking" as const,
      subject: {
        service_id: "orders",
        endpoint_id: "endpoint-a",
        fact_kind: "parameter" as const,
        fact_key: '["parameter","endpoint-a","query","priority"]',
      },
    };
    expect(parseContractDifference(base)).toMatchObject({ ok: true });

    const invalid = [
      { ...base, subject: { ...base.subject, fact_kind: "caller_chosen" } },
      { ...base, subject: { ...base.subject, fact_kind: "response" } },
      { ...base, subject: { ...base.subject, fact_key: '["parameter","endpoint-b","query","priority"]' } },
      { ...base, subject: { ...base.subject, fact_key: '["parameter","endpoint-a","priority","query"]' } },
      { ...base, subject: { ...base.subject, fact_key: '[ "parameter", "endpoint-a", "query", "priority" ]' } },
      { ...base, subject: { ...base.subject, component_id: "component-a" } },
    ];
    for (const candidate of invalid) expect(parseContractDifference(candidate).ok).toBe(false);

    const absence = {
      ...base,
      kind: "fact.absence_unconfirmed" as const,
      compatibility: "unknown" as const,
    };
    expect(parseContractDifference(absence)).toMatchObject({ ok: true });
    expect(parseContractDifference({
      ...absence,
      subject: { ...absence.subject, fact_kind: "endpoint" },
    }).ok).toBe(false);

    const condition = {
      difference_id: "condition-shape-only",
      kind: "condition.added" as const,
      compatibility: "potentially_breaking" as const,
      subject: {
        service_id: "orders",
        endpoint_id: "endpoint-a",
        fact_kind: "condition_group" as const,
        fact_key: '["condition_group","claim","endpoint-a",null,"request.field.presence"]',
      },
      before: [] as [],
      after: [{
        value: "urgent",
        verification: "declared" as const,
        condition: {
          kind: "predicate" as const,
          operator: "present" as const,
          field: "priority",
          affected_schema_paths: ["/priority"],
        },
      }] as [ClaimConditionAssignment],
    };
    expect(parseContractDifference(condition)).toMatchObject({ ok: true });
    expect(parseContractDifference({
      ...condition,
      subject: { ...condition.subject, fact_key: '["condition_group","claim",null,null,"request.field.presence"]' },
    }).ok).toBe(false);

    const diagnostic = {
      difference_id: "diagnostic-shape-only",
      kind: "analysis.diagnostic_added" as const,
      compatibility: "unknown" as const,
      subject: {
        service_id: "orders",
        affected_endpoint_ids: ["endpoint-a"],
        fact_kind: "diagnostic",
        fact_key: '["diagnostic","unsupported_construct","[\\"endpoint-a\\"]"]',
      },
      after: { code: "unsupported_construct", severity: "warning", affected_endpoint_ids: ["endpoint-a"] },
    };
    expect(parseContractDifference(diagnostic)).toMatchObject({ ok: true });
    expect(parseContractDifference({
      ...diagnostic,
      subject: { ...diagnostic.subject, fact_key: '["diagnostic","unsupported_construct","[]"]' },
    }).ok).toBe(false);

    const invalidSet = validDifferenceSet([base]);
    invalidSet.differences[0]!.subject.fact_key = '["parameter","endpoint-b","query","priority"]';
    const result = parseContractDifferenceSet(invalidSet);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((candidate) => candidate.code === "semantic.fact_key_mismatch")).toBe(true);
      expect(result.error.issues.some((candidate) => candidate.code === "semantic.identity_mismatch")).toBe(false);
    }
  });

  test("covers every non-condition taxonomy kind and each absence fact tuple", () => {
    const endpointSubject = {
      service_id: "orders", endpoint_id: "endpoint-a", fact_kind: "endpoint",
      fact_key: '["endpoint","endpoint-a"]',
    } as const;
    const facts: Array<{ kind: Exclude<ContractDifference["kind"], `condition.${string}`>; subject: Record<string, unknown> }> = [
      ...(["endpoint.added", "endpoint.removed", "endpoint.absence_unconfirmed", "endpoint.path_parameter_names_changed"] as const)
        .map((kind) => ({ kind, subject: endpointSubject })),
      ...(["parameter.added", "parameter.removed", "parameter.changed"] as const).map((kind) => ({
        kind,
        subject: {
          service_id: "orders", endpoint_id: "endpoint-a", fact_kind: "parameter",
          fact_key: '["parameter","endpoint-a","query","priority"]',
        },
      })),
      ...(["request_body.added", "request_body.removed", "request_body.changed"] as const).map((kind) => ({
        kind,
        subject: {
          service_id: "orders", endpoint_id: "endpoint-a", fact_kind: "request_body",
          fact_key: '["request_body","endpoint-a","application/json"]',
        },
      })),
      ...(["response.added", "response.removed", "response.changed"] as const).map((kind) => ({
        kind,
        subject: {
          service_id: "orders", endpoint_id: "endpoint-a", fact_kind: "response",
          fact_key: '["response","endpoint-a","[\\"exact\\",200]"]',
        },
      })),
      {
        kind: "security.changed",
        subject: {
          service_id: "orders", endpoint_id: "endpoint-a", fact_kind: "security",
          fact_key: '["security","endpoint-a"]',
        },
      },
      ...(["schema.added", "schema.removed", "schema.changed"] as const).map((kind) => ({
        kind,
        subject: {
          service_id: "orders", component_id: "component-a", affected_endpoint_ids: ["endpoint-a"],
          fact_kind: "schema", fact_key: '["schema","component-a"]',
        },
      })),
      ...(["claim.added", "claim.removed", "claim.changed"] as const).map((kind) => ({
        kind,
        subject: {
          service_id: "orders", fact_kind: "claim",
          fact_key: '["claim",null,"#/properties/priority","request.field.presence"]',
        },
      })),
      {
        kind: "analysis.coverage_changed",
        subject: { service_id: "orders", fact_kind: "coverage", fact_key: '["coverage"]' },
      },
      {
        kind: "analysis.identity_changed",
        subject: { service_id: "orders", fact_kind: "identity", fact_key: '["identity"]' },
      },
      ...(["analysis.diagnostic_added", "analysis.diagnostic_resolved"] as const).map((kind) => ({
        kind,
        subject: {
          service_id: "orders", affected_endpoint_ids: ["endpoint-a"], fact_kind: "diagnostic",
          fact_key: '["diagnostic","unsupported_construct","[\\"endpoint-a\\"]"]',
        },
      })),
      ...([
        ["parameter", '["parameter","endpoint-a","query","priority"]', { endpoint_id: "endpoint-a" }],
        ["request_body", '["request_body","endpoint-a","application/json"]', { endpoint_id: "endpoint-a" }],
        ["response", '["response","endpoint-a","[\\"default\\"]"]', { endpoint_id: "endpoint-a" }],
        ["schema", '["schema","component-a"]', { component_id: "component-a", affected_endpoint_ids: ["endpoint-a"] }],
        ["claim", '["claim",null,null,"response.description"]', {}],
      ] as const).map(([factKind, factKey, fields]) => ({
        kind: "fact.absence_unconfirmed" as const,
        subject: { service_id: "orders", ...fields, fact_kind: factKind, fact_key: factKey },
      })),
    ];

    for (const [index, fact] of facts.entries()) {
      const difference = {
        difference_id: `shape-${index}`,
        kind: fact.kind,
        compatibility: "unknown",
        subject: fact.subject,
      };
      expect(parseContractDifference(difference), `${fact.kind}/${String(fact.subject.fact_kind)} should accept its exact tuple`)
        .toMatchObject({ ok: true });
      expect(parseContractDifference({
        ...difference,
        subject: { ...fact.subject, fact_key: '["wrong"]' },
      }), `${fact.kind} should reject another kind's tuple`).toMatchObject({ ok: false });
    }
  });

  test("validates complete partition-aware claim-condition assignments", () => {
    const condition = {
      kind: "predicate",
      operator: "present",
      field: "priority",
      affected_schema_paths: ["/priority"],
    } as const;
    const assignment = { value: "urgent", verification: "declared", condition } as const;
    expect(parseClaimConditionAssignment(assignment)).toMatchObject({ ok: true });
    expect(parseClaimConditionAssignment(condition).ok).toBe(false);
    expect(parseClaimConditionAssignment({ value: "urgent", verification: "declared" }).ok).toBe(false);
    expect(parseClaimConditionAssignment({ ...assignment, evidence_ids: ["evidence-secret"] }).ok).toBe(false);
    expect(parseClaimConditionAssignment({ ...assignment, verification: "guessed" }).ok).toBe(false);
    expect(parseClaimConditionAssignment({ ...assignment, condition: { ...condition, operator: "sometimes" } }).ok).toBe(false);
    expect(parseClaimConditionAssignment({ ...assignment, value: undefined }).ok).toBe(false);
  });

  test("requires canonical grouped assignments and preserves their value partitions", () => {
    const metadata = {
      service_id: "orders",
      base_snapshot_id: "snapshot-base",
      target_snapshot_id: "snapshot-base",
    };
    const condition = (field: string) => ({
      kind: "predicate" as const,
      operator: "present" as const,
      field,
      affected_schema_paths: [`/${field}`],
    });
    const before: ClaimConditionAssignment[] = [
      { value: "B", verification: "declared" as const, condition: condition("y") },
      { value: "A", verification: "declared" as const, condition: condition("x") },
    ];
    const after: ClaimConditionAssignment[] = [
      { value: "A", verification: "declared" as const, condition: condition("y") },
      { value: "B", verification: "declared" as const, condition: condition("x") },
    ];
    const withoutId = {
      kind: "condition.changed" as const,
      compatibility: "potentially_breaking" as const,
      subject: {
        service_id: "orders",
        endpoint_id: "endpoint-a",
        fact_kind: "condition_group" as const,
        fact_key: '["condition_group","claim","endpoint-a",null,"request.field.presence"]',
      },
      before,
      after,
    };
    const unordered = { difference_id: differenceId(withoutId, metadata), ...withoutId } as ContractDifference;
    expect(parseContractDifferenceSet(validDifferenceSet([unordered])).ok).toBe(false);

    const duplicate = structuredClone(unordered) as Extract<ContractDifference, { kind: "condition.changed" }>;
    duplicate.before = [duplicate.before[0]!, duplicate.before[0]!];
    expect(parseContractDifferenceSet(validDifferenceSet([duplicate])).ok).toBe(false);
  });

  test("rejects wrapper disagreement, action-mode disagreement, nested extras, and private data", () => {
    const mismatch = structuredClone(validOutput());
    mismatch.target.snapshot_id = "other-snapshot";
    const mode = structuredClone(validOutput()) as Record<string, any>;
    mode.plan.action = "analyze_full_service";
    const nestedExtra = structuredClone(validOutput()) as Record<string, any>;
    nestedExtra.base.service_root = "services/orders";

    expect(parseContractChangesOutput(mismatch).ok).toBe(false);
    expect(parseContractChangesOutput(mode).ok).toBe(false);
    expect(parseContractChangesOutput(nestedExtra).ok).toBe(false);

    for (const [key, value] of Object.entries({
      service_root: "services/orders",
      changed_paths: ["services/orders/src/private.ts"],
      source_digest: `sha256:${"9".repeat(64)}`,
      config_fingerprint: `sha256:${"8".repeat(64)}`,
      evidence: [{ source: { value: "secret" } }],
      location: { path: "src/private.ts" },
      diagnostics: [{ message: "raw private diagnostic" }],
      analyzer_result: { source: { access_label: "credential" } },
    })) {
      expect(parseContractChangesOutput({ ...validOutput(), [key]: value }).ok).toBe(false);
    }
  });

  test("rejects private metadata in fact projections but permits API schema properties named source", () => {
    const metadata = {
      service_id: "orders",
      base_snapshot_id: "snapshot-base",
      target_snapshot_id: "snapshot-base",
    };
    const endpoint = {
      kind: "endpoint.added" as const,
      compatibility: "non_breaking" as const,
      subject: {
        service_id: "orders",
        endpoint_id: "endpoint-a",
        fact_kind: "endpoint" as const,
        fact_key: '["endpoint","endpoint-a"]',
      },
      after: { method: "GET" },
    };
    for (const [key, value] of Object.entries({
      source: "private source content",
      evidence: [{ evidence_id: "evidence-secret" }],
      evidence_ids: ["evidence-secret"],
      location: { path: "services/orders/src/private.ts" },
      span: { line: 14 },
      access_label: "credential-scope",
      snapshot_id: "volatile-snapshot",
      claim_id: "volatile-claim",
      diagnostic_id: "volatile-diagnostic",
      message: "raw diagnostic message",
    })) {
      expect(parseContractDifference({
        difference_id: "shape-only",
        ...endpoint,
        after: { ...endpoint.after, [key]: value },
      }).ok).toBe(false);
    }

    const schema = {
      difference_id: "schema-shape-only",
      kind: "schema.added" as const,
      compatibility: "non_breaking" as const,
      subject: {
        service_id: "orders",
        component_id: "component-a",
        affected_endpoint_ids: ["endpoint-a"],
        fact_kind: "schema" as const,
        fact_key: '["schema","component-a"]',
      },
      after: {
        schema_id: "component-a",
        schema: {
          type: "object",
          properties: {
            source: { type: "string", description: "A legitimate API field" },
          },
        },
      },
    };
    expect(parseContractDifference(schema)).toMatchObject({ ok: true });

    const metadataLeak = structuredClone(schema) as Record<string, any>;
    metadataLeak.after.source = "private source content";
    expect(parseContractDifference(metadataLeak).ok).toBe(false);

    const privateEndpoint = {
      ...endpoint,
      after: { method: "GET", location: { path: "secret/provider/source.ts" } },
    };
    const privateDifference = {
      difference_id: differenceId(privateEndpoint, metadata),
      ...privateEndpoint,
    } as ContractDifference;
    const privateOutput = { ...validOutput(), differences: validDifferenceSet([privateDifference]) };
    const privateResult = parseContractChangesOutput(privateOutput);
    expect(privateResult.ok).toBe(false);
    expect(JSON.stringify(privateResult)).not.toContain("secret/provider/source.ts");

    const { difference_id: _shapeOnlyId, ...safeSchema } = schema;
    const safeDifference = {
      difference_id: differenceId(safeSchema, metadata),
      ...safeSchema,
    } as ContractDifference;
    const safeOutput = { ...validOutput(), differences: validDifferenceSet([safeDifference]) };
    const safeResult = parseContractChangesOutput(safeOutput);
    expect(safeResult, JSON.stringify(safeResult)).toMatchObject({ ok: true });
  });

  test("contains non-JSON and hostile values without exposing planted values", () => {
    const planted = "secret://credential-and-source-path";
    const accessor = structuredClone(validOutput()) as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => { throw new Error(planted); },
    });
    const hostile = new Proxy({}, {
      ownKeys: () => { throw new Error(planted); },
    });
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => { throw new Error(planted); },
    });

    for (const candidate of [accessor, hostile, accessorArray, { ...validOutput(), value: 1n }, { ...validOutput(), value: Number.NaN }]) {
      let result: unknown;
      expect(() => { result = parseContractChangesOutput(candidate); }).not.toThrow();
      expect(result).toMatchObject({ ok: false });
      expect(String(result)).not.toContain(planted);
    }
  });

  test("exposes only stable safe update error properties", () => {
    const error = new UpdateError("INVALID_UPDATE_INPUT", {
      issues: [{ path: "/target/source_digest", code: "shape.pattern", message: "planted-secret" } as any],
    });
    expect(error).toMatchObject({
      name: "UpdateError",
      message: "Update input is invalid",
      code: "INVALID_UPDATE_INPUT",
      retryable: false,
      issues: [{ path: "/target/source_digest", code: "shape.pattern" }],
    });
    expect(Object.keys(error).sort()).toEqual(["code", "issues", "name", "retryable"]);
    expect(JSON.stringify(error)).not.toContain("planted-secret");
  });
});
