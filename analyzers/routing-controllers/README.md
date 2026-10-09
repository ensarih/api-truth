# routing-controllers analyzer profile

`nodejs-routing-controllers@0.8.0` reads a bounded service source tree and emits
a D03 analyzer result. It never executes project code or resolves packages.

Run it locally with `npm run extract:routing-controllers -- --source <service-tree>
--service <service-id> --revision <immutable-hex-revision>`. The command prints
one JSON result to standard output and diagnostic codes to standard error.

The profile recognizes legacy TypeScript decorator syntax imported directly
from `routing-controllers`, including named aliases and namespace imports.
It supports literal `@Controller` and `@JsonController` prefixes; literal
`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, and `@Options` paths;
named `@Param`, `@QueryParam`, and `@HeaderParam`; `@Body` with literal
`required: true` or `required: false` options; and literal
`@HttpCode` and `@ContentType`. Primitive, array, and inline object type
annotations produce declared schemas. The known JSON behavior of
`@JsonController` supplies JSON media type; no status is inferred from the
HTTP method or a return type.

`@QueryParams()` and `@HeaderParams()` with inline object types emit declared
query and header fields. Their runtime requiredness remains unknown, including
for fields without TypeScript's optional marker. A class or imported type is
not expanded by this slice. A field also declared through the matching named
decorator is marked unresolved rather than choosing one of the declarations.
Header name collisions are compared without case sensitivity.

The default profile requires a direct call to `createExpressServer`, `useExpressServer`,
`createKoaServer`, or `useKoaServer` imported from `routing-controllers`. Its
options must contain a `controllers` array of direct class references or a
bounded absolute glob. The array may be reached through imported static `const`
objects. Globs built with an imported `path.join(__dirname, ...)` can select
matching files inside the selected source tree; unsupported or out-of-service
patterns produce diagnostics. A literal or statically resolved `routePrefix`
joins the controller and action paths. Source-to-runtime glob projection remains
unverified, so glob-derived routes have incomplete coverage and inferred route
claims. Without an explicitly selected declaration profile, unregistered
decorated classes emit no endpoints.

Hosts can optionally pass `productionEntrypoint` to `createAnalyzer`, using a
normalized project-relative path such as `services/orders/src/main.ts`. In
this mode the analyzer follows a bounded graph of literal relative runtime
imports and re-exports, then accepts only direct source-level registration
statements in modules reachable from that entrypoint. Unreachable registrations
do not emit endpoints. Type-only imports do not make a module reachable;
dynamic imports, conditional or nested `require` calls, unresolved local imports,
ambiguous paths, and resource-limit failures produce diagnostics and incomplete
coverage. Shadowed `require` identifiers are never treated as module edges.
Known `routing-controllers`, Express, Koa, and Node built-in imports are not
traversed; other bare runtime package imports are diagnosed as unresolved
external source. Destructured bindings and assignments to `require` are treated
as shadowing, and `require` inside `try`/`catch` stays unresolved.
The selected entrypoint and resolved graph participate in the reproducibility
fingerprint. The selected service tree remains digest-bound as a whole.
Coverage still reports `production_entrypoint_deployment_unverified`; the
selection does not prove that a deployment invokes that source file.

This option proves only bounded static source reachability. It does not execute
the application, establish which command a deployment uses, or prove deployed
startup, environment configuration, runtime controller loading, or route
availability. Without this option, the existing extraction behavior is
unchanged.

For services that bootstrap controllers through a separate wrapper, place a
profile JSON file inside the selected production source tree and pass its
relative path with `--profile`. For example:

```json
{
  "profile_version": "1.0.0",
  "decorator_modules": ["@example/route-kit"],
  "binding": "declarations_only",
  "route_prefix": "/api"
}
```

The profile opts in to extracting directly imported decorator declarations
without a visible registration call. It does not prove that the wrapper
re-exports identical decorator behavior, that the controller is loaded at
startup, or that the configured prefix is mounted. Those facts receive
owner-assertion evidence and unresolved diagnostics; route claims are not
eligible as proven runtime behavior. Only use this profile when the wrapper's
decorators follow the recognized `routing-controllers` contract. The profile
path and content are included in the source fingerprint, and malformed,
duplicate-key, or out-of-service profiles are rejected. No package is loaded or
executed during analysis.

The same selected profile can supply `route_prefix` when a direct registration
reads its prefix from an environment variable. In that case, the analyzer still
uses only controllers matched by the static registration list or glob; it does
not emit every decorated class. Without an explicit prefix value, it reports
`route_prefix_unresolved` and emits no potentially incorrect full route path.

Coverage remains incomplete because the request does not identify a proven
production startup entry point. Registration in an unused file cannot establish
runtime exposure. Dynamic or ambiguous registration adds scoped diagnostics.
Dynamic paths, route arrays and patterns, inheritance, re-exports, unsupported
whole-object parameter bindings, passthrough responses, unsupported decorators, missing
type metadata, and source syntax errors also produce scoped diagnostics.
Dynamic route prefixes and version selectors are not applied. A service with
these features must not treat declared routes as a complete runtime inventory.

The analyzer accepts one `source_tree` resolution input at the service root.
All contained JS, TS, JSON, and YAML files affect the digest. Symbolic links,
malformed UTF-8, and source trees above the file and byte budgets are rejected.
Incremental requests use full-service extraction and a distinct fingerprint.

From the repository root, try the synthetic fixture locally:

```sh
npm run --silent extract:routing-controllers -- --source fixtures/nodejs/routing-controllers/orders/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

To use a declaration profile, add `--profile api-truth.routing.json` when that
file is inside the directory supplied by `--source`.

The synthetic glob and environment-prefix example can be checked with:

```sh
npm run --silent extract:routing-controllers -- --source fixtures/nodejs/routing-controllers/glob/src --service pets --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --profile api-truth.routing.json
```

The command writes one D03 JSON result to stdout and diagnostic codes to
stderr. It reports incomplete coverage until the startup entry point can be
verified. The focused tests are
`tests/unit/routing-controllers-analyzer.test.ts` and
`tests/contract/routing-controllers-cli.test.ts`.


The local command accepts `--entrypoint app.ts` to enable this mode relative to `--source`. Installation analyzer selections use `production_entrypoint`; it is pinned in configuration identity. Omitting it keeps explicit declaration discovery. Request object key order does not affect result identities; entrypoint choice, graph changes and source bytes do.
