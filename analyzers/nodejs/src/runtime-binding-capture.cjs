'use strict';
// Opt-in runtime instrumentation. The offline analyzer never loads this module.
const Module = require('node:module');
const {createHash} = require('node:crypto');
const {readFileSync, realpathSync} = require('node:fs');
const {relative, resolve, isAbsolute} = require('node:path');
const routerDigest = 'sha256:d716c923ac7868402a98a47740e95ee83b0be5c9201daf4e11e0b13fe626f416';
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
let installed = false;
exports.installSwaggerRuntimeBindingCapture = function(options) {
  if (installed || process.version !== 'v22.19.0') throw new Error('Unsupported runtime capture');
  const root = realpathSync(options.serviceRoot);
  for (const key of ['repository_id', 'service_id', 'environment', 'session_id'])
    if (typeof options[key] !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(options[key])) throw new Error('Invalid capture identity');
  if (!/^[a-fA-F0-9]{12,128}$/.test(options.immutable_revision) || !/^sha256:[a-f0-9]{64}$/.test(options.source_digest))
    throw new Error('Invalid capture source');
  installed = true;
  const originalLoad = Module._load, originalCompile = Module.prototype._compile;
  const compiled = new Map(), observations = new Map(), contexts = new Set();
  let frame;
  let invalid = false;
  const contained = file => {
    const path = relative(root, file).replaceAll('\\', '/');
    return !isAbsolute(path) && path !== '..' && !path.startsWith('../') ? path : undefined;
  };
  Module.prototype._compile = function(content, filename) {
    if (contained(filename) !== undefined) {
      if (compiled.size >= 4096 || Buffer.byteLength(content) > 1000000) invalid = true;
      else compiled.set(filename, hash(content));
    }
    return originalCompile.call(this, content, filename);
  };
  Module._load = function(specifier, parent, isMain) {
    const filename = Module._resolveFilename(specifier, parent, isMain);
    const loaded = originalLoad.apply(this, arguments);
    if (typeof filename === 'string' && filename.replaceAll('\\', '/').endsWith('/swagger-node-runner/fittings/swagger_router.js')) {
      if (hash(readFileSync(filename)) !== routerDigest || typeof loaded !== 'function') return loaded;
      return function(definition, pipes) {
        const route = loaded.apply(this, arguments);
        const config = pipes.config.swaggerNodeRunner.config.swagger;
        // Values never leave the capture as clear-text configuration/environment data.
        try {
          if (contexts.size >= 1024) invalid = true;
          else contexts.add(hash(JSON.stringify({definition, config, node: process.version, argv: process.argv})));
        } catch { invalid = true; }
        const mock = !!definition.mockMode || !!config.mockMode;
        return function(context, callback) {
          const previous = frame;
          frame = {context, mock, router: filename};
          try { return route.apply(this, arguments); } finally { frame = previous; }
        };
      };
    }
    if (!frame || frame.mock || !parent || parent.filename !== frame.router || typeof filename !== 'string'
      || !loaded || typeof loaded !== 'object' || contained(filename) === undefined || !compiled.has(filename)) return loaded;
    return new Proxy(loaded, {get(target, property) {
      const value = Reflect.get(target, property, target);
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      if (!descriptor || descriptor.value !== value || typeof value !== 'function' || typeof property !== 'string') return value;
      return function(request, response, callback) {
        try {
          if (frame && !frame.mock && frame.context.request === request) {
            const operation = request.swagger.operation;
            const id = operation.definition.operationId;
            const controller = operation['x-swagger-router-controller'] || operation.pathObject['x-swagger-router-controller'];
            const base = operation.pathObject.api.definition.basePath || '';
            const applicationPath = (base === '/' ? '' : base.replace(/\/$/, '')) + operation.pathObject.path;
            if (property === id && typeof controller === 'string') {
              const observation = {method: operation.method.toUpperCase(), application_path: applicationPath,
                controller, operation_id: id, export_name: property, handler_path: contained(filename),
                handler_digest: compiled.get(filename), mock_mode: false};
              const key = observation.method + ':' + applicationPath;
              const prior = observations.get(key);
              if (prior && JSON.stringify(prior) !== JSON.stringify(observation) || observations.size >= 1024 && !prior) invalid = true;
              else observations.set(key, observation);
            }
          }
        } catch { invalid = true; }
        return Reflect.apply(value, this, arguments);
      };
    }});
  };
  return {
    receipt() {
      if (invalid) throw new Error('Conflicting or incomplete runtime capture');
      const cached = Object.values(require.cache);
      if (cached.length > 4096) throw new Error('Runtime module limit exceeded');
      let bytes = 0;
      const modules = cached.map(module => {
        const content = readFileSync(module.filename); bytes += content.byteLength;
        if (bytes > 64000000) throw new Error('Runtime module byte limit exceeded');
        return [module.filename, hash(content)];
      }).sort();
      return {version: '1.0.0', repository_id: options.repository_id, service_id: options.service_id,
        immutable_revision: options.immutable_revision, source_digest: options.source_digest,
        environment: options.environment, session_id: options.session_id, captured_at: new Date().toISOString(),
        node_version: process.version.slice(1), router_digest: routerDigest,
        runtime_fingerprint: hash(JSON.stringify({modules, contexts: [...contexts].sort()})),
        bindings: [...observations.values()].sort((a, b) => (a.method + a.application_path).localeCompare(b.method + b.application_path))};
    },
    stop() { Module._load = originalLoad; Module.prototype._compile = originalCompile; installed = false; },
  };
};
