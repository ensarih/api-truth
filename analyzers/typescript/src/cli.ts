import { resolve } from "node:path";
import { createAnalyzer, ANALYZER } from "./index.js";
import { digestSources, readSources } from "./source.js";
import { parseAnalyzerRequest } from "../../../packages/ir/src/index.js";

export async function runCli(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  const allowed = new Set(["--source", "--service", "--revision", "--ir-version"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name || !allowed.has(name) || values.has(name) || !value || value.startsWith("--")) throw new Error("Invalid CLI arguments");
    values.set(name, value);
  }
  if (!["--source", "--service", "--revision"].every(name => values.has(name))) throw new Error("Missing CLI arguments");
  const candidate = {
    exchange_version: "1.0.0", ir_version: values.get("--ir-version") ?? "1.0.0", request_id: "local-extraction", analyzer: ANALYZER,
    source: { repository_id: "local", service_id: values.get("--service"), service_root: ".", immutable_revision: values.get("--revision"), source_digest: "pending", access_label: "local" },
    resolution_inputs: [{ kind: "source_tree", path: ".", digest: "pending" }], prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 1000, max_output_bytes: 10000000 }, execution_policy: { network_access: false, side_effects: "none" },
  };
  const parsed = parseAnalyzerRequest(candidate);
  if (!parsed.ok) throw new Error("Invalid analyzer request");
  const projectRoot = resolve(values.get("--source")!);
  const start = Date.now();
  const { files, root } = await readSources(projectRoot, ".", parsed.value.limits.max_files, () => {
    if (Date.now() - start > 30000) throw new Error("Source timeout");
  });
  const digest = digestSources(files, root);
  parsed.value.source.source_digest = digest;
  parsed.value.resolution_inputs[0]!.digest = digest;
  const result = await createAnalyzer({ projectRoot }).analyze(parsed.value);
  for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic.severity}: ${diagnostic.code}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
