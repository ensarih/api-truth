import { resolve } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ANALYZER, createAnalyzer } from "../../analyzers/typescript/src/index.js";
import type { AnalyzerRequest, AnalyzerResult, ContractSnapshot } from "../../packages/ir/src/index.js";
import {
  createAccessPolicyStore,
  createCatalogStore,
  contractSnapshotFromAnalyzerResult,
  type AccessPolicyStore,
  type CatalogStore,
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

let result: AnalyzerResult;
let database: CatalogTestDatabase;
let catalog: CatalogStore;
let access: AccessPolicyStore;

const request: AnalyzerRequest = {
  exchange_version: "1.0.0",
  ir_version: "1.0.0",
  request_id: "catalog-access-request",
  analyzer: ANALYZER,
  source: {
    repository_id: "access-repository",
    service_id: "access-service",
    service_root: ".",
    immutable_revision: "b".repeat(40),
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

beforeAll(async () => {
  result = await createAnalyzer({
    projectRoot: resolve("fixtures/typescript/orders/baseline/src"),
  }).analyze(request);
  result = structuredClone(result);
  result.evidence[0]!.access_label = "shared-types-read";
});

beforeEach(async () => {
  database = await createCatalogTestDatabase();
  catalog = createCatalogStore(database.pool, { schema: database.schema });
  access = createAccessPolicyStore(database.pool, { schema: database.schema });
});

afterEach(async () => {
  await database.cleanup();
});

const seed = async (tenantId = "tenant-access"): Promise<void> => {
  for (const scopeId of ["orders-read", "shared-types-read"]) {
    await access.putScope({ tenantId }, { scopeId, active: true });
  }
  await access.putGrant({ tenantId }, { principalId: "one-scope", scopeId: "orders-read", active: true });
  for (const scopeId of ["orders-read", "shared-types-read"]) {
    await access.putGrant({ tenantId }, { principalId: "all-scopes", scopeId, active: true });
  }
  await catalog.ingestAnalyzerResult({ tenantId, result, configFingerprint: "config-access" });
};

const capture = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
};

describe("current catalog authorization", () => {
  test("requires current grants for every required scope", async () => {
    await seed();
    await expect(catalog.getSnapshot(
      { tenantId: "tenant-access", principalId: "one-scope" },
      result.snapshot_id,
    )).rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
    await expect(catalog.getSnapshot(
      { tenantId: "tenant-access", principalId: "all-scopes" },
      result.snapshot_id,
    )).resolves.toMatchObject({ snapshotId: result.snapshot_id });
  });

  test("revocation and scope deactivation immediately deny historical reads", async () => {
    await seed();
    const context = { tenantId: "tenant-access", principalId: "all-scopes" };
    await expect(catalog.getSnapshot(context, result.snapshot_id)).resolves.toBeDefined();

    await access.putGrant(context, {
      principalId: context.principalId,
      scopeId: "shared-types-read",
      active: false,
    });
    await expect(catalog.getSnapshot(context, result.snapshot_id))
      .rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });

    await access.putGrant(context, {
      principalId: context.principalId,
      scopeId: "shared-types-read",
      active: true,
    });
    await access.putScope(context, { scopeId: "shared-types-read", active: false });
    await expect(catalog.getSnapshot(context, result.snapshot_id))
      .rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
  });

  test("fails closed when a required scope definition is missing", async () => {
    await seed();
    const schema = quoteCatalogTestSchema(database.schema);
    await database.pool.query(
      `DELETE FROM ${schema}.principal_scope_grants WHERE tenant_id = $1 AND access_scope_id = $2`,
      ["tenant-access", "shared-types-read"],
    );
    await database.pool.query(
      `DELETE FROM ${schema}.access_scopes WHERE tenant_id = $1 AND access_scope_id = $2`,
      ["tenant-access", "shared-types-read"],
    );
    await expect(catalog.getSnapshot(
      { tenantId: "tenant-access", principalId: "all-scopes" },
      result.snapshot_id,
    )).rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
  });

  test("uses one generic safe result for missing and denied resources", async () => {
    await seed();
    const planted = [
      "scope-secret-shared-types",
      "principal-secret-missing",
      "snapshot-secret-missing",
      "provider-secret-reference",
    ];
    const errors = await Promise.all([
      capture(catalog.getSnapshot({ tenantId: "tenant-access", principalId: "one-scope" }, result.snapshot_id)),
      capture(catalog.getSnapshot({ tenantId: "tenant-access", principalId: planted[1]! }, result.snapshot_id)),
      capture(catalog.getSnapshot({ tenantId: "unknown-tenant", principalId: "all-scopes" }, result.snapshot_id)),
      capture(catalog.getSnapshot({ tenantId: "tenant-access", principalId: "all-scopes" }, planted[2]!)),
    ]);
    for (const error of errors) {
      expect(error).toMatchObject({
        code: "CATALOG_NOT_FOUND_OR_DENIED",
        message: "Catalog resource was not found or access was denied",
      });
      const exposed = `${String(error)} ${JSON.stringify(error)}`;
      for (const secret of planted) expect(exposed).not.toContain(secret);
    }
  });

  test("ignores caller-invented scope assertions", async () => {
    await seed();
    const hostileContext = {
      tenantId: "tenant-access",
      principalId: "one-scope",
      scopeIds: ["orders-read", "shared-types-read"],
    };
    await expect(catalog.getSnapshot(hostileContext, result.snapshot_id))
      .rejects.toMatchObject({ code: "CATALOG_NOT_FOUND_OR_DENIED" });
  });

  test("validates policy mutations and maps unknown grant scopes safely", async () => {
    await expect(access.putGrant(
      { tenantId: "tenant-access" },
      { principalId: "principal-secret", scopeId: "scope-secret", active: true },
    )).rejects.toMatchObject({ code: "UNKNOWN_ACCESS_SCOPE" });

    for (const operation of [
      access.putScope({ tenantId: "" }, { scopeId: "secret", active: true }),
      access.putScope({ tenantId: "tenant" }, { scopeId: "", active: true }),
      catalog.getSnapshot({ tenantId: "", principalId: "secret-principal" }, "snapshot"),
      catalog.getSnapshot({ tenantId: "tenant", principalId: "" }, "snapshot"),
      catalog.getSnapshot({ tenantId: "tenant", principalId: "principal" }, ""),
    ]) {
      const error = await capture(operation);
      expect(error).toMatchObject({ code: "INVALID_CATALOG_INPUT" });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("secret-principal");
    }

    const secret = "hostile-secret-value";
    const hostile = new Proxy({}, { get: () => { throw new Error(secret); } });
    const error = await capture(access.putScope(hostile as never, hostile as never));
    expect(error).toMatchObject({ code: "INVALID_CATALOG_INPUT" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);

    expect(() => createCatalogStore(database.pool, { schema: hostile as never }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CATALOG_INPUT" }));
  });
});

describe("stored row verification", () => {
  test("returns only safe storage failures for corrupted indexed fields, document, digests, status, and scopes", async () => {
    const tenantId = "tenant-corrupt";
    const principalId = "reader-corrupt";
    await access.putScope({ tenantId }, { scopeId: "orders-read", active: true });
    await access.putGrant({ tenantId }, { principalId, scopeId: "orders-read", active: true });
    const converted = contractSnapshotFromAnalyzerResult(result, "config-corrupt");
    const original = converted.snapshot;
    const schema = quoteCatalogTestSchema(database.schema);
    const zeroDigest = `sha256:${"0".repeat(64)}`;
    const cases: Array<[
      string,
      (document: ContractSnapshot) => Partial<Record<string, unknown>>,
    ]> = [
      ["snapshot id", (document) => ({ document: {
        ...document,
        snapshot_id: "different-document-id",
        evidence: document.evidence.map((evidence) => ({
          ...evidence,
          scope: { ...evidence.scope, snapshot_id: "different-document-id" },
        })),
      } })],
      ["repository id", () => ({ repository_id: "different-repository" })],
      ["service id", () => ({ service_id: "different-service" })],
      ["source repository relationship", (document) => ({ document: {
        ...document,
        source: { ...document.source, repository_id: "different-source-repository" },
      } })],
      ["immutable revision", () => ({ immutable_revision: "different-revision" })],
      ["IR version", () => ({ ir_version: "9.9.9" })],
      ["identity version", () => ({ identity_version: "9.9.9" })],
      ["config fingerprint", () => ({ config_fingerprint: "different-config" })],
      ["status versus coverage", () => ({ analyzer_status: "success" })],
      ["identity digest", () => ({ identity_sha256: zeroDigest })],
      ["content digest", () => ({ content_sha256: zeroDigest })],
    ];

    for (const [label, change] of cases) {
      const snapshotId = `corrupt-${label.replaceAll(" ", "-")}`;
      const document: ContractSnapshot = structuredClone(original);
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
        analyzer_status: "partial",
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

      const error = await capture(catalog.getSnapshot({ tenantId, principalId }, snapshotId));
      expect(error, label).toMatchObject({
        code: "CATALOG_STORAGE_ERROR",
        message: "Catalog storage operation failed",
      });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(label);
    }
  });
});
