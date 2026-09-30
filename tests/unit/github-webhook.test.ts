import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { GitHubWebhookError, verifyGitHubWebhookDelivery } from "../../connectors/reference/src/github-webhook.js";

const secret = "It's a Secret to Everybody";
const deliveryId = "01234567-89ab-cdef-0123-456789abcdef";
const body = Buffer.from("Hello, World!", "utf8");
const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
const fresh = () => {
  const ids = new Set<string>();
  const bodies = new Set<string>();
  return { async claim(id: string, bodySha256: string) {
    expect(bodySha256).toMatch(/^[0-9a-f]{64}$/);
    if (ids.has(id) || bodies.has(bodySha256)) return false;
    ids.add(id); bodies.add(bodySha256); return true;
  } };
};
const input = (overrides: Record<string, unknown> = {}) => ({ body, signature256: signature, deliveryId, event: "push", ...overrides });
const host = (overrides: Record<string, unknown> = {}) => ({ secret, maxPayloadBytes: 1024, replay: fresh(), ...overrides });

test("accepts GitHub's published HMAC vector and returns isolated verified bytes", async () => {
  const raw = Buffer.from(body);
  const result = await verifyGitHubWebhookDelivery(input({ body: raw }), host());
  expect(result.deliveryId).toBe(deliveryId);
  expect(result.event).toBe("push");
  expect(result.bodyBytes).toEqual(body);
  raw[0] = 0;
  const exposed = result.bodyBytes;
  exposed[0] = 0;
  expect(result.bodyBytes).toEqual(body);
  expect(Object.isFrozen(result)).toBe(true);
});

test("signs original bytes, including Unicode, without parsing or reserializing", async () => {
  const unicode = Buffer.from('{"message":"café ☕"}', "utf8");
  const expected = `sha256=${createHmac("sha256", secret).update(unicode).digest("hex")}`;
  const result = await verifyGitHubWebhookDelivery(input({ body: unicode, signature256: expected }), host());
  expect(result.bodyBytes).toEqual(unicode);
  await expect(verifyGitHubWebhookDelivery(input({ body: Buffer.from('{"message":"cafe ☕"}'), signature256: expected }), host()))
    .rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("rejects absent, malformed, and incorrect signatures before replay claim", async () => {
  let claims = 0;
  const replay = { async claim() { claims++; return true; } };
  for (const value of [undefined, "", "sha1=" + "0".repeat(40), "sha256=abc", "sha256=" + "g".repeat(64),
    "sha256=" + "0".repeat(64), [signature], `${signature},${signature}`]) {
    await expect(verifyGitHubWebhookDelivery(input({ signature256: value }), host({ replay })))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
  expect(claims).toBe(0);
});

test("rejects missing or malformed delivery and event headers", async () => {
  for (const overrides of [{ deliveryId: undefined }, { deliveryId: "wrong" }, { deliveryId: `${deliveryId}\nforged` },
    { event: undefined }, { event: "" }, { event: "Push" }, { event: "push\nforged" }]) {
    await expect(verifyGitHubWebhookDelivery(input(overrides), host()))
      .rejects.toMatchObject({ code: "INVALID_DELIVERY" });
  }
});

test("enforces a finite payload limit before hashing or replay claim", async () => {
  let claims = 0;
  const replay = { async claim() { claims++; return true; } };
  await expect(verifyGitHubWebhookDelivery(input({ body: Buffer.alloc(5) }), host({ maxPayloadBytes: 4, replay })))
    .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  for (const value of [0, -1, Infinity, 1.5, 2 ** 30]) {
    await expect(verifyGitHubWebhookDelivery(input(), host({ maxPayloadBytes: value, replay })))
      .rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  }
  expect(claims).toBe(0);
});

test("rejects a replay and maps replay-store failures to a safe error", async () => {
  const replay = fresh();
  await verifyGitHubWebhookDelivery(input(), host({ replay }));
  await expect(verifyGitHubWebhookDelivery(input(), host({ replay })))
    .rejects.toMatchObject({ code: "REPLAYED" });
  await expect(verifyGitHubWebhookDelivery(input({ deliveryId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }), host({ replay })))
    .rejects.toMatchObject({ code: "REPLAYED" });
  await expect(verifyGitHubWebhookDelivery(input(), host({ replay: { async claim() { throw new Error("private database marker"); } } })))
    .rejects.toMatchObject({ code: "REPLAY_STORE_UNAVAILABLE", message: "REPLAY_STORE_UNAVAILABLE" });
});

test("metadata cannot change while the replay claim is pending", async () => {
  const mutable = input();
  const replay = { async claim(id: string) {
    mutable.deliveryId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    mutable.event = "issues";
    expect(id).toBe(deliveryId);
    return true;
  } };
  const result = await verifyGitHubWebhookDelivery(mutable, host({ replay }));
  expect(result.deliveryId).toBe(deliveryId);
  expect(result.event).toBe("push");
});

test("does not leak the secret or raw body through errors", async () => {
  const privateSecret = "very private webhook secret";
  const privateBody = Buffer.from("very private payload");
  try {
    await verifyGitHubWebhookDelivery(input({ body: privateBody, signature256: "bad" }), host({ secret: privateSecret }));
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubWebhookError);
    expect(JSON.stringify(error)).not.toContain(privateSecret);
    expect(String(error)).not.toContain(privateSecret);
    expect(String(error)).not.toContain(privateBody.toString());
  }
});
