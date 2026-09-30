import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createReferenceEventBridge, ReferenceBridgeError } from "../../connectors/reference/src/bridge.js";
import { buildSyntheticReferenceFixture } from "../../connectors/reference/src/fixture.js";
import { applyOrchestrationMigrations, createOrchestrationRepository } from "../../packages/orchestration/src/index.js";
import { createCatalogTestDatabase, quoteCatalogTestSchema } from "./support/database.js";

const admin = { tenantId: "synthetic", principalId: "admin", capabilities: ["configuration.admin", "orchestration.status.read"] };

test("trusted local bridge uses D08 ledger for duplicate and stale facts and rejects unknown artifacts", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const steps = buildSyntheticReferenceFixture("main");
    const configuration = steps[0]!.policy.configuration;
    await repository.registerConfiguration(admin, { fingerprint: "reference-config", document: configuration });
    await repository.activateInitialConfiguration(admin, { fingerprint: "reference-config" });
    const branch = steps[3]!;
    const stale = { ...branch.fact, event_id: "synthetic-stale", provider_reference: "synthetic-stale-delivery",
      sequence: "3", new_revision: "c".repeat(40) };
    const unknownArtifact = { ...steps[4]!.fact, event_id: "synthetic-unknown-artifact", artifact_id: "missing" };
    const deliveries = new Map<string, { fact: Record<string, unknown>; policy: Record<string, unknown>; provider: string }>([
      ["branch", { fact: branch.fact, policy: branch.policy, provider: "github" }],
      ["stale", { fact: stale, policy: branch.policy, provider: "github" }],
      ["unknown", { fact: unknownArtifact, policy: steps[4]!.policy, provider: "github" }],
      ["forged", { fact: branch.fact, policy: branch.policy, provider: "other" }],
    ]);
    const bridge = createReferenceEventBridge(repository, {
      async verify(raw) {
        const selected = deliveries.get(raw as string);
        if (!selected) throw new Error("unverified delivery");
        const verifiedFactJson = JSON.stringify(selected.fact);
        return { verifiedFactJson, verifiedFactSha256: createHash("sha256").update(verifiedFactJson).digest("hex"),
          context: selected.policy.context, knownArtifacts: selected.policy.knownArtifacts,
          provider: selected.provider, providerReference: selected.fact.provider_reference as string };
      },
    });
    await expect(bridge.deliver("branch")).resolves.toMatchObject({ outcome: "accepted", disposition: "scheduled" });
    await expect(bridge.deliver("branch")).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(bridge.deliver("stale")).resolves.toMatchObject({ outcome: "accepted", disposition: "ignored_stale" });
    await expect(bridge.deliver("unknown")).rejects.toMatchObject({ code: "UNKNOWN_ARTIFACT" });
    await expect(bridge.deliver("forged")).rejects.toBeInstanceOf(ReferenceBridgeError);
    const schema = quoteCatalogTestSchema(database.schema);
    const count = await database.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${schema}.orchestration_events WHERE tenant_id=$1`, [admin.tenantId]);
    expect(count.rows[0]?.total).toBe("2");
  } finally { await database.cleanup(); }
}, 30_000);

test("synthetic baseline through UAT observation reaches the D08 ledger in order", async () => {
  const database = await createCatalogTestDatabase();
  try {
    await applyOrchestrationMigrations(database.pool, { schema: database.schema });
    const repository = createOrchestrationRepository(database.pool, { schema: database.schema });
    const steps = buildSyntheticReferenceFixture("main");
    await repository.registerConfiguration(admin, { fingerprint: "reference-config", document: steps[0]!.policy.configuration });
    await repository.activateInitialConfiguration(admin, { fingerprint: "reference-config" });
    const bridge = createReferenceEventBridge(repository, {
      async verify(raw) {
        const step = steps.find((candidate) => candidate.fact.event_id === raw);
        if (!step) throw new Error("unverified delivery");
        const verifiedFactJson = JSON.stringify(step.fact);
        return { verifiedFactJson, verifiedFactSha256: createHash("sha256").update(verifiedFactJson).digest("hex"),
          context: step.policy.context, knownArtifacts: step.policy.knownArtifacts,
          provider: "github", providerReference: step.fact.provider_reference as string };
      },
    });
    for (const step of steps) await expect(bridge.deliver(step.fact.event_id)).resolves.toMatchObject({ outcome: "accepted" });
    const schema = quoteCatalogTestSchema(database.schema);
    const count = await database.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${schema}.orchestration_events WHERE tenant_id=$1`, [admin.tenantId]);
    expect(count.rows[0]?.total).toBe("7");
  } finally { await database.cleanup(); }
}, 30_000);
