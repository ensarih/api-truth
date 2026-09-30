/** Local synthetic fixture formatter. This entry does not authenticate or ingest events. */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { registerHooks } from "node:module";

const sourceRoots = [new URL("../../packages/", import.meta.url).href,
  new URL("./src/", import.meta.url).href];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")
      && sourceRoots.some((root) => context.parentURL?.startsWith(root))) {
      const target = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (sourceRoots.some((root) => target.href.startsWith(root))) return nextResolve(target.href, context);
    }
    return nextResolve(specifier, context);
  },
});

try {
  if (process.argv.length !== 3) throw new Error("INVALID_INPUT");
  const policyPath = process.argv[2];
  const handle = await open(policyPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let policy;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("INVALID_INPUT");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const chunk = await handle.read(buffer, size, buffer.length - size, size);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    if (size > 64 * 1024) throw new Error("INVALID_INPUT");
    policy = JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { await handle.close(); }
  const { runLocalAdapterCli } = await import("./src/cli.ts");
  process.exitCode = await runLocalAdapterCli(process.stdin, process.stdout, process.stderr, policy);
} catch {
  process.stderr.write("INVALID_INPUT\n");
  process.exitCode = 1;
}
