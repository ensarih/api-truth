import { resolve } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import {
  parseEvent,
  type AnalyzerRequest,
  type AnalyzerResult,
  type ContractSnapshot,
} from "../../packages/ir/src/index.js";
import {
  createAccessPolicyStore,
  createCatalogStore,
  contractSnapshotFromAnalyzerResult,
  type AccessPolicyStore,
  type BranchPointer,
  type CatalogStore,
  type PromoteBranchInput,
  type ProviderReference,
} from "../../packages/catalog/src/index.js";
import {
  snapshotContentSha256,
  snapshotIdentitySha256,
} from "../../packages/catalog/src/canonical.js";
import {
  createCatalogTestDatabase,
  quoteCatalogTestSchema,
  type CatalogTestDatabase,
} from "./support/database.js";

const repositoryId = "orders-repository";
const serviceId = "orders-service";
const principalId = "branch-reader";
const branch = "main";
let baseResult: AnalyzerResult;
let database: CatalogTestDatabase;
let catalog: CatalogStore;
let access: AccessPolicyStore;

const request: AnalyzerRequest = {
  exchange_version: "1.0.0",
  ir_version: "1.0.0",
  request_id: "catalog-branches-request",
  analyzer: ANALYZER,
  source: {
    repository_id: repositoryId,
    service_id: serviceId,
    service_root: ".",
    immutable_revision: "a".repeat(40),
    source_digest: "pending",
    access_label: "orders-read",
  },
  resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }],
  prior_dependencies: [],
  changed_paths: [],
  extraction_mode: "baseline",
  limits: { timeout_ms: 30_000, max_files: 100, max_output_bytes: 1_000_000 },
  execution_policy: { network_access: false, side_effects: "none" },
};

const variant = (snapshotId: string, revision: string, overrides: {
  repositoryId?: string;
  serviceId?: string;
} = {}): AnalyzerResult => {
  const result = structuredClone(baseResult);
  result.snapshot_id = snapshotId;
  result.source.repository_id = overrides.repositoryId ?? repositoryId;
  result.source.service_id = overrides.serviceId ?? serviceId;
  result.source.immutable_revision = revision;
  result.evidence = result.evidence.map((evidence) => ({
    ...evidence,
    source_version: revision,
    scope: {
      ...evidence.scope,
      service_id: overrides.serviceId ?? serviceId,
      snapshot_id: snapshotId,
      revision,
    },
  }));
  return result;
};

const seedSnapshot = async (
  tenantId: string,
  result: AnalyzerResult,
  grantPrincipal = principalId,
): Promise<void> => {
  const converted = contractSnapshotFromAnalyzerResult(result, "config-branches");
  for (const scopeId of converted.requiredScopeIds) {
    await access.putScope({ tenantId }, { scopeId, active: true });
    await access.putGrant({ tenantId }, { principalId: grantPrincipal, scopeId, active: true });
  }
  await catalog.ingestAnalyzerResult({ tenantId, result, configFingerprint: "config-branches" });
};

const promotion = (
  tenantId: string,
  snapshotId: string,
  provider: ProviderReference,
  expected?: PromoteBranchInput["expected"],
): PromoteBranchInput => ({
  tenantId,
  repositoryId,
  serviceId,
  branch,
  snapshotId,
  provider,
  ...(expected === undefined ? {} : { expected }),
});

const sequence = (value: string, reference = `delivery-${value.slice(-12)}`): ProviderReference => ({
  provider: "enterprise-cd",
  provider_reference: reference,
  order: { kind: "sequence", value },
});

const pointerRow = async (tenantId: string): Promise<BranchPointer | undefined> => {
  try {
    return (await catalog.resolveBranch(
      { tenantId, principalId },
      { repositoryId, serviceId, branch },
    )).pointer;
  } catch {
    return undefined;
  }
};

beforeAll(async () => {
  baseResult = await createAnalyzer({
    projectRoot: resolve("fixtures/typescript/orders/baseline/src"),
  }).analyze(request);
  expect(["success", "partial"]).toContain(baseResult.status);
});

beforeEach(async () => {
  database = await createCatalogTestDatabase();
  catalog = createCatalogStore(database.pool, { schema: database.schema });
  access = createAccessPolicyStore(database.pool, { schema: database.schema });
});

afterEach(async () => {
  await database.cleanup();
});

describe("catalog branch promotion", () => {
  test("creates version one, preserves exact replay, and accepts D03 provider evidence directly", async () => {
    const tenantId = "tenant-first";
    const first = variant("snapshot-first", "1".repeat(40));
    await seedSnapshot(tenantId, first);
    const event = parseEvent({
      event_version: "1.0.0",
      event_id: "evt-branch-first",
      event_type: "branch.updated",
      producer: { producer_id: "enterprise-cd", adapter_version: "2.1.0" },
      occurred_at: "2026-09-22T08:00:00Z",
      received_at: "2026-09-22T08:00:01Z",
      subjects: { repository_id: repositoryId, service_ids: [serviceId] },
      provider_evidence: sequence("1", "delivery-d03-wire"),
      payload: {
        branch,
        prior_revision: null,
        new_revision: first.source.immutable_revision,
        reference_state: "created",
      },
    });
    if (!event.ok || event.value.event_type !== "branch.updated") throw new Error("invalid event fixture");

    const inserted = await catalog.promoteBranch(promotion(
      tenantId,
      first.snapshot_id,
      event.value.provider_evidence,
    ));
    const replay = await catalog.promoteBranch(promotion(
      tenantId,
      first.snapshot_id,
      event.value.provider_evidence,
    ));

    expect(inserted).toMatchObject({
      outcome: "promoted",
      pointer: {
        pointerVersion: "1",
        snapshotId: first.snapshot_id,
        provider: { provider_reference: "delivery-d03-wire" },
      },
    });
    expect(replay).toEqual({ outcome: "existing", pointer: inserted.pointer });
    const sql = await database.pool.query<{
      provider_reference: string;
      pointer_version: string;
      order_value: string;
    }>(
      `SELECT provider_reference, pointer_version, order_value
       FROM "${database.schema}".catalog_branch_pointers
       WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(sql.rows).toEqual([{
      provider_reference: "delivery-d03-wire",
      pointer_version: "1",
      order_value: "1",
    }]);
  });

  test("rejects missing and mismatched targets without changing the pointer", async () => {
    const tenantId = "tenant-targets";
    const first = variant("snapshot-target-first", "2".repeat(40));
    await seedSnapshot(tenantId, first);
    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("10")));

    const invalidTargets: PromoteBranchInput[] = [
      promotion(tenantId, "missing-target", sequence("11")),
      { ...promotion(tenantId, first.snapshot_id, sequence("11")), serviceId: "billing-service" },
      { ...promotion(tenantId, first.snapshot_id, sequence("11")), repositoryId: "other-repository" },
    ];
    for (const input of invalidTargets) {
      await expect(catalog.promoteBranch(input))
        .rejects.toMatchObject({ code: "BRANCH_TARGET_INELIGIBLE" });
    }
    await expect(catalog.promoteBranch(promotion("other-tenant", first.snapshot_id, sequence("11"))))
      .rejects.toMatchObject({ code: "BRANCH_TARGET_INELIGIBLE" });
    expect(await pointerRow(tenantId)).toMatchObject({ snapshotId: first.snapshot_id, pointerVersion: "1" });
  });

  test("advances canonical sequences and rejects stale and equal-conflicting updates", async () => {
    const tenantId = "tenant-sequence";
    const first = variant("snapshot-sequence-first", "5".repeat(40));
    const second = variant("snapshot-sequence-second", "6".repeat(40));
    await seedSnapshot(tenantId, first);
    await seedSnapshot(tenantId, second);

    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("9")));
    await expect(catalog.promoteBranch(promotion(tenantId, second.snapshot_id, sequence("10"))))
      .resolves.toMatchObject({ outcome: "promoted", pointer: { pointerVersion: "2" } });
    await expect(catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("9"))))
      .rejects.toMatchObject({ code: "BRANCH_POINTER_STALE" });
    await expect(catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("10", "different"))))
      .rejects.toMatchObject({ code: "BRANCH_POINTER_CONFLICT" });
    expect(await pointerRow(tenantId)).toMatchObject({ snapshotId: second.snapshot_id, pointerVersion: "2" });
  });

  test("compares hundreds-of-thousands-digit sequences by length and ASCII suffix", async () => {
    const tenantId = "tenant-huge-sequence";
    const first = variant("snapshot-huge-first", "7".repeat(40));
    const second = variant("snapshot-huge-second", "8".repeat(40));
    await seedSnapshot(tenantId, first);
    await seedSnapshot(tenantId, second);
    const lower = `${"8".repeat(200_000)}1`;
    const sameLengthHigher = `${"8".repeat(200_000)}2`;
    const longer = `1${"0".repeat(200_001)}`;

    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence(lower, "huge-lower")));
    await catalog.promoteBranch(promotion(tenantId, second.snapshot_id, sequence(sameLengthHigher, "huge-suffix")));
    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence(longer, "huge-longer")));
    await expect(catalog.promoteBranch(promotion(
      tenantId,
      second.snapshot_id,
      sequence(sameLengthHigher, "huge-stale"),
    ))).rejects.toMatchObject({ code: "BRANCH_POINTER_STALE" });

    const row = await database.pool.query<{ order_value: string }>(
      `SELECT order_value FROM "${database.schema}".catalog_branch_pointers WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(row.rows[0]?.order_value).toBe(longer);
  }, 30_000);

  test("requires exact CAS for opaque tokens, noncanonical sequences, provider and kind changes", async () => {
    const tenantId = "tenant-cas";
    const first = variant("snapshot-cas-first", "9".repeat(40));
    const second = variant("snapshot-cas-second", "a".repeat(40));
    await seedSnapshot(tenantId, first);
    await seedSnapshot(tenantId, second);

    const cursor = (value: string): ProviderReference => ({
      provider: "enterprise-cd",
      provider_reference: `cursor-${value}`,
      order: { kind: "cursor", value },
    });
    await expect(catalog.promoteBranch(promotion(tenantId, first.snapshot_id, cursor("a"))))
      .rejects.toMatchObject({ code: "BRANCH_POINTER_CONFLICT" });
    await catalog.promoteBranch(promotion(
      tenantId,
      first.snapshot_id,
      cursor("a"),
      { state: "absent" },
    ));
    await expect(catalog.promoteBranch(promotion(tenantId, second.snapshot_id, cursor("b"))))
      .rejects.toMatchObject({ code: "BRANCH_POINTER_CONFLICT" });
    await expect(catalog.promoteBranch(promotion(
      tenantId,
      second.snapshot_id,
      cursor("b"),
      { state: "present", pointerVersion: "1" },
    ))).resolves.toMatchObject({ pointer: { pointerVersion: "2" } });

    const guarded: ProviderReference[] = [
      sequence("09", "noncanonical"),
      { provider: "other-provider", provider_reference: "provider-change", order: { kind: "cursor", value: "c" } },
      { provider: "enterprise-cd", provider_reference: "kind-change", order: { kind: "effective_version", value: "v3" } },
      { provider: "enterprise-cd", provider_reference: "no-order" },
    ];
    let version = 2;
    for (const provider of guarded) {
      await expect(catalog.promoteBranch(promotion(tenantId, first.snapshot_id, provider)))
        .rejects.toMatchObject({ code: "BRANCH_POINTER_CONFLICT" });
      await catalog.promoteBranch(promotion(
        tenantId,
        first.snapshot_id,
        provider,
        { state: "present", pointerVersion: String(version) },
      ));
      version += 1;
    }
    expect(await pointerRow(tenantId)).toMatchObject({ pointerVersion: String(version) });
  });

  test("enforces absent and present expected state and stale pointer versions", async () => {
    const tenantId = "tenant-expected";
    const first = variant("snapshot-expected-first", "b".repeat(40));
    const second = variant("snapshot-expected-second", "c".repeat(40));
    await seedSnapshot(tenantId, first);
    await seedSnapshot(tenantId, second);

    await expect(catalog.promoteBranch(promotion(
      tenantId,
      first.snapshot_id,
      sequence("1"),
      { state: "present", pointerVersion: "1" },
    ))).rejects.toMatchObject({ code: "BRANCH_POINTER_CONFLICT" });
    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("1"), { state: "absent" }));
    await expect(catalog.promoteBranch(promotion(
      tenantId,
      second.snapshot_id,
      sequence("2"),
      { state: "absent" },
    ))).rejects.toMatchObject({ code: "BRANCH_POINTER_CONFLICT" });
    await catalog.promoteBranch(promotion(
      tenantId,
      second.snapshot_id,
      sequence("2"),
      { state: "present", pointerVersion: "1" },
    ));
    await expect(catalog.promoteBranch(promotion(
      tenantId,
      first.snapshot_id,
      sequence("3"),
      { state: "present", pointerVersion: "1" },
    ))).rejects.toMatchObject({ code: "BRANCH_POINTER_CONFLICT" });
    expect(await pointerRow(tenantId)).toMatchObject({ snapshotId: second.snapshot_id, pointerVersion: "2" });
  });

  test("serializes first promotions, monotonic races, and equal-token conflicts", async () => {
    const first = variant("snapshot-race-first", "d".repeat(40));
    const second = variant("snapshot-race-second", "e".repeat(40));
    for (let run = 0; run < 4; run += 1) {
      const tenantId = `tenant-race-${run}`;
      await seedSnapshot(tenantId, first);
      await seedSnapshot(tenantId, second);
      const firstRace = await Promise.allSettled([
        catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("10", "equal-a"))),
        catalog.promoteBranch(promotion(tenantId, second.snapshot_id, sequence("10", "equal-b"))),
      ]);
      expect(firstRace.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(firstRace.filter((value) => value.status === "rejected")).toMatchObject([
        { reason: expect.objectContaining({ code: "BRANCH_POINTER_CONFLICT" }) },
      ]);
      const monotonic = await Promise.allSettled([
        catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("11", "race-11"))),
        catalog.promoteBranch(promotion(tenantId, second.snapshot_id, sequence("12", "race-12"))),
      ]);
      expect(monotonic.some((value) => value.status === "fulfilled")).toBe(true);
      expect(await pointerRow(tenantId)).toMatchObject({
        snapshotId: second.snapshot_id,
        provider: { order: { value: "12" } },
      });
    }
  });

  test("serializes long sequence races across length and suffix boundaries", async () => {
    const tenantId = "tenant-long-race";
    const first = variant("snapshot-long-race-first", "f".repeat(40));
    const second = variant("snapshot-long-race-second", "0".repeat(40));
    await seedSnapshot(tenantId, first);
    await seedSnapshot(tenantId, second);
    const base = `${"7".repeat(120_000)}1`;
    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence(base, "long-base")));
    const suffixHigher = `${"7".repeat(120_000)}2`;
    const lengthHigher = `1${"0".repeat(120_001)}`;
    await Promise.allSettled([
      catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence(suffixHigher, "long-suffix"))),
      catalog.promoteBranch(promotion(tenantId, second.snapshot_id, sequence(lengthHigher, "long-length"))),
    ]);
    expect(await pointerRow(tenantId)).toMatchObject({
      snapshotId: second.snapshot_id,
      provider: { order: { value: lengthHigher } },
    });
  }, 30_000);

  test("rolls back when the database fails after target validation", async () => {
    const tenantId = "tenant-rollback";
    const first = variant("snapshot-rollback-first", "1".repeat(40));
    const second = variant("snapshot-rollback-second", "2".repeat(40));
    await seedSnapshot(tenantId, first);
    await seedSnapshot(tenantId, second);
    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("1")));
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(`
      CREATE FUNCTION ${schema}.catalog_test_reject_pointer()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'forced branch test failure';
      END;
      $$;
      CREATE TRIGGER catalog_test_reject_pointer
      BEFORE UPDATE ON ${schema}.catalog_branch_pointers
      FOR EACH ROW EXECUTE FUNCTION ${schema}.catalog_test_reject_pointer();
    `);

    await expect(catalog.promoteBranch(promotion(tenantId, second.snapshot_id, sequence("2"))))
      .rejects.toMatchObject({ code: "CATALOG_STORAGE_ERROR" });
    await database.pool.query(`DROP TRIGGER catalog_test_reject_pointer ON ${schema}.catalog_branch_pointers`);
    expect(await pointerRow(tenantId)).toMatchObject({ snapshotId: first.snapshot_id, pointerVersion: "1" });
  });

  test("prevalidates hostile input without acquiring a database connection or leaking values", async () => {
    const secret = "provider-reference-secret";
    const hostile = new Proxy({}, { get: () => { throw new Error(secret); } });
    for (const input of [
      promotion("", "snapshot", sequence("1", secret)),
      promotion("tenant", "", sequence("1", secret)),
      promotion("tenant", "snapshot", { provider: "", provider_reference: secret }),
      promotion("tenant", "snapshot", { provider: "provider", provider_reference: "" }),
      promotion("tenant", "snapshot", { provider: "provider", provider_reference: secret, order: { kind: "sequence", value: "" } }),
      promotion("tenant", "snapshot", sequence("2", secret), { state: "present", pointerVersion: "0" }),
      promotion("tenant", "snapshot", sequence("2", secret), { state: "absent", pointerVersion: "1" } as never),
      hostile as never,
    ]) {
      let error: unknown;
      try {
        await catalog.promoteBranch(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "INVALID_CATALOG_INPUT" });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    }
  });
});

describe("catalog branch resolution", () => {
  test("returns pointer and snapshot together and immediately honors current revocation", async () => {
    const tenantId = "tenant-resolution";
    const first = variant("snapshot-resolution", "3".repeat(40));
    await seedSnapshot(tenantId, first);
    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("1")));

    const resolution = await catalog.resolveBranch(
      { tenantId, principalId },
      { repositoryId, serviceId, branch },
    );
    expect(resolution.pointer.snapshotId).toBe(first.snapshot_id);
    expect(resolution.stored.snapshot).toEqual(
      contractSnapshotFromAnalyzerResult(first, "config-branches").snapshot,
    );

    await access.putGrant(
      { tenantId },
      { principalId, scopeId: first.source.access_label, active: false },
    );
    await expect(catalog.resolveBranch(
      { tenantId, principalId },
      { repositoryId, serviceId, branch },
    )).rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
  });

  test("uses one safe result for denied, missing, cross-tenant, and hostile resolution input", async () => {
    const tenantId = "tenant-resolution-denied";
    const first = variant("snapshot-resolution-denied", "4".repeat(40));
    await seedSnapshot(tenantId, first);
    await catalog.promoteBranch(promotion(tenantId, first.snapshot_id, sequence("1")));
    const secret = "secret-branch-or-principal";
    const cases = [
      () => catalog.resolveBranch({ tenantId, principalId: secret }, { repositoryId, serviceId, branch }),
      () => catalog.resolveBranch({ tenantId: "other-tenant", principalId }, { repositoryId, serviceId, branch }),
      () => catalog.resolveBranch({ tenantId, principalId }, { repositoryId, serviceId, branch: secret }),
    ];
    for (const operation of cases) {
      let error: unknown;
      try {
        await operation();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "CATALOG_NOT_FOUND_OR_DENIED",
        message: "Catalog resource was not found or access was denied",
      });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    }
    await expect(catalog.resolveBranch(
      { tenantId: "", principalId },
      { repositoryId, serviceId, branch },
    )).rejects.toMatchObject({ code: "INVALID_CATALOG_INPUT" });
  });

  test("runs the shared full consistency verifier for every resolved document", async () => {
    const tenantId = "tenant-resolution-corrupt";
    await access.putScope({ tenantId }, { scopeId: "orders-read", active: true });
    await access.putGrant({ tenantId }, { principalId, scopeId: "orders-read", active: true });
    const converted = contractSnapshotFromAnalyzerResult(baseResult, "config-corrupt-branch");
    const original = converted.snapshot;
    const schema = quoteCatalogTestSchema(database.schema);
    const zeroDigest = `sha256:${"0".repeat(64)}`;
    const cases: Array<[string, (document: ContractSnapshot) => Partial<Record<string, unknown>>]> = [
      ["repository", () => ({ repository_id: "different-repository" })],
      ["service", () => ({ service_id: "different-service" })],
      ["source repository", (document) => ({ document: {
        ...document,
        source: { ...document.source, repository_id: "different-source-repository" },
      } })],
      ["revision", () => ({ immutable_revision: "different-revision" })],
      ["IR version", () => ({ ir_version: "9.9.9" })],
      ["identity version", () => ({ identity_version: "9.9.9" })],
      ["config", () => ({ config_fingerprint: "different-config" })],
      ["status", () => ({ analyzer_status: original.coverage.status === "complete" ? "partial" : "success" })],
      ["identity digest", () => ({ identity_sha256: zeroDigest })],
      ["content digest", () => ({ content_sha256: zeroDigest })],
      ["document snapshot", (document) => ({ document: {
        ...document,
        snapshot_id: "document-mismatch",
        evidence: document.evidence.map((evidence) => ({
          ...evidence,
          scope: { ...evidence.scope, snapshot_id: "document-mismatch" },
        })),
      } })],
    ];

    for (const [label, change] of cases) {
      const snapshotId = `branch-corrupt-${label.replaceAll(" ", "-")}`;
      const document = structuredClone(original);
      document.snapshot_id = snapshotId;
      document.evidence = document.evidence.map((evidence) => ({
        ...evidence,
        scope: { ...evidence.scope, snapshot_id: snapshotId },
      }));
      const changes = change(document);
      const storedDocument = structuredClone((changes.document ?? document) as ContractSnapshot);
      const values = {
        snapshot_id: snapshotId,
        repository_id: document.service.repository_id,
        service_id: document.service.service_id,
        immutable_revision: document.source.immutable_revision,
        analyzer_status: document.coverage.status === "complete" ? "success" : "partial",
        ir_version: document.ir_version,
        identity_version: document.identity_version,
        config_fingerprint: document.config.config_fingerprint,
        identity_sha256: snapshotIdentitySha256(storedDocument),
        content_sha256: snapshotContentSha256(storedDocument),
        document: storedDocument,
        ...changes,
      };
      await database.pool.query(
        `INSERT INTO ${schema}.catalog_snapshots (
          tenant_id, snapshot_id, repository_id, service_id, immutable_revision,
          analyzer_status, ir_version, identity_version, config_fingerprint,
          identity_sha256, content_sha256, required_scope_ids, document
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          tenantId, values.snapshot_id, values.repository_id, values.service_id,
          values.immutable_revision, values.analyzer_status, values.ir_version,
          values.identity_version, values.config_fingerprint, values.identity_sha256,
          values.content_sha256, ["orders-read"], values.document,
        ],
      );
      const corruptBranch = `corrupt-${label.replaceAll(" ", "-")}`;
      await database.pool.query(
        `INSERT INTO ${schema}.catalog_branch_pointers (
          tenant_id, repository_id, service_id, branch, snapshot_id,
          provider, provider_reference, order_kind, order_value
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tenantId, values.repository_id, values.service_id, corruptBranch, snapshotId,
          "provider-secret", "reference-secret", "sequence", "1",
        ],
      );
      let error: unknown;
      try {
        await catalog.resolveBranch(
          { tenantId, principalId },
          { repositoryId: String(values.repository_id), serviceId: String(values.service_id), branch: corruptBranch },
        );
      } catch (caught) {
        error = caught;
      }
      expect(error, label).toMatchObject({
        code: "CATALOG_STORAGE_ERROR",
        message: "Catalog storage operation failed",
      });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("provider-secret");
    }
  });
});
