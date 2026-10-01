# Node.js Swagger 2 document analyzer (initial slice)

`nodejs-swagger2-document@0.3.0` reads one explicitly selected, contained
Swagger 2 **JSON or YAML** file. It produces D03 analyzer results for declared
operations, parameters, response status/media/schema, definitions, evidence,
claims, dependencies, and scoped diagnostics. The selected file is supplied as
the sole `type_manifest` resolution input. Its path and bytes determine the
source digest; the adapter rejects mismatched claimed SHA-256 digests, symlinks,
invalid UTF-8, and out-of-service paths. It never executes service code or
reads logs, network, or a model.

This is a document profile, not yet the `nodejs-swagger-express-mw` runtime
profile from [the backlog](../../docs/NODEJS_ANALYZER_BACKLOG.md). It does not
establish that the middleware mounts a route or resolve a handler. Swagger
`host`, `schemes`, and `basePath` are not joined into the application route
identity. A valid `basePath` is retained as a service-level exposure declaration
with source evidence; middleware or gateway evidence must establish where it is
applied. Automatically prepending it here could double-count a prefix or claim
a route that the application does not serve.
JSON parsing rejects duplicate decoded object keys and overly deep structures.
YAML parsing rejects duplicate keys, multiple documents, aliases, custom tags,
prototype keys, and structures over the node or depth limits.
Middleware binding is unverified, so even otherwise valid documents receive
incomplete coverage. Swagger 2 `apiKey` and `basic` security definitions and
requirements retain document evidence; OAuth 2, missing definitions, and
unrepresentable scopes leave operation security unknown with diagnostics.
Unsupported security mapping,
serialization details, form data, and unknown response media remain visible
through diagnostics. Middleware binding and CI orchestration selection are
subsequent backlog slices.

## Try it locally

From the repository root:

```sh
npm run --silent extract:swagger2 -- --source fixtures/nodejs/swagger2/orders --document api/swagger/swagger.json --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

For YAML, use `--document api/swagger/swagger.yaml` with the same fixture.

`--source` is the selected service directory; `--document` is a path inside
that directory. The command writes one D03 JSON result to stdout and diagnostic
codes to stderr. `--revision` must be an immutable 12–128 character hex
revision. This fixture produces one declared GET route and a visible
`middleware_binding_unverified` diagnostic.

Run the local checks with `npm run check`. The focused tests are in
`tests/unit/swagger2-document.test.ts`,
`tests/unit/nodejs-document-source.test.ts`, and
`tests/unit/nodejs-swagger-analyzer.test.ts`.
