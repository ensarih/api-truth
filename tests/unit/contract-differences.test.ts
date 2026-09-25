import { describe, expect, test } from "vitest";
import {
  deriveEndpointIdentity,
  parseContractSnapshot,
  type Claim,
  type ContractSnapshot,
  type Endpoint,
} from "../../packages/ir/src/index.js";
import {
  compareContractSnapshots,
  parseContractDifferenceSet,
  UpdateError,
} from "../../packages/updates/src/index.js";

const baseRevision = "a".repeat(40);
const targetRevision = "b".repeat(40);

type ClaimCondition = NonNullable<Claim["condition"]>;

const condition = (field: string, value: string, paths = [`/${field}`]): ClaimCondition => ({
  kind: "predicate",
  operator: "equals",
  field,
  value,
  affected_schema_paths: paths,
});

const claim = (
  claim_id: string,
  value: unknown,
  claimCondition?: ClaimCondition,
  verification: Claim["verification"] = "declared",
  predicate = "request.rule",
): Claim => ({
  claim_id,
  subject: {
    service_id: "pets",
    endpoint_id: "endpoint-claims",
    schema_pointer: "/request/body",
  },
  predicate,
  value: value as Claim["value"],
  verification,
  ...(claimCondition === undefined ? {} : { condition: claimCondition }),
  evidence_ids: ["ev-route"],
});

const endpoint = (
  endpoint_id: string,
  method: string,
  application_path: string,
  evidence_id = "ev-route",
): Endpoint => ({
  endpoint_id,
  identity: deriveEndpointIdentity({
    identity_version: "1.0.0",
    service_id: "pets",
    method,
    application_path,
    selectors: {},
  }),
  application_path,
  parameters: [],
  request_bodies: [],
  responses: [{ status: { kind: "exact", code: 204 }, content: [] }],
  security: { alternatives: [] },
  evidence_ids: [evidence_id],
});

const snapshot = (
  snapshot_id: string,
  immutable_revision: string,
  endpoints: Endpoint[],
  coverage: "complete" | "incomplete" = "complete",
): ContractSnapshot => {
  const result: ContractSnapshot = {
    ir_version: "1.0.0",
    identity_version: "1.0.0",
    snapshot_id,
    service: { service_id: "pets", repository_id: "animal-care", root: "services/pets" },
    source: {
      repository_id: "animal-care",
      immutable_revision,
      source_digest: `sha256:${immutable_revision[0]!.repeat(64)}`,
    },
    analyzer: { analyzer_id: "fixture", analyzer_version: "1.0.0" },
    config: { config_version: "1.0.0", config_fingerprint: "fixture-config" },
    created_at: "2026-09-24T08:00:00.000Z",
    coverage: coverage === "complete"
      ? { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] }
      : {
          status: "incomplete",
          analyzed_roots: ["src"],
          unresolved_roots: ["src/legacy"],
          reason: "fixture incomplete",
          diagnostic_ids: ["diag-incomplete"],
        },
    evidence: endpoints.length === 0 ? [] : [{
      evidence_id: "ev-route",
      source: { kind: "source_code", source_id: "animal-care" },
      source_version: immutable_revision,
      location: { path: "src/routes.ts" },
      method: "deterministic_analysis",
      scope: { service_id: "pets" },
      limitations: [],
      access_label: "fixture-read",
    }],
    schemas: {},
    endpoints,
    claims: [],
    editorial_reviews: [],
    export_eligibility: [],
    dependencies: [],
    diagnostics: coverage === "complete" ? [] : [{
      diagnostic_id: "diag-incomplete",
      code: "fixture.incomplete",
      severity: "warning",
      message: "fixture wording is private bookkeeping",
      affected_endpoint_ids: [],
      evidence_ids: [],
    }],
  };
  expect(parseContractSnapshot(result)).toMatchObject({ ok: true });
  return result;
};

const compare = (
  baseEndpoints: Endpoint[],
  targetEndpoints: Endpoint[],
  targetCoverage: "complete" | "incomplete" = "complete",
) => compareContractSnapshots({
  base_snapshot: snapshot("snapshot-base", baseRevision, baseEndpoints),
  target_snapshot: snapshot("snapshot-target", targetRevision, targetEndpoints, targetCoverage),
});

describe("D07 endpoint contract differences", () => {
  test("compares retained parameter facts by canonical key", () => {
    const before = endpoint("endpoint-parameters", "GET", "/pets");
    before.parameters = [{
      name: "limit",
      in: "query",
      presence: { state: "optional", evidence_ids: ["ev-route"] },
      schema: { type: "integer" },
      serialization: { style: "form" },
    }];
    const after = structuredClone(before);
    after.parameters[0]!.presence = { state: "required", evidence_ids: ["ev-route"] };

    expect(compare([before], [after]).differences).toEqual([
      expect.objectContaining({
        kind: "parameter.changed",
        compatibility: "potentially_breaking",
        subject: expect.objectContaining({
          fact_kind: "parameter",
          fact_key: '["parameter","endpoint-parameters","query","limit"]',
        }),
      }),
    ]);
  });

  test.each([
    ["optional", "non_breaking"],
    ["required", "potentially_breaking"],
    ["conditional", "potentially_breaking"],
    ["unknown", "unknown"],
  ] as const)("labels an added %s parameter", (state, compatibility) => {
    const before = endpoint("endpoint-add-parameter", "GET", "/pets");
    const after = structuredClone(before);
    after.parameters = [{
      name: "filter",
      in: "query",
      presence: state === "conditional"
        ? {
            state,
            condition: {
              kind: "predicate",
              operator: "present",
              field: "mode",
              affected_schema_paths: ["/mode"],
            },
            evidence_ids: ["ev-route"],
          }
        : { state, evidence_ids: ["ev-route"] },
      schema: { type: "string" },
      serialization: { style: "form" },
    }];

    expect(compare([before], [after]).differences).toEqual([
      expect.objectContaining({ kind: "parameter.added", compatibility }),
    ]);
  });

  test.each([
    ["optional", "required", "potentially_breaking"],
    ["optional", "conditional", "potentially_breaking"],
    ["required", "optional", "non_breaking"],
    ["conditional", "optional", "non_breaking"],
    ["unknown", "optional", "unknown"],
    ["optional", "unknown", "unknown"],
  ] as const)("labels parameter presence %s to %s", (from, to, compatibility) => {
    const makePresence = (state: typeof from | typeof to) => state === "conditional"
      ? {
          state,
          condition: {
            kind: "predicate" as const,
            operator: "present" as const,
            field: "mode",
            affected_schema_paths: ["/mode"],
          },
          evidence_ids: ["ev-route"],
        }
      : { state, evidence_ids: ["ev-route"] };
    const before = endpoint("endpoint-transition", "GET", "/pets");
    before.parameters = [{ name: "filter", in: "query", presence: makePresence(from), schema: { type: "string" }, serialization: { style: "form" } }];
    const after = structuredClone(before);
    after.parameters[0]!.presence = makePresence(to);

    expect(compare([before], [after]).differences[0]).toMatchObject({
      kind: "parameter.changed",
      compatibility,
    });
  });

  test.each(["optional", "required", "unknown"] as const)(
    "uses conservative compatibility for an unchanged-%s schema or serialization change",
    (state) => {
      const before = endpoint("endpoint-schema-change", "GET", "/pets");
      before.parameters = [{ name: "filter", in: "query", presence: { state, evidence_ids: ["ev-route"] }, schema: { type: "string" }, serialization: { style: "form" } }];
      const after = structuredClone(before);
      after.parameters[0]!.schema = { type: "integer" };
      expect(compare([before], [after]).differences[0]).toMatchObject({
        kind: "parameter.changed",
        compatibility: "potentially_breaking",
      });
      after.parameters[0]!.schema = { type: "string" };
      after.parameters[0]!.serialization = { style: "simple" };
      expect(compare([before], [after]).differences[0]).toMatchObject({
        kind: "parameter.changed",
        compatibility: "potentially_breaking",
      });
    },
  );

  test.each([
    ["optional", "required", "potentially_breaking"],
    ["required", "optional", "non_breaking"],
    ["unknown", "optional", "unknown"],
    ["optional", "unknown", "unknown"],
  ] as const)("labels request-body presence %s to %s", (from, to, compatibility) => {
    const before = endpoint("endpoint-body-transition", "POST", "/pets");
    before.request_bodies = [{
      media_type: "application/json",
      presence: { state: from, evidence_ids: ["ev-route"] },
      schema: { type: "object" },
      serialization: { format: "json" },
    }];
    const after = structuredClone(before);
    after.request_bodies[0]!.presence = { state: to, evidence_ids: ["ev-route"] };
    expect(compare([before], [after]).differences[0]).toMatchObject({
      kind: "request_body.changed",
      compatibility,
    });
  });

  test.each([
    ["optional", "non_breaking"],
    ["required", "potentially_breaking"],
    ["conditional", "potentially_breaking"],
    ["unknown", "unknown"],
  ] as const)("labels an added %s request body", (state, compatibility) => {
    const before = endpoint("endpoint-add-body", "POST", "/pets");
    const after = structuredClone(before);
    after.request_bodies = [{
      media_type: "application/json",
      presence: state === "conditional"
        ? {
            state,
            condition: {
              kind: "predicate",
              operator: "present",
              field: "mode",
              affected_schema_paths: ["/mode"],
            },
            evidence_ids: ["ev-route"],
          }
        : { state, evidence_ids: ["ev-route"] },
      schema: { type: "object" },
      serialization: { format: "json" },
    }];
    expect(compare([before], [after]).differences).toEqual([
      expect.objectContaining({ kind: "request_body.added", compatibility }),
    ]);
  });

  test.each(["optional", "required", "unknown"] as const)(
    "uses conservative compatibility for an unchanged-%s request-body schema or serialization change",
    (state) => {
      const before = endpoint("endpoint-body-change", "POST", "/pets");
      before.request_bodies = [{ media_type: "application/json", presence: { state, evidence_ids: ["ev-route"] }, schema: { type: "object" }, serialization: { format: "json" } }];
      const after = structuredClone(before);
      after.request_bodies[0]!.schema = { type: "string" };
      expect(compare([before], [after]).differences[0]).toMatchObject({
        kind: "request_body.changed",
        compatibility: "potentially_breaking",
      });
      after.request_bodies[0]!.schema = { type: "object" };
      after.request_bodies[0]!.serialization = { format: "xml" };
      expect(compare([before], [after]).differences[0]).toMatchObject({
        kind: "request_body.changed",
        compatibility: "potentially_breaking",
      });
    },
  );

  test("compares bodies, grouped responses, and security as narrow canonical facts", () => {
    const before = endpoint("endpoint-members", "POST", "/pets");
    before.request_bodies = [{
      media_type: "application/json",
      presence: { state: "optional", evidence_ids: ["ev-route"] },
      schema: { type: "object" },
      serialization: { format: "json" },
    }];
    before.responses = [{
      status: { kind: "exact", code: 200 },
      content: [{ media_type: "application/json", schema: { type: "object" }, serialization: { format: "json" } }],
      headers: [{ name: "X-Rate", schema: { type: "integer" } }],
    }];
    const after = structuredClone(before);
    after.request_bodies[0]!.presence = { state: "required", evidence_ids: ["ev-route"] };
    after.responses[0]!.headers![0]!.schema = { type: "string" };
    after.security = { alternatives: [{ requirements: [{ scheme: "oauth", scopes: ["write", "read"] }] }] };

    const result = compare([before], [after]);
    expect(result.differences.map(({ kind }) => kind)).toEqual([
      "request_body.changed",
      "response.changed",
      "security.changed",
    ]);
    expect(result.differences.map(({ subject }) => subject.fact_key)).toEqual([
      '["request_body","endpoint-members","application/json"]',
      '["response","endpoint-members","[\\"exact\\",200]"]',
      '["security","endpoint-members"]',
    ]);
    expect(result.differences.every(({ compatibility }) => compatibility === "potentially_breaking")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("evidence_ids");
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
  });

  test("uses absence-unconfirmed for missing retained members under incomplete target coverage", () => {
    const before = endpoint("endpoint-missing-members", "POST", "/pets");
    before.parameters = [{ name: "q", in: "query", presence: { state: "optional", evidence_ids: ["ev-route"] }, schema: { type: "string" }, serialization: { style: "form" } }];
    before.request_bodies = [{ media_type: "application/json", presence: { state: "optional", evidence_ids: ["ev-route"] }, schema: { type: "object" }, serialization: { format: "json" } }];
    before.responses.push({ status: { kind: "exact", code: 400 }, content: [] });
    const after = structuredClone(before);
    after.parameters = [];
    after.request_bodies = [];
    after.responses = after.responses.filter(({ status }) => status.kind !== "exact" || status.code !== 400);

    const absences = compare([before], [after], "incomplete").differences
      .filter(({ kind }) => kind === "fact.absence_unconfirmed");
    expect(absences).toHaveLength(3);
    expect(absences.map(({ subject }) => subject.fact_kind)).toEqual(["parameter", "request_body", "response"]);
    expect(absences.every(({ compatibility }) => compatibility === "unknown")).toBe(true);
  });

  test("compares component schemas with their complete canonical endpoint ownership union", () => {
    const baseEndpoint = endpoint("endpoint-zeta", "GET", "/pets");
    const targetEndpoint = endpoint("endpoint-alpha", "GET", "/animals");
    const base = snapshot("snapshot-base", baseRevision, [baseEndpoint]);
    const target = snapshot("snapshot-target", targetRevision, [targetEndpoint]);
    base.endpoints[0]!.parameters = [{ name: "pet", in: "query", presence: { state: "optional", evidence_ids: ["ev-route"] }, schema: { $ref: "#/schemas/Pet" }, serialization: { style: "form" } }];
    target.endpoints[0]!.responses = [{ status: { kind: "exact", code: 200 }, content: [{ media_type: "application/json", schema: { $ref: "#/schemas/Pet" }, serialization: { format: "json" } }] }];
    base.schemas.Pet = { schema_id: "Pet", schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } }, evidence_ids: ["ev-route"] };
    target.schemas.Pet = { schema_id: "Pet", schema: { type: "object", required: ["age", "name"], properties: { age: { type: "integer" }, name: { type: "string" } } }, evidence_ids: ["ev-route"] };

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    const changed = result.differences.find(({ kind }) => kind === "schema.changed");
    expect(changed).toMatchObject({
      compatibility: "potentially_breaking",
      subject: {
        component_id: "Pet",
        affected_endpoint_ids: ["endpoint-alpha", "endpoint-zeta"],
        fact_kind: "schema",
        fact_key: '["schema","Pet"]',
      },
    });
    expect(JSON.stringify(changed)).not.toContain("evidence_ids");
  });

  test("projects coverage and diagnostics without volatile IDs, evidence, or wording", () => {
    const base = snapshot("snapshot-base", baseRevision, []);
    const target = snapshot("snapshot-target", targetRevision, [], "incomplete");
    const first = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    target.diagnostics[0]!.diagnostic_id = "diag-renamed";
    target.diagnostics[0]!.message = "different private wording";
    target.coverage.diagnostic_ids = ["diag-renamed"];
    const second = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });

    expect(second).toEqual(first);
    expect(first.differences.map(({ kind }) => kind)).toEqual([
      "analysis.coverage_changed",
      "analysis.diagnostic_added",
    ]);
    expect(first.differences.map(({ subject }) => subject.fact_key)).toEqual([
      '["coverage"]',
      '["diagnostic","fixture.incomplete",[]]',
    ]);
    expect(JSON.stringify(first)).not.toContain("diagnostic_id");
    expect(JSON.stringify(first)).not.toContain("wording");
  });

  test("covers member and schema additions, removals, and incomplete schema absence", () => {
    const baseEndpoint = endpoint("endpoint-taxonomy", "POST", "/pets");
    baseEndpoint.parameters = [{ name: "old", in: "query", presence: { state: "optional", evidence_ids: ["ev-route"] }, schema: { type: "string" }, serialization: { style: "form" } }];
    baseEndpoint.request_bodies = [{ media_type: "text/plain", presence: { state: "optional", evidence_ids: ["ev-route"] }, schema: { type: "string" }, serialization: { format: "text" } }];
    baseEndpoint.responses.push({ status: { kind: "exact", code: 400 }, content: [] });
    const targetEndpoint = structuredClone(baseEndpoint);
    targetEndpoint.parameters = [{ name: "new", in: "query", presence: { state: "optional", evidence_ids: ["ev-route"] }, schema: { type: "string" }, serialization: { style: "form" } }];
    targetEndpoint.request_bodies = [{ media_type: "application/json", presence: { state: "unknown", evidence_ids: ["ev-route"] }, schema: { type: "object" }, serialization: { format: "json" } }];
    targetEndpoint.responses = targetEndpoint.responses.filter(({ status }) => status.kind !== "exact" || status.code !== 400);
    targetEndpoint.responses.push({ status: { kind: "exact", code: 201 }, content: [] });
    const base = snapshot("snapshot-base", baseRevision, [baseEndpoint]);
    const target = snapshot("snapshot-target", targetRevision, [targetEndpoint]);
    base.schemas.Old = { schema_id: "Old", schema: { type: "string" }, evidence_ids: ["ev-route"] };
    target.schemas.New = { schema_id: "New", schema: { type: "string" }, evidence_ids: ["ev-route"] };

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    expect(result.differences.map(({ kind }) => kind)).toEqual([
      "schema.added",
      "schema.removed",
      "parameter.added",
      "parameter.removed",
      "request_body.added",
      "request_body.removed",
      "response.added",
      "response.removed",
    ]);
    expect(result.differences.map(({ compatibility }) => compatibility)).toEqual([
      "non_breaking",
      "potentially_breaking",
      "non_breaking",
      "potentially_breaking",
      "unknown",
      "potentially_breaking",
      "potentially_breaking",
      "potentially_breaking",
    ]);

    target.coverage = {
      status: "incomplete",
      analyzed_roots: ["src"],
      unresolved_roots: ["src/legacy"],
      reason: "partial",
      diagnostic_ids: ["diag-partial"],
    };
    target.diagnostics = [{
      diagnostic_id: "diag-partial",
      code: "fixture.partial",
      severity: "warning",
      message: "partial",
      affected_endpoint_ids: [],
      evidence_ids: [],
    }];
    const partial = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    const oldSchema = partial.differences.find(({ subject }) => subject.fact_key === '["schema","Old"]');
    expect(oldSchema).toMatchObject({ kind: "fact.absence_unconfirmed", compatibility: "unknown" });
  });

  test.each([
    ["request body", (candidate: Endpoint) => {
      candidate.request_bodies = ["first", "second"].map((format) => ({
        media_type: "application/json",
        presence: { state: "optional" as const, evidence_ids: ["ev-route"] },
        schema: { type: "string" as const },
        serialization: { format },
      }));
    }, "/target_snapshot/endpoints/0/request_bodies/1"],
    ["response content", (candidate: Endpoint) => {
      candidate.responses = ["first", "second"].map((format) => ({
        status: { kind: "exact" as const, code: 200 },
        content: [{ media_type: "application/json", schema: { type: "string" as const }, serialization: { format } }],
      }));
    }, "/target_snapshot/endpoints/0/responses/1/content/0"],
    ["ASCII-normalized response header", (candidate: Endpoint) => {
      candidate.responses = [
        { status: { kind: "exact", code: 200 }, content: [], headers: [{ name: "X-Rate", schema: { type: "integer" } }] },
        { status: { kind: "exact", code: 200 }, content: [], headers: [{ name: "x-rate", schema: { type: "string" } }] },
      ];
    }, "/target_snapshot/endpoints/0/responses/1/headers/0"],
  ] as const)("rejects a duplicate %s comparison key safely", (_label, mutate, expectedPath) => {
    const duplicate = endpoint("endpoint-duplicate-member", "GET", "/pets");
    mutate(duplicate);
    let thrown: unknown;
    try {
      compare([], [duplicate]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "UPDATE_COMPARISON_INCOMPATIBLE",
      issues: [{ path: expectedPath, code: "semantic.duplicate_comparison_key" }],
    });
    expect(JSON.stringify(thrown)).not.toContain("first");
    expect(JSON.stringify(thrown)).not.toContain("second");
  });

  test("rejects duplicate projected diagnostic keys safely", () => {
    const target = snapshot("snapshot-target", targetRevision, []);
    target.diagnostics = ["private one", "private two"].map((message, index) => ({
      diagnostic_id: `diag-${index}`,
      code: "duplicate.code",
      severity: index === 0 ? "warning" as const : "error" as const,
      message,
      affected_endpoint_ids: [],
      evidence_ids: [],
    }));
    target.coverage.diagnostic_ids = ["diag-0", "diag-1"];

    let thrown: unknown;
    try {
      compareContractSnapshots({
        base_snapshot: snapshot("snapshot-base", baseRevision, []),
        target_snapshot: target,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "UPDATE_COMPARISON_INCOMPATIBLE",
      issues: [{ path: "/target_snapshot/diagnostics/1", code: "semantic.duplicate_comparison_key" }],
    });
    expect(JSON.stringify(thrown)).not.toContain("private one");
    expect(JSON.stringify(thrown)).not.toContain("duplicate.code");
  });

  test("diagnostic severity changes are a projected resolution and addition", () => {
    const base = snapshot("snapshot-base", baseRevision, []);
    const target = snapshot("snapshot-target", targetRevision, []);
    base.diagnostics = [{ diagnostic_id: "base-diag", code: "contract.warning", severity: "warning", message: "old", affected_endpoint_ids: [], evidence_ids: [] }];
    target.diagnostics = [{ diagnostic_id: "target-diag", code: "contract.warning", severity: "error", message: "new", affected_endpoint_ids: [], evidence_ids: [] }];
    base.coverage.diagnostic_ids = ["base-diag"];
    target.coverage.diagnostic_ids = ["target-diag"];

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    expect(result.differences.map(({ kind }) => kind)).toEqual([
      "analysis.diagnostic_added",
      "analysis.diagnostic_resolved",
    ]);
    expect(new Set(result.differences.map(({ difference_id }) => difference_id)).size).toBe(2);
    expect(new Set(result.differences.map(({ subject, kind }) => JSON.stringify([kind, subject]))).size).toBe(2);
  });

  test("canonical set permutations and volatile snapshot bookkeeping preserve bytes and IDs", () => {
    const before = endpoint("endpoint-canonical", "GET", "/pets");
    const after = structuredClone(before);
    after.security = { alternatives: [
      { requirements: [{ scheme: "oauth", scopes: ["write", "read"] }] },
      { requirements: [{ scheme: "api-key", scopes: [] }] },
    ] };
    const firstBase = snapshot("snapshot-base", baseRevision, [before]);
    const firstTarget = snapshot("snapshot-target", targetRevision, [after]);
    const secondBase = structuredClone(firstBase);
    const secondTarget = structuredClone(firstTarget);
    secondBase.created_at = "2030-01-01T00:00:00.000Z";
    secondTarget.created_at = "2031-01-01T00:00:00.000Z";
    secondBase.evidence[0]!.location = { path: "src/renamed.ts", line: 99 };
    secondTarget.evidence[0]!.location = { path: "src/other.ts", line: 101 };
    secondTarget.endpoints[0]!.security.alternatives.reverse();
    secondTarget.endpoints[0]!.security.alternatives[1]!.requirements[0]!.scopes.reverse();

    const first = compareContractSnapshots({ base_snapshot: firstBase, target_snapshot: firstTarget });
    const second = compareContractSnapshots({ base_snapshot: secondBase, target_snapshot: secondTarget });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(parseContractDifferenceSet(second)).toMatchObject({ ok: true });

    secondTarget.endpoints[0]!.security.alternatives[0]!.requirements[0]!.scopes.push("admin");
    const changed = compareContractSnapshots({ base_snapshot: secondBase, target_snapshot: secondTarget });
    expect(changed.differences[0]!.difference_id).not.toBe(first.differences[0]!.difference_id);
  });

  test("emits deterministic endpoint additions and confirmed removals", () => {
    const added = endpoint("endpoint-add", "POST", "/pets");
    const removed = endpoint("endpoint-remove", "DELETE", "/pets/:petId");

    const first = compare([removed], [added]);
    const second = compare([removed], [added]);

    expect(second).toEqual(first);
    expect(first.differences.map(({ kind }) => kind)).toEqual([
      "endpoint.added",
      "endpoint.removed",
    ]);
    expect(first.differences.map(({ compatibility }) => compatibility)).toEqual([
      "non_breaking",
      "potentially_breaking",
    ]);
    expect(first.differences.map(({ subject }) => subject.fact_key)).toEqual([
      '["endpoint","endpoint-add"]',
      '["endpoint","endpoint-remove"]',
    ]);
    expect(first).toMatchObject({
      contract_difference_version: "1.0.0",
      service_id: "pets",
      comparison_status: "complete",
      incomplete_reason_codes: [],
    });
    expect(parseContractDifferenceSet(first)).toMatchObject({ ok: true });
    expect(JSON.stringify(first)).not.toContain("evidence_ids");
    expect(JSON.stringify(first)).not.toContain("fixture wording");
  });

  test("uses absence-unconfirmed for a missing endpoint under incomplete target coverage", () => {
    const result = compare([endpoint("endpoint-old", "GET", "/pets")], [], "incomplete");

    expect(result.comparison_status).toBe("incomplete");
    expect(result.incomplete_reason_codes).toEqual(["target_coverage_incomplete"]);
    expect(result.differences.map(({ kind }) => kind)).toEqual([
      "analysis.coverage_changed",
      "analysis.diagnostic_added",
      "endpoint.absence_unconfirmed",
    ]);
    expect(result.differences.find(({ kind }) => kind === "endpoint.absence_unconfirmed")).toMatchObject({
      compatibility: "unknown",
      subject: {
        endpoint_id: "endpoint-old",
        fact_kind: "endpoint",
        fact_key: '["endpoint","endpoint-old"]',
      },
    });
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
  });

  test.each([
    ["literal path", endpoint("endpoint-old", "GET", "/pets"), endpoint("endpoint-new", "GET", "/animals")],
    ["method", endpoint("endpoint-old", "GET", "/pets"), endpoint("endpoint-new", "POST", "/pets")],
    ["reused ID with a new route identity", endpoint("endpoint-same", "GET", "/pets"), endpoint("endpoint-same", "POST", "/animals")],
  ])("treats a %s change as an addition plus a coverage-safe absence", (_label, before, after) => {
    expect(compare([before], [after]).differences.map(({ kind }) => kind)).toEqual([
      "endpoint.added",
      "endpoint.removed",
    ]);
    expect(compare([before], [after], "incomplete").differences
      .map(({ kind }) => kind)
      .filter((kind) => kind.startsWith("endpoint."))).toEqual([
      "endpoint.added",
      "endpoint.absence_unconfirmed",
    ]);
  });

  test("retains route identity across placeholder renames", () => {
    const before = endpoint("endpoint-pet", "GET", "/pets/:petId");
    const after = endpoint("endpoint-pet", "GET", "/pets/:id");
    expect(after.identity).toEqual(before.identity);

    const result = compare([before], [after]);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      kind: "endpoint.path_parameter_names_changed",
      compatibility: "potentially_breaking",
      subject: {
        endpoint_id: "endpoint-pet",
        fact_kind: "endpoint",
        fact_key: '["endpoint","endpoint-pet"]',
      },
      before: ["petId"],
      after: ["id"],
    });
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
  });

  test("emits the narrow retained member change instead of a whole-endpoint blob", () => {
    const before = endpoint("endpoint-pet", "GET", "/pets/:petId");
    const after = structuredClone(before);
    after.security = { alternatives: [{ requirements: [{ scheme: "oauth", scopes: ["read"] }] }] };

    expect(compare([before], [after]).differences).toEqual([
      expect.objectContaining({ kind: "security.changed", compatibility: "potentially_breaking" }),
    ]);
  });

  test("groups same-status response records into one canonical semantic projection", () => {
    const merged = endpoint("endpoint-response", "GET", "/pets");
    merged.responses = [{
      status: { kind: "exact", code: 200 },
      content: [
        { media_type: "application/json", schema: { type: "object" }, serialization: { format: "json" } },
        { media_type: "text/plain", schema: { type: "string" }, serialization: { format: "text" } },
      ],
      headers: [
        { name: "X-Alpha", schema: { type: "string" } },
        { name: "x-zeta", schema: { type: "integer" } },
      ],
    }];
    const split = structuredClone(merged);
    split.responses = [
      {
        status: { kind: "exact", code: 200 },
        content: [merged.responses[0]!.content[1]!],
        headers: [merged.responses[0]!.headers![1]!],
      },
      {
        status: { kind: "exact", code: 200 },
        content: [merged.responses[0]!.content[0]!],
        headers: [merged.responses[0]!.headers![0]!],
      },
    ];

    const mergedResult = compare([], [merged]);
    const splitResult = compare([], [split]);
    expect(splitResult).toEqual(mergedResult);
    expect(splitResult.differences[0]!.difference_id).toBe(mergedResult.differences[0]!.difference_id);
    expect(splitResult.difference_set_id).toBe(mergedResult.difference_set_id);
    expect((splitResult.differences[0]!.after as any).responses).toHaveLength(1);

    const oneEmpty = endpoint("endpoint-empty", "GET", "/empty");
    const repeatedEmpty = structuredClone(oneEmpty);
    repeatedEmpty.responses = [
      structuredClone(oneEmpty.responses[0]!),
      structuredClone(oneEmpty.responses[0]!),
    ];
    expect(compare([], [repeatedEmpty])).toEqual(compare([], [oneEmpty]));
  });

  test("reports all exact coverage reasons in contract order", () => {
    const base = snapshot("snapshot-base", baseRevision, [], "incomplete");
    const target = snapshot("snapshot-target", targetRevision, [], "incomplete");
    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });

    expect(result.comparison_status).toBe("incomplete");
    expect(result.incomplete_reason_codes).toEqual([
      "base_coverage_incomplete",
      "target_coverage_incomplete",
    ]);
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
  });

  test("identity version changes yield one service-scoped marker and no inferred endpoint churn", () => {
    const base = snapshot("snapshot-base", baseRevision, [endpoint("endpoint-old", "GET", "/pets")]);
    const target = snapshot("snapshot-target", targetRevision, [endpoint("endpoint-new", "POST", "/animals")]);
    (target as unknown as { identity_version: string }).identity_version = "2.0.0";
    for (const candidate of target.endpoints) {
      (candidate.identity as unknown as { identity_version: string }).identity_version = "2.0.0";
      candidate.identity.route_key = `2.0.0${candidate.identity.route_key.slice("1.0.0".length)}`;
    }

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });

    expect(result.incomplete_reason_codes).toEqual(["identity_version_changed"]);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      kind: "analysis.identity_changed",
      compatibility: "unknown",
      subject: {
        service_id: "pets",
        fact_kind: "identity",
        fact_key: '["identity"]',
      },
    });
    expect(result.differences.some(({ kind }) => kind.startsWith("endpoint."))).toBe(false);
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
  });

  test.each(["repository", "service", "root"] as const)(
    "rejects a %s mismatch with a safe comparison error",
    (field) => {
      const base = snapshot("snapshot-base", baseRevision, []);
      const target = snapshot("snapshot-target", targetRevision, []);
      if (field === "repository") {
        target.service.repository_id = "other-repository";
        target.source.repository_id = "other-repository";
      } else if (field === "service") {
        target.service.service_id = "other-service";
      } else {
        target.service.root = "services/other";
      }

      expect(() => compareContractSnapshots({ base_snapshot: base, target_snapshot: target }))
        .toThrowError(expect.objectContaining({
          name: "UpdateError",
          code: "UPDATE_COMPARISON_INCOMPATIBLE",
          message: "Contract snapshots cannot be compared",
        } satisfies Partial<UpdateError>));
    },
  );

  test("validates both snapshots without exposing rejected values", () => {
    const base = snapshot("snapshot-base", baseRevision, []);
    const target = snapshot("snapshot-target", targetRevision, []) as ContractSnapshot & { secret?: string };
    target.secret = "must-not-escape";

    let thrown: unknown;
    try {
      compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "UpdateError",
      code: "UPDATE_COMPARISON_INCOMPATIBLE",
      message: "Contract snapshots cannot be compared",
    });
    expect(JSON.stringify(thrown)).not.toContain("must-not-escape");
  });

  test("rejects duplicate endpoint comparison keys with only a safe path and code", () => {
    const duplicate = endpoint("endpoint-duplicate", "GET", "/pets");
    duplicate.parameters = ["first-private-value", "second-private-value"].map((privateValue) => ({
      name: "filter",
      in: "query" as const,
      presence: { state: "optional" as const, evidence_ids: ["ev-route"] },
      schema: { type: "string" as const, description: privateValue },
      serialization: { style: "form" },
    }));
    const base = snapshot("snapshot-base", baseRevision, []);
    const target = snapshot("snapshot-target", targetRevision, [duplicate]);

    let thrown: unknown;
    try {
      compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "UPDATE_COMPARISON_INCOMPATIBLE",
      issues: [{
        path: "/target_snapshot/endpoints/0/parameters/1",
        code: "semantic.duplicate_comparison_key",
      }],
    });
    expect(JSON.stringify(thrown)).not.toContain("private-value");
    expect(JSON.stringify(thrown)).not.toContain("filter");
  });

  test("aggregates condition additions, removals, and changes by owning claim tuple", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    const x = condition("mode", "x", ["/z", "/a"]);
    const y = condition("mode", "y");
    base.claims = [
      claim("base-added", "add"),
      claim("base-removed", "remove", x, "observed"),
      claim("base-changed", { z: 1, a: 2 }, x, "inferred"),
    ];
    target.claims = [
      claim("target-changed", { a: 2, z: 1 }, y, "inferred"),
      claim("target-added", "add", x),
      claim("target-removed", "remove", undefined, "observed"),
    ];

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    const conditionDifferences = result.differences.filter(({ kind }) => kind.startsWith("condition."));
    expect(conditionDifferences.map(({ kind }) => kind)).toEqual([
      "condition.added",
      "condition.removed",
      "condition.changed",
    ]);
    expect(conditionDifferences.every(({ subject }) =>
      subject.fact_kind === "condition_group"
      && subject.fact_key === '["condition_group","claim","endpoint-claims","/request/body","request.rule"]')).toBe(true);
    expect(conditionDifferences.map(({ compatibility }) => compatibility)).toEqual([
      "potentially_breaking",
      "unknown",
      "potentially_breaking",
    ]);
    expect(conditionDifferences[0]).toMatchObject({
      before: [],
      after: [{ value: "add", verification: "declared", condition: { value: "x" } }],
    });
    expect(conditionDifferences[1]).toMatchObject({
      before: [{ value: "remove", verification: "observed", condition: { value: "x" } }],
      after: [],
    });
    expect(conditionDifferences[2]).toMatchObject({
      before: [{ value: { a: 2, z: 1 }, verification: "inferred", condition: { value: "x" } }],
      after: [{ value: { a: 2, z: 1 }, verification: "inferred", condition: { value: "y" } }],
    });
    expect(new Set(conditionDifferences.map(({ difference_id }) => difference_id)).size).toBe(3);
    expect(new Set(conditionDifferences.map(({ kind, subject }) => JSON.stringify([kind, subject]))).size).toBe(3);
    expect(result.differences.some(({ kind }) => kind.startsWith("claim."))).toBe(false);
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain("claim_id");
    expect(JSON.stringify(result)).not.toContain("evidence_ids");
  });

  test("preserves value partitions when conditions are reassigned", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const x = condition("mode", "x");
    const y = condition("mode", "y");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = [claim("base-a", "A", x), claim("base-b", "B", y)];
    target.claims = [claim("target-a", "A", y), claim("target-b", "B", x)];

    const first = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    const changed = first.differences.find(({ kind }) => kind === "condition.changed");
    expect(first.differences).toHaveLength(1);
    expect(changed).toMatchObject({
      compatibility: "potentially_breaking",
      before: [
        { value: "A", verification: "declared", condition: { value: "x" } },
        { value: "B", verification: "declared", condition: { value: "y" } },
      ],
      after: [
        { value: "B", verification: "declared", condition: { value: "x" } },
        { value: "A", verification: "declared", condition: { value: "y" } },
      ],
    });
    expect(JSON.stringify((changed as any).before)).not.toBe(JSON.stringify((changed as any).after));
    expect(new Set((changed as any).before.map((assignment: any) => JSON.stringify(assignment.condition))))
      .toEqual(new Set((changed as any).after.map((assignment: any) => JSON.stringify(assignment.condition))));

    base.claims.reverse();
    target.claims.reverse();
    base.claims[0]!.claim_id = "volatile-base-id";
    target.claims[0]!.claim_id = "volatile-target-id";
    const permuted = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    expect(JSON.stringify(permuted)).toBe(JSON.stringify(first));
  });

  test("emits a new conditioned owner only as a grouped claim addition", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    target.claims = [claim("new-conditioned", "new", condition("mode", "strict"))];

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    expect(result.differences).toEqual([
      expect.objectContaining({
        kind: "claim.added",
        compatibility: "unknown",
        subject: expect.objectContaining({
          endpoint_id: "endpoint-claims",
          fact_kind: "claim",
          fact_key: '["claim","endpoint-claims","/request/body","request.rule"]',
        }),
        after: [{
          value: "new",
          verification: "declared",
          condition: expect.objectContaining({ value: "strict" }),
        }],
      }),
    ]);
    expect(result.differences.some(({ kind }) => kind === "condition.added")).toBe(false);
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
  });

  test("does not pair claims across a reused endpoint ID with a new route identity", () => {
    const beforeRoute = endpoint("endpoint-claims", "GET", "/pets");
    const afterRoute = endpoint("endpoint-claims", "POST", "/animals");
    const base = snapshot("snapshot-base", baseRevision, [beforeRoute]);
    const target = snapshot("snapshot-target", targetRevision, [afterRoute]);
    base.claims = [claim("old-route-claim", "old")];
    target.claims = [claim("new-route-claim", "new")];

    const claimDifferences = compareContractSnapshots({ base_snapshot: base, target_snapshot: target })
      .differences.filter(({ subject }) => subject.fact_kind === "claim");
    expect(claimDifferences.map(({ kind }) => kind)).toEqual(["claim.added", "claim.removed"]);
    expect(claimDifferences.some(({ kind }) => kind === "claim.changed")).toBe(false);
  });

  test("uses unconfirmed absence for a missing claim under incomplete target coverage", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route], "incomplete");
    base.claims = [claim("removed-claim", "old")];

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    const missing = result.differences.find(({ subject }) => subject.fact_kind === "claim");
    expect(missing).toMatchObject({
      kind: "fact.absence_unconfirmed",
      compatibility: "unknown",
      subject: {
        endpoint_id: "endpoint-claims",
        fact_kind: "claim",
        fact_key: '["claim","endpoint-claims","/request/body","request.rule"]',
      },
    });
    expect(result.differences.some(({ kind }) => kind === "claim.removed")).toBe(false);
  });

  test("honors claim multiplicity before collapsing safe grouped projections", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = [claim("duplicate-one", "same"), claim("duplicate-two", "same")];
    target.claims = [claim("duplicate-target", "same")];

    const result = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });
    expect(result.differences).toEqual([
      expect.objectContaining({
        kind: "claim.removed",
        compatibility: "unknown",
        before: [{ value: "same", verification: "declared" }],
      }),
    ]);
    expect(parseContractDifferenceSet(result)).toMatchObject({ ok: true });
  });

  test("ignores claim IDs, evidence details, reviews, and eligibility records", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = [claim("base-claim", "old")];
    target.claims = [claim("target-claim", "new")];
    const first = compareContractSnapshots({ base_snapshot: base, target_snapshot: target });

    const decoratedBase = structuredClone(base);
    const decoratedTarget = structuredClone(target);
    decoratedBase.claims[0]!.claim_id = "decorated-base-claim";
    decoratedTarget.claims[0]!.claim_id = "decorated-target-claim";
    decoratedBase.evidence[0]!.location = { path: "src/private-base.ts", line: 10 };
    decoratedTarget.evidence[0]!.location = { path: "src/private-target.ts", line: 20 };
    decoratedBase.editorial_reviews = [{
      review_id: "review-base",
      claim_id: "decorated-base-claim",
      state: "rejected",
      reviewer_id: "reviewer-base",
      reviewed_at: "2026-09-24T09:00:00.000Z",
      explanation: "private base explanation",
    }];
    decoratedTarget.editorial_reviews = [{
      review_id: "review-target",
      claim_id: "decorated-target-claim",
      state: "accepted",
      reviewer_id: "reviewer-target",
      reviewed_at: "2026-09-24T10:00:00.000Z",
      explanation: "private target explanation",
    }];
    decoratedBase.export_eligibility = [{
      eligibility_id: "eligibility-base",
      claim_id: "decorated-base-claim",
      status: "ineligible",
      scope: { service_id: "pets", snapshot_id: "snapshot-base", endpoint_ids: ["endpoint-claims"] },
      policy_version: "base-policy",
      evidence_fingerprint: "base-fingerprint",
      reason: "private base reason",
    }];
    decoratedTarget.export_eligibility = [{
      eligibility_id: "eligibility-target",
      claim_id: "decorated-target-claim",
      status: "ineligible",
      scope: { service_id: "pets", snapshot_id: "snapshot-target", endpoint_ids: ["endpoint-claims"] },
      policy_version: "target-policy",
      evidence_fingerprint: "target-fingerprint",
      reason: "private target reason",
    }];

    const decorated = compareContractSnapshots({
      base_snapshot: decoratedBase,
      target_snapshot: decoratedTarget,
    });
    expect(JSON.stringify(decorated)).toBe(JSON.stringify(first));
    expect(JSON.stringify(decorated)).not.toContain("private");
  });

  test("labels only the exact reverse request presence claim transition non-breaking", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const transition = (beforeValue: string, afterValue: string) => {
      const base = snapshot("snapshot-base", baseRevision, [route]);
      const target = snapshot("snapshot-target", targetRevision, [route]);
      base.claims = [claim("before", beforeValue, undefined, "declared", "request.field.presence")];
      target.claims = [claim("after", afterValue, undefined, "declared", "request.field.presence")];
      return compareContractSnapshots({ base_snapshot: base, target_snapshot: target }).differences
        .find(({ kind }) => kind === "claim.changed");
    };

    expect(transition("optional", "required")).toMatchObject({ compatibility: "potentially_breaking" });
    expect(transition("required", "optional")).toMatchObject({ compatibility: "non_breaking" });
    expect(transition("conditional", "optional")).toMatchObject({ compatibility: "non_breaking" });
    expect(transition("required", "conditional")).toMatchObject({ compatibility: "unknown" });
  });

  test("keeps presence tightening potentially breaking when verification and condition also change", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = [claim(
      "base-tightening",
      "optional",
      condition("mode", "legacy"),
      "declared",
      "request.field.presence",
    )];
    target.claims = [claim(
      "target-tightening",
      "required",
      condition("mode", "strict"),
      "observed",
      "request.field.presence",
    )];

    expect(compareContractSnapshots({ base_snapshot: base, target_snapshot: target }).differences)
      .toEqual([expect.objectContaining({
        kind: "claim.changed",
        compatibility: "potentially_breaking",
      })]);

    base.claims[0]!.value = "required";
    target.claims[0]!.value = "optional";
    expect(compareContractSnapshots({ base_snapshot: base, target_snapshot: target }).differences)
      .toEqual([expect.objectContaining({
        kind: "claim.changed",
        compatibility: "unknown",
      })]);
  });

  test("applies tightening precedence to a grouped multi-member presence change", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = [
      claim("base-optional", "optional", undefined, "declared", "request.field.presence"),
      claim("base-unknown", "unknown", undefined, "inferred", "request.field.presence"),
    ];
    target.claims = [
      claim("target-required", "conditional", undefined, "owner_asserted", "request.field.presence"),
      claim("target-unknown", "unknown", undefined, "observed", "request.field.presence"),
    ];

    const changed = compareContractSnapshots({ base_snapshot: base, target_snapshot: target })
      .differences.find(({ kind }) => kind === "claim.changed");
    expect(changed).toMatchObject({ compatibility: "potentially_breaking" });
    expect((changed as any).before).toHaveLength(2);
    expect((changed as any).after).toHaveLength(2);
  });

  test("does not infer tightening when optional and restrictive members coexist unchanged", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = [
      claim("base-optional", "optional", condition("mode", "base-optional"), "declared", "request.field.presence"),
      claim("base-required", "required", condition("mode", "base-required"), "declared", "request.field.presence"),
    ];
    target.claims = [
      claim("target-optional", "optional", condition("mode", "target-optional"), "observed", "request.field.presence"),
      claim("target-required", "required", condition("mode", "target-required"), "observed", "request.field.presence"),
    ];

    const changed = compareContractSnapshots({ base_snapshot: base, target_snapshot: target })
      .differences.find(({ kind }) => kind === "claim.changed");
    expect(changed).toMatchObject({ compatibility: "unknown" });
  });

  test("detects net tightening while restrictive members already coexist", () => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = [
      claim("base-optional-one", "optional", undefined, "declared", "request.field.presence"),
      claim("base-optional-two", "optional", undefined, "declared", "request.field.presence"),
      claim("base-required", "required", undefined, "declared", "request.field.presence"),
    ];
    target.claims = [
      claim("target-optional", "optional", undefined, "declared", "request.field.presence"),
      claim("target-required-one", "required", undefined, "declared", "request.field.presence"),
      claim("target-required-two", "required", undefined, "declared", "request.field.presence"),
    ];

    const changed = compareContractSnapshots({ base_snapshot: base, target_snapshot: target })
      .differences.find(({ kind }) => kind === "claim.changed");
    expect(changed).toMatchObject({ compatibility: "potentially_breaking" });
  });

  test.each([
    {
      label: "optional count decreases without a restrictive count increase",
      baseValues: [
        ["optional", "declared"],
        ["optional", "declared"],
        ["required", "declared"],
      ],
      targetValues: [
        ["optional", "declared"],
        ["required", "observed"],
      ],
    },
    {
      label: "restrictive count increases without an optional count decrease",
      baseValues: [
        ["optional", "declared"],
        ["required", "declared"],
      ],
      targetValues: [
        ["optional", "observed"],
        ["required", "declared"],
        ["required", "declared"],
      ],
    },
  ] as const)("keeps $label unknown", ({ baseValues, targetValues }) => {
    const route = endpoint("endpoint-claims", "POST", "/pets");
    const base = snapshot("snapshot-base", baseRevision, [route]);
    const target = snapshot("snapshot-target", targetRevision, [route]);
    base.claims = baseValues.map(([value, verification], index) => claim(
      `base-partial-${index}`,
      value,
      undefined,
      verification,
      "request.field.presence",
    ));
    target.claims = targetValues.map(([value, verification], index) => claim(
      `target-partial-${index}`,
      value,
      undefined,
      verification,
      "request.field.presence",
    ));

    const changed = compareContractSnapshots({ base_snapshot: base, target_snapshot: target })
      .differences.find(({ kind }) => kind === "claim.changed");
    expect(changed).toMatchObject({ compatibility: "unknown" });
  });
});
