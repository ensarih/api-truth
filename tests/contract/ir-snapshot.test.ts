import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { parseContractSnapshot } from "../../packages/ir/src/index.js";

let validSnapshot: Record<string, any>;
beforeAll(async () => {
  validSnapshot = JSON.parse(await readFile(fileURLToPath(new URL("../fixtures/ir/express-snapshot.json", import.meta.url)), "utf8"));
});

const clone = <T>(value: T): T => structuredClone(value);
const expectInvalid = (value: unknown, code: string) => {
  const result = parseContractSnapshot(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.issues.some((item) => item.code === code)).toBe(true);
};

describe("contract snapshot wire contract", () => {
  test("accepts a partial Express snapshot while preserving coverage and unknown requiredness", () => {
    const result = parseContractSnapshot(validSnapshot);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.coverage.status).toBe("incomplete");
      expect(result.value.endpoints[0]?.parameters[1]?.presence.state).toBe("unknown");
      expect(result.value.editorial_reviews[0]?.state).toBe("accepted");
      expect(result.value.export_eligibility[1]?.status).toBe("ineligible");
    }
  });

  test("rejects missing evidence provenance and scope", () => {
    const candidate = clone(validSnapshot);
    delete candidate.evidence[0].source_version;
    delete candidate.evidence[0].scope;
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.map((item) => item.path)).toEqual(expect.arrayContaining([
        "/evidence/0/source_version",
        "/evidence/0/scope",
      ]));
    }
  });

  test("rejects unsupported versions and malformed timestamps", () => {
    const candidate = clone(validSnapshot);
    candidate.ir_version = "2.0.0";
    candidate.created_at = "yesterday";
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.map((item) => item.path)).toEqual(expect.arrayContaining(["/ir_version", "/created_at"]));
    }
  });

  test("rejects duplicate IDs and dangling endpoint/evidence references", () => {
    const candidate = clone(validSnapshot);
    candidate.endpoints.push(clone(candidate.endpoints[0]));
    candidate.claims[0].subject.endpoint_id = "missing-endpoint";
    candidate.claims[0].evidence_ids = ["missing-evidence"];
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.error.issues.map((item) => item.code);
      expect(codes).toEqual(expect.arrayContaining(["semantic.duplicate_id", "semantic.dangling_reference"]));
    }
  });

  test("rejects cross-service references", () => {
    const candidate = clone(validSnapshot);
    candidate.claims[0].subject.service_id = "payments";
    expectInvalid(candidate, "semantic.cross_service_reference");
  });

  test("rejects eligible inferred constraints and unknown qualifying evidence", () => {
    const candidate = clone(validSnapshot);
    candidate.export_eligibility[1] = {
      ...candidate.export_eligibility[1],
      status: "eligible",
      basis: { kind: "behavioral_verification", evidence_ids: ["ev-inference", "missing-evidence"] },
    };
    delete candidate.export_eligibility[1].reason;
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
        "semantic.ineligible_evidence",
        "semantic.dangling_reference",
      ]));
    }
  });

  test("rejects qualifying evidence that is unrelated to the eligible claim", () => {
    const candidate = clone(validSnapshot);
    candidate.export_eligibility[1] = {
      eligibility_id: "eligibility-2",
      claim_id: "claim-priority-business-rule",
      status: "eligible",
      scope: { service_id: "orders", snapshot_id: "snapshot-orders-rev-b", endpoint_ids: ["ep-create"] },
      policy_version: "normative-v1",
      evidence_fingerprint: "sha256:unrelated",
      basis: { kind: "supported_runtime_validator", evidence_ids: ["ev-validator"] },
    };
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.unrelated_evidence")).toBe(true);
  });

  test("rejects an eligibility basis that mismatches its evidence method", () => {
    const candidate = clone(validSnapshot);
    candidate.claims[1].evidence_ids.push("ev-validator");
    candidate.export_eligibility[1] = {
      eligibility_id: "eligibility-2",
      claim_id: "claim-priority-business-rule",
      status: "eligible",
      scope: { service_id: "orders", snapshot_id: "snapshot-orders-rev-b", endpoint_ids: ["ep-create"] },
      policy_version: "normative-v1",
      evidence_fingerprint: "sha256:mismatch",
      basis: { kind: "behavioral_verification", evidence_ids: ["ev-validator"] },
    };
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.basis_mismatch")).toBe(true);
  });

  test("rejects eligibility scope that excludes the claim endpoint", () => {
    const candidate = clone(validSnapshot);
    candidate.export_eligibility[0].scope.endpoint_ids = ["ep-get"];
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.scope_mismatch")).toBe(true);
  });

  test("rejects eligible claims with unresolved contradictory claims", () => {
    const candidate = clone(validSnapshot);
    candidate.claims.push({
      ...clone(candidate.claims[0]),
      claim_id: "claim-priority-optional",
      value: "optional",
    });
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.conflicting_claims")).toBe(true);
  });

  test("requires qualifying evidence scope to cover the eligible claim subject and snapshot", () => {
    const candidate = clone(validSnapshot);
    candidate.evidence[1].scope.endpoint_id = "ep-get";
    candidate.evidence[1].scope.snapshot_id = "snapshot-orders-rev-b";
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.scope_mismatch")).toBe(true);
  });

  test.each([
    ["invalid regular expression", { type: "string", pattern: "[" }],
    ["duplicate enum values", { type: "string", enum: ["a", "a"] }],
    ["unregistered external reference", { $ref: "https://unregistered.invalid/schema" }],
  ])("rejects an embedded schema with %s", (_name, schema) => {
    const candidate = clone(validSnapshot);
    candidate.schemas.Customer.schema = schema;
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.invalid_api_schema")).toBe(true);
  });

  test("requires explicit affected diagnostics for incomplete coverage", () => {
    const candidate = clone(validSnapshot);
    candidate.coverage.diagnostic_ids = [];
    expectInvalid(candidate, "semantic.incomplete_coverage_without_diagnostic");
  });

  test("rejects identity data inconsistent with method/path/selectors", () => {
    const candidate = clone(validSnapshot);
    candidate.endpoints[0].identity.route_key = "wrong";
    expectInvalid(candidate, "semantic.identity_mismatch");
  });

  test("rejects non-JSON values at an unknown-input boundary", () => {
    const candidate = clone(validSnapshot);
    candidate.claims[0].value = 1n;
    expect(parseContractSnapshot(candidate).ok).toBe(false);
  });

  test.each([
    {
      name: "review",
      path: "/editorial_reviews",
      mutate: (candidate: Record<string, any>) => candidate.editorial_reviews.push({
        ...clone(candidate.editorial_reviews[0]), claim_id: "claim-priority-required",
      }),
    },
    {
      name: "eligibility",
      path: "/export_eligibility",
      mutate: (candidate: Record<string, any>) => candidate.export_eligibility.push({
        ...clone(candidate.export_eligibility[1]), claim_id: "claim-priority-required",
      }),
    },
  ])("rejects a duplicate $name ID", ({ path, mutate }) => {
    const candidate = clone(validSnapshot);
    mutate(candidate);
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues).toContainEqual(expect.objectContaining({ path, code: "semantic.duplicate_id" }));
  });

  test("rejects route identity collisions even when endpoint IDs differ", () => {
    const candidate = clone(validSnapshot);
    candidate.endpoints.push({ ...clone(candidate.endpoints[0]), endpoint_id: "ep-get-copy" });
    expectInvalid(candidate, "semantic.route_identity_collision");
  });

  test("reports a dangling presence evidence reference at its actual field path", () => {
    const candidate = clone(validSnapshot);
    candidate.endpoints[0].parameters[0].presence.evidence_ids = ["missing-evidence"];
    const result = parseContractSnapshot(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: "/endpoints/0/parameters/0/presence/evidence_ids/0",
        code: "semantic.dangling_reference",
      }));
    }
  });
});
