import { describe, expect, test } from "vitest";
import {
  deriveEndpointIdentity,
  parseContractSnapshot,
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
    expect(result.differences.map(({ kind }) => kind)).toEqual(["endpoint.absence_unconfirmed"]);
    expect(result.differences[0]).toMatchObject({
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
    expect(compare([before], [after], "incomplete").differences.map(({ kind }) => kind)).toEqual([
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

  test("does not emit a whole-endpoint change for retained endpoint member changes", () => {
    const before = endpoint("endpoint-pet", "GET", "/pets/:petId");
    const after = structuredClone(before);
    after.security = { alternatives: [{ requirements: [{ scheme: "oauth", scopes: ["read"] }] }] };

    expect(compare([before], [after]).differences).toEqual([]);
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
});
