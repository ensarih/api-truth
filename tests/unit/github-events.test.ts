import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { normalizeVerifiedGitHubEvent, GitHubEventError } from "../../connectors/reference/src/github-events.js";
import { verifyGitHubWebhookDelivery } from "../../connectors/reference/src/github-webhook.js";

const secret = "test-webhook-secret";
const repository = { id: 42, full_name: "acme/orders" };
const host = { repository: { id: 42, fullName: "acme/orders" }, intendedBranches: ["main", "release/v1"] };
const a = "a".repeat(40);
const b = "b".repeat(40);
const zero = "0".repeat(40);
const push = () => ({ repository, ref: "refs/heads/main", before: a, after: b,
  created: false, deleted: false, forced: false });
const pr = () => ({ repository, action: "synchronize", number: 17,
  pull_request: { number: 17, base: { ref: "main", sha: a, repo: repository },
    head: { ref: "feature/one", sha: b, repo: { id: 99, full_name: "fork/orders" } } } });
const delivery = async (event: string, payload: unknown) => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature256 = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return verifyGitHubWebhookDelivery({ body, signature256, deliveryId: "01234567-89ab-cdef-0123-456789abcdef", event },
    { secret, maxPayloadBytes: 1024 * 1024, replay: { async claim() { return true; } } });
};

test("push produces only a bounded reconciliation trigger, with no invented ordering", async () => {
  const result = normalizeVerifiedGitHubEvent(await delivery("push", push()), host);
  expect(result).toEqual({ kind: "reconciliation_trigger", provider: "github", repository,
    deliveryId: "01234567-89ab-cdef-0123-456789abcdef", sourceEvent: "push", branch: "main" });
  expect(JSON.stringify(result)).not.toMatch(/sequence|timestamp|before|after|new_revision/);
  expect(Object.isFrozen(result)).toBe(true);
});

test("push creation and deletion are triggers, not direct branch state", async () => {
  for (const payload of [{ ...push(), created: true, before: zero },
    { ...push(), deleted: true, after: zero }]) {
    expect(normalizeVerifiedGitHubEvent(await delivery("push", payload), host).kind).toBe("reconciliation_trigger");
  }
});

test("pull_request synchronization from a fork triggers reconciliation of configured base", async () => {
  const result = normalizeVerifiedGitHubEvent(await delivery("pull_request", pr()), host);
  expect(result).toEqual({ kind: "reconciliation_trigger", provider: "github", repository,
    deliveryId: "01234567-89ab-cdef-0123-456789abcdef", sourceEvent: "pull_request",
    action: "synchronize", branch: "main", pullRequestNumber: 17 });
});

test("rejects unconfigured branches and tag refs with explicit safe errors", async () => {
  for (const [payload, code] of [
    [{ ...push(), ref: "refs/heads/release/v2" }, "UNCONFIGURED_BRANCH"],
    [{ ...push(), ref: "refs/tags/v1" }, "INVALID_PAYLOAD"],
    [{ ...push(), ref: "refs/heads/release/*" }, "INVALID_PAYLOAD"],
  ] as const) {
    const verified = await delivery("push", payload);
    expect(() => normalizeVerifiedGitHubEvent(verified, host)).toThrowError(code);
  }
});

test("rejects wrong repository locator, malformed SHAs, and conflicting push flags", async () => {
  const bad = [{ ...push(), repository: { id: 43, full_name: "acme/orders" } },
    { ...push(), repository: { id: 42, full_name: "other/orders" } },
    { ...push(), after: "not-a-sha" }, { ...push(), before: "A".repeat(40) },
    { ...push(), deleted: true, after: b }, { ...push(), created: true, before: a },
    { ...push(), created: true, deleted: true }];
  for (const payload of bad) {
    const verified = await delivery("push", payload);
    expect(() => normalizeVerifiedGitHubEvent(verified, host)).toThrow(GitHubEventError);
  }
});

test("rejects unsupported event and PR action, inconsistent PR identity and base repository", async () => {
  const cases: [string, unknown][] = [["issues", { repository }],
    ["pull_request", { ...pr(), action: "labeled" }],
    ["pull_request", { ...pr(), number: 18 }],
    ["pull_request", { ...pr(), pull_request: { ...pr().pull_request, base: { ref: "main", sha: a,
      repo: { id: 99, full_name: "fork/orders" } } } }]];
  for (const [event, payload] of cases) {
    const verified = await delivery(event, payload);
    expect(() => normalizeVerifiedGitHubEvent(verified, host)).toThrow(GitHubEventError);
  }
});

test("PR base branch uses exact configured names and requires valid revision fields", async () => {
  for (const payload of [
    { ...pr(), pull_request: { ...pr().pull_request, base: { ...pr().pull_request.base, ref: "release/v2" } } },
    { ...pr(), pull_request: { ...pr().pull_request, head: { ...pr().pull_request.head, sha: zero } } },
  ]) {
    const verified = await delivery("pull_request", payload);
    expect(() => normalizeVerifiedGitHubEvent(verified, host)).toThrow(GitHubEventError);
  }
});

test("parses only verified bytes and rejects invalid JSON without leaking it", async () => {
  const body = Buffer.from("private malformed {", "utf8");
  const signature256 = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const verified = await verifyGitHubWebhookDelivery({ body, signature256,
    deliveryId: "01234567-89ab-cdef-0123-456789abcdef", event: "push" },
  { secret, maxPayloadBytes: 1024, replay: { async claim() { return true; } } });
  try { normalizeVerifiedGitHubEvent(verified, host); throw new Error("expected rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(GitHubEventError);
    expect(String(error)).not.toContain("private malformed");
  }
});
