import { resolve } from "node:path";
import { parseAnalyzerRequest } from "../../../packages/ir/src/index.js";
import { ANALYZER, createAnalyzer } from "./index.js";

export async function runCli(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  const allowed = new Set(["--source", "--document", "--service", "--revision", "--ir-version"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name || !allowed.has(name) || values.has(name) || !value || value.startsWith("--")) throw new Error("Invalid CLI arguments");
    values.set(name, value);
  }
  if (!["--source", "--document", "--service", "--revision"].every(name => values.has(name))) throw new Error("Missing CLI arguments");
  const documentPath = values.get("--document")!;
  const candidate = {
    exchange_version: "1.0.0", ir_version: values.get("--ir-version") ?? "1.1.0", request_id: "local-openapi3-extraction", analyzer: ANALYZER,
    source: { repository_id: "local", service_id: values.get("--service"), service_root: ".", immutable_revision: values.get("--revision"), source_digest: "pending", access_label: "local" },
    resolution_inputs: [{ kind: "type_manifest", path: documentPath, digest: "pending" }],
    prior_dependencies: [], changed_paths: [], extraction_mode: "baseline",
    limits: { timeout_ms: 30000, max_files: 1, max_output_bytes: 10000000 },
    execution_policy: { network_access: false, side_effects: "none" },
  };
  const parsed = parseAnalyzerRequest(candidate);
  if (!parsed.ok) throw new Error("Invalid analyzer request");
  const result = await createAnalyzer({ projectRoot: resolve(values.get("--source")!) }).analyze(parsed.value);
  for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic.severity}: ${diagnostic.code}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
