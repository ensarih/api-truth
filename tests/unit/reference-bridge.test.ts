import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createReferenceEventBridge, ReferenceBridgeError } from "../../connectors/reference/src/bridge.js";
import { buildSyntheticReferenceFixture } from "../../connectors/reference/src/fixture.js";

const attested = (fact: Record<string, unknown>, policy: Record<string, unknown>) => {
  const verifiedFactJson = JSON.stringify(fact);
  return { verifiedFactJson, verifiedFactSha256: createHash("sha256").update(verifiedFactJson).digest("hex"),
    context: policy.context, knownArtifacts: policy.knownArtifacts, provider: "github",
    providerReference: fact.provider_reference as string };
};

test("bridge ingests only host-attested bytes, even if raw input mutates during config fetch", async () => {
  const step = buildSyntheticReferenceFixture("main")[3]!;
  const raw = structuredClone(step.fact);
  const calls: unknown[] = [];
  const repository = {
    async getTrustedActiveConfiguration() {
      raw.new_revision = "f".repeat(40);
      return { document: step.policy.configuration };
    },
    async ingestEvent(context: unknown, event: unknown) {
      calls.push({ context, event });
      return { outcome: "accepted" as const, disposition: "scheduled" as const, dispositionCounts: { scheduled: 1 } };
    },
  };
  const bridge = createReferenceEventBridge(repository, { async verify(delivery) {
    return attested(delivery as Record<string, unknown>, step.policy);
  } });
  const result = await bridge.deliver(raw);
  expect(result.outcome).toBe("accepted");
  expect(calls).toHaveLength(1);
  expect((calls[0] as any).event.payload.new_revision).toBe("b".repeat(40));
});

test("bridge rejects changed attestation, provider mismatch, and unknown artifacts before ingestion", async () => {
  const step = buildSyntheticReferenceFixture("main")[4]!;
  let ingested = 0;
  const repository = { async getTrustedActiveConfiguration() { return { document: step.policy.configuration }; },
    async ingestEvent() { ingested++; return { outcome: "accepted" as const, disposition: "no_work" as const, dispositionCounts: {} }; } };
  const badHash = createReferenceEventBridge(repository, { async verify() { return { ...attested(step.fact, step.policy), verifiedFactSha256: "0".repeat(64) }; } });
  await expect(badHash.deliver(step.fact)).rejects.toBeInstanceOf(ReferenceBridgeError);
  const badProvider = createReferenceEventBridge(repository, { async verify() { return { ...attested(step.fact, step.policy), provider: "other" }; } });
  await expect(badProvider.deliver(step.fact)).rejects.toBeInstanceOf(ReferenceBridgeError);
  const unknown = { ...step.fact, artifact_id: "unknown" };
  const badArtifact = createReferenceEventBridge(repository, { async verify() { return attested(unknown, step.policy); } });
  await expect(badArtifact.deliver(unknown)).rejects.toBeInstanceOf(ReferenceBridgeError);
  expect(ingested).toBe(0);
});

test("host verification and active-configuration failures expose only safe bridge codes", async () => {
  const step = buildSyntheticReferenceFixture("main")[3]!;
  const repository = { async getTrustedActiveConfiguration() { return { document: step.policy.configuration }; },
    async ingestEvent() { throw new Error("must not ingest"); } };
  const rejected = createReferenceEventBridge(repository, { async verify() { throw new Error("private verifier marker"); } });
  await expect(rejected.deliver(step.fact)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "UNAUTHORIZED" });
  const unavailable = createReferenceEventBridge({ ...repository,
    async getTrustedActiveConfiguration() { throw new Error("private database marker"); } },
  { async verify() { return attested(step.fact, step.policy); } });
  await expect(unavailable.deliver(step.fact)).rejects.toMatchObject({ code: "TRUST_UNAVAILABLE", message: "TRUST_UNAVAILABLE" });
});
