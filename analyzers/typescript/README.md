# TypeScript/Express analyzer

This package provides the first deterministic, code-first analyzer. It reads a
declared TypeScript/JavaScript service root through the TypeScript compiler API;
it does not import analyzed modules, start the application, run build hooks, use
the network, query a database, or call a model.

The public API is `createAnalyzer({ projectRoot }).analyze(request)` (or the
working-directory convenience export `analyze(request)`). Both return an
`AnalyzerResult` validated by `@api-truth/ir`. The adapter identity is
`typescript-express@0.1.0`; output records TypeScript `5.9.3` and analyzer
configuration `1.0.0` in toolchain claims.

## Local extraction

From the repository root, inspect the baseline fixture directly:

```sh
npm run --silent extract -- --source fixtures/typescript/orders/baseline/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The result JSON is the only stdout content. Coverage diagnostics are written to
stderr. To save the JSON in a disposable file while leaving diagnostics visible:

```sh
npm run --silent extract -- --source fixtures/typescript/orders/baseline/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$(mktemp -t api-truth-orders)"
```

The command accepts `--source`, `--service`, `--revision`, and optional
`--ir-version`. It rejects missing or duplicate arguments, mutable revision
labels, unsupported IR versions, out-of-root inputs, verified SHA-256 digest
mismatches, and resource-limit failures without printing source-sensitive
details. Placeholder or malformed digest labels are replaced with the SHA-256
digest of the source bytes actually read before result identity is computed.

Run the focused suite with `npm run test:extractor`.

## Support matrix

| Area | Supported baseline | Preserved as unknown or diagnostic |
|---|---|---|
| Express setup | Default-import `express()` apps; named/aliased `Router()` and default-import `.Router()` receivers; static app/router factories that directly return their receiver | Unknown receivers, runtime factory selection, and route-builder chains |
| Registration | Literal `get`, `post`, `put`, `patch`, `delete`, `options`, and `head` calls | `all`, computed methods, conditional/loop registrations, and malformed path syntax |
| Mounting | Literal prefixes, imported routers, shared middleware, mount-local middleware, and prefix-scoped middleware | Computed prefixes, dynamic imports, and mount cycles |
| Parameters | Named `:path` fields, accessed query fields, and declared `Request` query generic properties | Runtime query presence without a supported validator remains unknown |
| Declarations | Request body, response, and query generics; interfaces/type aliases; objects, arrays, primitives, literal enums, null unions, optionals, and recursive references | Inheritance, unsupported type members, unresolved types, and opaque fields |
| Runtime validation | Rejecting top-level guards for property presence, `Array.isArray`, and literal-array enumeration, including optional enumeration guards | Other boolean/control-flow conditions; no guessed requiredness |
| Responses | Explicit 100–599 status calls and media types in fluent chains or preceding linear statements on the same response identifier; JSON/send/end serialization shapes; middleware error responses | Missing/dynamic/invalid statuses, branch-dependent state, aliases, missing media types, and unresolved values or spreads |
| Security | Declared middleware is recorded with an unknown guarantee | No inferred scheme, credential semantics, or authorization guarantee |
| Evidence and impact | Source spans, declaration/handler/validator dependencies, and shared/transitive schema dependencies | Any unresolved construct makes coverage incomplete and permits downstream full-service fallback |

Endpoint identity uses service, HTTP method, normalized path shape, and route
selectors. Parameter names remain on endpoint parameters and do not affect the
normalized path shape. Response serialization evidence stays separate from DTO
declarations, and unknown status, media, security, or presence facts are never
defaulted to OpenAPI-friendly values.
