import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoots = [
  new URL("../packages/ir/src/", import.meta.url).href,
  new URL("../packages/catalog/src/", import.meta.url).href,
  new URL("../packages/updates/src/", import.meta.url).href,
  new URL("../analyzers/typescript/src/", import.meta.url).href,
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".")
      && specifier.endsWith(".js")
      && sourceRoots.some((root) => context.parentURL?.startsWith(root))
    ) {
      const target = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (sourceRoots.some((root) => target.href.startsWith(root))) {
        return nextResolve(target.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const [irModule, catalogModule, updatesModule, analyzerModule, sourceModule] = await Promise.all([
  import("../packages/ir/src/index.ts"),
  import("../packages/catalog/src/index.ts"),
  import("../packages/updates/src/index.ts"),
  import("../analyzers/typescript/src/index.ts"),
  import("../analyzers/typescript/src/source.ts"),
]);

const { CONFIG_VERSION, IDENTITY_VERSION, parseAnalyzerRequest } = irModule;
const { contractSnapshotFromAnalyzerResult } = catalogModule;
const {
  CONTRACT_CHANGES_OUTPUT_VERSION,
  UpdateError,
  asUpdateError,
  executeUpdate,
  parseContractChangesOutput,
  planUpdate,
} = updatesModule;
const { ANALYZER, createAnalyzer } = analyzerModule;
const { digestSources, readSources } = sourceModule;

const requiredArguments = [
  "--base-source",
  "--changed-source",
  "--service",
  "--base-revision",
  "--changed-revision",
] as const;
const allowedArguments = new Set<string>(requiredArguments);
const canonicalDigest = /^sha256:[a-f0-9]{64}$/;
const immutableRevision = /^[a-fA-F0-9]{12,128}$/;
const configFingerprint = "contract-changes-cli-v1";

type Arguments = {
  baseSource: string;
  changedSource: string;
  serviceId: string;
  baseRevision: string;
  changedRevision: string;
};

type Output = {
  stdout(value: string): void;
  stderr(value: string): void;
};

type SourceInventory = {
  projectRoot: string;
  sourceRoot: string;
  digest: string;
  files: ReadonlyMap<string, string>;
};

const invalidInput = (): never => {
  throw new UpdateError("INVALID_UPDATE_INPUT");
};

const parseArguments = (args: readonly string[]): Arguments => {
  if (args.length !== requiredArguments.length * 2) return invalidInput();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined
      || value === undefined
      || !allowedArguments.has(name)
      || values.has(name)
      || value.length === 0
      || value.startsWith("--")
    ) return invalidInput();
    values.set(name, value);
  }
  if (!requiredArguments.every((name) => values.has(name))) return invalidInput();
  const serviceId = values.get("--service")!;
  const baseRevision = values.get("--base-revision")!;
  const changedRevision = values.get("--changed-revision")!;
  if (serviceId.trim() !== serviceId || serviceId.length === 0
    || !immutableRevision.test(baseRevision) || !immutableRevision.test(changedRevision)) {
    return invalidInput();
  }
  return {
    baseSource: values.get("--base-source")!,
    changedSource: values.get("--changed-source")!,
    serviceId,
    baseRevision,
    changedRevision,
  };
};

const sourceInventory = async (candidate: string): Promise<SourceInventory> => {
  try {
    const projectRoot = resolve(candidate);
    const rootStat = await lstat(projectRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return invalidInput();
    const started = Date.now();
    const loaded = await readSources(projectRoot, ".", 1_000, () => {
      if (Date.now() - started > 30_000) return invalidInput();
    });
    const digest = digestSources(loaded.files, loaded.root);
    if (!canonicalDigest.test(digest)) return invalidInput();
    return { projectRoot, sourceRoot: loaded.root, digest, files: loaded.files };
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return invalidInput();
  }
};

const utf8Compare = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const relativeFiles = (inventory: SourceInventory): Map<string, string> => new Map(
  [...inventory.files.entries()].map(([path, contents]) => [
    relative(inventory.sourceRoot, path).replaceAll("\\", "/"),
    contents,
  ]),
);

const changedPaths = (base: SourceInventory, target: SourceInventory): string[] => {
  const baseFiles = relativeFiles(base);
  const targetFiles = relativeFiles(target);
  return [...new Set([...baseFiles.keys(), ...targetFiles.keys()])]
    .filter((path) => baseFiles.get(path) !== targetFiles.get(path))
    .sort(utf8Compare);
};

const deterministicId = (kind: "base" | "target", values: Record<string, string>): string => {
  const content = JSON.stringify({ kind, ...values });
  return `contract-changes-${kind}-${createHash("sha256").update(content).digest("hex")}`;
};

const analyzerRequest = (input: {
  kind: "base" | "target";
  serviceId: string;
  revision: string;
  digest: string;
  paths: string[];
}) => {
  const candidate = {
    exchange_version: "1.0.0",
    ir_version: "1.0.0",
    request_id: deterministicId(input.kind, {
      service_id: input.serviceId,
      revision: input.revision,
      digest: input.digest,
      changed_paths: JSON.stringify(input.paths),
    }),
    analyzer: ANALYZER,
    source: {
      repository_id: "local",
      service_id: input.serviceId,
      service_root: ".",
      immutable_revision: input.revision,
      source_digest: input.digest,
      access_label: "local",
    },
    resolution_inputs: [{ kind: "source_tree", path: ".", digest: input.digest }],
    prior_dependencies: [],
    changed_paths: input.paths,
    extraction_mode: input.kind === "base" ? "baseline" : "fallback_full_service",
    limits: { timeout_ms: 30_000, max_files: 1_000, max_output_bytes: 10_000_000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
  const parsed = parseAnalyzerRequest(candidate);
  if (!parsed.ok) return invalidInput();
  return parsed.value;
};

const analysisKey = (snapshot: ReturnType<typeof contractSnapshotFromAnalyzerResult>["snapshot"]) => ({
  analyzer: snapshot.analyzer,
  analyzer_exchange_version: "1.0.0",
  ir_version: snapshot.ir_version,
  identity_version: snapshot.identity_version,
  config_version: snapshot.config.config_version,
  config_fingerprint: snapshot.config.config_fingerprint,
});

const snapshotSummary = (snapshot: ReturnType<typeof contractSnapshotFromAnalyzerResult>["snapshot"]) => ({
  snapshot_id: snapshot.snapshot_id,
  immutable_revision: snapshot.source.immutable_revision,
  analyzer: snapshot.analyzer,
  ir_version: snapshot.ir_version,
  identity_version: snapshot.identity_version,
  config_version: snapshot.config.config_version,
  coverage_status: snapshot.coverage.status,
});

export const executeContractChanges = async (rawArguments: readonly string[]) => {
  const args = parseArguments(rawArguments);
  const [baseInventory, targetInventory] = await Promise.all([
    sourceInventory(args.baseSource),
    sourceInventory(args.changedSource),
  ]);
  const paths = changedPaths(baseInventory, targetInventory);
  const baseRequest = analyzerRequest({
    kind: "base",
    serviceId: args.serviceId,
    revision: args.baseRevision,
    digest: baseInventory.digest,
    paths: [],
  });
  const baseResult = await createAnalyzer({ projectRoot: baseInventory.projectRoot }).analyze(baseRequest);
  const baseSnapshot = contractSnapshotFromAnalyzerResult(baseResult, configFingerprint).snapshot;
  const baseKey = analysisKey(baseSnapshot);
  if (baseKey.identity_version !== IDENTITY_VERSION || baseKey.config_version !== CONFIG_VERSION) {
    return invalidInput();
  }
  const targetKey = { ...baseKey, analyzer: { ...baseKey.analyzer } };
  const plan = planUpdate({
    base_snapshot: baseSnapshot,
    base_analysis_key: baseKey,
    target: {
      repository_id: baseSnapshot.service.repository_id,
      service_id: baseSnapshot.service.service_id,
      service_root: baseSnapshot.service.root,
      immutable_revision: args.changedRevision,
      source_digest: targetInventory.digest,
      analysis_key: targetKey,
    },
    changed_paths: paths,
    changed_paths_complete: true,
  });
  const targetRequest = analyzerRequest({
    kind: "target",
    serviceId: args.serviceId,
    revision: args.changedRevision,
    digest: targetInventory.digest,
    paths,
  });
  const execution = await executeUpdate({
    plan,
    request: targetRequest,
    base_snapshot: baseSnapshot,
    config_fingerprint: configFingerprint,
  }, createAnalyzer({ projectRoot: targetInventory.projectRoot }));
  const candidate = {
    contract_changes_output_version: CONTRACT_CHANGES_OUTPUT_VERSION,
    plan: {
      update_plan_version: plan.update_plan_version,
      plan_id: plan.plan_id,
      action: plan.action,
      ...(plan.extraction_mode === undefined ? {} : { extraction_mode: plan.extraction_mode }),
      dependency_coverage: plan.dependency_coverage,
      affected_endpoint_ids: plan.affected_endpoint_ids,
      fallback_reasons: plan.fallback_reasons,
    },
    base: snapshotSummary(baseSnapshot),
    target: snapshotSummary(execution.target_snapshot),
    differences: execution.differences,
  };
  const parsed = parseContractChangesOutput(candidate);
  if (!parsed.ok) return invalidInput();
  return parsed.value;
};

export const runContractChangesCli = async (
  rawArguments: readonly string[],
  output: Output,
): Promise<number> => {
  try {
    const result = await executeContractChanges(rawArguments);
    output.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const updateError = asUpdateError(error);
    output.stderr(`api-truth changes error [${updateError.code}]: ${updateError.message}\n`);
    return 1;
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runContractChangesCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  });
}
