import {createHash} from "node:crypto";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, test} from "vitest";
import {ANALYZER as swaggerAnalyzer, createAnalyzer as createSwaggerAnalyzer} from "../../analyzers/nodejs/src/index.js";
import {ANALYZER as openapi3Analyzer, createAnalyzer as createOpenapi3Analyzer} from "../../analyzers/openapi3/src/index.js";
import {ANALYZER as openapi31Analyzer, createAnalyzer as createOpenapi31Analyzer} from "../../analyzers/openapi31/src/index.js";
import {isParsedDocumentCache, ParsedDocumentCache, type ParsedDocumentCacheKey, type ParsedDocumentCacheScope} from "../../analyzers/nodejs/src/parsed-document-cache.js";
import type {AnalyzerRequest} from "../../packages/ir/src/index.js";
import {createConfiguredAnalyzer} from "../../analyzers/host/src/index.js";

const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});

const scope: ParsedDocumentCacheScope = {tenantId: "tenant-a", repositoryId: "repo-a", serviceId: "orders",
  serviceRoot: "service", configFingerprint: "config-1"};
function key(overrides: Partial<ParsedDocumentCacheKey> = {}, text = '{"a":1}'): ParsedDocumentCacheKey {
  const documentPath = overrides.documentPath ?? "service/openapi.json";
  const digest = `sha256:${createHash("sha256").update(documentPath).update("\0").update(text).digest("hex")}`;
  return {...scope, adapterId: "openapi3-document", adapterVersion: "0.2.0", irVersion: "1.1.0",
    ...overrides, documentPath, digest: overrides.digest ?? digest};
}

test("strict parse cache hits exact scoped bytes, isolates identities and freezes successful trees", () => {
  const cache = new ParsedDocumentCache({maxEntries: 16, maxBytes: 4096});
  expect(isParsedDocumentCache(cache)).toBe(true);
  expect(isParsedDocumentCache(Object.create(ParsedDocumentCache.prototype))).toBe(false);
  expect(isParsedDocumentCache({parse: () => ({swagger: "2.0"})})).toBe(false);
  const first = cache.parse(key(), '{"a":1}') as {a: number};
  expect(first).toEqual({a: 1});
  expect(Object.isFrozen(first)).toBe(true);
  expect(() => { (first as {a: number}).a = 9; }).toThrow();
  expect(cache.parse(key(), '{"a":1}')).toBe(first);
  for (const changed of [
    key({tenantId: "tenant-b"}), key({repositoryId: "repo-b"}), key({serviceId: "other"}),
    key({configFingerprint: "config-2"}), key({adapterId: "openapi31-document"}),
    key({adapterVersion: "0.1.0"}), key({irVersion: "1.0.0"}), key({documentPath: "service/other.json"}),
  ]) expect(cache.parse(changed, '{"a":1}')).toEqual({a: 1});
  expect(cache.stats).toMatchObject({hits: 1, misses: 9, entries: 9});
});

test("failures are not cached and LRU and retained-byte limits stay bounded", () => {
  const cache = new ParsedDocumentCache({maxEntries: 1, maxBytes: 64});
  expect(() => cache.parse(key(), '{"a":')).toThrow();
  expect(() => cache.parse(key(), '{"a":')).toThrow();
  expect(cache.stats).toMatchObject({entries: 0, parseFailures: 2, misses: 2});
  cache.parse(key(), '{"a":1}');
  const second = key({documentPath: "service/second.json"}, '{"b":2}');
  cache.parse(second, '{"b":2}');
  expect(cache.stats).toMatchObject({entries: 1, evictions: 1});
  cache.parse(key(), '{"a":1}');
  expect(cache.stats).toMatchObject({entries: 1, evictions: 2, retainedBytes: 7});
  const tooLarge = new ParsedDocumentCache({maxEntries: 2, maxBytes: 2});
  tooLarge.parse(key(), '{"a":1}');
  expect(tooLarge.stats.entries).toBe(0);
});

test("YAML is parsed by the fixed strict parser and malformed YAML is never retained", () => {
  const cache = new ParsedDocumentCache({maxEntries: 4, maxBytes: 4096});
  const yamlKey = key({documentPath: "service/openapi.yaml"}, "a: 1\n");
  const first = cache.parse(yamlKey, "a: 1\n");
  expect(first).toEqual({a: 1});
  expect(cache.parse(yamlKey, "a: 1\n")).toBe(first);
  const invalidKey = key({documentPath: "service/duplicate.yaml"}, "a: 1\na: 2\n");
  expect(() => cache.parse(invalidKey, "a: 1\na: 2\n")).toThrow();
  expect(cache.stats).toMatchObject({hits: 1, parseFailures: 1, entries: 1});
});

test("cache recomputes path-plus-text digest and host rejects forged cache instances", () => {
  const cache = new ParsedDocumentCache({maxEntries: 4, maxBytes: 4096});
  const actual = key();
  const cached = cache.parse(actual, '{"a":1}');
  expect(cache.parse(actual, '{"a":2}')).toEqual({a: 2});
  expect(cache.stats).toMatchObject({hits: 0, entries: 1});
  expect(cache.parse(actual, '{"a":1}')).toBe(cached);
  const forged = Object.create(ParsedDocumentCache.prototype);
  expect(() => createConfiguredAnalyzer({projectRoot: ".", selection: {},
    parsedDocumentCache: forged as ParsedDocumentCache, parsedDocumentCacheScope: scope})).toThrow("INVALID_TRUSTED_DOCUMENT_CACHE");
});

test("cache validation rejects proxies before property traps and freezes parser authority", () => {
  const cache = new ParsedDocumentCache({maxEntries: 4, maxBytes: 4096});
  const trapCalls: string[] = [];
  const proxy = new Proxy(cache, {
    getPrototypeOf() {trapCalls.push("getPrototypeOf"); return ParsedDocumentCache.prototype;},
    get(_target, key) {trapCalls.push(String(key)); return key === "stats" ? {} : () => ({forged: true});},
  });
  expect(isParsedDocumentCache(proxy)).toBe(false);
  expect(trapCalls).toEqual([]);
  expect(Object.isFrozen(ParsedDocumentCache.prototype)).toBe(true);
  expect(Reflect.set(ParsedDocumentCache.prototype, "parse", () => ({forged: true}))).toBe(false);
  expect(cache.parse(key(), '{"a":1}')).toEqual({a: 1});
});

const docs = [
  {name: "Swagger 2", analyzer: swaggerAnalyzer, create: createSwaggerAnalyzer,
    path: "service/swagger.json", document: {swagger: "2.0", info: {title: "Orders", version: "1"},
      paths: {"/orders": {get: {responses: {"200": {description: "ok"}}}}}}},
  {name: "OpenAPI 3.0", analyzer: openapi3Analyzer, create: createOpenapi3Analyzer,
    path: "service/openapi.json", document: {openapi: "3.0.3", info: {title: "Orders", version: "1"},
      paths: {"/orders": {get: {responses: {"200": {description: "ok"}}}}}}},
  {name: "OpenAPI 3.1", analyzer: openapi31Analyzer, create: createOpenapi31Analyzer,
    path: "service/openapi31.json", document: {openapi: "3.1.0", info: {title: "Orders", version: "1"},
      paths: {"/orders": {get: {responses: {"200": {description: "ok"}}}}}}},
] as const;

for (const profile of docs) test(`${profile.name} cache hit reprojects fresh revision evidence and preserves coverage`, async () => {
  const root = await mkdtemp(join(tmpdir(), "api-truth-parsed-cache-")); roots.push(root);
  await mkdir(join(root, "service"));
  await writeFile(join(root, profile.path), JSON.stringify(profile.document));
  const cache = new ParsedDocumentCache({maxEntries: 4, maxBytes: 100_000});
  const mutableScope = {...scope};
  const analyzerOptions = {projectRoot: root, parsedDocumentCache: cache, parsedDocumentCacheScope: mutableScope};
  const adapter = profile.create(analyzerOptions);
  const makeRequest = (revision: string, id: string): AnalyzerRequest => ({exchange_version: "1.0.0", ir_version: "1.1.0",
    request_id: id, analyzer: profile.analyzer,
    source: {repository_id: scope.repositoryId, service_id: scope.serviceId, service_root: scope.serviceRoot,
      immutable_revision: revision, source_digest: "pending", access_label: "private"},
    resolution_inputs: [{kind: "type_manifest", path: profile.path, digest: "pending"}], prior_dependencies: [],
    changed_paths: [], extraction_mode: "baseline", limits: {timeout_ms: 30000, max_files: 1, max_output_bytes: 100_000},
    execution_policy: {network_access: false, side_effects: "none"}});
  const firstRevision = "a".repeat(40), secondRevision = "b".repeat(40);
  const first = await adapter.analyze(makeRequest(firstRevision, "first"));
  mutableScope.tenantId = "mutated-after-factory";
  Object.assign(analyzerOptions, {parsedDocumentCache: {parse: () => ({forged: true})}});
  const second = await adapter.analyze(makeRequest(secondRevision, "second"));
  expect(cache.stats).toMatchObject({entries: 1, hits: 1, misses: 1});
  expect(second.request_id).toBe("second");
  expect(second.result_id).not.toBe(first.result_id);
  expect(second.snapshot_id).not.toBe(first.snapshot_id);
  expect(second.endpoints).toEqual(first.endpoints);
  expect(second.claims).toEqual(first.claims);
  expect(second.diagnostics.map(item => item.code)).toEqual(first.diagnostics.map(item => item.code));
  expect(second.status).toBe(first.status);
  expect(second.coverage).toEqual(first.coverage);
  expect(first.evidence.length).toBeGreaterThan(0);
  expect(first.evidence.every(item => item.source_version === firstRevision
    && item.scope.revision === firstRevision && item.scope.snapshot_id === first.snapshot_id)).toBe(true);
  expect(second.evidence.every(item => item.source_version === secondRevision
    && item.scope.revision === secondRevision && item.scope.snapshot_id === second.snapshot_id)).toBe(true);
});

test("cache scope snapshots reject accessors and proxies without invoking traps", () => {
  const cache = new ParsedDocumentCache();
  let getterCalls = 0;
  const accessorScope = {...scope};
  Object.defineProperty(accessorScope, "tenantId", {enumerable: true, get() {getterCalls++; return "tenant-a";}});
  expect(() => createSwaggerAnalyzer({projectRoot: ".", parsedDocumentCache: cache,
    parsedDocumentCacheScope: accessorScope as ParsedDocumentCacheScope})).toThrow("Invalid trusted document cache");
  expect(getterCalls).toBe(0);
  const proxyCalls: string[] = [];
  const proxyScope = new Proxy(scope, {getPrototypeOf() {proxyCalls.push("prototype"); return Object.prototype;}});
  expect(() => createSwaggerAnalyzer({projectRoot: ".", parsedDocumentCache: cache,
    parsedDocumentCacheScope: proxyScope})).toThrow("Invalid trusted document cache");
  expect(proxyCalls).toEqual([]);
});
