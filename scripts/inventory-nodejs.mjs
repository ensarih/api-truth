import {registerHooks} from "node:module";

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
  const {runInventoryCli} = await import("../analyzers/nodejs/src/inventory-cli.ts");
  await runInventoryCli(process.argv.slice(2));
} catch {
  process.stderr.write("Node.js inventory failed: invalid selection, source boundary, limits, or analysis failure.\n");
  process.exitCode = 1;
}
