import { isProxy } from "node:util/types";
import { parseStrictJson } from "../../../packages/ir/src/strict-json.js";

const ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 65_536;
const MAX_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;
type SignatureInput = Readonly<{ secretRef: string; algorithm: "RS256"; signingInput: Uint8Array }>;

export class GitHubInstallationTokenError extends Error {
  readonly code: "GITHUB_INSTALLATION_TOKEN_INVALID_CONFIGURATION" | "GITHUB_INSTALLATION_TOKEN_UNAVAILABLE"
    | "GITHUB_INSTALLATION_TOKEN_TIMEOUT";
  constructor(code: GitHubInstallationTokenError["code"]) {
    super(code);
    this.name = "GitHubInstallationTokenError";
    this.code = code;
  }
}
const fail = (code: GitHubInstallationTokenError["code"]): never => {
  throw new GitHubInstallationTokenError(code);
};
const invalid = (): never => fail("GITHUB_INSTALLATION_TOKEN_INVALID_CONFIGURATION");
const unavailable = (): never => fail("GITHUB_INSTALLATION_TOKEN_UNAVAILABLE");

function descriptors(input: unknown): Record<string, PropertyDescriptor> | undefined {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
    const values = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some(key => typeof key !== "string")
      || Object.values(values).some(value => !("value" in value) || !value.enumerable)) return undefined;
    return values;
  } catch { return undefined; }
}
const value = (record: Record<string, PropertyDescriptor>, key: string): unknown => record[key]?.value;
const exactKeys = (record: Record<string, PropertyDescriptor>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(record, key))
  && Object.keys(record).every(key => required.includes(key) || optional.includes(key));
const positiveId = (input: unknown): input is number => Number.isSafeInteger(input) && Number(input) > 0;
const smallName = (input: unknown): input is string => typeof input === "string" && input.length > 0
  && input.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input);
const fullName = (input: unknown): input is string => typeof input === "string" && input.length <= 255
  && input.split("/").length === 2 && input.split("/").every(smallName);
const object = (input: unknown): input is JsonRecord => !!input && typeof input === "object" && !Array.isArray(input);

export type GitHubInstallationTokenBinding = Readonly<{
  appId: number;
  installationId: number;
  account: Readonly<{ id: number; login: string; type: "Organization" | "User" }>;
  repository: Readonly<{ id: number; fullName: string }>;
  /** Opaque host-owned secret identifier; never provided by a request or callback result. */
  secretRef: string;
  /** Trusted sign-only key service. It signs this resolver's internally-built RS256 JWT. */
  sign: (input: SignatureInput) => Promise<Uint8Array>;
  /** Injectable for offline tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}>;

/** Creates an uncached, single-repository token resolver. It does not establish host source authorization. */
export function createGitHubInstallationTokenResolver(bindingInput: GitHubInstallationTokenBinding): () => Promise<string> {
  const fields = descriptors(bindingInput) ?? invalid();
  if (!exactKeys(fields, ["appId", "installationId", "account", "repository", "secretRef", "sign"],
    ["fetch", "timeoutMs", "maxResponseBytes", "now"])) invalid();
  const accountFields = descriptors(value(fields, "account")) ?? invalid();
  const repositoryFields = descriptors(value(fields, "repository")) ?? invalid();
  if (!exactKeys(accountFields, ["id", "login", "type"])
    || !exactKeys(repositoryFields, ["id", "fullName"])) invalid();
  const appId = value(fields, "appId"), installationId = value(fields, "installationId");
  const accountId = value(accountFields, "id"), accountLogin = value(accountFields, "login");
  const accountType = value(accountFields, "type"), repositoryId = value(repositoryFields, "id");
  const repositoryFullName = value(repositoryFields, "fullName"), secretRef = value(fields, "secretRef");
  const sign = value(fields, "sign"), transport = value(fields, "fetch") ?? globalThis.fetch;
  const timeoutMs = value(fields, "timeoutMs") ?? 10_000, maxResponseBytes = value(fields, "maxResponseBytes") ?? MAX_RESPONSE_BYTES;
  const now = value(fields, "now") ?? Date.now;
  if (!positiveId(appId) || !positiveId(installationId) || !positiveId(accountId) || !smallName(accountLogin)
    || accountType !== "Organization" && accountType !== "User" || !positiveId(repositoryId)
    || !fullName(repositoryFullName) || typeof secretRef !== "string" || secretRef.length < 1 || secretRef.length > 256
    || !/^[A-Za-z0-9._:/-]+$/.test(secretRef) || typeof sign !== "function" || typeof transport !== "function"
    || !Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(maxResponseBytes) || Number(maxResponseBytes) < 1 || Number(maxResponseBytes) > MAX_RESPONSE_BYTES
    || typeof now !== "function") invalid();
  const fixed = Object.freeze({ appId: appId as number, installationId: installationId as number, account: Object.freeze({
    id: accountId as number, login: accountLogin as string, type: accountType as "Organization" | "User",
  }), repository: Object.freeze({ id: repositoryId as number, fullName: repositoryFullName as string }), secretRef: secretRef as string,
  sign: sign as GitHubInstallationTokenBinding["sign"], fetch: transport as typeof fetch,
  timeoutMs: timeoutMs as number, maxResponseBytes: maxResponseBytes as number,
  now: now as () => number });
  const [owner, repo] = fixed.repository.fullName.split("/");

  return async () => {
    const controller = new AbortController();
    let timedOut = false;
    let rejectDeadline: (error: GitHubInstallationTokenError) => void = () => {};
    const deadlinePromise = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectDeadline(new GitHubInstallationTokenError("GITHUB_INSTALLATION_TOKEN_TIMEOUT"));
    }, fixed.timeoutMs);
    const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadlinePromise]);
    const deadline = Date.now() + fixed.timeoutMs;
    const fixedFailure = (): never => fail(timedOut || Date.now() >= deadline
      ? "GITHUB_INSTALLATION_TOKEN_TIMEOUT" : "GITHUB_INSTALLATION_TOKEN_UNAVAILABLE");
    try {
      const issuedAtMs = fixed.now();
      if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) unavailable();
      const issuedAt = Math.floor(issuedAtMs / 1000) - 60;
      const expiresAt = Math.floor(issuedAtMs / 1000) + 9 * 60;
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: fixed.appId })).toString("base64url");
      const signingText = `${header}.${payload}`;
      let signature: unknown;
      try {
        signature = await bounded(fixed.sign(Object.freeze({ secretRef: fixed.secretRef, algorithm: "RS256",
          signingInput: new Uint8Array(Buffer.from(signingText, "ascii")) })));
      } catch { return fixedFailure(); }
      if (!(signature instanceof Uint8Array) || signature.byteLength < 64 || signature.byteLength > 1024) unavailable();
      const jwt = `${signingText}.${Buffer.from(signature as Uint8Array).toString("base64url")}`;
      const request = async (path: string, method: "GET" | "POST", body?: string): Promise<JsonRecord> => {
        if (timedOut || Date.now() >= deadline) fixedFailure();
        let response: Response | undefined;
        try {
          response = await bounded(fixed.fetch(`${ORIGIN}${path}`, {
            method, redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
            signal: controller.signal,
            headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${jwt}`,
              "X-GitHub-Api-Version": API_VERSION, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            ...(body === undefined ? {} : { body }),
          }));
        } catch { return fixedFailure(); }
        const received = response!;
        const discard = () => { try { if (received.body) void received.body.cancel().catch(() => {}); } catch { /* Fixed error below. */ } };
        if (timedOut || Date.now() >= deadline) { discard(); fixedFailure(); }
        const expectedStatus = method === "POST" ? 201 : 200;
        const bodyStream = received.body;
        if (received.status !== expectedStatus || !bodyStream) { discard(); unavailable(); }
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try { reader = bodyStream!.getReader(); } catch { unavailable(); }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            if (timedOut || Date.now() >= deadline) fixedFailure();
            const { done, value: chunk } = await bounded(reader!.read());
            if (done) break;
            bytes += chunk.byteLength;
            if (bytes > fixed.maxResponseBytes) unavailable();
            chunks.push(chunk);
          }
        } catch (error) {
          if (error instanceof GitHubInstallationTokenError) throw error;
          fixedFailure();
        } finally { void reader!.cancel().catch(() => {}); }
        let parsed: unknown;
        try {
          parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(
            chunks.map(chunk => Buffer.from(chunk)), bytes)), { maxDepth: 24, maxNodes: 4_000 });
        } catch { unavailable(); }
        if (!object(parsed)) unavailable();
        return parsed as JsonRecord;
      };
      const installation = await request(`/app/installations/${fixed.installationId}`, "GET");
      if (installation.id !== fixed.installationId || installation.app_id !== fixed.appId
        || !object(installation.account) || installation.account.id !== fixed.account.id
        || installation.account.login !== fixed.account.login || installation.account.type !== fixed.account.type
        || installation.suspended_at !== null) unavailable();
      const repositoryInstallation = await request(`/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/installation`, "GET");
      if (repositoryInstallation.id !== fixed.installationId || repositoryInstallation.app_id !== fixed.appId
        || repositoryInstallation.suspended_at !== null || !object(repositoryInstallation.account)
        || repositoryInstallation.account.id !== fixed.account.id
        || repositoryInstallation.account.login !== fixed.account.login
        || repositoryInstallation.account.type !== fixed.account.type) unavailable();
      const tokenResult = await request(`/app/installations/${fixed.installationId}/access_tokens`, "POST",
        JSON.stringify({ repository_ids: [fixed.repository.id], permissions: { contents: "read" } }));
      const token = tokenResult.token, expiry = tokenResult.expires_at, permissions = tokenResult.permissions;
      const nowMs = fixed.now();
      const expiryMs = typeof expiry === "string" ? Date.parse(expiry) : NaN;
      if (!Number.isSafeInteger(nowMs) || nowMs < 0
        || typeof token !== "string" || token.length < 1 || token.length > 4096
        || !/^[A-Za-z0-9._-]+$/.test(token) || tokenResult.repository_selection !== "selected"
        || !object(permissions) || permissions.contents !== "read"
        || Object.keys(permissions).some(key => key !== "contents" && key !== "metadata")
        || Object.hasOwn(permissions, "metadata") && permissions.metadata !== "read"
        || !Number.isFinite(expiryMs) || expiryMs <= nowMs || expiryMs > nowMs + 60 * 60_000 + 60_000) unavailable();
      if (Object.hasOwn(tokenResult, "repositories")) {
        const repos = tokenResult.repositories;
        if (!Array.isArray(repos) || repos.length !== 1 || !object(repos[0])
          || repos[0].id !== fixed.repository.id || repos[0].full_name !== fixed.repository.fullName) unavailable();
      }
      return token as string;
    } catch (error) {
      if (error instanceof GitHubInstallationTokenError) throw error;
      return fixedFailure();
    } finally { clearTimeout(timer); }
  };
}
