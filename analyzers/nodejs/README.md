# Node.js Swagger 2 analyzers

`nodejs-swagger2-document@0.5.0` reads one explicitly selected, contained
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
Unsupported security mapping, serialization details, form fields, and unknown
response media remain visible through diagnostics. The separate direct
middleware profile below covers one registration shape; broader binding and
CI orchestration selection remain backlog items.

## Parameter serialization and form declarations

Both `0.5.0` profiles map flat primitive parameters using the declared
[Swagger 2 parameter rules](https://spec.openapis.org/oas/v2.0.html#parameter-object)
and [OpenAPI serialization styles](https://spec.openapis.org/oas/v3.1.1.html#style-examples):

| Parameter | Supported mapping |
|---|---|
| Scalar query | `form`, `explode: false` |
| Scalar path/header | `simple`, `explode: false` |
| Query array `csv` or omitted collection format | `form`, `explode: false` |
| Path/header array `csv` or omitted collection format | `simple`, `explode: false` |
| Query array `ssv` / `pipes` | `spaceDelimited` / `pipeDelimited`, `explode: false` |
| Query array `multi` | `form`, `explode: true` |

Only primitive array items are supported. Tabs, nested arrays, invalid
location/format combinations, and empty-value overrides retain a
`swagger2-unresolved` serialization marker with a scoped diagnostic; no
replacement delimiter is guessed. Supported mappings carry
`parameter.serialization` declaration claims. Omitted `required` means
optional for non-path parameters and bodies; invalid or missing requiredness
on a path remains unknown.

Scalar and flat primitive-array `formData` fields are grouped into one object schema for each declared
`application/x-www-form-urlencoded` or `multipart/form-data` request media
type. Operation `consumes` overrides the document value. Required form fields
populate the schema's `required` list; any required field makes the body
required, otherwise the body is optional. Field types, descriptions, formats and type-compatible enums are retained.
Exact field and media declarations remain endpoint-scoped evidence. A multipart file becomes a string with
`format: binary`; URL-encoded files remain unresolved in this profile.

Tab-delimited or nested form arrays, unsupported constraints/unknown fields, malformed or referenced parameter
entries, unknown media, duplicate body/form fields within one declaration list,
multiple bodies, and mixed body/form declarations prevent a guessed complete
body. Legitimate operation overrides of path-level declarations still apply.
Documented routes and selected form declaration claims remain available.

The profiles require **IR 1.1.0**; both local commands default to it. Requests to these
profiles explicitly selecting IR 1.0.0 fail before reading source.
Existing IR 1.0 snapshots remain readable; they cannot contain `encoding`.
Readers must be upgraded before consuming IR 1.1 output. Comparisons across
different IR versions remain incompatible; establish a same-version baseline
when moving a service to this profile.

Per-field `encoding` records carry source/media evidence. Scalar fields use
`form` with `explode: false`; arrays use the same supported query
`collectionFormat` mappings above, including repeated `multi` values. File
parts use an `application/octet-stream` content-type declaration under this
bounded binary-file profile. Unsupported fields leave the body unresolved.
Changing a delimiter reaches the contract-difference engine; moving or replacing
evidence alone does not create a contract change.

The compiler can export matched `urlencoded`/`multipart` bodies and their
encoding when exact endpoint evidence qualifies. Declaration-only, limited,
service-wide, or unrelated encoding evidence produces
`UNVERIFIED_FORM_ENCODING` and omits the draft operation. Inline requiredness
and format constraints retain their separate evidence gates. These Swagger
extractions remain partial declarations; this slice does not make them strictly
publishable or establish runtime validation, handler binding, or file MIME
acceptance.

The local upload fixture works with both commands:

```sh
npm run --silent extract:swagger2 -- --source fixtures/nodejs/swagger2/form-data/src --document api/swagger/swagger.yaml --service uploads --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
npm run --silent extract:swagger2-middleware -- --source fixtures/nodejs/swagger2/form-data/src --service uploads --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The focused tests are `tests/unit/swagger2-serialization.test.ts` and
`tests/contract/nodejs-swagger-cli.test.ts`.

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

## Direct swagger-express-mw registration

`nodejs-swagger-express-mw@0.5.0` is a separate, explicitly selected profile.
It reads a bounded service tree and the exact default file
`api/swagger/swagger.yaml`. The first supported source shape is a root entrypoint
that imports `express` and `swagger-express-mw`, creates an Express app, and
calls `SwaggerExpress.create({ appRoot: __dirname }, callback)` with a direct
`middleware.register(app)` inside the callback. A missing, conditional,
ambiguous, or dynamic registration emits no routes and fails the selected
analysis. Other create/registration shapes remain outside this profile.

For that supported registration, the Swagger document's valid literal
`basePath` is composed with each operation path. A missing `basePath` adds no
prefix. Invalid or dynamic prefixes emit no route identity. `host` and
`schemes` are exposure declarations, not application path segments. All
collected source/configuration files and the selected document affect the
fingerprint; the adapter does not execute the service or import packages.
Controller handlers and the production startup entrypoint are still unverified,
so successful extraction remains **partial**. It must not be treated as a
complete runtime inventory or strictly publishable OpenAPI contract.

### Handler source candidates

The profile reads exact `x-swagger-router-controller` declarations at the
operation or path level, with the operation declaration taking precedence.
An explicit `operationId` must identify a unique CommonJS function export.
The bounded source policy searches `api/controllers/<controller>.js` for an
extensionless controller name, or an explicitly named `.js`/`.cjs` file.
Configured contained directories are also supported as described below.
Controller traversal, TypeScript build projections,
directory modules, dynamic/re-exported values, getters, duplicate or mutated
exports, and ESM are unresolved. A `.js` candidate requires its nearest package
scope inside the selected service tree; an unscanned ancestor cannot establish
that scope. Source modules and package-scope files are limited to 1 MB; modules
are limited to 50,000 visited syntax nodes. Each module and package scope is
parsed once per analysis, including when multiple routes share a handler.

Candidates retain separate Swagger declaration, function location, package
scope, and routing configuration evidence. Their `handler.candidate` claims are **inferred**, with
`handler_candidate_unverified` diagnostics. No handler dependencies or
handler-derived parameter, response, or schema facts are attached. Missing or
unsupported candidates preserve the document routes. Explicit custom pipes
and non-middleware `x-controller-interface` overrides leave matching unresolved. Environment overrides,
framework versions, module initialization, and startup remain unverified.

### Static routing configuration

One `config/default.json`, `default.yaml`, or `default.yml` can declare a
`swagger.swaggerControllerPipe` and a bounded `swagger.bagpipes` pipeline ending
in one `swagger_router` fitting. The router must explicitly list contained
`controllersDirs` and `mockControllersDirs`, use non-mock routing, and use the
middleware controller interface. Supported preceding fittings are
`cors`, `swagger_params_parser`, `swagger_security`, `swagger_validator`,
and `express_compatibility`; a static `json_error_handler` error declaration is
also accepted. Inline fittings and named fitting objects are supported.
Directories are limited to eight distinct contained paths and pipelines to
32 entries. Multiple matching source modules or visible competing directory/JSON
modules leave the candidate unresolved.

Absent configuration, or a static configuration with absent/null `bagpipes`,
retains the explicit default-directory assumption. Layered configuration,
dynamic configuration, unsupported formats, mock routing, custom fitting
files, dependency factories, unknown pipeline behavior, and unsupported
directories leave handler matching unresolved. Unknown-format files under
`config/` are counted against the file/byte limits and hashed as opaque bytes;
their contents are never emitted. All collected text and opaque configuration
files enter a sorted, content-hashed manifest for invalidation.

`routing.configuration.declaration` records the declared pipeline and
directories with exact configuration pointers. Defaults remain inferred.
`routing_runtime_overrides_unverified` makes clear that these declarations do
not prove effective configuration: environment variables, alternate config
directories, installed framework versions, module loading and startup are
still unverified. Candidate matching adds no runtime binding or handler-derived
contract facts.

This source policy follows the default-directory/controller lookup inspected
in [swagger-node-runner 0.7.3](https://github.com/apigee-127/swagger-node-runner/blob/866b75f267fa94522cc0233563763af1dd758843/fittings/swagger_router.js)
and its [default pipeline](https://github.com/apigee-127/swagger-node-runner/blob/866b75f267fa94522cc0233563763af1dd758843/index.js).
That reference does not establish the analyzed service's installed version or
effective configuration.

Try the synthetic fixture:

```sh
npm run --silent extract:swagger2-middleware -- --source fixtures/nodejs/swagger2/middleware/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The configured-directory fixture is
`fixtures/nodejs/swagger2/configured-middleware/src`; use it as the source in the
same command.

The focused tests are `tests/unit/swagger2-routing-config.test.ts`,
`tests/unit/swagger2-handler-candidates.test.ts`,
`tests/unit/swagger2-middleware-analyzer.test.ts`, and
`tests/contract/swagger2-middleware-cli.test.ts`.
