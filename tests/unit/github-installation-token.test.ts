import { generateKeyPairSync, sign, verify } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createGitHubCurrentStateReader } from "../../connectors/reference/src/github-current-state.js";
import { createGitHubInstallationTokenResolver, GitHubInstallationTokenError } from "../../connectors/reference/src/github-installation-token.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fixedNow = Date.parse("2026-10-09T12:00:00.000Z");
const jwtPayload = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const appInstallation = () => ({ id: 77, app_id: 91, account: { id: 51, login: "acme", type: "Organization" }, suspended_at: null });
const repositoryInstallation = () => ({ id: 77, app_id: 91, suspended_at: null, account: { id: 51, login: "acme", type: "Organization" } });
const tokenResponse = (extra: Record<string, unknown> = {}) => ({ token: "ghs.synthetic_token", expires_at: new Date(fixedNow + 3_600_000).toISOString(),
  permissions: { contents: "read" }, repository_selection: "selected", ...extra });
const defaultBinding = (transport: typeof fetch) => ({ appId: 91, installationId: 77,
  account: { id: 51, login: "acme", type: "Organization" as const }, repository: { id: 42, fullName: "acme/api" },
  secretRef: "vault/github-app/key-rotation-a", now: () => fixedNow,
  sign: async ({ secretRef, algorithm, signingInput }: { secretRef: string; algorithm: "RS256"; signingInput: Uint8Array }) => {
    expect(secretRef).toBe("vault/github-app/key-rotation-a");
    expect(algorithm).toBe("RS256");
    return sign("RSA-SHA256", signingInput, privateKey.privateKey);
  }, fetch: transport, timeoutMs: 1_000, maxResponseBytes: 16_384 });

test("mints a short-lived RS256 app JWT and requests exactly one repository with contents read", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init: init! });
    expect(url.startsWith("https://api.github.com/")).toBe(true);
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>)["X-GitHub-Api-Version"]).toBe("2026-03-10");
    const bearer = (init?.headers as Record<string, string>).Authorization!;
    const jwt = bearer.slice("Bearer ".length);
    const [head, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), privateKey.publicKey,
      Buffer.from(signature!, "base64url"))).toBe(true);
    expect(jwtPayload(jwt)).toEqual({ iat: Math.floor(fixedNow / 1000) - 60,
      exp: Math.floor(fixedNow / 1000) + 9 * 60, iss: 91 });
    if (url.endsWith("/app/installations/77")) return response(appInstallation());
    if (url.endsWith("/repos/acme/api/installation")) return response(repositoryInstallation());
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [42], permissions: { contents: "read" } });
    return response(tokenResponse(), 201); // Current API example may omit `repositories`; the request itself is scoped.
  }) as typeof fetch;
  const resolver = createGitHubInstallationTokenResolver(defaultBinding(transport));
  await expect(resolver()).resolves.toBe("ghs.synthetic_token");
  expect(calls.map(call => call.url)).toEqual(["https://api.github.com/app/installations/77",
    "https://api.github.com/repos/acme/api/installation", "https://api.github.com/app/installations/77/access_tokens"]);
  expect(JSON.stringify(calls)).not.toContain("synthetic_token");
  await expect(resolver()).resolves.toBe("ghs.synthetic_token");
  expect(transport).toHaveBeenCalledTimes(6); // A new token flow runs per call; no token cache is kept.
});

test.each([
  ["wrong app", { app_id: 99 }],
  ["wrong installation", { id: 78 }],
  ["wrong account", { account: { id: 52, login: "acme", type: "Organization" } }],
  ["suspended", { suspended_at: "2026-10-01T00:00:00Z" }],
] as const)("refuses installation binding mismatch: %s", async (_label, override) => {
  const fetchImpl = vi.fn(async () => response({ ...appInstallation(), ...override })) as typeof fetch;
  await expect(createGitHubInstallationTokenResolver(defaultBinding(fetchImpl))())
    .rejects.toMatchObject({ code: "GITHUB_INSTALLATION_TOKEN_UNAVAILABLE" });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test("refuses a repository mapped to a different installation before minting", async () => {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes("/repos/")
    ? response({ ...repositoryInstallation(), id: 78 }) : response(appInstallation())) as typeof fetch;
  await expect(createGitHubInstallationTokenResolver(defaultBinding(fetchImpl))())
    .rejects.toMatchObject({ code: "GITHUB_INSTALLATION_TOKEN_UNAVAILABLE" });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test.each([
  ["all-repository response", { repository_selection: "all" }],
  ["write permission", { permissions: { contents: "write" } }],
  ["extra permission", { permissions: { contents: "read", issues: "read" } }],
  ["wrong listed repository", { repositories: [{ id: 43, full_name: "acme/other" }] }],
  ["multiple listed repositories", { repositories: [{ id: 42, full_name: "acme/api" }, { id: 43, full_name: "acme/other" }] }],
  ["expired token", { expires_at: new Date(fixedNow - 1).toISOString() }],
  ["too-long token", { expires_at: new Date(fixedNow + 62 * 60_000).toISOString() }],
] as const)("rejects an unsafe token response: %s", async (_label, override) => {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/app/installations/77")) return response(appInstallation());
    if (url.endsWith("/repos/acme/api/installation")) return response(repositoryInstallation());
    return response(tokenResponse(override), 201);
  }) as typeof fetch;
  await expect(createGitHubInstallationTokenResolver(defaultBinding(fetchImpl))())
    .rejects.toMatchObject({ code: "GITHUB_INSTALLATION_TOKEN_UNAVAILABLE" });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

test("binding is detached and callback cannot choose app, installation, repository, or secret", async () => {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/app/installations/77")
    ? response(appInstallation()) : String(input).includes("/repos/") ? response(repositoryInstallation()) : response(tokenResponse(), 201)) as typeof fetch;
  const binding = defaultBinding(fetchImpl);
  const resolver = createGitHubInstallationTokenResolver(binding);
  binding.repository.id = 43;
  binding.secretRef = "attacker-controlled";
  await expect(resolver()).resolves.toBe("ghs.synthetic_token");
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

test("malformed and hostile binding inputs fail before signing or network", async () => {
  const fetchImpl = vi.fn(async () => response(appInstallation())) as typeof fetch;
  const base = defaultBinding(fetchImpl);
  const sign = vi.fn(base.sign);
  const accessor = { ...base, get appId() { throw new Error("PRIVATE_BINDING_CANARY"); } };
  expect(() => createGitHubInstallationTokenResolver(accessor as never)).toThrow("GITHUB_INSTALLATION_TOKEN_INVALID_CONFIGURATION");
  expect(() => createGitHubInstallationTokenResolver({ ...base, sign: undefined } as never))
    .toThrow("GITHUB_INSTALLATION_TOKEN_INVALID_CONFIGURATION");
  expect(sign).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("total deadline covers a stalled signer and stalled response stream", async () => {
  const fetchImpl = vi.fn(async () => response(appInstallation())) as typeof fetch;
  const stalledSigner = createGitHubInstallationTokenResolver({ ...defaultBinding(fetchImpl), timeoutMs: 5,
    sign: async () => new Promise<Uint8Array>(() => {}) });
  await expect(stalledSigner()).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_TOKEN_TIMEOUT" });
  expect(fetchImpl).not.toHaveBeenCalled();

  const stalledFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() {
    return new Promise<void>(() => {});
  } }), { status: 200 })) as typeof fetch;
  const resolver = createGitHubInstallationTokenResolver({ ...defaultBinding(stalledFetch), timeoutMs: 10 });
  await expect(resolver()).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_TOKEN_TIMEOUT" });
});

test("signer and transport failures never echo signing material, JWTs, tokens, or provider text", async () => {
  const marker = "PRIVATE_KEY_OR_JWT_CANARY";
  const signerFailure = createGitHubInstallationTokenResolver({ ...defaultBinding(vi.fn() as typeof fetch),
    sign: async () => { throw new Error(marker); } });
  await expect(signerFailure()).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_TOKEN_UNAVAILABLE" });
  let signerError: unknown;
  try { await signerFailure(); } catch (error) { signerError = error; }
  expect(String(signerError)).not.toContain(marker);

  const failedTransport = vi.fn(async () => { throw new Error(marker); }) as typeof fetch;
  let transportError: unknown;
  try { await createGitHubInstallationTokenResolver(defaultBinding(failedTransport))(); }
  catch (error) { transportError = error; }
  expect(transportError).toMatchObject({ code: "GITHUB_INSTALLATION_TOKEN_UNAVAILABLE" });
  expect(String(transportError)).not.toContain(marker);
  expect(failedTransport).toHaveBeenCalledOnce();
});

test("oversized, duplicate-key and redirect responses fail with fixed errors", async () => {
  const responses = [
    new Response(`{"id":77,"app_id":91,"account":{"id":51,"login":"acme","type":"Organization"},"suspended_at":null,"x":"${"X".repeat(20_000)}"}`, { status: 200 }),
    new Response('{"id":77,"id":78}', { status: 200 }),
    new Response(null, { status: 302, headers: { location: "https://example.invalid/" } }),
  ];
  for (const bad of responses) {
    const fetchImpl = vi.fn(async () => bad) as typeof fetch;
    try {
      await createGitHubInstallationTokenResolver(defaultBinding(fetchImpl))();
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubInstallationTokenError);
      expect(String(error)).not.toContain("XXXXX");
      expect(String(error)).not.toContain("example.invalid");
    }
  }
});

test("installation token resolver composes with the exact branch reader without exposing credentials", async () => {
  const calls: string[] = [];
  const token = "ghs.composed_token";
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/app/installations/77")) return response(appInstallation());
    if (url.endsWith("/repos/acme/api/installation")) return response(repositoryInstallation());
    if (url.endsWith("/app/installations/77/access_tokens")) return response(tokenResponse({ token }), 201);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    return url.endsWith("/repos/acme/api") ? response({ id: 42, full_name: "acme/api" })
      : response({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } });
  }) as typeof fetch;
  const resolver = createGitHubInstallationTokenResolver(defaultBinding(fetchImpl));
  const reader = createGitHubCurrentStateReader({ tenantId: "tenant", repositoryId: "repo", githubRepositoryId: 42,
    fullName: "acme/api", intendedBranches: ["main"], resolveToken: resolver, fetch: fetchImpl });
  const result = await reader.readExactBranch({ tenantId: "tenant", repositoryId: "repo", branch: "main" });
  expect(result).toMatchObject({ state: "present", immutableRevision: "a".repeat(40) });
  expect(calls).toEqual(["https://api.github.com/app/installations/77", "https://api.github.com/repos/acme/api/installation",
    "https://api.github.com/app/installations/77/access_tokens", "https://api.github.com/repos/acme/api",
    "https://api.github.com/repos/acme/api/git/ref/heads/main"]);
  expect(JSON.stringify(result)).not.toContain(token);
});


test.each([
  ["different app", {app_id: 92}],
  ["newly suspended", {suspended_at: "2026-10-09T12:00:00Z"}],
])("rechecks repository installation state before minting: %s",async(_label,override)=>{
  const transport=vi.fn(async(input:string|URL|Request)=>String(input).includes("/repos/")
    ?response({...repositoryInstallation(),...override}):response(appInstallation())) as typeof fetch;
  await expect(createGitHubInstallationTokenResolver(defaultBinding(transport))())
    .rejects.toMatchObject({code:"GITHUB_INSTALLATION_TOKEN_UNAVAILABLE"});
  expect(transport).toHaveBeenCalledTimes(2);
});

test("an invalid final clock cannot bypass token expiry validation",async()=>{
  const transport=vi.fn(async(input:string|URL|Request)=>{
    const url=String(input);
    if(url.endsWith("/app/installations/77"))return response(appInstallation());
    if(url.includes("/repos/"))return response(repositoryInstallation());
    return response(tokenResponse(),201);
  }) as typeof fetch;
  const now=vi.fn().mockReturnValueOnce(fixedNow).mockReturnValue(Number.NaN);
  await expect(createGitHubInstallationTokenResolver({...defaultBinding(transport),now})())
    .rejects.toMatchObject({code:"GITHUB_INSTALLATION_TOKEN_UNAVAILABLE"});
});
