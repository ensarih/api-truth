import { registerHooks } from "node:module";

const roots = [new URL("../packages/ir/src/", import.meta.url).href,
  new URL("../analyzers/java-spring/src/", import.meta.url).href];
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
  await import("../analyzers/java-spring/src/cli.ts");
} catch {
  process.stderr.write("JAVA_ANALYZER_FAILED\n");
  process.exitCode = 1;
}
