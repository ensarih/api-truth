# Node.js analyzer expansion backlog

**Status:** active analyzer priority, 2026-10-08
**Current implementation:** `typescript-express@0.4.0` covers a bounded static
Express subset. `nodejs-swagger2-document@0.9.0` reads selected Swagger 2 JSON/YAML
declarations with flat parameter serialization and scalar/flat-array form and multipart-file
extraction. IR 1.1 encoding and qualified export are implemented; runtime binding,
runtime validation and broader constraint eligibility remain open. Qualified
direct form requiredness and scalar format export are implemented.
`nodejs-swagger-express-mw@0.17.0` recognizes one direct default-file
registration shape, composes a valid literal `basePath`, and identifies exact
default or statically configured CommonJS handler source candidates with separate evidence.
Effective routing configuration, controller handler binding, framework version,
and production startup remain unverified.
`nodejs-routing-controllers@0.7.0` extracts a bounded literal decorator subset
and binds direct controller registrations. An opt-in, source-bound declaration
profile can identify wrapper imports and emit unregistered candidate routes with
owner-asserted prefix evidence, but cannot prove the startup entry point or
wrapper semantics. Bounded glob lists from imported static configuration select
only contained controller source files, with runtime source projection marked
unverified. OpenAPI 3 and other decorator
frameworks are not currently discovered.

This backlog records the work needed to cover those services without weakening
the project's evidence, identity, isolation, or update guarantees. It was
derived from a temporary design reference that is intentionally not part of the
repository.

## 1. Current coverage

| Flow | Status | Existing capability to reuse |
|---|---|---|
| Literal Express app/router registrations | Implemented within the published D05 support matrix | Endpoint identity, mounted routers, DTO schemas, selected validators, response serialization, evidence, dependencies, diagnostics |
| Swagger 2 JSON/YAML declarations | Initial document-only profile; middleware binding unverified | D03 endpoint/schema/evidence contracts, selected security definitions and basePath claim, and D07 update/difference engine |
| Swagger 2 routes loaded by `swagger-express-mw` | Direct default-file registration, bounded static pipeline declarations and exact CommonJS handler candidates; effective configuration and handler/startup binding remain open | Document-only profile and its bounded JSON/YAML parsers |
| OpenAPI 3.x document-defined routes | Missing | D03 contract model; future reusable document kernel |
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

## 4. Adapter delivery backlog

### NB4 — Swagger 2 middleware adapter

**Priority:** P0 when present in the pilot, otherwise P1
**Adapter identity:** a distinct versioned `nodejs-swagger-express-mw` profile

The middleware `0.17.0` profile recognizes one direct default-file registration, composes
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
  overrides, body parameters, `consumes`/`produces`, exact/range/default
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
- Remaining: broader conformance and complete affecting transitive version policy,
  effective configuration, startup and module initialization before
  authoritative binding and handler-derived facts.
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
