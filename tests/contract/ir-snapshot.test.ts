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
});
