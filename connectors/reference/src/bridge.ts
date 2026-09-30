import { createHash } from "node:crypto";
import { parseAuthenticatedEventContext, type EventReceipt } from "../../../packages/orchestration/src/index.js";
import { detachReferenceJson, normalizeLocalFact, ReferenceAdapterError } from "./adapter.js";

export class ReferenceBridgeError extends Error {
  readonly code: "INVALID_ATTESTATION" | "UNAUTHORIZED" | "UNKNOWN_ARTIFACT" | "TRUST_UNAVAILABLE";
  constructor(code: ReferenceBridgeError["code"]) {
    super(code);
    this.name = "ReferenceBridgeError";
    this.code = code;
  }
}

export type VerifiedReferenceDelivery = Readonly<{
  /** Canonical JSON bytes already authenticated by the host, covering every fact field. */
  verifiedFactJson: string;
  verifiedFactSha256: string;
  context: unknown;
  knownArtifacts: unknown;
  provider: string;
  providerReference: string;
}>;
export type TrustedReferenceHost = Readonly<{
  verify(rawDelivery: unknown): Promise<VerifiedReferenceDelivery>;
}>;
export type ReferenceIngestionPort = Readonly<{
  getTrustedActiveConfiguration(tenantId: unknown): Promise<{ document: unknown }>;
  ingestEvent(context: unknown, event: unknown): Promise<EventReceipt>;
}>;

/** The host authenticates the full delivery; D08 owns active configuration, authorization, and durable ingest. */
export const createReferenceEventBridge = (repository: ReferenceIngestionPort, host: TrustedReferenceHost) => Object.freeze({
  async deliver(rawDelivery: unknown): Promise<EventReceipt> {
    let verifiedInput: unknown;
    try { verifiedInput = detachReferenceJson(await host.verify(rawDelivery)); }
    catch { throw new ReferenceBridgeError("UNAUTHORIZED"); }
    if (verifiedInput === null || typeof verifiedInput !== "object" || Array.isArray(verifiedInput))
      throw new ReferenceBridgeError("INVALID_ATTESTATION");
    const requiredKeys = ["verifiedFactJson", "verifiedFactSha256", "context", "knownArtifacts", "provider", "providerReference"];
    if (Object.keys(verifiedInput).length !== requiredKeys.length
      || requiredKeys.some((key) => !Object.hasOwn(verifiedInput, key)))
      throw new ReferenceBridgeError("INVALID_ATTESTATION");
    const verified = verifiedInput as VerifiedReferenceDelivery;
    if (typeof verified.verifiedFactJson !== "string"
      || Buffer.byteLength(verified.verifiedFactJson) > 64 * 1024
      || typeof verified.verifiedFactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(verified.verifiedFactSha256)
      || typeof verified.provider !== "string" || verified.provider.length === 0 || verified.provider.length > 512
      || typeof verified.providerReference !== "string" || verified.providerReference.length === 0
      || verified.providerReference.length > 512) throw new ReferenceBridgeError("INVALID_ATTESTATION");
    const digest = createHash("sha256").update(verified.verifiedFactJson).digest("hex");
    if (digest !== verified.verifiedFactSha256) throw new ReferenceBridgeError("INVALID_ATTESTATION");
    let fact: unknown;
    try { fact = JSON.parse(verified.verifiedFactJson); } catch { throw new ReferenceBridgeError("INVALID_ATTESTATION"); }
    if (JSON.stringify(fact) !== verified.verifiedFactJson) throw new ReferenceBridgeError("INVALID_ATTESTATION");
    const parsedContext = parseAuthenticatedEventContext(verified.context);
    if (!parsedContext.ok || !parsedContext.value.capabilities.includes("event.ingest"))
      throw new ReferenceBridgeError("UNAUTHORIZED");
    let active: { document: unknown };
    try { active = await repository.getTrustedActiveConfiguration(parsedContext.value.tenantId); }
    catch { throw new ReferenceBridgeError("TRUST_UNAVAILABLE"); }
    let event;
    try {
      event = normalizeLocalFact(fact, { configuration: active.document, context: parsedContext.value,
        knownArtifacts: verified.knownArtifacts });
    } catch (error) {
      if (error instanceof ReferenceAdapterError && error.code === "UNKNOWN_ARTIFACT")
        throw new ReferenceBridgeError("UNKNOWN_ARTIFACT");
      throw new ReferenceBridgeError("UNAUTHORIZED");
    }
    if (event.provider_evidence.provider !== verified.provider
      || event.provider_evidence.provider_reference !== verified.providerReference)
      throw new ReferenceBridgeError("INVALID_ATTESTATION");
    return repository.ingestEvent(parsedContext.value, event);
  },
});
