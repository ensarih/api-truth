# Node.js Swagger 2 document analyzer (initial slice)

`nodejs-swagger2-document@0.2.0` reads one explicitly selected, contained
Swagger 2 **JSON** file. It produces D03 analyzer results for declared
operations, parameters, response status/media/schema, definitions, evidence,
claims, dependencies, and scoped diagnostics. The selected file is supplied as
the sole `type_manifest` resolution input. Its path and bytes determine the
source digest; the adapter rejects mismatched claimed SHA-256 digests, symlinks,
invalid UTF-8, and out-of-service paths. It never executes service code or
reads logs, network, or a model.

This is a document profile, not yet the `nodejs-swagger-express-mw` runtime
profile from [the backlog](../../docs/NODEJS_ANALYZER_BACKLOG.md). It does not
establish that the middleware mounts a route or resolve a handler. Swagger
`host`, `schemes`, and `basePath` are not joined into the route identity.
JSON parsing rejects duplicate decoded object keys and overly deep structures.
Middleware binding is unverified, so even otherwise valid documents receive
incomplete coverage. Swagger 2 `apiKey` and `basic` security definitions and
requirements retain document evidence; OAuth 2, missing definitions, and
unrepresentable scopes leave operation security unknown with diagnostics.
Unsupported security mapping,
serialization details, form data, and unknown response media remain visible
through diagnostics. YAML, middleware binding, and CI orchestration selection
are subsequent backlog slices.

## Try it locally

From the repository root:

```sh
npm run --silent extract:swagger2 -- --source fixtures/nodejs/swagger2/orders --document api/swagger/swagger.json --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

`--source` is the selected service directory; `--document` is a path inside
that directory. The command writes one D03 JSON result to stdout and diagnostic
codes to stderr. `--revision` must be an immutable 12–128 character hex
revision. This fixture produces one declared GET route and a visible
`middleware_binding_unverified` diagnostic.

Run the local checks with `npm run check`. The focused tests are in
`tests/unit/swagger2-document.test.ts`,
`tests/unit/nodejs-document-source.test.ts`, and
`tests/unit/nodejs-swagger-analyzer.test.ts`.
