import { resolve } from "node:path";
import type { ConfigurationLocation } from "./routing-config.js";
import { parseStrictJson } from "./strict-json.js";

export type RoutingDependencyResolution = {
  kind: "locked"; versions: Record<string, string>; conformance_target: boolean; evidence_locations: ConfigurationLocation[];
} | {kind: "unresolved"; conformance_target: false; evidence_locations: ConfigurationLocation[]};
export type FrameworkLockResolution = {
  kind: "locked"; wrapper_version: string; runner_version: string; conformance_target: boolean;
  evidence_locations: ConfigurationLocation[]; routing_dependencies: RoutingDependencyResolution;
} | { kind: "unresolved"; code: "framework_version_unverified"; evidence_locations: ConfigurationLocation[] };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactVersion = (value: unknown): value is string => typeof value === "string" && value.length < 100
  && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
const pointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

/** Only the three routing-affecting runner dependencies; never a complete installed graph. */
function routingDependencies(packages: Record<string, unknown>, runnerPath: string,
  runner: Record<string, unknown>, lockPath: string): RoutingDependencyResolution {
  const evidence_locations: ConfigurationLocation[] = [];
  const unresolved = (): RoutingDependencyResolution => ({kind: "unresolved", conformance_target: false, evidence_locations});
  if (!object(runner.dependencies)) return unresolved();
  const versions: Record<string, string> = {};
  const targets = {bagpipes: ["0.1.2", "^0.1.0"], config: ["1.31.0", "^1.16.0"], sway: ["1.0.0", "^1.0.0"]};
  for (const [name, [target, targetRange]] of Object.entries(targets)) {
    evidence_locations.push({path: lockPath, pointer: `/packages/${pointer(runnerPath)}/dependencies/${name}`});
    let parent = runnerPath;
    let selected: string | undefined;
    while (true) {
      const candidate = `${parent ? `${parent}/` : ""}node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) { selected = candidate; break; }
      if (!parent) break;
      const boundary = parent.lastIndexOf("/node_modules/");
      parent = boundary < 0 ? "" : parent.slice(0, boundary);
    }
    if (!selected) return unresolved();
    evidence_locations.push({path: lockPath, pointer: `/packages/${pointer(selected)}/version`});
    const entry = packages[selected];
    if (!object(entry) || entry.link !== undefined && entry.link !== false
      || entry.name !== undefined && entry.name !== name || !exactVersion(entry.version)) return unresolved();
    const spec = runner.dependencies[name];
    // Exact specs are recorded. The only accepted ranges are the tested range/version pairs.
    if (spec !== entry.version && !(spec === targetRange && entry.version === target)) return unresolved();
    versions[name] = entry.version;
  }
  return {kind: "locked", versions, conformance_target: Object.entries(targets).every(([name, [target]]) => versions[name] === target),
    evidence_locations};
}

/** Lockfile declarations only: this neither reads installed modules nor proves runtime loading. */
export function resolveSwaggerFrameworkLock(files: Map<string, string>, root: string,
  opaqueFiles: Map<string, string> = new Map()): FrameworkLockResolution {
  const locations: ConfigurationLocation[] = [];
  const fail = (): FrameworkLockResolution => ({kind: "unresolved", code: "framework_version_unverified", evidence_locations: locations});
  const parse = (path: string): unknown => {
    const text = files.get(resolve(root, path));
    if (text === undefined || Buffer.byteLength(text) > 1_000_000) throw new Error("Unsupported lock input");
    locations.push({path, pointer: "/"});
    return parseStrictJson(text);
  };
  try {
    const selected = ["package-lock.json", "npm-shrinkwrap.json"].filter(path => files.has(resolve(root, path)));
    if (selected.length !== 1 || ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]
      .some(path => files.has(resolve(root, path)) || opaqueFiles.has(resolve(root, path)))) return fail();
    const manifest = parse("package.json");
    const lockPath = selected[0]!;
    const lock = parse(lockPath);
    if (!object(manifest) || manifest.overrides !== undefined || !object(manifest.dependencies)
      || manifest.packageManager !== undefined && (typeof manifest.packageManager !== "string"
        || !/^npm@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(manifest.packageManager))
      || !object(lock) || ![2, 3].includes(Number(lock.lockfileVersion))
      || typeof lock.lockfileVersion !== "number" || !object(lock.packages)) return fail();
    const packages = lock.packages;
    const declared = manifest.dependencies["swagger-express-mw"];
    const lockRoot = packages[""];
    if (!exactVersion(declared) || !object(lockRoot) || !object(lockRoot.dependencies)
      || lockRoot.dependencies["swagger-express-mw"] !== declared) return fail();
    const entry = (path: string, name: string): Record<string, unknown> | undefined => {
      const value = packages[path];
      if (!object(value) || value.link !== undefined && value.link !== false
        || value.name !== undefined && value.name !== name || !exactVersion(value.version)) return undefined;
      return value;
    };
    const wrapperPath = "node_modules/swagger-express-mw";
    const wrapper = entry(wrapperPath, "swagger-express-mw");
    if (!wrapper || wrapper.version !== declared || !object(wrapper.dependencies)) return fail();
    const nested = `${wrapperPath}/node_modules/swagger-node-runner`;
    // An invalid nearest entry must not fall back to an unrelated hoisted runner.
    const runnerPath = Object.hasOwn(packages, nested) ? nested : "node_modules/swagger-node-runner";
    const runner = entry(runnerPath, "swagger-node-runner");
    if (!runner || !exactVersion(runner.version)) return fail();
    const runnerSpec = wrapper.dependencies["swagger-node-runner"];
    if (runnerSpec !== runner.version
      && !(runnerSpec === "^0.7.0" && /^0\.7\.(0|[1-9][0-9]*)$/.test(runner.version))) return fail();
    locations.push({path: "package.json", pointer: "/dependencies/swagger-express-mw"},
      {path: lockPath, pointer: "/packages//dependencies/swagger-express-mw"},
      {path: lockPath, pointer: `/packages/${pointer(wrapperPath)}/version`},
      {path: lockPath, pointer: `/packages/${pointer(wrapperPath)}/dependencies/swagger-node-runner`},
      {path: lockPath, pointer: `/packages/${pointer(runnerPath)}/version`});
    return {kind: "locked", wrapper_version: declared, runner_version: runner.version,
      conformance_target: declared === "0.7.0" && runner.version === "0.7.0", evidence_locations: locations,
      routing_dependencies: routingDependencies(packages, runnerPath, runner, lockPath)};
  } catch { return fail(); }
}
