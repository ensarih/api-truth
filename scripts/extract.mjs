import { registerHooks } from "node:module";

// Native Node type stripping runs our checked-in sources. The hook only resolves
// this tool's NodeNext .js imports to .ts; analyzed files are never imported.
const roots = [new URL("../packages/ir/src/", import.meta.url).href, new URL("../analyzers/typescript/src/", import.meta.url).href];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && roots.some(root => context.parentURL?.startsWith(root))) {
      const target = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (roots.some(root => target.href.startsWith(root))) return nextResolve(target.href, context);
    }
    return nextResolve(specifier, context);
  },
});
try {
  const { runCli } = await import("../analyzers/typescript/src/cli.ts");
  await runCli(process.argv.slice(2));
} catch {
  process.stderr.write("Extraction failed: invalid arguments, source boundary, limits, or analyzer failure.\n");
  process.exitCode = 1;
}
