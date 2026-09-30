/** Local synthetic fixture formatter. This entry does not authenticate or ingest events. */
import { readFile, stat } from "node:fs/promises";
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
  if ((await stat(policyPath)).size > 64 * 1024) throw new Error("INVALID_INPUT");
  const bytes = await readFile(policyPath);
  if (bytes.byteLength > 64 * 1024) throw new Error("INVALID_INPUT");
  const policy = JSON.parse(bytes.toString("utf8"));
  const { runLocalAdapterCli } = await import("./src/cli.ts");
  process.exitCode = await runLocalAdapterCli(process.stdin, process.stdout, process.stderr, policy);
} catch {
  process.stderr.write("INVALID_INPUT\n");
  process.exitCode = 1;
}
