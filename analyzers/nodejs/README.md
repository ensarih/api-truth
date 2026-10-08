# Node.js Swagger 2 analyzers

`nodejs-swagger2-document@0.9.0` reads one explicitly selected, contained
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

The document `0.7.0` and middleware `0.12.0` profiles map flat primitive
parameters using the declared
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
`UNVERIFIED_FORM_ENCODING` and omits the draft operation. Inline form
requiredness can export only with an unconditional eligible claim at the exact
snapshot field pointer and qualifying endpoint evidence. Direct scalar form
formats can export with a separate eligible `field_format`
claim whose value matches the schema format at that exact pointer. Source
declarations and encoding proof alone do not establish format eligibility.
These Swagger
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

`nodejs-swagger-express-mw@0.24.0` is a separate, explicitly selected profile.
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


### Locked framework declarations

Middleware profile 0.6 records the declared `swagger-express-mw` and nearest
`swagger-node-runner` versions from one root npm `package-lock.json` or
`npm-shrinkwrap.json` (lockfile v2/v3). Root production dependencies must pin
an exact wrapper version and agree with the lock root. Runner declarations
support an exact version or the bounded `^0.7.0` range. The nearest nested runner
entry takes precedence over the hoisted entry; an invalid nested entry cannot
fall back. Aliases, links, stale roots, overrides, competing npm locks, detected
pnpm/Yarn/Bun locks, conflicting package-manager markers, invalid/oversized JSON and unsupported declarations remain
`framework_version_unverified` gaps. Other package managers remain unsupported.

`framework.lock.declaration` retains exact package/lock JSON Pointers and
revision-scoped evidence. Candidate handlers reference matching endpoint-scoped
lock evidence, and lock changes invalidate the service fingerprint. The
`conformance_target` flag identifies the initial wrapper/runner `0.7.0`/`0.7.0`
target; other readable version pairs emit `framework_version_unsupported`.
This is a target for future behavior tests, not a compatibility certification.

Lock evidence remains limited: it does not establish installed artifacts,
runtime module resolution, environment configuration, startup, or handler
behavior. A target pair still emits `framework_runtime_unverified`; handler
candidates remain inferred and gain no handler-derived facts or dependencies.
The wrapper delegates to the runner, so wrapper version alone is insufficient:
see the tagged [wrapper source](https://github.com/apigee-127/swagger-express/blob/v0.7.0/lib/index.js)
and [runner manifest](https://github.com/apigee-127/swagger-node-runner/blob/v0.7.0/package.json).


### Runtime conformance fixture

The separate [runtime harness](../../tests/conformance/swagger-runtime/README.md)
tests the `0.7.0` wrapper/runner pair and its locked dependency tree against
synthetic services. It checks directory/controller selection, initialization
fallback, missing handlers, mocks and environment overrides. The legacy stack
runs on pinned Node 22.19.0; analysis remains on Node 24.6.0. A negative test
records the legacy stack's Node 24 failure. These behavior tests do not qualify
installed artifacts or effective runtime configuration of a scanned service;
handler candidates remain inferred.


### Startup declarations and environment inputs

Middleware profile `0.7.0` records `startup.entrypoint.declaration` only for an
explicit root `package.json` with `type: commonjs`, exact `engines.node: 22.19.0`,
and `scripts.start: node app.js` (or a root `.cjs` filename) matching the recognized
registration file. Pre/post-start hooks, flags, shell commands, other entrypoints,
ranges, and missing declarations remain unverified. This is a syntactic npm
startup declaration, not proof of deployment or invocation.

A bounded inventory of contained JS/TS files records potential configuration
inputs through direct `process.env` access. It identifies reads, writes/deletes,
computed accesses, whole-environment aliases and imports of the process module.
Selected Node configuration/loader keys and Swagger key families are retained;
values and arbitrary variable names are never included. Unknown Swagger keys
use `swagger_*`; other keys and dynamic or opaque access use `unknown`. Malformed/oversized
sources and exhausted node budgets also leave an opaque gap. The scan observes
syntax, not execution reachability or effective environment values.

`environment.access.declaration` and `startup_environment_unverified` retain
limited exact source evidence. Any detected input blocks source handler
candidates with `handler_environment_unverified`, while documented routes stay
available. Startup declarations and unaffected candidates reference limited
startup evidence. They add no authoritative handler dependencies or facts.
An empty inventory is not proof that external loaders, imported packages,
reflection, global aliases, environment overrides or deployment settings are
absent; all runtime/startup/binding gates remain in place.


### Routing dependency lock declarations

Middleware `0.8.0` additionally records `framework.routing_dependencies.declaration`
for three runner dependencies: `bagpipes`, `config`, and `sway`. The policy walks
bounded npm lock package locations from the runner through its ancestors, taking
the nearest entry; a malformed or linked nearest entry never falls back to a
hoisted copy. Exact dependency specs are supported, as are only the tested
range/version pairs: `^0.1.0` / `0.1.2`, `^1.16.0` / `1.31.0`, and `^1.0.0` / `1.0.0`.
Missing entries, aliases and other ranges remain unverified with diagnostics.

The claim contains selected versions and exact source pointers. Its target flag
requires both the wrapper/runner pair and these three versions to match the
isolated harness. This is a partial lock declaration, not the complete dependency
graph, installed-module identity, integrity verification or runtime certification.
Candidates carry limited endpoint-scoped lock evidence and remain inferred;
handler-derived facts and dependencies still require authoritative binding.


### Controller initialization guard

The guard introduced in middleware `0.9.0` withholds a source handler candidate with
`handler_initialization_unverified` when the controller contains opaque top-level
initialization: calls/imported dependencies, throws, control flow, classes,
property reads, computed object keys or spreads. The bounded syntax subset allows
function declarations, direct export assignments, string directives and const
initializers containing function expressions or literal scalar/array/object
values. Function bodies and parameter defaults are deferred. Exported const
handlers must be initialized before the export assignment; function declarations
may be referenced before their declaration. Duplicate top-level bindings are
also withheld.

This is a conservative source-candidate filter. It never loads modules and does
not certify JavaScript execution, runtime globals, imported dependencies or
production startup. Accepted candidates remain inferred. Unresolved candidates
leave document-derived routes available with partial coverage. A controller edit
invalidates extraction, and diagnostic output contains no exception/source text.


### Local CommonJS initialization sources

Middleware `0.10.0` extends the initialization guard to top-level const
initializers using an unshadowed `require` with one literal relative path.
Contained `.js` and `.cjs` files are inspected recursively using the same bounded
syntax policy. Extensionless paths select a contained `.js` file only; competing
JSON/directory forms stay unresolved. Paths outside the service, external
packages, dynamic calls, import cycles, incompatible nearest package scopes and
opaque initialization withhold the candidate. No service module is executed.

The graph is limited to 32 source files including the controller, 8 import edges
in depth, 1 MB of cumulative source bytes and the analysis time budget. Repeated
imports are deduplicated. Accepted candidates include sorted
`initialization_sources` with endpoint-scoped source and package evidence under
`static-routing-source-candidates-2`. This evidence remains limited and inferred;
it adds no authoritative handler dependency edges or handler-derived contracts.
The complete contained tree is hashed, so helper and package-scope edits
invalidate extraction. This extension does not establish runtime initialization,
external configuration or authoritative handler binding.


### Composed schemas and dictionaries

Document `0.6.0` and middleware `0.11.0` preserve Swagger `allOf` compositions
without flattening or merging their branches. Each composition must contain
1–32 schema objects within the existing depth and document budgets.
`additionalProperties` preserves booleans (including a closed dictionary with
`false`) or a schema object. Empty schema objects stay unconstrained; malformed
forms are omitted with scoped diagnostics and partial coverage.

Local definition references remain reusable canonical `#/schemas/...` references,
including recursive definitions and `~0`/`~1` escaped names. Nested pointer paths,
invalid tilde escapes, invalid literal fragment characters and URI percent-encoded
fragments remain unsupported and
cannot create a schema reference. Endpoint dependencies follow
references through composition branches and dictionary values, so referenced
schema edits reach the affected endpoints. Both inline request/response schemas
and reusable definitions use this conversion.

These remain source declarations. The change does not establish runtime
validation, conditional requiredness or export eligibility. Normative export of
unverified dictionary constraints remains gated by the existing exporter policy.


### Declared numeric and size limits

Document `0.7.0` and middleware `0.12.0` preserve finite `minimum`/`maximum`
declarations and nonnegative safe-integer `minLength`/`maxLength` and
`minItems`/`maxItems` declarations. This applies to reusable and inline schemas,
including nested arrays, compositions and dictionaries, and to query/path/header
parameter schemas. Zero and fractional numeric bounds remain intact.

Unsupported values are omitted with exact source-pointer diagnostics. Strict
exclusive bounds cannot be represented by the current IR, so their associated
bound is omitted with `schema_exclusive_bound_unsupported`; false exclusivity
with a valid numeric bound preserves the equivalent inclusive declaration.
Orphaned flags remain diagnosed. Conflicting minimum/maximum pairs are both
omitted with `schema_bounds_conflict`. The independent opposite bound is retained
when only one exclusive bound is unsupported.

Schema `required` arrays must contain unique nonempty string names (an empty
list is retained). Malformed lists are omitted with `schema_required_unsupported`
instead of failing the complete extraction. These remain declarations with
partial coverage; runtime validation, normative constraint export, form-field
limit support and other constraint keywords remain gated. Limit edits invalidate
extraction without changing endpoint identity. No export eligibility or handler
facts are promoted by this change.


### Declared patterns and enums (2026-10-08)

Document `0.8.0` and middleware `0.13.0` preserve patterns on explicit string
schemas, including query/path/header parameters. Patterns are limited to 4,096
UTF-16 code units and checked with Unicode-mode JavaScript regex compilation,
matching the catalog validator; they are never matched against request input.
Missing/non-string types, malformed patterns and excessive patterns remain
unresolved with pointer-scoped diagnostics. No type is invented.

Enum declarations retain source order and JSON value types, including composite
values. Empty/malformed enums, more than 1,024 members, duplicate JSON values,
and values exceeding depth 32 or 10,000 visited nodes are diagnosed and omitted.
Object key order does not affect duplicate equality; array order does. Duplicate
scalar/form-item enums leave the form body unresolved. Rejected constraint
values are not copied into diagnostics. Constraint edits invalidate extraction
without changing endpoint identity.

These are document declarations. Runtime enforcement and normative constraint
export remain gated; form patterns remain outside the supported form subset.


### Schema positions and literal data (2026-10-08)

Document `0.9.0` and middleware `0.14.0` distinguish enum/default/example data
from schema declarations during inspection. An enum object may contain `$ref`,
`enum` or `properties` keys without creating a reference or a nested constraint.
The catalog likewise preserves enum/const JSON values without translating
references inside them. Reference checks and duplicate-enum checks recurse only
through actual schema positions, including compositions and dictionary schemas.
Properties named `enum` or `default` still receive normal schema validation.
No reference is fetched and no runtime or export authority is promoted.


### Direct middleware mock-mode declaration (2026-10-08)

Middleware `0.15.0` accepts `create({appRoot: __dirname, mockMode: false}, callback)`
with a literal boolean only. This declaration takes precedence over the static
file's top-level `swagger.mockMode` setting, matching the pinned runner. Explicit
true preserves document endpoints and withholds normal controller candidates.
The create option carries exact source-span evidence; option edits invalidate
extraction. Duplicate keys, spreads, dynamic values and additional create
options remain unsupported. Nested router settings are still checked separately.
Two isolated runtime cases verify mock routing and create-over-file precedence.

This does not resolve environment overrides or startup execution. Controller
candidates remain inferred, and no authoritative handler binding is emitted.


### Declared npm environment selection (2026-10-08)

Middleware `0.16.0` recognizes the exact POSIX-style npm start declaration
`NODE_ENV=production node app.js` (also development, test, staging and uat).
The CommonJS manifest, matching root registration entrypoint and exact Node
22.19.0 pin are still required; hooks, additional shell syntax, arbitrary names,
cross-env commands and dynamic values remain unsupported.

This selects at most one matching `config/<environment>.json`, `.yaml` or `.yml`
in addition to at most one default file. The environment file currently supports
only `{ "swagger": { "mockMode": false } }` with a boolean. Declared precedence is
default file, environment file, then literal create option. Other config files,
multiple representations, opaque files and broader environment-layer contents
keep configuration unresolved. Exact environment-file and npm start pointers
are retained; edits participate in the service digest and invalidate extraction.

The analyzer never reads host environment values. This is a launch declaration,
not proof of startup execution, deployment availability, effective environment
or handler binding. Source environment hazards still suppress candidates.
Two fresh-process framework cases verify selected production-file mock behavior;
they do not execute or certify the service's npm start command.


### Environment controller-directory declarations (2026-10-08)

Middleware `0.17.0` expands the selected environment layer to support
`swagger.bagpipes.<router>.controllersDirs`. The router must already exist in
the default file as a named `swagger_router`; the override may change only its
contained directory array. The environment array replaces the default array,
matching the pinned config library. Global boolean mockMode may also be declared
in the same layer. Pipeline changes, new routers, inline routers, other router
fields, empty/escaping/duplicate directories and dynamic files remain unresolved.

Directory-element evidence points to the environment file; unchanged router
name and pipeline evidence points to the default file. Layer edits invalidate
extraction while endpoint identity stays stable. An isolated runtime case proves
directory-array replacement and the selected controller candidate. Host overrides,
startup execution and authoritative handler binding remain unverified.


### Environment router mock declarations (2026-10-08)

Middleware `0.18.0` permits a selected environment file to override `mockMode`,
`mockControllersDirs` and `controllersInterface` on one existing named
`swagger_router`, alongside the previously supported controller-directory list.
Mock mode must be boolean, mock directory lists must be bounded and contained
(empty is supported), and the interface must be exactly `middleware`.
Other fields and interfaces remain unresolved. Arrays replace their default
values; scalar and array-element evidence points to the environment file.

The pinned router enables mocks when either its own mockMode or the global
mockMode is true. A global create option of false does not disable a router's
true setting. Normal handler candidates are therefore withheld for either
true setting, while document endpoints remain available. Two isolated runtime
cases verify environment-selected mocks and disabling a default router mock
setting. Source edits invalidate extraction without changing endpoint identity.
No mock handler binding, effective deployment configuration or authoritative
normal-handler binding is asserted.


### Controlled runtime handler binding (2026-10-08)

Middleware `0.19.0` adds opt-in signed capture receipts. Matching actual normal
handler invocations emit an `observed` binding scoped to the capture session and
environment, with handler-source and receipt dependencies. Mocks, missing
exports, untrusted signatures and stale sources do not bind. Static candidates
remain inferred without a receipt. The offline analyzer never executes service
code. A trusted producer must attest the running tree, revision and environment;
the analyzer caller supplies an external public trust key. Signing alone does
not prove capture origin. This completes the bounded observed-binding slice;
NB4 still includes broader framework profiles, production startup/environment
proof and handler-derived contract extraction.

See [capture and trust contract](../../docs/SWAGGER_RUNTIME_BINDING.md) for setup, limits and validation.


### Bound handler response-status discrepancies (2026-10-08)

Middleware `0.20.0` inspects a bounded CommonJS handler only after a matching
trusted runtime binding. A single returned `res.sendStatus(201)` or
`res.status(201).json/send(literal)`/`end()` expression produces an inferred
`handler.response.status.declaration`, with exact source span and dependencies.
Decimal statuses 100–599 are supported; the response receiver must be the
handler's second simple parameter. Literal JSON bodies are inspected only to
exclude side effects; no body schema is inferred. Other statements, aliases,
branches, dynamic statuses/payloads and unsupported modules remain unresolved.

A status missing from the document's response keys produces an endpoint-scoped
`handler_response_status_discrepancy` warning linking both sources. An exact
matching key or `default` prevents that warning. The warning is a discrepancy
between declarations, not proof of undocumented runtime behavior. Handler
binding does not certify Express method integrity or that a response completed.
Documented endpoint responses and OpenAPI eligibility remain unchanged. Stale
or untrusted receipts cannot produce these handler declarations. Broader flow,
validator and response-schema extraction remain in NB4.

Validation: 863 offline tests and 29 pinned runtime cases, including actual
matching, mismatching and default-response dispatch. Independent review found
no blocker in authority, matching, evidence or bounded-source handling.


### Bound literal JSON response bodies (2026-10-08)

Middleware `0.21.0` extracts a type-only shape from the existing bounded,
single-return `res.status(...).json(literal)` profile after accepting a signed
handler binding. It emits an inferred `handler.response.body.declaration` with
exact body-span evidence and a source dependency. Literal values, requiredness,
const/enum, media guarantees and additional-property constraints are omitted.
Empty arrays have unknown items; mixed arrays retain at most 32 type variants.
Depth and node budgets are bounded. Nonfinite numbers, duplicate/reserved keys,
getters, holes, spreads, computed fields and dynamic payloads stay unresolved.
`send`, `sendStatus` and `end` do not create JSON body declarations.

The exact status response, or `default`, is compared for explicit type differences
at matching fields and array items. Integer shapes satisfy declared number types.
The comparison ignores requiredness, extra fields and value constraints; refs,
compositions and unsupported schemas remain unresolved. Differences create
`handler.response.body.type.discrepancy` claims naming paths and an endpoint-scoped
warning. No matching-schema assertion or runtime response contract is made.
Documented endpoint schemas and OpenAPI eligibility remain unchanged.

Validation: 878 offline tests plus 32 pinned runtime cases. Actual matching,
mismatching and referenced-schema fixture responses exercise the new path.
Independent review found no blocker. Dynamic DTOs, validator analysis and broader
response flows remain pending in NB4.


### Documented required response-field discrepancies (2026-10-08)

Middleware `0.22.0` compares documented required fields with accepted bound
handlers' literal JSON body shapes. It emits inferred
`handler.response.body.required.discrepancy` claims naming missing paths and
endpoint-scoped `handler_response_body_required_discrepancy` warnings. Source
literal presence does not establish contract requiredness; documented required
lists and endpoint schemas remain unchanged. A null-valued key counts as present.
Nested objects and known array item variants are supported; empty arrays do not
invent missing items. Type discrepancies remain a separate comparison.

Exact-status responses take precedence over default responses. Malformed or
duplicate required lists, references/compositions, unsupported schemas and
comparison limits remain unresolved, with no partial absence findings. Presence
comparison is bounded to 10,000 visited entries, depth 64 and 32 missing paths.
Source body values are still omitted. These warnings compare declarations, not
actual serialized responses or validation guarantees. Dynamic DTOs, validators
and broader control flow remain pending in NB4.

Validation: 890 offline tests and 35 pinned runtime cases, including missing,
present and null-valued documented required fields.


### Local definition references in response comparisons (2026-10-08)

Middleware `0.23.0` resolves bounded response-schema references to local Swagger
`definitions` before comparing accepted bound handlers' literal bodies. Exact
single-key `#/definitions/<escaped-name>` references may chain and appear in
schema properties/items. Repeated targets are supported with unique provenance.
Referenced definition evidence and dependencies are attached to affected endpoints
and discrepancy claims, so shared definitions participate in invalidation.

Expansion is bounded to 10,000 schema nodes, depth 64 and 128 definition targets.
Cycles, missing targets, reference siblings, reserved names, percent-encoded
fragments, non-definition pointers and file/URL references stay unresolved.
Metadata such as default/example values is not traversed for references.
Composed schemas and broader reference forms remain outside this comparison
profile. Endpoint schemas retain their original document references; source
body/type/required-field claims remain inferred and do not establish runtime
validation or serialization. No file or network reference is fetched.

Validation: 904 offline tests and 38 pinned runtime cases. Referenced matching,
type-conflicting, required-field-conflicting and cyclic schemas are covered.
Broader schema composition, response-object refs and validator analysis remain
pending in NB4.


### Reusable response objects in handler comparisons (2026-10-09)

Middleware `0.24.0` resolves exact local `#/responses/<escaped-name>` chains for
bound-handler body comparisons, then applies the existing local-definition
schema resolver. Exact statuses still precede `default`. Concrete responses
require a string description and supported description/schema/headers/examples
or extension fields; refs with siblings remain unresolved. References must use
one contained escaped name. Cycles, missing targets, external/file references,
percent fragments and chains beyond 64 references remain unresolved.

Comparison claims retain source-body, runtime-binding, selector, response-chain,
terminal-schema and definition evidence. Resolved response objects add endpoint
dependencies alongside definitions. No requiredness or validation is inferred
from the runtime binding. The general document parser and normalized endpoint
responses are unchanged; this slice does not add response-object expansion to
catalog contract extraction or OpenAPI publication.

Validation: 916 offline tests and 41 pinned runtime cases. Reusable matching and
type-conflicting responses and a default reusable required-field response are
covered. Independent review found no blocker. General response extraction,
compositions, dynamic bodies and validator analysis remain pending in NB4.
