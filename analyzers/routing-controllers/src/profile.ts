import { parseStrictJson } from "../../../packages/ir/src/strict-json.js";

export type RoutingProfile = Readonly<{
  path: string;
  decoratorModules: readonly string[];
  routePrefix: string;
}>;

const moduleName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const staticPrefix = /^(?:|\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?)$/;

/** An explicit, bounded assertion about decorator imports and an unverified route prefix. */
export function parseRoutingProfile(path: string, text: string): RoutingProfile {
  try {
    if (Buffer.byteLength(text) > 8192) throw new Error("size");
    const value = parseStrictJson(text, { maxDepth: 4, maxNodes: 64 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).some(key => !["profile_version", "decorator_modules", "binding", "route_prefix"].includes(key))
      || raw.profile_version !== "1.0.0" || raw.binding !== "declarations_only"
      || !Array.isArray(raw.decorator_modules) || raw.decorator_modules.length > 8
      || raw.decorator_modules.some(item => typeof item !== "string" || item.length > 200 || !moduleName.test(item))
      || new Set(raw.decorator_modules).size !== raw.decorator_modules.length
      || typeof raw.route_prefix !== "string" || !staticPrefix.test(raw.route_prefix)) throw new Error("shape");
    return Object.freeze({ path, decoratorModules: Object.freeze([...raw.decorator_modules]), routePrefix: raw.route_prefix });
  } catch { throw new Error("Invalid routing profile"); }
}
