/** Local, synthetic-only OpenAPI publication demonstration. Requires the isolated test database. */
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import type { ContractSnapshot } from "../packages/ir/src/index.js";

const sourceRoots = [new URL("../packages/", import.meta.url).href,
  new URL("../scripts/", import.meta.url).href,
  new URL("../tests/integration/support/", import.meta.url).href];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")
      && sourceRoots.some((root) => context.parentURL?.startsWith(root))) {
      const target = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (sourceRoots.some((root) => target.href.startsWith(root))) return nextResolve(target.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const [{ snapshotContentSha256, snapshotIdentitySha256 },
  { applyOpenApiMigrations, createOpenApiPublicationStore },
  { createCatalogTestDatabase, quoteCatalogTestSchema }] = await Promise.all([
  import("../packages/catalog/src/canonical.ts"),
  import("../packages/openapi/src/index.ts"),
  import("../tests/integration/support/database.ts"),
]);

const context = { tenantId: "openapi-demo", principalId: "local-reader" };
const selector = { kind: "revision" as const, repositoryId: "commerce", serviceId: "orders",
  snapshotId: "snapshot-orders-rev-b", revision: "rev-b", configFingerprint: "sha256:config-a" };
const key = { kind: "revision" as const, repositoryId: selector.repositoryId,
  serviceId: selector.serviceId, revision: selector.revision };

const fixture = async (): Promise<ContractSnapshot> => {
  const snapshot = JSON.parse(await readFile(new URL("../tests/fixtures/ir/express-snapshot.json", import.meta.url),
    "utf8")) as ContractSnapshot;
  snapshot.endpoints = [snapshot.endpoints[0]!];
  snapshot.schemas = {};
  snapshot.claims = [];
  snapshot.editorial_reviews = [];
  snapshot.export_eligibility = [];
  snapshot.dependencies = [];
  snapshot.coverage = { status: "complete", analyzed_roots: ["src"], diagnostic_ids: [] };
  snapshot.endpoints[0]!.parameters = snapshot.endpoints[0]!.parameters.slice(0, 1);
  snapshot.endpoints[0]!.responses[0]!.content[0]!.schema = { type: "string" };
  snapshot.evidence = snapshot.evidence.filter((item) => item.scope.endpoint_id !== "ep-create");
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-proof", method: "deterministic_analysis",
    limitations: [], scope: { service_id: "orders", snapshot_id: snapshot.snapshot_id, endpoint_id: "ep-get" } });
  snapshot.endpoints[0]!.evidence_ids = ["ev-proof"];
  snapshot.endpoints[0]!.parameters[0]!.presence.evidence_ids = ["ev-proof"];
  snapshot.evidence.push({ ...snapshot.evidence[0]!, evidence_id: "ev-anonymous", method: "deterministic_analysis",
    limitations: [] });
  snapshot.endpoints[0]!.security = { state: "anonymous", evidence_ids: ["ev-anonymous"], alternatives: [] };
  return snapshot;
};

const run = async (): Promise<void> => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOpenApiMigrations(database.pool, { schema: database.schema });
    const schema = quoteCatalogTestSchema(database.schema);
    const scope = "openapi-demo-read";
    await database.pool.query(`INSERT INTO ${schema}.access_scopes(tenant_id,access_scope_id,active)
      VALUES($1,$2,true)`, [context.tenantId, scope]);
    await database.pool.query(`INSERT INTO ${schema}.principal_scope_grants
      (tenant_id,principal_id,access_scope_id,active) VALUES($1,$2,$3,true)`, [context.tenantId,
      context.principalId, scope]);
    const seed = async (snapshot: ContractSnapshot): Promise<void> => {
      await database.pool.query(`INSERT INTO ${schema}.catalog_snapshots(tenant_id,snapshot_id,repository_id,
        service_id,immutable_revision,analyzer_status,ir_version,identity_version,config_fingerprint,
        identity_sha256,content_sha256,required_scope_ids,document)
        VALUES($1,$2,$3,$4,$5,'success',$6,$7,$8,$9,$10,$11,$12::jsonb)`, [context.tenantId,
        snapshot.snapshot_id, snapshot.service.repository_id, snapshot.service.service_id,
        snapshot.source.immutable_revision, snapshot.ir_version, snapshot.identity_version,
        snapshot.config.config_fingerprint, snapshotIdentitySha256(snapshot), snapshotContentSha256(snapshot),
        [scope], JSON.stringify(snapshot)]);
    };
    const snapshot = await fixture();
    await seed(snapshot);
    const store = createOpenApiPublicationStore(database.pool, { schema: database.schema });
    const prepared = await store.prepareRevision(context, selector);
    if (!prepared.publishable) throw new Error("synthetic fixture did not compile strictly");
    const first = await store.publish(context, prepared, { state: "absent" });
    const repeat = await store.publish(context, prepared, { state: "absent" });
    if (repeat.publicationId !== first.publicationId || repeat.pointerVersion !== "1")
      throw new Error("idempotent publication failed");
    const next = structuredClone(snapshot);
    next.snapshot_id = "snapshot-orders-rev-b-corrected";
    next.evidence = next.evidence.map((item) => ({ ...item,
      scope: { ...item.scope, snapshot_id: next.snapshot_id } }));
    await seed(next);
    const nextPrepared = await store.prepareRevision(context, { ...selector, snapshotId: next.snapshot_id });
    if (!nextPrepared.publishable) throw new Error("corrected fixture did not compile strictly");
    let staleRejected = false;
    try { await store.publish(context, nextPrepared, { state: "absent" }); }
    catch (error) { staleRejected = error instanceof Error && "code" in error && error.code === "STALE_POINTER"; }
    if (!staleRejected || (await store.readCurrent(context, key)).publicationId !== first.publicationId)
      throw new Error("stale publication replaced the current artifact");
    const second = await store.publish(context, nextPrepared, { state: "present", pointerVersion: "1" });
    const current = await store.readCurrent(context, key);
    const historical = await store.readPublication(context, first.publicationId);
    if (current.publicationId !== second.publicationId || current.pointerVersion !== "2"
      || !Buffer.from(current.bytes).equals(Buffer.from(nextPrepared.bytes!))
      || historical.publicationId !== first.publicationId)
      throw new Error("publication recovery or historical read failed");
    process.stdout.write(`${JSON.stringify({ outcome: "passed", firstPublicationId: first.publicationId,
      currentPublicationId: current.publicationId, currentContentSha256: current.contentSha256,
      pointerVersion: current.pointerVersion, staleRejected, historicalReadable: true })}\n`);
  } finally { await database.cleanup(); }
};

try { await run(); }
catch (error) {
  process.stderr.write(`OpenAPI local round trip failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}
