import {canonicalJsonStringify} from "../../../packages/ir/src/index.js";
import {createHash} from "node:crypto";
import {isProxy} from "node:util/types";
import {parseStrictJson} from "./strict-json.js";
import {parseStrictYaml} from "./strict-yaml.js";

/** Trusted host scope for a syntax-only cache. Never construct this from analyzer request fields. */
export type ParsedDocumentCacheScope = Readonly<{
  tenantId: string;
  repositoryId: string;
  serviceId: string;
  serviceRoot: string;
  configFingerprint: string;
}>;

export type ParsedDocumentCacheKey = Readonly<ParsedDocumentCacheScope & {
  adapterId: string;
  adapterVersion: string;
  irVersion: string;
  documentPath: string;
  digest: string;
}>;

export type ParsedDocumentCacheStats = Readonly<{
  entries: number;
  retainedBytes: number;
  hits: number;
  misses: number;
  parseFailures: number;
  evictions: number;
}>;

const scopeFields = ["tenantId", "repositoryId", "serviceId", "serviceRoot", "configFingerprint"] as const;
export function snapshotParsedDocumentCacheScope(value: unknown): ParsedDocumentCacheScope | undefined {
  if (isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== scopeFields.length || ownKeys.some(key => typeof key !== "string"
    || !(scopeFields as readonly string[]).includes(key))) return undefined;
  const copy: Record<string, string> = {};
  for (const field of scopeFields) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== "string" || descriptor.value.length < 1 || descriptor.value.length > 2048)
      return undefined;
    copy[field] = descriptor.value;
  }
  return Object.freeze(copy) as ParsedDocumentCacheScope;
}

type Entry = {value: unknown; bytes: number};

function validKey(key: ParsedDocumentCacheKey): boolean {
  return [key.tenantId, key.repositoryId, key.serviceId, key.serviceRoot, key.configFingerprint,
    key.adapterId, key.adapterVersion, key.irVersion, key.documentPath, key.digest]
    .every(value => typeof value === "string" && value.length > 0 && value.length <= 2048)
    && /^sha256:[a-f0-9]{64}$/i.test(key.digest)
    && /\.(?:json|ya?ml)$/.test(key.documentPath);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

/**
 * Bounded LRU for strict-parser output only. Callers must verify current bytes before lookup.
 * Successful cached values are deeply frozen; thrown parser errors are never retained.
 */
export class ParsedDocumentCache {
  #values = new Map<string, Entry>();
  #retainedBytes = 0;
  #hits = 0;
  #misses = 0;
  #parseFailures = 0;
  #evictions = 0;
  #limits: Readonly<{maxEntries: number; maxBytes: number}>;

  constructor(limits: Readonly<{maxEntries: number; maxBytes: number}> = {
    maxEntries: 32, maxBytes: 8_000_000,
  }) {
    if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 256
      || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 64_000_000)
      throw new Error("Invalid parsed-document cache limits");
    this.#limits = Object.freeze({...limits});
    Object.freeze(this);
  }

  get stats(): ParsedDocumentCacheStats {
    return Object.freeze({entries: this.#values.size, retainedBytes: this.#retainedBytes, hits: this.#hits,
      misses: this.#misses, parseFailures: this.#parseFailures, evictions: this.#evictions});
  }

  clear(): void {
    this.#values.clear();
    this.#retainedBytes = 0;
  }

  parse(key: ParsedDocumentCacheKey, text: string): unknown {
    if (!validKey(key) || typeof text !== "string") throw new Error("Invalid parsed-document cache key");
    const textDigest = `sha256:${createHash("sha256").update(key.documentPath).update("\0")
      .update(Buffer.from(text, "utf8")).digest("hex")}`;
    const canonical = canonicalJsonStringify({cache: "strict-document-parse-v1", ...key});
    const cached = this.#values.get(canonical);
    if (cached && textDigest === key.digest) {
      this.#values.delete(canonical);
      this.#values.set(canonical, cached);
      this.#hits++;
      return cached.value;
    }
    this.#misses++;
    let value: unknown;
    try {
      value = /\.ya?ml$/.test(key.documentPath) ? parseStrictYaml(text) : parseStrictJson(text);
    } catch (error) { this.#parseFailures++; throw error; }
    // A caller must have verified raw bytes through readSelectedDocument. If text re-encoding
    // differs (for example, a UTF-8 BOM), parse normally but do not reuse or retain it.
    if (textDigest !== key.digest) return value;
    let bytes: number;
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) return value;
      bytes = Buffer.byteLength(encoded, "utf8");
    } catch { return value; }
    if (bytes > this.#limits.maxBytes) return value;
    deepFreeze(value);
    while (this.#values.size >= this.#limits.maxEntries || this.#retainedBytes + bytes > this.#limits.maxBytes) {
      const oldest = this.#values.entries().next().value as [string, Entry] | undefined;
      if (!oldest) break;
      this.#values.delete(oldest[0]);
      this.#retainedBytes -= oldest[1].bytes;
      this.#evictions++;
    }
    this.#values.set(canonical, {value, bytes});
    this.#retainedBytes += bytes;
    return value;
  }
}

/** Reject objects that merely imitate this cache or subclass its fixed parser behavior. */
export function isParsedDocumentCache(value: unknown): value is ParsedDocumentCache {
  if (isProxy(value) || !(value instanceof ParsedDocumentCache)
    || Object.getPrototypeOf(value) !== ParsedDocumentCache.prototype) return false;
  try { void value.stats; return true; } catch { return false; }
}

Object.freeze(ParsedDocumentCache.prototype);
