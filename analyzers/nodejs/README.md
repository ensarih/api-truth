# Node.js Swagger 2 document analyzer (initial slice)

`nodejs-swagger2-document@0.1.0` reads one explicitly selected, contained
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
incomplete coverage. Unsupported security mapping,
serialization details, form data, and unknown response media remain visible
through diagnostics. YAML, middleware binding, and CI orchestration selection
are subsequent backlog slices.

Run the local checks with `npm run check`. The focused tests are in
`tests/unit/swagger2-document.test.ts`,
`tests/unit/nodejs-document-source.test.ts`, and
`tests/unit/nodejs-swagger-analyzer.test.ts`.
