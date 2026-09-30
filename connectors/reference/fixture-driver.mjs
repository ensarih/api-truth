/** Public synthetic workflow driver. Formats fixtures only; no API call or deployment occurs. */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const run = async () => {
  if (process.argv.length !== 6 || process.argv[2] !== "--branch" || process.argv[4] !== "--output")
    throw new Error("INVALID_INPUT");
  const branch = process.argv[3];
  const output = process.argv[5];
  if (branch.length === 0 || branch.length > 512 || output.length === 0) throw new Error("INVALID_INPUT");
  const { buildSyntheticReferenceFixture } = await import("./src/fixture.ts");
  const { parseEvent } = await import("../../packages/ir/src/index.ts");
  const steps = buildSyntheticReferenceFixture(branch);
  const events = [];
  const previous = new Map();
  const directory = await mkdtemp(join(tmpdir(), "api-truth-synthetic-"));
  try {
    for (const [index, step] of steps.entries()) {
      const priorKey = String(step.fact.kind);
      const policy = { ...step.policy, ...(previous.has(priorKey) ? { previousEvent: previous.get(priorKey) } : {}) };
      const policyFile = join(directory, `policy-${index}.json`);
      await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.mjs", import.meta.url)), policyFile],
        { input: JSON.stringify(step.fact), encoding: "utf8", maxBuffer: 1024 * 1024 });
      if (result.status !== 0) throw new Error(`FORMAT_FAILED_${index}`);
      const parsed = parseEvent(JSON.parse(result.stdout));
      if (!parsed.ok) throw new Error(`INVALID_EVENT_${index}`);
      events.push(parsed.value);
      previous.set(priorKey, parsed.value);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ demonstration_only: true, events }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Wrote ${events.length} synthetic event envelopes.\n`);
};

try { await run(); }
catch (error) {
  process.stderr.write(`${error instanceof Error && error.message === "UNCONFIGURED_BRANCH" ? "UNCONFIGURED_BRANCH" : "INVALID_FIXTURE"}\n`);
  process.exitCode = 1;
}
