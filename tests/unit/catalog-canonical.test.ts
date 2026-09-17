import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { AnalyzerResult, ContractSnapshot } from "../../packages/ir/src/index.js";
import { parseContractSnapshot } from "../../packages/ir/src/index.js";
import {
  canonicalJson,
  canonicalScopeIds,
  compareProviderOrder,
  normalizedContractContent,
  sha256Canonical,
  snapshotContentSha256,
  snapshotIdentitySha256,
} from "../../packages/catalog/src/canonical.js";
import { CatalogError, catalogStorageError } from "../../packages/catalog/src/errors.js";
import { contractSnapshotFromAnalyzerResult } from "../../packages/catalog/src/index.js";

let snapshot: ContractSnapshot;
let partialResult: AnalyzerResult;

beforeAll(async () => {
  const fixture = JSON.parse(await readFile(
    fileURLToPath(new URL("../fixtures/ir/express-snapshot.json", import.meta.url)),
    "utf8",
  )) as ContractSnapshot;
  snapshot = structuredClone(fixture);
  partialResult = {
    exchange_version: "1.0.0",
    ir_version: fixture.ir_version,
    identity_version: fixture.identity_version,
    request_id: "request-catalog-1",
    result_id: "result-catalog-1",
    snapshot_id: fixture.snapshot_id,
    analyzer: structuredClone(fixture.analyzer),
    source: {
      repository_id: fixture.source.repository_id,
      service_id: fixture.service.service_id,
      service_root: fixture.service.root,
      immutable_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      source_digest: fixture.source.source_digest,
      access_label: "orders-read",
    },
    status: "partial",
    completed_at: fixture.created_at,
    coverage: structuredClone(fixture.coverage),
    evidence: structuredClone(fixture.evidence),
    schemas: structuredClone(fixture.schemas),
    endpoints: structuredClone(fixture.endpoints),
    claims: structuredClone(fixture.claims),
    dependencies: structuredClone(fixture.dependencies),
    diagnostics: structuredClone(fixture.diagnostics),
    reproducibility_fingerprint: "sha256:analysis-inputs",
  };
});

describe("catalog canonical values", () => {
  test("sorts object keys recursively while preserving array order", () => {
    expect(sha256Canonical({ b: 2, nested: { d: 4, c: 3 }, a: 1 }))
      .toBe(sha256Canonical({ a: 1, nested: { c: 3, d: 4 }, b: 2 }));
    expect(sha256Canonical([2, 1])).not.toBe(sha256Canonical([1, 2]));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("rejects values outside the JSON data model", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrowError(
      expect.objectContaining({ code: "INVALID_CATALOG_INPUT" }),
    );
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining({ code: "INVALID_CATALOG_INPUT" }),
    );
    expect(() => canonicalJson(new Date())).toThrowError(
      expect.objectContaining({ code: "INVALID_CATALOG_INPUT" }),
    );

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => { throw new Error("secret getter value"); },
    });
    expect(() => canonicalJson(accessor)).toThrowError(
      expect.objectContaining({ code: "INVALID_CATALOG_INPUT" }),
    );
  });

  test("converts hostile canonical Proxy traps to a safe input error", () => {
    const plantedSecret = "secret://provider-reference-and-password";
    const hostile = new Proxy({}, {
      getPrototypeOf: () => { throw new Error(plantedSecret); },
    });

    let caught: unknown;
    try {
      canonicalJson(hostile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogError);
    expect(caught).toMatchObject({ code: "INVALID_CATALOG_INPUT" });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(plantedSecret);
  });

  test("normalizes away only the top-level snapshot creation time", () => {
    const later = { ...snapshot, created_at: "2026-09-17T12:00:00.000Z" };
    expect(snapshotContentSha256(later)).toBe(snapshotContentSha256(snapshot));

    const changedDiagnostics = structuredClone(snapshot.diagnostics);
    changedDiagnostics[0] = { ...changedDiagnostics[0]!, message: "changed diagnostic" };
    expect(snapshotContentSha256({ ...snapshot, diagnostics: changedDiagnostics }))
      .not.toBe(snapshotContentSha256(snapshot));

    const nestedCreatedAt = structuredClone(snapshot);
    nestedCreatedAt.claims[0]!.value = { created_at: "nested timestamp" };
    expect(snapshotContentSha256(nestedCreatedAt)).not.toBe(snapshotContentSha256(snapshot));
    expect("created_at" in normalizedContractContent(snapshot)).toBe(false);
  });

  test("includes every documented identity field in the identity digest", () => {
    const expected = sha256Canonical({
      snapshot_id: snapshot.snapshot_id,
      repository_id: snapshot.service.repository_id,
      service_id: snapshot.service.service_id,
      immutable_revision: snapshot.source.immutable_revision,
      analyzer: snapshot.analyzer,
      ir_version: snapshot.ir_version,
      identity_version: snapshot.identity_version,
      config_fingerprint: snapshot.config.config_fingerprint,
    });
    expect(snapshotIdentitySha256(snapshot)).toBe(expected);
    expect(snapshotIdentitySha256({
      ...snapshot,
      config: { ...snapshot.config, config_fingerprint: "sha256:changed" },
    })).not.toBe(expected);
  });

  test("deduplicates and UTF-8 byte-sorts required scope IDs", () => {
    expect(canonicalScopeIds(["équipe", "zeta", "équipe", "alpha"]))
      .toEqual(["alpha", "zeta", "équipe"]);
    expect(() => canonicalScopeIds(["valid", ""])).toThrowError(
      expect.objectContaining({ code: "INVALID_CATALOG_INPUT" }),
    );
    expect(() => canonicalScopeIds([])).toThrowError(
      expect.objectContaining({ code: "INVALID_CATALOG_INPUT" }),
    );
  });

  test("compares only arbitrary-length canonical decimal sequences", () => {
    const sequence = (value: string) => ({ kind: "sequence" as const, value });
    const cursor = (value: string) => ({ kind: "cursor" as const, value });

    expect(compareProviderOrder(sequence("9"), sequence("10"))).toBe("newer");
    expect(compareProviderOrder(sequence("10"), sequence("9"))).toBe("older");
    expect(compareProviderOrder(sequence("10"), sequence("10"))).toBe("equal");
    expect(compareProviderOrder(sequence("9".repeat(200_000)), sequence("1".repeat(200_001))))
      .toBe("newer");
    expect(compareProviderOrder(sequence("1".repeat(200_000) + "0"), sequence("1".repeat(200_000) + "1")))
      .toBe("newer");
    expect(compareProviderOrder(sequence("09"), sequence("10"))).toBe("unknown");
    expect(compareProviderOrder(cursor("a"), cursor("b"))).toBe("unknown");
  });
});

describe("analyzer result conversion", () => {
  test("creates a D03-valid snapshot and canonical required scopes", () => {
    const result = structuredClone(partialResult);
    result.evidence[1]!.access_label = "shared-types-read";
    const converted = contractSnapshotFromAnalyzerResult(result, "sha256:config");

    expect(parseContractSnapshot(converted.snapshot).ok).toBe(true);
    expect(converted.analyzerStatus).toBe("partial");
    expect(converted.requiredScopeIds).toEqual(["orders-read", "shared-types-read"]);
    expect(converted.snapshot.editorial_reviews).toEqual([]);
    expect(converted.snapshot.export_eligibility).toEqual([]);
    expect(converted.snapshot.config.config_fingerprint).toBe("sha256:config");
  });

  test("accepts success only with complete coverage", () => {
    const result = structuredClone(partialResult);
    result.status = "success";
    result.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
    const converted = contractSnapshotFromAnalyzerResult(result, "sha256:config");
    expect(converted.analyzerStatus).toBe("success");
    expect(converted.snapshot.coverage.status).toBe("complete");
  });

  test("rejects a D03-valid failed analyzer result", () => {
    const failedResult = { ...structuredClone(partialResult), status: "failed" as const };
    expect(() => contractSnapshotFromAnalyzerResult(failedResult, "sha256:config"))
      .toThrowError(expect.objectContaining({ code: "SNAPSHOT_INELIGIBLE" }));
  });

  test("projects validation issues without exposing rejected values", () => {
    const invalid = structuredClone(partialResult) as AnalyzerResult & Record<string, unknown>;
    invalid.completed_at = "postgresql://user:password@database/private";
    invalid.source.access_label = "scope-top-secret";
    (invalid.source as typeof invalid.source & Record<string, unknown>).provider_reference = "provider-secret-ref";

    let caught: unknown;
    try {
      contractSnapshotFromAnalyzerResult(invalid, "sha256:config");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogError);
    expect(caught).toMatchObject({
      code: "INVALID_SNAPSHOT",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: expect.any(String), code: expect.any(String) }),
      ]),
    });
    const exposed = JSON.stringify(caught);
    expect(exposed).not.toContain("postgresql://");
    expect(exposed).not.toContain("scope-top-secret");
    expect(exposed).not.toContain("provider-secret-ref");
  });

  test("converts hostile analyzer accessors to a safe snapshot error", () => {
    const plantedSecret = "secret://provider-reference-and-password";
    const hostile = structuredClone(partialResult);
    Object.defineProperty(hostile, "status", {
      enumerable: true,
      get: () => { throw new Error(plantedSecret); },
    });

    let caught: unknown;
    try {
      contractSnapshotFromAnalyzerResult(hostile, "sha256:config");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogError);
    expect(caught).toMatchObject({ code: "INVALID_SNAPSHOT" });
    expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(plantedSecret);
  });

  test("wraps raw storage errors with a stable safe error", () => {
    const wrapped = catalogStorageError(new Error("postgresql://user:password@database private SQL"));
    expect(wrapped).toMatchObject({ code: "CATALOG_STORAGE_ERROR", retryable: true });
    expect(`${wrapped.message} ${JSON.stringify(wrapped)}`).not.toContain("password");
  });
});
