import {readFile, lstat} from "node:fs/promises";
import {sha256, runtimeBindingFilename} from "./runtime-binding.js";
import { resolve } from "node:path";
import { parseAnalyzerRequest } from "../../../packages/ir/src/index.js";
import { ANALYZER, createAnalyzer } from "./middleware.js";

export async function runCli(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  const allowed = new Set(["--source", "--service", "--revision", "--ir-version", "--binding-receipt", "--binding-public-key"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name || !allowed.has(name) || values.has(name) || !value || value.startsWith("--"))
      throw new Error("Invalid CLI arguments");
    values.set(name, value);
  }
  if (!["--source", "--service", "--revision"].every(name => values.has(name)))
    throw new Error("Missing CLI arguments");
  const sourceRoot = resolve(values.get("--source")!);
  const receipt = values.get("--binding-receipt"), keyPath = values.get("--binding-public-key");
  if (!!receipt !== !!keyPath || receipt && receipt !== runtimeBindingFilename) throw new Error("Invalid binding options");
  const boundedRead = async (path: string, limit: number) => {
    if ((await lstat(path)).size > limit) throw new Error("Binding input limit exceeded");
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new Error("Binding input limit exceeded");
    return bytes.toString("utf8");
  };
  const receiptText = receipt ? await boundedRead(resolve(sourceRoot, receipt), 1_000_000) : undefined;
  const publicKey = keyPath ? await boundedRead(resolve(keyPath), 10000) : undefined;
  if (publicKey && Buffer.byteLength(publicKey) > 10000 || receiptText && Buffer.byteLength(receiptText) > 1_000_000)
    throw new Error("Binding input limit exceeded");
  const candidate = {
    exchange_version: "1.0.0", ir_version: values.get("--ir-version") ?? "1.1.0",
    request_id: "local-swagger2-middleware-extraction", analyzer: ANALYZER,
    source: { repository_id: "local", service_id: values.get("--service"), service_root: ".",
      immutable_revision: values.get("--revision"), source_digest: "pending", access_label: "local" },
    resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" },
      { kind: "type_manifest", path: "api/swagger/swagger.yaml", digest: "pending" },
      ...(receipt && receiptText ? [{kind: "runtime_observation", path: receipt, digest: sha256(receiptText)}] : [])],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 500, max_output_bytes: 10000000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
  const parsed = parseAnalyzerRequest(candidate);
  if (!parsed.ok) throw new Error("Invalid analyzer request");
  const result = await createAnalyzer({ projectRoot: sourceRoot, ...(publicKey ? {trustedRuntimePublicKey: publicKey} : {}) }).analyze(parsed.value);
  for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic.severity}: ${diagnostic.code}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
