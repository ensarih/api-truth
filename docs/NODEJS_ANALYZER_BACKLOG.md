# Node.js analyzer expansion backlog

**Status:** active analyzer priority, 2026-10-09
**Current implementation:** `typescript-express@0.5.1` covers a bounded static
Express subset. `nodejs-swagger2-document@0.15.0` reads selected Swagger 2 JSON/YAML
declarations with flat parameter serialization and scalar/flat-array form and multipart-file
extraction. IR 1.1 encoding and qualified export are implemented; runtime binding,
runtime validation and broader constraint eligibility remain open. Qualified
direct form requiredness and scalar format export are implemented.
`nodejs-swagger-express-mw@0.32.0` recognizes one direct default-file
registration shape, composes a valid literal `basePath`, and identifies exact
default or statically configured CommonJS handler source candidates with separate evidence.
Optional trusted captures establish observed handler binding for one exact
source revision, environment and session. Production startup, future dispatch,
response enforcement and installed framework verification remain unverified.
`nodejs-routing-controllers@0.9.0` extracts a bounded literal decorator subset
and binds direct controller registrations. An opt-in, source-bound declaration
profile can identify wrapper imports and emit unregistered candidate routes with
owner-asserted prefix evidence, but cannot prove the startup entry point or
wrapper semantics. Bounded glob lists from imported static configuration select
only contained controller source files, with runtime source projection marked
unverified. Separate selected-document profiles cover bounded OpenAPI 3.0.x
and 3.1.0/3.1.1 subsets. Other decorator frameworks are not currently discovered.

This backlog records the work needed to cover those services without weakening
the project's evidence, identity, isolation, or update guarantees. It was
derived from a temporary design reference that is intentionally not part of the
repository.

## 1. Current coverage

| Flow | Status | Existing capability to reuse |
|---|---|---|
| Literal Express app/router registrations | Implemented within the published D05 support matrix | Endpoint identity, mounted routers, DTO schemas, selected validators, response serialization, evidence, dependencies, diagnostics |
| Swagger 2 JSON/YAML declarations | Initial document-only profile; middleware binding unverified | D03 endpoint/schema/evidence contracts, selected security definitions and basePath claim, and D07 update/difference engine |
| Swagger 2 routes loaded by `swagger-express-mw` | Bounded static registration/configuration, exact CommonJS candidates and optional signed session-scoped observed handler binding; production startup and runtime response enforcement remain open | Document-only profile and its bounded JSON/YAML parsers |
| OpenAPI 3.x document-defined routes | Separate bounded 3.0.x and 3.1.0/3.1.1 selected-document profiles; runtime binding and broader dialect/resource semantics remain open | Shared selected-document reader, bounded parsers and IR 1.1 contracts |
| routing-controllers literal decorators | Initial profile; direct and bounded glob registrations, literal body requiredness, inline `@QueryParams` and `@HeaderParams` fields, and opt-in wrapper declarations; startup entry point unverified | D03 route/parameter/response claims and explicit unsupported diagnostics |
| NestJS, tsoa, inversify, and custom decorator wrappers | Missing | Bounded TypeScript compiler host, schema extraction, handler analysis, D03 contracts |
| Mixed Express/spec/decorator services | Detection and merge policy missing | D03 identity/provenance and D07 deletion safety provide constraints for a future composite design |

D07 is already analyzer-neutral. Once a new adapter emits a valid D03 result,
the existing dependency planner, full-service fallback, deletion guard, and
structured differences apply. Logs and LLMs are downstream enrichment sources;
they must not create deterministic routes that code or an authoritative API
document did not establish.

## 2. Decisions required before implementation

### NB1 — Contract, identity, and authority decisions

**Priority:** P0
**Owners:** D03 contract evolution, D05 analyzer boundary, D08 job binding, D10 export policy

- Define an honest representation for unknown request/response media types and
  for security that was not analyzed. An empty security alternative must never
  be used to mean both “public” and “unknown.”
- Define declared security-scheme evidence needed for faithful later export.
- Keep OpenAPI `servers` declarations outside application route identity unless
  a versioned adapter policy proves an in-process route prefix. Preserve them
  for later D09 exposure/environment evidence.
- Join Swagger 2 `basePath` only for a middleware profile whose documented
  runtime behavior establishes that prefix.
- Evolve D03 with fact-level claims and provenance before reconciling documents
  with code. Each status, media type, schema, parameter rule, serialization
  rule, and security alternative obtained from a source must retain its own
  evidence, authority, and verification category. The normalized selected value
  references the winning claim under an explicit authority matrix; losing or
  incomparable claims remain available through deterministic discrepancy
  diagnostics. Endpoint-level evidence alone is insufficient for this merge.
- Define scoped `success`, `partial`, and `failed` rules. A selected
  authoritative input that cannot be parsed and yields no analyzed scope is a
  failure. Local unsupported constructs beside valid operations are partial.
  Complete empty coverage is allowed only when absence is proven.
- Define closed, versioned adapter options or profile identities for document
  paths, controller roots, framework/version ranges, wrapper aliases, and
  prefix policies. D08 must pin adapter ID/version/options digest and resolution
  inputs in each job and reject mismatched results.

**Acceptance:** fixtures prove that unknown security/media/status/requiredness,
multiple servers, conflicting document/handler facts, and adapter-option changes
cannot become confident defaults or stale cache reuse.

## 3. Shared foundations

### NB2 — Inventory and explicit adapter selection

**Priority:** P0
**Placement:** update the existing pilot decision record; do not create a parallel discovery system.

- Inventory authorized pilot services by routing pattern, package/framework
  version, document dialect, decorator mode, wrapper type, generated metadata,
  global prefix/version/host routing, and mixed-pattern signals.
- Select the first adapter family from measured demand.
- Keep production selection explicit in service configuration. Setup-time
  detection may recommend a profile or report ambiguity; it must not silently
  apply a `decorators > Swagger > Express` priority.
- A branchless inventory tool must remain bounded to an explicitly supplied
  service tree and must not enumerate repository branches.

**Acceptance:** every pilot service has one explicit supported profile or a
visible unsupported/mixed classification; configuration changes force D08
reanalysis through the existing analysis-key boundary.

### NB3 — Shared bounded Node and API-document kernels

**Priority:** P0
**Depends on:** NB1

- Refactor only proven common D05 primitives: contained file collection,
  digesting, TypeScript program setup, result/evidence/dependency builders,
  schema extraction, handler analysis, canonical ordering, resource limits, and
  safe errors.
- Preserve all current Express outputs and diagnostics under regression tests.
- Add one reusable Swagger/OpenAPI document kernel for both middleware-backed
  analysis and future generic document ingestion. Do not duplicate document
  semantics in D10, which is an exporter.
- Define an analyzer-specific affecting-file manifest. Every JS/TS/YAML/JSON
  file and options/alias manifest that can change output participates in the
  reproducibility fingerprint.
- Enforce cumulative byte/node/ref budgets, contained paths and symlinks, safe
  YAML schema with no custom tags, duplicate-key and multi-document rejection,
  malformed UTF-8 handling, JSON Pointer escaping, prototype-pollution key
  rejection, bounded cycles, and no implicit file or URL ref access.

**Acceptance:** existing D05 results remain stable; hostile parsers cannot leak
source text or escape resource limits; no source execution, build hook, package
installation, network, database, log, or model access occurs.

The dated NB4 entries below are historical implementation evidence; earlier
versions and open-gate statements do not describe the current release scope.
The summary above and the main backlog remain the current status ledger.

## 4. Adapter delivery backlog

### NB4 — Swagger 2 middleware adapter

**Priority:** P0 when present in the pilot, otherwise P1
**Adapter identity:** a distinct versioned `nodejs-swagger-express-mw` profile

The middleware `0.18.0` profile recognizes one direct default-file registration, composes
`basePath` under that policy, and records exact controller/operationId source
candidates for bounded CommonJS exports. One strict static default JSON/YAML
configuration can select a declared controller pipeline and contained
directories. Defaults are inferred; custom pipeline declarations carry exact
configuration pointers. Layered/opaque configuration, mocks, fitting overrides,
custom operation pipes, non-middleware interfaces, competing modules,
unverified package scopes, and unsupported exports keep matching unresolved.
Opaque configuration files are counted and content-hashed for invalidation.
Candidates carry Swagger, source, configuration and contained package-scope
evidence, remain inferred, and add no handler-derived contract facts or
dependencies. Environment overrides, effective configuration, framework version
and startup are still unverified. This slice does not complete the
handler-binding or framework-version conformance gate below. The document `0.7.0` and middleware `0.12.0` profiles
also preserve flat parameter collection formats and aggregate bounded scalar
formData/file declarations per consumes media, with exact field/media evidence.
Tabs, nested arrays, unsupported form constraints, URL-encoded files, malformed or
referenced parameter entries, and conflicting payload declarations stay
unresolved. Per-field encoding is retained in IR 1.1 and participates in contract
differences without provenance-only noise. Qualified encoding exports to
OpenAPI; declaration-only or limited evidence cannot enter normative output.
Exact eligible inline form-field requiredness now exports using original
snapshot field pointers, independent of media sorting. Declaration-only
requiredness remains non-normative. Direct scalar formats now export with
exact-value eligible `field_format`
claims and qualifying endpoint evidence. Nested/array-item formats and broader
constraint eligibility remain gated; runtime binding remains open. Legacy IR 1.0 snapshots remain readable; cross-version
comparisons require
a new same-version baseline. The orchestrated Express profile remains pinned
to IR 1.0 until explicit profile selection is implemented.

- Parse bounded Swagger 2 operations, path-level and operation-level parameter
  overrides, body parameters, `consumes`/`produces`, exact/default
  responses, definitions, recursive local references, and operation evidence.
- Preserve supported `collectionFormat` serialization, `formData`, file bodies,
  and global-versus-operation `consumes`/`produces`; diagnose each unsupported
  form instead of silently projecting it to a simpler contract.
- Reject or explicitly diagnose optional Swagger path parameters because runtime
  route identity requires every path parameter.
- Implemented reusable definitions as D03 schema components with canonical
  `#/schemas/...` references. Document `0.6.0` and middleware `0.11.0` also
  preserve bounded `allOf` and boolean/schema `additionalProperties`, including
  recursive/escaped references and dependency fan-out. Malformed forms stay
  diagnosed; runtime validation and normative constraint eligibility remain open.
- Implemented prerequisite: bounded npm v2/v3 wrapper/nearest runner lock
  declarations, exact evidence pointers, source invalidation, and an explicitly
  uncertified `0.7.0`/`0.7.0` conformance target. Missing/unsupported versions
  remain diagnosed; no candidate promotion or installed/runtime proof occurs.
- Implemented behavior prerequisite: an isolated wrapper/runner `0.7.0` pair,
  Express `4.13.3`, Node `22.19.0` and a locked transitive tree. Ten conformance
  tests cover controller/pipe-related selection, directory precedence and
  initialization fallback, missing handlers, mock/environment behavior and
  Node 24 incompatibility. Static analysis stays on Node 24 and candidates
  remain inferred. See the [runtime harness](../tests/conformance/swagger-runtime/README.md).
- Implemented startup/environment prerequisite: a bounded root npm-start
  declaration links the registration filename and exact Node 22.19.0 pin;
  contained source environment inputs get safe limited evidence and suppress
  handler candidates when configuration remains uncertain. No startup execution
  or empty-inventory completeness is inferred. An eleventh runtime test proves
  a source mock-mode override preserves routes and suppresses the candidate.
- Implemented routing-dependency prerequisite: profile `0.8.0` records nearest
  npm lock declarations for bagpipes/config/sway, restricted tested range/version
  pairs and exact specs, safe evidence and unsupported/unverified diagnostics.
  The target flag does not certify the complete installed graph or execution.
- Implemented initialization guard: profile `0.9.0` withholds candidates for
  opaque controller initialization and exports before const initialization.
  Literal/function-only source remains inferred; no execution proof is emitted.
  A twelfth pinned runtime test covers one failing controller with a valid export.
- Implemented local initialization sources: profile `0.10.0` follows bounded
  literal relative CommonJS imports under the syntax guard, records limited
  source/scope evidence, and diagnoses missing/cyclic/opaque/external imports.
  Helper edits invalidate candidates; two additional runtime cases cover working
  and failing helper imports (14 runtime tests). No runtime binding is inferred.
- Implemented declared bounds: document `0.7.0` and middleware `0.12.0`
  preserve finite numeric and nonnegative safe-integer size limits in schemas
  and query/path/header parameters. Exclusive/invalid/conflicting forms remain
  diagnosed, malformed required arrays preserve routes, and limit edits
  invalidate extraction. Runtime validation and normative export stay gated.
- Implemented pattern/enum declarations: document `0.8.0` and middleware `0.13.0`
  preserve bounded, syntax-valid patterns on explicit string schemas and unique
  JSON enum values. Invalid/duplicate declarations produce scoped diagnostics;
  duplicate form enums remain unresolved. Runtime enforcement stays unverified.
- Implemented literal-data traversal: document `0.9.0` and middleware `0.14.0`
  preserve schema-like keys inside JSON enum values. Catalog validation treats
  enum/const values as data and follows references only in schema positions;
  duplicate real schema enums remain rejected.
- Implemented direct create-option declaration: middleware `0.15.0` accepts
  a literal boolean `mockMode` beside `appRoot: __dirname`, with exact source-span
  evidence and precedence over the static file top-level setting. Two pinned
  runtime scenarios verify this precedence (16 runtime tests). Environment
  overrides and authoritative binding remain unverified.
- Implemented explicit npm environment selection: middleware `0.16.0` records
  a bounded POSIX-style `NODE_ENV=<known name> node <entrypoint>` launch
  declaration and selects a static environment mock-mode layer. File/default,
  environment-file and create-option precedence have exact evidence; two more
  pinned runtime cases verify selection (18 runtime tests). Host environment,
  arbitrary layered config and authoritative binding remain unverified.
- Implemented environment controller directories: middleware `0.17.0` permits
  a contained `controllersDirs` replacement for one existing named router.
  Directory evidence comes from the selected layer; other fields retain their
  default-file evidence. A pinned runtime case verifies array replacement
  (19 runtime tests). Dynamic/broader overlays remain unresolved.
- Implemented environment router mock declarations: middleware `0.18.0` also
  supports boolean router mockMode, contained mockControllersDirs replacement,
  and explicit middleware interface. Global or router mock true withholds normal
  candidates; create mock false cannot cancel router mock true. Exact overlay
  evidence and two pinned runtime cases cover this behavior (21 runtime tests).
- Remaining: broader conformance and complete affecting transitive version policy,
  production configuration/startup and module initialization verification. Later
  dated entries record bounded observed binding and inferred handler facts.
- Resolve handlers only through documented middleware/version semantics. The
  first profile must require an exact controller mapping plus `operationId`.
  Bounded symbol search may produce candidate evidence and diagnostics but may
  not attach handler-derived facts when ambiguous.
- Support common contained CommonJS/ESM export forms only when uniquely proven.
- Keep spec-derived endpoints when a handler is unresolved. Attach handler and
  validator dependencies only after authoritative binding.
- Emit discrepancy diagnostics for conflicting document, type, validator, and
  handler facts without changing their authority categories.

**Acceptance:** supported operations emit valid deterministic endpoints;
unresolved handlers do not suppress them; duplicate operation IDs, missing
refs, external refs, ambiguous exports, invalid documents, and unsupported
constructs yield safe scoped diagnostics; a shared definition or handler change
reaches every applicable endpoint through D07.

### NB5 — First decorator framework profile

**Priority:** P0 when dominant in the pilot, otherwise P1

**Profile choice:** `routing-controllers` is the first family, based on the
project owner's priority. The `0.6.0` literal profile is an initial slice,
not completion of this gate.

- Resolve decorators by import provenance, including aliases and namespaces;
  never match a bare name from an unrelated package.
- Implement the chosen framework's controller/method prefix rules, root and
  empty paths, global/router prefixes, inheritance, and legacy versus standard
  decorator syntax as explicitly supported or explicitly incomplete. Diagnose
  regular-expression paths that cannot be represented as stable route identity.
  Path arrays, URI versioning, and host/route selectors belong only to framework
  profiles whose verified semantics support them; do not project them onto
  `routing-controllers` by analogy with another framework.
- Map only proven parameter roles. Path parameters follow route semantics;
  query/header/body optionality in TypeScript does not by itself prove runtime
  requiredness.
- Expand whole-object query/header DTOs only where the framework profile
  defines that binding. Keep named and whole-object decorators distinct.
- A declared return type creates declared schema evidence. It does not invent a
  status code, media type, or runtime serialization. Support framework status
  and response decorators separately; keep unknowns explicit.
- Diagnose unsupported wildcard/all-method routes, dynamic paths, ambiguous
  overloads/inheritance, response passthrough, and missing type metadata without
  erasing other supported endpoints.

**Acceptance:** unrelated same-named decorators emit no route; framework prefix,
version, inheritance, parameter, status, and response semantics have dedicated
fixtures; unsupported scope makes coverage incomplete; results are D03-valid
with stable facts, canonical ordering, IDs, and reproducibility fingerprints;
completion metadata is excluded from determinism comparisons.

### NB6 — OpenAPI 3.0 and bounded 3.1 slices

**Priority:** P1
**Depends on:** NB3 and preferably NB4

- Add OpenAPI 3.0 paths, parameters, `requestBody`, media-specific response
  content, components, and local refs using the shared document kernel.
- Preserve supported parameter `style`, `explode`, and `content`, cookie
  parameters, response headers, and request-body encoding. Diagnose every
  unsupported serialization form rather than dropping it, and reject or
  explicitly diagnose optional path parameters.
- Add a separately documented 3.1 subset only after 3.0 is stable.
- Apply path/operation-level server precedence only as declared exposure
  evidence. Do not choose `servers[0]` or add a server URL path to route identity
  without an explicit adapter policy from NB1.
- Reject implicit remote refs; accept only declared, digest-bound resolution
  inputs within their configured root.

**Acceptance:** media-specific bodies/responses remain distinct, overrides are
correct, multiple/variable servers stay explicit, unsupported dialect features
produce diagnostics, and no environment URL becomes an application route.

### NB7 — Wrapper and additional decorator profiles

**Priority:** P1/P2 by measured demand
**Depends on:** NB5

- Trace transparent relative re-export chains inside the selected service.
- Represent external/custom aliases with a closed, digest-bound profile or
  manifest. Do not crawl arbitrary `node_modules` or trust same-named exports.
- Complete routing-controllers, then add NestJS, tsoa, and inversify profiles one at a time,
  each with pinned versions and an independent support matrix.
- Cover framework-specific global prefixes, generated metadata, default status
  behavior, response/security decorators, middleware, inheritance, and
  parameter roles.

**Acceptance:** circular or behavioral wrappers diagnose safely; each framework
passes its own conformance suite and passing one never implies support for
another.

### NB8 — Mixed-pattern detection and composite decision

**Priority:** P1 detection, P3 extraction
**Depends on:** at least two adapter families

- Add onboarding detection for mixed Express/spec/decorator signals and return
  an explicit ambiguity result.
- Count a foreign routing signal only when bounded evidence connects it to the
  selected production service: an imported/registered production entry point,
  an authoritative configured API document, or framework metadata generated
  for that service. A dependency declaration alone, test/fixture content, dead
  source file, or unrelated same-named decorator cannot downgrade coverage.
- Under a single selected adapter, foreign signals make coverage visibly
  incomplete; never silently hide lower-priority routes.
- If real services require combined extraction, first choose either one
  versioned composite analyzer producing one D03 result or a D03/D06 extension
  for multiple result reconciliation. Define pointer, provenance, identity
  collision, discrepancy, and deletion-safety behavior before implementation.
- Same-operation spec/code facts should reconcile with separate provenance;
  genuinely different handlers require supported selectors or an incomplete
  diagnostic.

**Acceptance:** no route is dropped by trigger priority; composite output, if
implemented, has one deterministic ownership model and passes D03/D06/D07
identity and deletion gates.

## 5. Cross-phase acceptance

The first delivered adapter family must include:

- synthetic baseline/changed/unsupported fixtures with no enterprise source,
  names, URLs, or payloads;
- shared schema/DTO and handler changes, route additions/deletions,
  unresolved-to-resolved transitions, and adapter/config/version changes;
- D07 fan-out, full-service update, incomplete deletion guard, deterministic
  differences, and cross-revision reuse behavior;
- D08 job pinning of adapter/profile/options/resolution inputs and rescheduling
  when any effective input changes;
- later D10 export checks that preserve known statuses/media and reject
  representational gaps without invention;
- later D11 portal/MCP checks that return the same pinned facts and surface
  coverage/diagnostics; and
- later D12 connector checks that invoke only the configured adapter.

Runtime logs may later correlate application routes with deployed/public URLs
and sanitized examples. Semantic providers may later describe purpose and
answer intent questions. Confluence may later add permission-scoped related
pages and discrepancies. None of these sources may create a missing route,
delete an endpoint through absence, or promote requiredness without qualifying
evidence.

## 6. Definition of done for every new analyzer profile

- Dedicated adapter/profile/version/options identity is pinned by configuration,
  D08 job, analyzer request/result, and reproducibility fingerprint.
- The complete affecting-file projection is bounded, contained, hashed, and
  tested.
- Every emitted fact has evidence and an authority/verification category;
  contradictions stay visible.
- Unknown security, status, media, requiredness, serialization, server prefix,
  and handler mapping are never converted into confident defaults.
- Coverage status is scoped and deterministic; failed analysis cannot replace a
  valid snapshot, and partial analysis cannot prove deletion.
- Unsupported framework/dialect constructs, hostile inputs, resource limits,
  and mixed signals have fixtures and safe diagnostics.
- Repeated extraction produces identical facts, canonical ordering, stable IDs,
  and reproducibility fingerprints for fixed inputs. Tests exclude completion
  timestamps and equivalent transport metadata from byte-equality assertions,
  and the complete offline suite remains green.


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

See [capture and trust contract](SWAGGER_RUNTIME_BINDING.md) for setup, limits and validation.


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


### Reusable responses in catalog extraction (2026-10-09)

Document profile `0.10.0` and middleware `0.25.0` expand bounded local reusable
response aliases into normalized endpoint responses. Schemas retain definition
references; media types come from the selecting operation's `produces` or the
root declaration. Missing media types remain unknown. Descriptions are preserved
as status-scoped `response.description` declaration claims.

Scalar string, integer, number and boolean response headers are extracted with
status-scoped `response.header.schema` declaration claims. Selector evidence stays
at the operation; schema, description and header evidence points to the terminal
reusable response. Alias chains and header declarations retain endpoint evidence
dependencies. This applies to inline response headers and descriptions too.

The existing 64-reference local resolver rejects cycles, missing targets, sibling
fields and unsupported references without fetching anything. Unresolved responses
retain their status selector while withholding their fields. Header extraction is
limited to 128 declarations per response. Invalid names, case-insensitive name
conflicts, Content-Type, arrays and unsupported header schemas are diagnosed and
withheld. Array serialization remains pending. These are document declarations;
runtime binding does not prove their validation or promote their authority.

Validation: 921 offline tests and 41 pinned runtime cases. Reusable runtime
fixtures verify catalog schemas, declared scalar headers and response/definition
dependencies alongside existing handler comparisons. Independent review found no
blocker. Broader compositions, dynamic bodies and validator analysis remain
pending in NB4.


### Composed response schemas in handler comparisons (2026-10-09)

Middleware `0.26.0` resolves local definition references inside bounded Swagger
`allOf` response schemas. Type and missing-field comparisons check every branch
and sibling declaration as an intersection, without flattening the documented
schema or merging incompatible constraints. Repeated findings are deduplicated;
reference evidence and endpoint dependencies retain every resolved definition.

Each composition contains 1–32 branches and shares the existing 64-depth,
10,000-node and 128-definition resolution limits. Unsupported branches, malformed
compositions, cycles and exhausted budgets remain unresolved and suppress partial
comparison findings. `anyOf`, `oneOf` and `not` document compositions remain
unsupported. Findings stay inferred source/document discrepancies; no runtime
validation, requiredness inference or normative-contract promotion is added.

Validation: 929 offline tests and 44 pinned runtime cases. Composed matching,
type-conflicting and default required-field responses retain all definition
dependencies. Independent review found no blocker. Broader alternatives, dynamic
bodies and validator analysis remain pending in NB4.


### Linear handler response declarations (2026-10-09)

Middleware `0.27.0` extends the bound-handler source subset with straight-line
local literal `const` declarations and one direct `res.status(201)` statement
before the final returned `json`, `send` or `end` call. A literal body can be
passed through its local constant identifier; JSON shapes retain the initializer's
exact source span and line. Names cannot shadow parameters or reserved names.
No body values, requiredness or runtime serialization guarantees are recorded.

Blocks contain at most 16 single-name constants, one separate status and a final
return (18 statements). All initializers, including unused ones, must satisfy the
existing inert JSON literal parser and its shared 10,000-node/64-depth bounds.
Aliases, mutation, calls, multiple statuses, dynamic values, conditional flow and
unsupported statements remain unresolved. A separate status cannot be combined
with a chained status. The original direct `sendStatus` subset is unchanged.

Validation: 949 offline tests and 48 pinned runtime cases. Local-body matching,
type and missing-field discrepancies and a separately assigned status are
exercised through controlled HTTP dispatch. Independent review found no blocker.
Findings remain inferred source declarations under an observed handler binding;
documented responses and strict OpenAPI authority remain unchanged. Broader
control flow and validator analysis remain pending in NB4.


### Security declaration provenance and invalidation (2026-10-09)

Document profile `0.11.0` and middleware `0.28.0` preserve an explicit empty
`security` array as an endpoint-scoped, declared `security.declaration` claim.
Root declarations and operation overrides retain their exact selected pointers.
Absent or malformed security remains unknown; an empty alternative object is
not silently converted to anonymous access.

Selected declarations and actually referenced, existing scheme definitions add
endpoint evidence dependencies. Scheme provenance is retained even when the IR
cannot represent that scheme; unused definitions do not become dependencies.
Names that are invalid OpenAPI/IR component keys are diagnosed and omitted from
normalized schemes instead of failing the whole analysis. Their raw requirement
claims and escaped source pointers remain available; affected endpoint security
stays unknown. Missing schemes and unsupported OAuth declarations remain unknown.

These are document declarations, not proof of runtime authentication or anonymous
access. Signed handler capture does not promote security claims. Strict OpenAPI
evidence requirements are unchanged.

Validation: 957 offline tests and 48 pinned runtime cases. Root anonymous and
operation override fixtures keep security claims declared even with accepted
handler binding. Unit cases cover used/unused definition provenance, unsupported
schemes, escaped invalid names, missing/malformed declarations and empty
alternatives. Independent review found no blocker. Runtime security enforcement
and normative qualification remain pending in NB4.


### Response schema and media declaration provenance (2026-10-09)

Document profile `0.12.0` and middleware `0.29.0` emit status-scoped declared
`response.schema.declaration` and `response.media.declaration` facts. Schema
provenance points to the concrete inline or terminal reusable response schema;
media provenance points to the selecting operation's `produces` or the inherited
root declaration. Both retain selector/alias evidence and endpoint dependencies.
Schemas are converted once per response rather than once per media type.

A schema with unknown media stays available as a declaration, with its local
schema-definition dependencies, while endpoint content stays empty and no media
claim is invented. Explicit empty `produces` overrides retain an empty media
list declaration. Unsupported aliases preserve only their existing selector;
no schema/media facts are created for them. Schema conversion diagnostics still
mark unsupported details and keep coverage incomplete.

Validation: 962 offline tests and 48 pinned runtime cases. Unit tests cover
reusable selector-specific claim IDs, operation/root media selection, explicit
empty lists, unknown/malformed media and unresolved aliases. Runtime assertions
keep document schema/media facts declared alongside observed handler binding.
Strict OpenAPI qualification and runtime serialization guarantees are unchanged.
Independent review found no blocker.


### Swagger 2 response selection and missing-schema findings (2026-10-09)

Document profile `0.13.0` and middleware `0.30.0` accept exact response status
codes and `default`; range selectors such as `2XX` are diagnosed and omitted.
They are not Swagger 2 response keys, even though the shared IR can represent
ranges for other document dialects. See the [official Swagger 2 Responses
Object](https://spec.openapis.org/oas/v2.0.html#responses-object).

A bounded shared selector uses an own exact-status property before an own
`default` property. Invalid or unresolved exact responses never fall back to a
more permissive default. Invalid statuses and inherited properties select
nothing. Existing source/document type and required-field comparisons use this
same selection.

A bound handler's literal JSON body paired with a concrete response lacking its
own schema now produces inferred `handler.response.body.schema_missing` and
`handler_response_body_schema_missing`. This replaces generic unresolved body
comparison for that specific case. The claim retains source, binding, selector
and reusable-response evidence and reports `examples_present`. It asserts only
a missing schema: examples are not compared, no whole-body documentation claim
is made, and no runtime response guarantee is inferred. Malformed/unresolved
responses or present invalid schemas still remain unresolved.

Validation: 975 offline tests and 52 pinned runtime cases. Cases cover inline and
reusable default responses without schemas, exact-over-default precedence and
examples without schemas. Independent review caught an overly broad initial
predicate; its correction and example case passed follow-up review. Strict
OpenAPI qualification and normalized response authority remain unchanged.


### Earlier local constants in literal JSON responses (2026-10-09)

Middleware `0.31.0` (analyzer package `0.34.0`) supports shorthand properties
and nested object/array fields referencing earlier local literal constants.
For example, `const controller = "orders"; const body = {controller};`
retains a string field in the inferred body shape. Supporting declarations have
exact source spans, claim evidence and endpoint dependencies; literal values
are omitted. The standalone document profile remains `0.13.0`.

Only earlier direct-block constants with inert initializers are accepted.
Direct initializer aliases, forward/self references, calls, mutations and
control flow remain unresolved. Every reference expansion consumes the shared
10,000-node/64-depth budget; the 16-local limit remains. Supporting evidence
includes only declarations reachable from the returned body. These source
findings do not prove runtime response schemas or qualify strict OpenAPI facts.

Validation: 984 offline tests and 55 pinned runtime cases, including shorthand
match, type discrepancy, required-field discrepancy and supporting evidence
links. Independent review found no actionable issue.


### Closed response-object discrepancies (2026-10-09)

Middleware `0.32.0` (package `0.35.0`) compares literal source response fields
against explicit `additionalProperties: false` declarations. Extra fields yield
inferred `handler.response.body.additional_properties.discrepancy` claims and
`handler_response_body_additional_discrepancy` warnings, with source, binding,
selected schema and resolved-definition evidence. Nested objects, array items
and each `allOf` branch retain their own closure scope; sibling/other-branch
properties do not broaden a closed branch. Swagger 2 includes this keyword in
its [Schema Object](https://spec.openapis.org/oas/v2.0.html#schema-object).

Omitted/true closure adds no extra-field restriction. Schema-valued dictionary
constraints, unsupported compositions, malformed schemas and exceeded limits
remain unresolved, suppressing partial findings. Comparison is bounded to
10,000 visits, depth 64 and 32 distinct field paths. No literal values are
recorded. Findings describe source/document differences, do not prove runtime
validation, and do not change normalized schemas or strict export eligibility.
The standalone document profile remains `0.13.0`.

Validation: 1,000 offline tests and 58 pinned runtime cases. Runtime cases cover
matching closed objects, extra fields and reusable definition provenance.
Independent review found no blocker.


### Bounded inventory and OpenAPI 3.0 document profile (2026-10-09)

`inventory:nodejs` takes explicit service roots, production entrypoints and selected documents. It follows bounded literal module graphs without executing code, recognizes exact supported framework registrations, resolves controller symbol identities, and reports mixed, unresolved and unsupported scopes. It does not select an analyzer automatically or enumerate branches.

`openapi3-document@0.1.0` reads one contained JSON/YAML OpenAPI 3.0.x document. Media-specific request/response declarations, parameter override and serialization rules, local references, security and server declarations retain exact pointer provenance. Specification defaults are inferred; malformed/conflicting declarations are withheld or diagnosed. Server URLs remain exposure declarations and never prefix application paths. OpenAPI 3.1, runtime binding and composite routing remain separate gates. See [adapter scope](../analyzers/openapi3/README.md) and [inventory usage](../analyzers/nodejs/INVENTORY.md).


### Configured source manifests through branch updates (2026-10-09)

Analyzer selections can explicitly pin up to 16 ordered, unique `type_manifest` paths. The host and durable worker reject missing/substituted/extra selections; the worker also requires canonical SHA-256 digests and service containment. D07 accepts source-tree plus contained manifests only for full-service fallback execution. D08 conservatively forces full analysis for these inputs, including unchanged source bytes at a new branch revision; this prevents unsafe reuse before a separate multi-input reuse gate. Actual Swagger middleware baseline and successive durable branch jobs pass against PostgreSQL. Runtime receipts, generated sources and classpaths remain rejected. Document-only durable orchestration remains open.


### Minimal Express API-key guard source proof (2026-10-09)

`typescript-express@0.5.0` establishes a header API-key source requirement only for an exact single-app, single-route module and a first guard that rejects mismatched nonempty literal credentials with an empty 401 before continuing. Header names and evidence are emitted; expected credentials are omitted. Extra runtime imports, middleware, registration paths or mutations and unsupported guard control flow leave security unknown. Real analyzed source reaches strict catalog/OpenAPI preparation without fabricated security evidence. The proof concerns source semantics under standard Express, not deployed credentials or observed access control. See the [bounded analyzer scope](../analyzers/typescript/README.md).


### Stable request identities and selected controller startup graph (2026-10-09)

All five compiled analyzer profiles canonicalize JSON object-key order for reproducible request fingerprints. Regression tests previously failed for every profile when the same request was reordered; they now produce identical snapshot/result fingerprints without sorting arrays or changing values. Current profiles are Express `0.5.1`, routing-controllers `0.8.0`, Swagger document `0.14.0`, Swagger middleware `0.33.0` and OpenAPI 3 document `0.1.1`.

Routing's explicit `production_entrypoint` option follows a bounded contained literal runtime import graph and only considers direct top-level framework registration in reachable files. Disconnected registrations, type-only imports, shadowed/destructured require, conditional/try-catch/dynamic loads and unknown external imports cannot establish that graph. Static deployment startup remains unverified. CLI/config/host option selection and configuration-change invalidation are tested. Broader decorator semantics and wrapper/composite profiles remain open.


### Document operation text for semantic discovery (2026-10-09)

Standalone Swagger document `0.15.0` and OpenAPI 3.0 document `0.2.0` retain bounded operation summaries/descriptions as declared claims with exact document-pointer evidence. Invalid or oversized text is withheld with a scoped diagnostic. The Swagger middleware `0.33.0` profile remains unchanged. Semantic projection now checks actual `api_document` evidence, exact source version and snapshot provenance; actual analyzer-produced snapshots exercise the boundary. Document prose is untrusted context and does not establish runtime behavior or normative contract guarantees.


### Protected Swagger document-value comparison (2026-10-09)

The separate Git connector `swagger-document-value-1` profile compares one host-selected default `api/swagger/swagger.yaml` document with a protected signed handler capture from the same immutable source. It requires literal raw document SHA-256, existing supported middleware/startup/routing/lock declarations and an unambiguous method/path/controller/operationId/export/handler-path match. Unsupported references, duplicate route shapes and ambiguous operations receive diagnostics; unmatched declarations never imply runtime absence. The underlying byte verifier additionally checks raw handler bytes, rejecting a decoded-text digest for a BOM-bearing file. The existing parsing/signature kernel still withholds BOM-bearing handler receipts; this slice does not broaden that accepted set.

This is a separate value-correspondence result, not an assertion that the runtime loaded the selected document. No normative contract, deployed state, catalog snapshot or portal/MCP read is promoted by this port. Runtime document-load attestation, qualified persistence/reads and arbitrary document selectors remain open.


### Signed controlled document-load verification (2026-10-10)

The optional Git connector `./protected-document-load` port verifies a
purpose-bound Ed25519 signature over exact canonical scope/observation bytes,
including tenant, against host-selected external hashes and independent full
source/session/framework/document/handler expectations. It rechecks host
authorization, bounds reads and configuration, and returns separate frozen
metadata. The isolated fixture verifies an actual controlled load against
committed Git bytes without a second handler execution. Durable composition,
qualified catalog reads, deployment and normative contract promotion remain open.


### Same-session protected loaded-document comparison (2026-10-10)

Git connector `swagger-loaded-document-1` composes signed loading and protected
Git/document correspondence. Scope, authorization, session, raw/canonical hashes,
ordered handler bindings and complete observed-binding matches must agree.
Protected load evidence and permission are rechecked after source comparison.
Only explicit unobserved declaration diagnostics may survive; they do not imply
API absence. The controlled collector withholds its unsigned binding receipt if
the document gate fails. Durable admission, catalog promotion and deployment
remain separate gates.


### Durable loaded-document comparison summary (2026-10-10)

The orchestration store separately persists the `swagger-loaded-document-1`
composition after matching both its capture association and existing
`protected-handler-bytes-1` summary. Exact host binding, detached bounded proof
validation, transaction-local authorization and locked parent checks precede
commit. Replay is idempotent; conflicting proof and failed finalization are
withheld. Only scope, opaque references, hashes, root/session and counts persist.
Queue admission/execution, current qualified readers and normative/deployment
promotion remain separate work.

Validation: TDD exposed the migration count and reviewed public-export list
changes. Independent review and a clean locked install/typecheck passed all 1,763
offline tests; the complete PostgreSQL suite passed all 461 tests. Real-Git and
signed-load composition, concurrent replay, conflicting/distinct load identities,
missing/forged parents, scoped denial, atomic finalization, immutable rows and
configured-schema lookups are covered.


### Loaded-document admission intent (2026-10-10)

A separate orchestration admission store fixes trusted capture/load/source
bindings and locks existing capture/handler verification, active configuration
and grants. Database-local host policy must explicitly authorize the same load
artifact and configuration activation epoch. Replay and quotas are serialized
per tenant; config switchback creates a new intent after fresh opt-in. The
queued intent shares the durable summary load identity but carries no verifier
output or API facts. Separate leases, execution/atomic completion, stale-job
cleanup and qualified readers remain open.

Validation: the initial TDD run rejected the absent admission module. Independent
review fixed a concurrency-test ordering assumption. A clean locked installation
and typecheck passed all 1,763 offline tests; all 466 PostgreSQL tests passed from
the staged archive. Five focused PostgreSQL cases exercise concurrent replay and
quota, exact load identity, epoch switchback, missing parents, malformed/hostile
inputs, mismatched artifact opt-in, revoked grants and immutable intents.


### Separate loaded-document worker leases (2026-10-10)

The document-profile worker claims and renews separately from handler-byte jobs.
It pins load/job/capture/configuration identities and current independent
execution permission. Migration `0015` separates mutable lifecycle from immutable
admissions and claim history, with backfill and insert-trigger initialization.
Tenant quota tracks active state; worker capacity is two per tenant and one per
repository/service/environment. Database-clock leases expire after 120 seconds;
reclaim rotates token hashes, with a maximum of three claims. Bounded/filtered
no-work results remain partial. Execution/atomic summary completion, retry
scheduling, stale-job cleanup and qualified reads remain open.

Validation: TDD exposed the absent module and incomplete policy fixture.
Independent review corrected environment binding, capacity assertions and legacy
backfill setup. A clean locked install/typecheck passed all 1,763 offline tests;
all 472 PostgreSQL tests passed from the staged archive, including the final
frozen full-binding return. Six focused cases cover upgrade/backfill, independent
environments, concurrent tenant capacity, ownership/token expiry/reclaim, three
attempts, current epoch/grant/artifact fences and immutable token-free history.


### Qualified loaded-document metadata read boundary (2026-10-10)

The separate query reader combines completed controlled-load proof with an exact
current source/environment pin and configuration activation epoch. Read capability
and independent source/environment/artifact read policy are separate from worker
execution or job management. It returns safe digests/counts and fixed limitations,
with no protected references, document body, route or handler content. Logs need
not be enabled. This metadata does not promote normative API or deployment claims.
Portal/MCP presentation and safe incremental multi-input reuse remain open.
