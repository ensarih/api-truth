import { relative } from "node:path";
import { parseStrictJson } from "./strict-json.js";
import { parseStrictYaml } from "./strict-yaml.js";

export type ConfigurationLocation = { path: string; pointer: string };
export type SupportedRoutingConfiguration = {
  kind: "supported"; origin: "default" | "configured"; controller_dirs: string[];
  pipeline: string; router_fitting: string; evidence_locations: ConfigurationLocation[];
};
export type RoutingConfiguration = SupportedRoutingConfiguration | {
  kind: "unresolved"; code: "handler_configuration_unverified"; reason: string;
  evidence_locations: ConfigurationLocation[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const pointerPart = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const relativePath = (root: string, path: string) => relative(root, path).replaceAll("\\", "/");
const directories = (value: unknown, allowEmpty = false): value is string[] => Array.isArray(value)
  && (allowEmpty || value.length > 0) && value.length <= 8 && new Set(value).size === value.length
  && value.every(dir => typeof dir === "string" && (dir === "."
    || /^[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.-]+)*$/.test(dir)
      && !dir.split("/").some(segment => segment === "." || segment === "..")));
const knownFittings = new Set(["cors", "swagger_params_parser", "swagger_security", "swagger_validator", "express_compatibility"]);

/** A static declaration profile. It never claims that environment/config layering is resolved. */
export function resolveSwaggerRoutingConfiguration(files: Map<string, string>, root: string,
  opaqueConfiguration: Map<string, string> = new Map(),
  createMockMode?: {value: boolean; location: ConfigurationLocation},
  environment?: {name: string; location: ConfigurationLocation}): RoutingConfiguration {
  const configFiles = [...files.keys(), ...opaqueConfiguration.keys()]
    .map(path => ({absolute: path, path: relativePath(root, path)}))
    .filter(item => item.path.startsWith("config/")).sort((a, b) => a.path.localeCompare(b.path));
  const locations: ConfigurationLocation[] = configFiles.map(item => ({path: item.path, pointer: "/"}));
  const fail = (reason: string): RoutingConfiguration => ({kind: "unresolved", code: "handler_configuration_unverified",
    reason, evidence_locations: locations});
  if (environment && !["development", "test", "production", "staging", "uat"].includes(environment.name))
    return fail("environment_selection_unsupported");
  if (environment) locations.push(environment.location);
  const defaults = configFiles.filter(item => ["json", "yaml", "yml"].some(ext => item.path === `config/default.${ext}`));
  const layers = configFiles.filter(item => environment && ["json", "yaml", "yml"].some(ext => item.path === `config/${environment.name}.${ext}`));
  if (defaults.length > 1 || layers.length > 1 || configFiles.some(item =>
    !defaults.includes(item) && !layers.includes(item) || opaqueConfiguration.has(item.absolute)))
    return fail("layered_or_unsupported_configuration");
  let swagger: Record<string, unknown> = {};
  const selected = defaults[0];
  if (selected) {
    const text = files.get(selected.absolute)!;
    if (Buffer.byteLength(text) > 1_000_000) return fail("configuration_limit_exceeded");
    let value: unknown;
    try { value = selected.path.endsWith(".json") ? parseStrictJson(text) : parseStrictYaml(text); }
    catch { return fail("invalid_configuration"); }
    const stack = [value];
    while (stack.length) {
      const entry = stack.pop();
      if (object(entry)) {
        if (Object.keys(entry).some(key => reserved.has(key))) return fail("invalid_configuration");
        stack.push(...Object.values(entry));
      } else if (Array.isArray(entry)) stack.push(...entry);
    }
    if (!object(value) || value.swagger !== undefined && !object(value.swagger)) return fail("invalid_configuration");
    if (object(value.swagger)) swagger = value.swagger;
  }
  const layer = layers[0];
  if (layer) {
    const text = files.get(layer.absolute)!;
    if (Buffer.byteLength(text) > 1_000_000) return fail("configuration_limit_exceeded");
    let value: unknown;
    try { value = layer.path.endsWith(".json") ? parseStrictJson(text) : parseStrictYaml(text); }
    catch { return fail("invalid_configuration"); }
    if (!object(value) || Object.keys(value).length !== 1 || !object(value.swagger)
      || Object.keys(value.swagger).length !== 1 || typeof value.swagger.mockMode !== "boolean")
      return fail("environment_layer_unsupported");
    swagger = {...swagger, mockMode: value.swagger.mockMode};
    locations.push({path: layer.path, pointer: "/swagger/mockMode"});
  }
  const allowed = new Set(["bagpipes", "swaggerControllerPipe", "defaultPipe", "fittingsDirs", "mockMode",
    "mapErrorsToJson", "startWithErrors", "startWithWarnings", "enforceUniqueOperationId"]);
  if (Object.keys(swagger).some(key => !allowed.has(key))) return fail("unsupported_swagger_configuration");
  if (createMockMode) {
    swagger = {...swagger, mockMode: createMockMode.value};
    locations.push(createMockMode.location);
  }
  if (swagger.mockMode !== undefined && swagger.mockMode !== false) return fail("mock_routing_unverified");
  const fittingDirs = swagger.fittingsDirs ?? ["api/fittings"];
  if (!directories(fittingDirs, true)) return fail("fitting_directories_unsupported");
  const overrides = [...files.keys()].map(path => relativePath(root, path)).filter(path => fittingDirs.some(dir =>
    dir === "." || path.startsWith(`${dir}/`)));
  if (overrides.length) {
    locations.push(...overrides.sort().map(path => ({path, pointer: "/"})));
    return fail("custom_fittings_unverified");
  }
  if (swagger.bagpipes === undefined || swagger.bagpipes === null) {
    return {kind: "supported", origin: "default", controller_dirs: ["api/controllers"],
      pipeline: "swagger_controllers", router_fitting: "_router", evidence_locations: locations};
  }
  if (!object(swagger.bagpipes)) return fail("pipeline_unverified");
  const bagpipes = swagger.bagpipes;
  const pipeline = swagger.swaggerControllerPipe;
  if (typeof pipeline !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(pipeline) || reserved.has(pipeline))
    return fail("controller_pipeline_unverified");
  const pipe = bagpipes[pipeline];
  if (!Array.isArray(pipe) || !pipe.length || pipe.length > 32) return fail("controller_pipeline_unverified");
  const add = (pointer: string) => { if (selected) locations.push({path: selected.path, pointer}); };
  add("/swagger/swaggerControllerPipe");
  const pipePointer = `/swagger/bagpipes/${pointerPart(pipeline)}`;
  let router: { value: Record<string, unknown>; name: string; pointer: string } | undefined;
  for (const [index, item] of pipe.entries()) {
    const itemPointer = `${pipePointer}/${index}`;
    add(itemPointer);
    if (object(item) && Object.keys(item).length === 1 && item.onError === "json_error_handler") continue;
    let fitting: Record<string, unknown>;
    let fittingName: string;
    let fittingPointer: string;
    if (typeof item === "string") {
      if (reserved.has(item)) return fail("pipeline_fitting_unverified");
      if (Object.prototype.hasOwnProperty.call(bagpipes, item)) {
        if (!object(bagpipes[item])) return fail("pipeline_fitting_unverified");
        fitting = bagpipes[item];
        fittingName = item;
        fittingPointer = `/swagger/bagpipes/${pointerPart(item)}`;
      } else {
        fitting = {name: item}; fittingName = item; fittingPointer = itemPointer;
      }
    } else if (object(item)) {
      fitting = item; fittingName = `inline-${index}`; fittingPointer = itemPointer;
    } else return fail("pipeline_fitting_unverified");
    if (typeof fitting.name !== "string") return fail("pipeline_fitting_unverified");
    if (fitting.name !== "swagger_router") {
      if (!knownFittings.has(fitting.name)) return fail("pipeline_fitting_unverified");
      continue;
    }
    if (router || index !== pipe.length - 1) return fail("ambiguous_or_nonfinal_router");
    router = {value: fitting, name: fittingName, pointer: fittingPointer};
  }
  if (!router) return fail("controller_router_unverified");
  const value = router.value;
  if (Object.keys(value).some(key => !["name", "mockMode", "mockControllersDirs", "controllersDirs", "controllersInterface"].includes(key)))
    return fail("router_configuration_unsupported");
  if (value.mockMode !== undefined && value.mockMode !== false) return fail("mock_routing_unverified");
  if (value.controllersInterface !== undefined && value.controllersInterface !== "middleware") return fail("controller_interface_unverified");
  if (!directories(value.controllersDirs) || !directories(value.mockControllersDirs, true)) return fail("controller_directories_unsupported");
  add(`${router.pointer}/name`);
  value.controllersDirs.forEach((_, index) => add(`${router!.pointer}/controllersDirs/${index}`));
  if (value.mockMode !== undefined) add(`${router.pointer}/mockMode`);
  if (value.controllersInterface !== undefined) add(`${router.pointer}/controllersInterface`);
  return {kind: "supported", origin: "configured", controller_dirs: value.controllersDirs,
    pipeline, router_fitting: router.name, evidence_locations: locations};
}
