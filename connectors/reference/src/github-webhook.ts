import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 4096;
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT = /^[a-z][a-z0-9_]{0,63}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

export class GitHubWebhookError extends Error {
  readonly code: "INVALID_CONFIGURATION" | "INVALID_DELIVERY" | "PAYLOAD_TOO_LARGE" | "UNAUTHORIZED"
    | "REPLAYED" | "REPLAY_STORE_UNAVAILABLE";
  constructor(code: GitHubWebhookError["code"]) {
    super(code);
    this.name = "GitHubWebhookError";
    this.code = code;
  }
}

export type GitHubWebhookInput = Readonly<{
  /** Original HTTP entity bytes, before JSON parsing or text decoding. */
  body: unknown;
  signature256: unknown;
  deliveryId: unknown;
  event: unknown;
}>;

export type GitHubWebhookHost = Readonly<{
  /** The secret configured for this particular webhook; never supplied by the HTTP sender. */
  secret: string | Uint8Array;
  maxPayloadBytes: number;
  /** Atomically reject either a repeated ID or a repeated body digest in this webhook's namespace. */
  replay: Readonly<{ claim(deliveryId: string, bodySha256: string): Promise<boolean> }>;
}>;

export type VerifiedGitHubWebhookDelivery = Readonly<{
  deliveryId: string;
  event: string;
  /** Each access returns a copy, so callers cannot mutate the verified bytes. */
  readonly bodyBytes: Buffer;
}>;

/** Verifies transport authenticity only. Event semantics and provider facts remain host responsibilities. */
export async function verifyGitHubWebhookDelivery(
  input: GitHubWebhookInput, host: GitHubWebhookHost,
): Promise<VerifiedGitHubWebhookDelivery> {
  const secret = host.secret;
  const secretBytes = typeof secret === "string" ? Buffer.from(secret, "utf8")
    : secret instanceof Uint8Array ? Buffer.from(secret) : undefined;
  if (!secretBytes || secretBytes.length === 0 || secretBytes.length > MAX_SECRET_BYTES
    || !Number.isSafeInteger(host.maxPayloadBytes) || host.maxPayloadBytes < 1
    || host.maxPayloadBytes > MAX_PAYLOAD_BYTES || typeof host.replay?.claim !== "function")
    throw new GitHubWebhookError("INVALID_CONFIGURATION");
  if (!(input.body instanceof Uint8Array)) throw new GitHubWebhookError("INVALID_DELIVERY");
  if (input.body.byteLength > host.maxPayloadBytes) throw new GitHubWebhookError("PAYLOAD_TOO_LARGE");
  const deliveryId = input.deliveryId;
  const event = input.event;
  if (typeof deliveryId !== "string" || !DELIVERY_ID.test(deliveryId)
    || typeof event !== "string" || !EVENT.test(event))
    throw new GitHubWebhookError("INVALID_DELIVERY");
  if (typeof input.signature256 !== "string") throw new GitHubWebhookError("UNAUTHORIZED");
  const match = SIGNATURE.exec(input.signature256);
  if (!match) throw new GitHubWebhookError("UNAUTHORIZED");

  // Copy first: both the HMAC and returned body refer to this exact snapshot.
  const verifiedBytes = Buffer.from(input.body);
  const calculated = createHmac("sha256", secretBytes).update(verifiedBytes).digest();
  const received = Buffer.from(match[1]!, "hex");
  if (!timingSafeEqual(calculated, received)) throw new GitHubWebhookError("UNAUTHORIZED");

  const bodySha256 = createHash("sha256").update(verifiedBytes).digest("hex");
  let claimed: boolean;
  try { claimed = await host.replay.claim(deliveryId, bodySha256); }
  catch { throw new GitHubWebhookError("REPLAY_STORE_UNAVAILABLE"); }
  if (claimed !== true) throw new GitHubWebhookError("REPLAYED");

  return Object.freeze({
    deliveryId,
    event,
    get bodyBytes() { return Buffer.from(verifiedBytes); },
  });
}
