import { resolve } from "node:path";
import { inventoryNodeService } from "./inventory.js";

/** Local, offline onboarding inventory. It prints only bounded classifications, evidence spans, digests and diagnostics. */
export async function runInventoryCli(args: string[]): Promise<void> {
  const scalar = new Map<string, string>();
  const entrypoints: string[] = [];
  const documents: string[] = [];
  const scalarFlags = new Set(["--project-root", "--service-root"]);
  const repeatedFlags = new Set(["--entrypoint", "--document"]);
  for (let index = 0; index < args.length;) {
    const name = args[index++];
    const value = args[index++];
    if (!name || (!scalarFlags.has(name) && !repeatedFlags.has(name)) || !value || value.startsWith("--"))
      throw new Error("Invalid inventory arguments");
    if (scalarFlags.has(name)) {
      if (scalar.has(name)) throw new Error("Invalid inventory arguments");
      scalar.set(name, value);
    } else if (name === "--entrypoint") entrypoints.push(value);
    else documents.push(value);
  }
  if (!["--project-root", "--service-root"].every(name => scalar.has(name)) || (!entrypoints.length && !documents.length))
    throw new Error("Missing inventory selection");
  const result = await inventoryNodeService({projectRoot: resolve(scalar.get("--project-root")!),
    serviceRoot: scalar.get("--service-root")!, entrypoints, authoritativeDocumentPaths: documents});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
