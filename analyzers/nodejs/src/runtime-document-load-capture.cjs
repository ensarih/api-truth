'use strict';
// Controlled-process observation only. Signing and protected verification are separate gates.
const Module = require('node:module');
const {createHash} = require('node:crypto');
const {constants, openSync, readSync, closeSync, fstatSync, lstatSync, realpathSync} = require('node:fs');
const {resolve, relative, isAbsolute} = require('node:path');
const {isProxy} = require('node:util/types');
const bindingCapture = require('./runtime-binding-capture.cjs');

const PROFILE = 'swagger-document-load-capture-1';
const DIAGNOSTIC = 'runtime_document_load_unverified';
const DOCUMENT = 'api/swagger/swagger.yaml';
const MAX_BYTES = 1_000_000;
const PINNED = Object.freeze({
  runner: 'b5be162c6fc054e68142381955ab15830df2db7594461d7fc8a7f89e2aeb98e8',
  sway: '0a207e82be5b13e13ef7b96413245e0aab5fab16a28279c5b3ff10a93c6c0d28',
  jsonRefs: '40c88fc102d4cd2b055ba24c2f7c7305b80c1ff222cf341e54ac380d71bc64c6',
  pathLoader: '3b8ffb6e1b3983dc57332c04eec090a5e2786e2fb93c1df4084bced72c8b7988',
  router: 'd716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416',
});
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fileIs = (file, suffix, digest) => {
  if (typeof file !== 'string' || !file.replaceAll('\\', '/').endsWith(suffix)) return false;
  try {
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor), atPath = lstatSync(file);
      if (!before.isFile() || !atPath.isFile() || before.size > MAX_BYTES
        || before.dev !== atPath.dev || before.ino !== atPath.ino) return false;
      const bytes = Buffer.alloc(before.size);
      let total = 0;
      while (total < bytes.length) {
        const count = readSync(descriptor, bytes, total, bytes.length - total, null);
        if (!count) return false;
        total += count;
      }
      const after = fstatSync(descriptor), current = lstatSync(file);
      return before.size === after.size && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs && before.dev === current.dev
        && before.ino === current.ino && sha(bytes) === 'sha256:' + digest;
    } finally {closeSync(descriptor);}
  } catch {return false;}
};
const safe = value => {
  const seen = new Set();
  let nodes = 0;
  const clone = (item, depth) => {
    if (++nodes > 20_000 || depth > 32) throw Error('document limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || isProxy(item) || seen.has(item)) throw Error('document value');
    seen.add(item);
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item)) {
      if (proto !== Array.prototype || item.length > 20_000) throw Error('document array');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).length !== item.length + 1) throw Error('document array shape');
      const result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('document array value');
        result.push(clone(descriptor.value, depth + 1));
      }
      seen.delete(item);
      return result;
    }
    if (proto !== Object.prototype && proto !== null) throw Error('document object');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) throw Error('document key');
    const result = Object.create(null);
    for (const key of Object.keys(descriptors).sort()) {
      // This first profile does not permit even local references. In particular, no
      // remote resolver can fetch a document before the gate has assessed it.
      if (key === '$ref') throw Error('document reference');
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) throw Error('document property');
      Object.defineProperty(result, key, {value: clone(descriptor.value, depth + 1), enumerable: true});
    }
    seen.delete(item);
    return result;
  };
  const canonical = JSON.stringify(clone(value, 0));
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BYTES) throw Error('document canonical limit');
  return sha(canonical);
};

/** The bytes returned here are the bytes the trusted gate supplies to the pinned parser. */
function readDocumentForCapture(serviceRoot) {
  const declaredRoot = resolve(serviceRoot), canonicalRoot = realpathSync(declaredRoot);
  const selected = resolve(declaredRoot, DOCUMENT), expected = resolve(canonicalRoot, DOCUMENT);
  if (isAbsolute(relative(canonicalRoot, expected)) || relative(canonicalRoot, expected).startsWith('..'))
    throw Error('document containment');
  const descriptor = openSync(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor), atPath = lstatSync(selected);
    if (!before.isFile() || !atPath.isFile() || before.dev !== atPath.dev || before.ino !== atPath.ino
      || realpathSync(selected) !== expected || before.size > MAX_BYTES) throw Error('document source');
    const chunks = [], chunk = Buffer.allocUnsafe(65_536);
    let total = 0;
    while (true) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_BYTES + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > MAX_BYTES) throw Error('document size');
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || total !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || realpathSync(selected) !== expected) throw Error('document changed');
    const bytes = Buffer.concat(chunks, total), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw Error('document utf8');
    return Object.freeze({text, rawSha256: sha(bytes)});
  } finally {closeSync(descriptor);}
}
exports.readDocumentForCapture = readDocumentForCapture;

exports.installSwaggerRuntimeDocumentLoadCapture = function(options) {
  const serviceRoot = resolve(options.serviceRoot), canonicalRoot = realpathSync(serviceRoot), selected = resolve(serviceRoot, DOCUMENT);
  const base = bindingCapture.installSwaggerRuntimeBindingCapture(options);
  const originalLoad = Module._load;
  let invalid = false, loads = 0, api, rawSha256, canonicalValueSha256, handlerObserved = false;
  let sawRunner = false, sawSway = false, sawRefs = false, sawPathLoader = false, sawRouter = false;
  const reject = () => {invalid = true; throw Error('Unsupported runtime document load');};
  Module._load = function(specifier, parent, isMain) {
    let filename;
    try {filename = Module._resolveFilename(specifier, parent, isMain);} catch {return originalLoad.apply(this, arguments);}
    if (typeof filename === 'string') {
      const targets = [['/swagger-node-runner/index.js', PINNED.runner], ['/sway/index.js', PINNED.sway],
        ['/json-refs/index.js', PINNED.jsonRefs], ['/path-loader/index.js', PINNED.pathLoader],
        ['/swagger-node-runner/fittings/swagger_router.js', PINNED.router]];
      const target = targets.find(([suffix]) => filename.replaceAll('\\', '/').endsWith(suffix));
      if (target && !fileIs(filename, target[0], target[1])) return reject();
    }
    const loaded = originalLoad.apply(this, arguments);
    if (typeof filename !== 'string') return loaded;
    const normalized = filename.replaceAll('\\', '/');
    if (normalized.endsWith('/swagger-node-runner/index.js')) {
      if (!fileIs(filename, '/swagger-node-runner/index.js', PINNED.runner)) invalid = true;
      else sawRunner = true;
    }
    if (normalized.endsWith('/json-refs/index.js')) {
      if (!fileIs(filename, '/json-refs/index.js', PINNED.jsonRefs)) invalid = true;
      else sawRefs = true;
    }
    if (normalized.endsWith('/path-loader/index.js')) {
      if (!fileIs(filename, '/path-loader/index.js', PINNED.pathLoader)
        || !parent?.filename?.replaceAll('\\', '/').endsWith('/json-refs/index.js')
        || typeof loaded?.load !== 'function') {invalid = true; return loaded;}
      sawPathLoader = true;
      return {...loaded, load(location, loaderOptions) {
        if (invalid || typeof location !== 'string' || location !== selected || ++loads !== 1
          || typeof loaderOptions?.processContent !== 'function') {
          invalid = true;
          return Promise.reject(Error('Unsupported document source'));
        }
        try {
          const raw = readDocumentForCapture(serviceRoot);
          rawSha256 = raw.rawSha256;
          return new Promise((accept, fail) => loaderOptions.processContent(
            {text: raw.text, location}, (error, parsed) => {
              if (error) {invalid = true; fail(Error('Document parse failed')); return;}
              try {safe(parsed);accept(parsed);} catch {invalid = true;fail(Error('Unsupported document value'));}
            }));
        } catch {invalid = true;return Promise.reject(Error('Unsupported document source'));}
      }};
    }
    if (normalized.endsWith('/sway/index.js')) {
      if (!fileIs(filename, '/sway/index.js', PINNED.sway)
        || !parent?.filename?.replaceAll('\\', '/').endsWith('/swagger-node-runner/index.js')
        || typeof loaded?.create !== 'function') {invalid = true; return loaded;}
      sawSway = true;
      return {...loaded, create(swayOptions) {
        if (!swayOptions || swayOptions.definition !== selected) return reject();
        return loaded.create.apply(this, arguments).then(value => {
          try {
            if (loads !== 1 || !rawSha256 || !value || typeof value !== 'object') return reject();
            api = value;
            canonicalValueSha256 = safe(value.definition);
            return value;
          } catch {return reject();}
        });
      }};
    }
    if (normalized.endsWith('/swagger-node-runner/fittings/swagger_router.js')) {
      if (!fileIs(filename, '/swagger-node-runner/fittings/swagger_router.js', PINNED.router)
        || typeof loaded !== 'function') {invalid = true; return loaded;}
      sawRouter = true;
      return function() {
        const route = loaded.apply(this, arguments);
        return function() {
          try {if (!api || safe(api.definition) !== canonicalValueSha256) invalid = true;}
          catch {invalid = true;}
          return route.apply(this, arguments);
        };
      };
    }
    if (parent?.filename?.replaceAll('\\', '/').endsWith('/swagger-node-runner/fittings/swagger_router.js')
      && normalized.startsWith(canonicalRoot.replaceAll('\\', '/') + '/')
      && loaded && typeof loaded === 'object') {
      return new Proxy(loaded, {get(target, property, receiver) {
        const handler = Reflect.get(target, property, receiver);
        if (typeof handler !== 'function' || typeof property !== 'string') return handler;
        return function() {
          handlerObserved = true;
          try {if (!api || safe(api.definition) !== canonicalValueSha256) invalid = true;}
          catch {invalid = true;}
          return Reflect.apply(handler, this, arguments);
        };
      }});
    }
    return loaded;
  };
  const observation = () => {
      try {
        const prior = base.receipt();
        if (invalid || !sawRunner || !sawSway || !sawRefs || !sawPathLoader || !sawRouter
          || loads !== 1 || !rawSha256 || !canonicalValueSha256 || !api || !handlerObserved
          || !Array.isArray(prior.bindings) || prior.bindings.length === 0
          || safe(api.definition) !== canonicalValueSha256) throw Error();
        return Object.freeze({kind: 'unsigned_runtime_document_load', profileVersion: PROFILE,
          source: Object.freeze({repositoryId: prior.repository_id, serviceId: prior.service_id,
            immutableRevision: prior.immutable_revision, sourceDigest: prior.source_digest,
            environment: prior.environment, sessionId: prior.session_id}),
          framework: Object.freeze({nodeVersion: prior.node_version, routerDigest: prior.router_digest,
            runnerDigest: 'sha256:' + PINNED.runner, swayDigest: 'sha256:' + PINNED.sway,
            jsonRefsDigest: 'sha256:' + PINNED.jsonRefs, pathLoaderDigest: 'sha256:' + PINNED.pathLoader}),
          document: Object.freeze({path: DOCUMENT, rawSha256, canonicalValueSha256}),
          bindings: Object.freeze(prior.bindings)});
      } catch {return Object.freeze({kind: 'unresolved', diagnostic: DIAGNOSTIC});}
    };
  return Object.freeze({
    observation,
    receipt() {
      if (observation().kind !== 'unsigned_runtime_document_load')
        throw Error('Runtime document load unverified');
      return base.receipt();
    },
    stop() {Module._load = originalLoad; base.stop();},
  });
};
