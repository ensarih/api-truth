# routing-controllers analyzer profile

`nodejs-routing-controllers@0.1.0` reads a bounded service source tree and emits
a D03 analyzer result. It never executes project code or resolves packages.

Run it locally with `npm run extract:routing-controllers -- --source <service-tree>
--service <service-id> --revision <immutable-hex-revision>`. The command prints
one JSON result to standard output and diagnostic codes to standard error.

The profile recognizes legacy TypeScript decorator syntax imported directly
from `routing-controllers`, including named aliases and namespace imports.
It supports literal `@Controller` and `@JsonController` prefixes; literal
`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, and `@Options` paths;
named `@Param`, `@QueryParam`, and `@HeaderParam`; `@Body`; and literal
`@HttpCode` and `@ContentType`. Primitive, array, and inline object type
annotations produce declared schemas. The known JSON behavior of
`@JsonController` supplies JSON media type; no status is inferred from the
HTTP method or a return type.

Coverage remains incomplete when controller registration cannot be established.
Dynamic paths, route arrays and patterns, inheritance, re-exports, whole-object
parameter bindings, passthrough responses, unsupported decorators, missing
type metadata, and source syntax errors also produce scoped diagnostics.
Global route prefixes and version selectors are not applied because this
profile has no verified runtime configuration binding. A service with these
features must not treat declared routes as a complete runtime inventory.

The analyzer accepts one `source_tree` resolution input at the service root.
All contained JS, TS, JSON, and YAML files affect the digest. Symbolic links,
malformed UTF-8, and source trees above the file and byte budgets are rejected.
Incremental requests use full-service extraction and a distinct fingerprint.

From the repository root, try the synthetic fixture locally:

```sh
npm run --silent extract:routing-controllers -- --source fixtures/nodejs/routing-controllers/orders/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The command writes one D03 JSON result to stdout and diagnostic codes to
stderr. It will report incomplete coverage until runtime controller registration
can be verified. The focused tests are
`tests/unit/routing-controllers-analyzer.test.ts` and
`tests/contract/routing-controllers-cli.test.ts`.
