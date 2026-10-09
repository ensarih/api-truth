import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  ANALYZER_EXCHANGE_VERSION, canonicalJsonStringify, configuredAnalyzerIrVersion, parseAnalyzerRequest,
  type AnalyzerRequest,
} from "../../../packages/ir/src/index.js";
import { createConfiguredAnalyzer, configuredAnalyzerProfiles } from "../../../analyzers/host/src/index.js";
import type { AnalysisWorkerPorts } from "../../../packages/orchestration/src/execution.js";
import { materializeGitSource, type MaterializedGitSource } from "./index.js";

type ResolveInput = Parameters<AnalysisWorkerPorts["resolver"]["resolve"]>[0];
type RepositoryBinding = Readonly<{ tenantId: string; repositoryId: string; repoPath: string }>;
type Limits = Readonly<{ maxFiles: number; maxBytes: number; timeoutMs: number; maxOutputBytes: number; maxSessions?: number }>;
type Session = { tree: MaterializedGitSource; request: AnalyzerRequest; canonical: string;
  host: ReturnType<typeof createConfiguredAnalyzer> };

const MAX_SESSIONS = 8;
const sha256 = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fail = (): never => { throw new Error("Local Git analysis request rejected"); };
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const normalizedProjectPath = (path: string): boolean => path === "."
  || /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(path)
    && !path.split("/").some(part => part === "." || part === "..");
const supportedAdapters = new Set([
  "typescript-express@0.6.0",
  "nodejs-routing-controllers@0.8.0",
  "nodejs-swagger-express-mw@0.33.0",
  "nodejs-swagger2-document@0.15.0",
  "openapi3-document@0.2.0",
]);
const standaloneDocumentAdapters = new Set([
  "nodejs-swagger2-document@0.15.0",
  "openapi3-document@0.2.0",
]);

function boundedLimits(value: Limits): boolean {
  return Number.isSafeInteger(value.maxFiles) && value.maxFiles > 0 && value.maxFiles <= 20_000
    && Number.isSafeInteger(value.maxBytes) && value.maxBytes > 0 && value.maxBytes <= 100_000_000
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 120_000
    && Number.isSafeInteger(value.maxOutputBytes) && value.maxOutputBytes > 0 && value.maxOutputBytes <= 20_000_000
    && (value.maxSessions === undefined || Number.isSafeInteger(value.maxSessions)
      && value.maxSessions > 0 && value.maxSessions <= MAX_SESSIONS);
}

function validateSelection(input: ResolveInput): { expectedInputs: Array<{ kind: "type_manifest"; path: string }>;
  irVersion: "1.0.0" | "1.1.0"; standaloneDocument: boolean } {
  const selection = input.service.analyzer;
  const adapterKey = `${selection.adapter_id}@${selection.adapter_version}`;
  const profile = configuredAnalyzerProfiles.find(item => item.adapter_id === selection.adapter_id
    && item.adapter_version === selection.adapter_version);
  if (!supportedAdapters.has(adapterKey) || profile === undefined) throw new Error("Local Git analysis request rejected");
  if (configuredAnalyzerIrVersion(selection) !== profile.ir_version
    || selection.ir_version !== undefined && selection.ir_version !== profile.ir_version) fail();
  const root = input.service.root;
  const standaloneDocument = standaloneDocumentAdapters.has(adapterKey);
  if (!normalizedProjectPath(root) || root.startsWith("/") || root.includes("\\")) fail();
  const expectedInputs = selection.resolution_inputs ?? [];
  if (expectedInputs.some(item => item.kind !== "type_manifest" || !normalizedProjectPath(item.path)
    || !(root === "." || item.path.startsWith(`${root}/`)))) fail();
  if (selection.production_entrypoint !== undefined
    && (adapterKey !== "nodejs-routing-controllers@0.8.0" || !normalizedProjectPath(selection.production_entrypoint)
      || !(root === "." || selection.production_entrypoint.startsWith(`${root}/`)))) fail();
  if (adapterKey === "typescript-express@0.6.0" && (expectedInputs.length || selection.production_entrypoint)) fail();
  if (adapterKey === "nodejs-routing-controllers@0.8.0" && expectedInputs.length > 1) fail();
  if (adapterKey === "nodejs-routing-controllers@0.8.0" && expectedInputs.some(item => !item.path.endsWith(".json"))) fail();
  if (adapterKey === "nodejs-swagger-express-mw@0.33.0") {
    const expectedDocument = root === "." ? "api/swagger/swagger.yaml" : `${root}/api/swagger/swagger.yaml`;
    if (selection.production_entrypoint !== undefined || expectedInputs.length !== 1
      || expectedInputs[0]?.path !== expectedDocument) fail();
  }
  if (standaloneDocument && (selection.ir_version !== "1.1.0" || selection.production_entrypoint !== undefined
    || expectedInputs.length !== 1)) fail();
  return { expectedInputs: [...expectedInputs], irVersion: profile.ir_version, standaloneDocument };
}

async function manifestDigest(tree: MaterializedGitSource, adapterId: string,
  configured: { kind: "type_manifest"; path: string }): Promise<string> {
  const projectPath = resolve(tree.projectRoot, configured.path);
  if (!inside(tree.projectRoot, projectPath)) fail();
  let bytes: Buffer;
  try { bytes = await readFile(projectPath); } catch { return fail(); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail(); }
  if (adapterId === "nodejs-routing-controllers") {
    const servicePath = resolve(tree.projectRoot, tree.serviceRoot);
    const relativePath = relative(servicePath, projectPath).replaceAll("\\", "/");
    if (!inside(servicePath, projectPath) || !normalizedProjectPath(relativePath)) fail();
    return sha256(`${relativePath}\0${text}`);
  }
  if (adapterId === "nodejs-swagger-express-mw") return sha256(`${configured.path}\0${text}`);
  if (adapterId === "nodejs-swagger2-document" || adapterId === "openapi3-document") {
    return sha256(`${configured.path}\0${text}`);
  }
  return fail();
}

/** Bind the D08 analysis ports to an explicit local-repository allowlist and one-shot immutable source sessions. */
export function createLocalGitAnalysisPorts(options: {
  repositories: readonly RepositoryBinding[];
  limits: Limits;
}): AnalysisWorkerPorts & { dispose(): Promise<void> } {
  if (!Array.isArray(options.repositories) || options.repositories.length < 1 || options.repositories.length > 128
    || !boundedLimits(options.limits)) fail();
  const limits: Limits = Object.freeze({ ...options.limits });
  const bindings = new Map<string, string>();
  for (const binding of options.repositories) {
    if (!binding || typeof binding.tenantId !== "string" || !binding.tenantId
      || typeof binding.repositoryId !== "string" || !binding.repositoryId
      || typeof binding.repoPath !== "string" || !isAbsolute(binding.repoPath)) fail();
    const key = `${binding.tenantId}\0${binding.repositoryId}`;
    if (bindings.has(key)) fail();
    bindings.set(key, binding.repoPath);
  }
  const maxSessions = limits.maxSessions ?? MAX_SESSIONS;
  const sessions = new Map<string, Session>();
  const pendingCleanup = new Map<string, MaterializedGitSource>();
  const inProgressRequests = new Set<string>();
  const activeRequestIds = new Set<string>();
  let reservations = 0;
  let reservationsDrained: Promise<void> | undefined;
  let signalReservationsDrained: (() => void) | undefined;
  let activeAnalyses = 0;
  let analysesDrained: Promise<void> | undefined;
  let signalAnalysesDrained: (() => void) | undefined;
  let disposed = false;
  const cleanup = async (requestId: string, tree: MaterializedGitSource) => {
    pendingCleanup.set(requestId, tree);
    try {
      await tree.dispose();
      pendingCleanup.delete(requestId);
    } catch {
      throw fail();
    }
  };

  const ports: AnalysisWorkerPorts & { dispose(): Promise<void> } = {
    resolver: {
      async resolve(rawInput) {
        if (disposed || reservations + sessions.size + activeAnalyses + pendingCleanup.size >= maxSessions) return fail();
        const key = `${rawInput.tenantId}\0${rawInput.repository.repository_id}`;
        const repoPath = bindings.get(key);
        if (!repoPath || rawInput.tenantId.length > 256 || rawInput.repository.repository_id.length > 256
          || !/^[a-f0-9]{40}$/i.test(rawInput.immutableRevision)
          || rawInput.baseRevision !== undefined && !/^[a-f0-9]{40}$/i.test(rawInput.baseRevision)
          || typeof rawInput.configFingerprint !== "string" || rawInput.configFingerprint.length < 1
          || rawInput.configFingerprint.length > 512) return fail();
        const selection = validateSelection(rawInput);
        const requestId = `local-git-${sha256(canonicalJsonStringify({
          tenantId: rawInput.tenantId, repositoryId: rawInput.repository.repository_id,
          serviceId: rawInput.service.service_id, serviceRoot: rawInput.service.root,
          accessScopeId: rawInput.repository.access_scope_id,
          revision: rawInput.immutableRevision.toLowerCase(), baseRevision: rawInput.baseRevision?.toLowerCase() ?? null,
          configFingerprint: rawInput.configFingerprint, analyzer: rawInput.service.analyzer, limits,
        })).slice(7)}`;
        if (sessions.has(requestId) || pendingCleanup.has(requestId)
          || inProgressRequests.has(requestId) || activeRequestIds.has(requestId)) return fail();
        inProgressRequests.add(requestId);
        if (reservations === 0) reservationsDrained = new Promise(resolveDone => { signalReservationsDrained = resolveDone; });
        reservations++;
        let tree: MaterializedGitSource | undefined;
        try {
          tree = await materializeGitSource({ repoPath, revision: rawInput.immutableRevision,
            serviceRoot: rawInput.service.root, limits: { maxFiles: limits.maxFiles, maxBytes: limits.maxBytes } });
          const host = createConfiguredAnalyzer({ projectRoot: tree.projectRoot, selection: rawInput.service.analyzer });
          const source = {
            repository_id: rawInput.repository.repository_id,
            service_id: rawInput.service.service_id,
            service_root: rawInput.service.root,
            immutable_revision: tree.revision,
            source_digest: "pending",
            access_label: rawInput.repository.access_scope_id,
          };
          const resolutionInputs = selection.standaloneDocument
            ? selection.expectedInputs.map(item => ({ ...item, digest: "pending" }))
            : [{ kind: "source_tree" as const, path: rawInput.service.root, digest: "pending" },
              ...selection.expectedInputs.map(item => ({ ...item, digest: "pending" }))];
          const mode = rawInput.baseRevision === undefined ? "baseline" as const : "fallback_full_service" as const;
          const probeRaw = {
            exchange_version: ANALYZER_EXCHANGE_VERSION, ir_version: selection.irVersion, request_id: requestId,
            analyzer: { analyzer_id: rawInput.service.analyzer.adapter_id,
              analyzer_version: rawInput.service.analyzer.adapter_version },
            source, resolution_inputs: resolutionInputs, prior_dependencies: [], changed_paths: [],
            extraction_mode: mode,
            limits: { timeout_ms: limits.timeoutMs, max_files: limits.maxFiles,
              max_output_bytes: limits.maxOutputBytes },
            execution_policy: { network_access: false, side_effects: "none" },
          };
          const probe = parseAnalyzerRequest(probeRaw);
          if (!probe.ok) return fail();
          const probedResult = await host.analyze(probe.value);
          if (!/^sha256:[a-f0-9]{64}$/i.test(probedResult.source.source_digest)) return fail();
          const normalizedInputs: Array<{ kind: "source_tree" | "type_manifest"; path: string; digest: string }> =
            selection.standaloneDocument ? [] : [
              { kind: "source_tree", path: rawInput.service.root, digest: probedResult.source.source_digest },
            ];
          for (const item of selection.expectedInputs) {
            const digest = await manifestDigest(tree, rawInput.service.analyzer.adapter_id, item);
            if (selection.standaloneDocument && digest !== probedResult.source.source_digest) return fail();
            normalizedInputs.push({ kind: "type_manifest", path: item.path, digest });
          }
          const parsed = parseAnalyzerRequest({ ...probe.value, source: { ...probe.value.source,
            source_digest: probedResult.source.source_digest }, resolution_inputs: normalizedInputs });
          if (!parsed.ok) return fail();
          if (disposed) return fail();
          const request = parsed.value;
          const canonical = canonicalJsonStringify(request);
          if (sessions.has(requestId)) return fail();
          sessions.set(requestId, { tree, request, canonical, host });
          tree = undefined;
          return { request, changedPaths: [], changedPathsComplete: false };
        } catch {
          return fail();
        } finally {
          try {
            if (tree) await cleanup(requestId, tree);
          } finally {
            inProgressRequests.delete(requestId);
            reservations--;
            if (reservations === 0) {
              signalReservationsDrained?.();
              reservationsDrained = undefined;
              signalReservationsDrained = undefined;
            }
          }
        }
      },
    },
    analyzer: {
      async analyze(rawRequest) {
        if (disposed) return fail();
        const parsed = parseAnalyzerRequest(rawRequest);
        if (!parsed.ok) return fail();
        const session = sessions.get(parsed.value.request_id);
        if (!session) return fail();
        sessions.delete(parsed.value.request_id);
        activeRequestIds.add(parsed.value.request_id);
        if (activeAnalyses === 0) analysesDrained = new Promise(resolveDone => { signalAnalysesDrained = resolveDone; });
        activeAnalyses++;
        try {
          if (canonicalJsonStringify(parsed.value) !== session.canonical) return fail();
          return await session.host.analyze(session.request);
        } catch {
          return fail();
        } finally {
          try {
            await cleanup(parsed.value.request_id, session.tree);
          } finally {
            activeRequestIds.delete(parsed.value.request_id);
            activeAnalyses--;
            if (activeAnalyses === 0) {
              signalAnalysesDrained?.();
              analysesDrained = undefined;
              signalAnalysesDrained = undefined;
            }
          }
        }
      },
    },
    async dispose() {
      disposed = true;
      if (reservations > 0) await reservationsDrained;
      if (activeAnalyses > 0) await analysesDrained;
      for (const [requestId, session] of sessions) {
        await cleanup(requestId, session.tree);
        sessions.delete(requestId);
      }
      for (const [requestId, tree] of pendingCleanup) await cleanup(requestId, tree);
    },
  };
  return ports;
}
