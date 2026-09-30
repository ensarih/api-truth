import type { VerifiedGitHubWebhookDelivery } from "./github-webhook.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "closed"]);

export class GitHubEventError extends Error {
  readonly code: "INVALID_CONFIGURATION" | "INVALID_PAYLOAD" | "REPOSITORY_MISMATCH"
    | "UNCONFIGURED_BRANCH" | "UNSUPPORTED_EVENT" | "UNSUPPORTED_ACTION";
  constructor(code: GitHubEventError["code"]) {
    super(code);
    this.name = "GitHubEventError";
    this.code = code;
  }
}

export type GitHubEventHost = Readonly<{
  /** Host-trusted repository identity for this webhook installation. */
  repository: Readonly<{ id: number; fullName: string }>;
  /** Exact branch names, never patterns. */
  intendedBranches: readonly string[];
}>;

export type GitHubReconciliationTrigger = Readonly<{
  kind: "reconciliation_trigger";
  provider: "github";
  repository: Readonly<{ id: number; full_name: string }>;
  deliveryId: string;
  sourceEvent: "push" | "pull_request";
  branch: string;
  action?: "opened" | "synchronize" | "reopened" | "closed";
  pullRequestNumber?: number;
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const branch = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 255 && BRANCH.test(value)
  && !value.includes("..") && !value.includes("//") && !value.endsWith("/")
  && !value.endsWith(".lock") && !value.includes("@{");
const repositoryName = (value: unknown): value is string => typeof value === "string"
  && value.length <= 255 && REPOSITORY_NAME.test(value)
  && !value.includes("..") && !value.includes("//");
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Produces a hint to re-read current provider state; it is not a D08 EventEnvelope. */
export function normalizeVerifiedGitHubEvent(
  verified: VerifiedGitHubWebhookDelivery, host: GitHubEventHost,
): GitHubReconciliationTrigger {
  if (!record(host) || !record(host.repository)
    || !positiveId(host.repository.id) || !repositoryName(host.repository.fullName)
    || !Array.isArray(host.intendedBranches) || host.intendedBranches.length === 0
    || host.intendedBranches.length > 256 || host.intendedBranches.some((name) => !branch(name))
    || new Set(host.intendedBranches).size !== host.intendedBranches.length)
    throw new GitHubEventError("INVALID_CONFIGURATION");
  if (!record(verified) || typeof verified.deliveryId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(verified.deliveryId))
    throw new GitHubEventError("INVALID_PAYLOAD");
  const deliveryId = verified.deliveryId;
  const event = verified.event;
  if (event !== "push" && event !== "pull_request") throw new GitHubEventError("UNSUPPORTED_EVENT");
  const bytes = verified.bodyBytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES)
    throw new GitHubEventError("INVALID_PAYLOAD");
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new GitHubEventError("INVALID_PAYLOAD"); }
  if (!record(payload) || !record(payload.repository)
    || !positiveId(payload.repository.id) || !repositoryName(payload.repository.full_name))
    throw new GitHubEventError("INVALID_PAYLOAD");
  if (payload.repository.id !== host.repository.id
    || payload.repository.full_name !== host.repository.fullName)
    throw new GitHubEventError("REPOSITORY_MISMATCH");
  const repository = Object.freeze({ id: host.repository.id, full_name: host.repository.fullName });
  const common = { kind: "reconciliation_trigger" as const, provider: "github" as const,
    repository, deliveryId };

  if (event === "push") {
    if (Object.hasOwn(payload, "action") || typeof payload.ref !== "string"
      || !payload.ref.startsWith("refs/heads/")) throw new GitHubEventError("INVALID_PAYLOAD");
    const selected = payload.ref.slice("refs/heads/".length);
    if (!branch(selected) || !sha(payload.before) || !sha(payload.after)
      || typeof payload.created !== "boolean" || typeof payload.deleted !== "boolean"
      || typeof payload.forced !== "boolean" || (payload.created && payload.deleted)
      || (payload.created !== (payload.before === ZERO_SHA))
      || (payload.deleted !== (payload.after === ZERO_SHA)))
      throw new GitHubEventError("INVALID_PAYLOAD");
    if (!host.intendedBranches.includes(selected)) throw new GitHubEventError("UNCONFIGURED_BRANCH");
    return Object.freeze({ ...common, sourceEvent: "push" as const, branch: selected });
  }

  if (typeof payload.action !== "string" || !PR_ACTIONS.has(payload.action))
    throw new GitHubEventError("UNSUPPORTED_ACTION");
  if (!positiveId(payload.number) || !record(payload.pull_request)
    || payload.pull_request.number !== payload.number
    || !record(payload.pull_request.base) || !record(payload.pull_request.head))
    throw new GitHubEventError("INVALID_PAYLOAD");
  const base = payload.pull_request.base;
  const head = payload.pull_request.head;
  if (!branch(base.ref) || !sha(base.sha) || base.sha === ZERO_SHA
    || !branch(head.ref) || !sha(head.sha) || head.sha === ZERO_SHA
    || !record(base.repo) || base.repo.id !== repository.id
    || base.repo.full_name !== repository.full_name)
    throw new GitHubEventError("INVALID_PAYLOAD");
  if (!host.intendedBranches.includes(base.ref)) throw new GitHubEventError("UNCONFIGURED_BRANCH");
  return Object.freeze({ ...common, sourceEvent: "pull_request" as const,
    action: payload.action as "opened" | "synchronize" | "reopened" | "closed",
    branch: base.ref, pullRequestNumber: payload.number });
}
