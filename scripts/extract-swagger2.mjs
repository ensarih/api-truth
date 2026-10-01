import { registerHooks } from "node:module";

const roots = [new URL("../packages/ir/src/", import.meta.url).href, new URL("../analyzers/nodejs/src/", import.meta.url).href];
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
  const { runCli } = await import("../analyzers/nodejs/src/cli.ts");
  await runCli(process.argv.slice(2));
} catch {
  process.stderr.write("Swagger 2 extraction failed: invalid arguments, source boundary, limits, or analyzer failure.\n");
  process.exitCode = 1;
}
