# routing-controllers analyzer profile

`nodejs-routing-controllers@0.5.0` reads a bounded service source tree and emits
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

`@QueryParams()` with an inline object type emits its declared fields as query
parameters. Their runtime requiredness remains unknown, including for fields
without TypeScript's optional marker. A class or imported type is not expanded
by this slice. A field also declared through `@QueryParam` is marked unresolved
rather than choosing one of the two declarations.

The default profile requires a direct call to `createExpressServer`, `useExpressServer`,
`createKoaServer`, or `useKoaServer` imported from `routing-controllers`. Its
literal options must contain a `controllers` array of direct class references,
including contained relative imports. A literal `routePrefix` joins the
controller and action paths. Without an explicitly selected declaration profile,
unregistered decorated classes emit no endpoints.

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

The command writes one D03 JSON result to stdout and diagnostic codes to
stderr. It reports incomplete coverage until the startup entry point can be
verified. The focused tests are
`tests/unit/routing-controllers-analyzer.test.ts` and
`tests/contract/routing-controllers-cli.test.ts`.
