# API Truth — Development backlog

**Updated:** 2026-10-09
**Source of truth for work status:** this file
**Scope:** public synthetic-fixture development; an enterprise pilot requires separately authorized inputs.

This backlog tracks delivery work and its acceptance gates. The [product
specification](SPECIFICATION.md) defines the intended behavior, the [roadmap](ROADMAP.md)
defines phase gates, and the [Node.js analyzer backlog](NODEJS_ANALYZER_BACKLOG.md)
contains the detailed adapter expansion. A **complete** status means implemented,
reviewed, and validated; it does not imply that a later phase is complete.

## Agreed execution priority — 2026-10-09

1. Close critical Node.js analyzer gaps within explicit supported profiles.
2. Verify the source-to-catalog-to-OpenAPI/portal/MCP path without promoting
   declarations or observations to unverified normative contracts.
3. Add sanitized log correlation, deployed URL mapping and request/response examples.
4. Add grounded semantic API discovery with selectable OpenAI, Gemini and Claude providers.
5. Complete live CI/CD provider wiring and environment integration.
6. Add the Java/Spring analyzer and its conformance gate.
7. Add permission-scoped Confluence context and documentation discrepancies.

This order supersedes the earlier assumption that Java precedes runtime and
semantic work. Existing phase and backlog IDs remain stable. Incremental updates,
configured branch selection, provenance and environment distinctions remain
requirements throughout; live-provider completion moves later, not out of scope.

## Autonomous completion queue — 2026-10-09

The owner authorized completing the maintained backlog without step-by-step
approval. Work proceeds through tested, independently reviewed commits; an
item remains open until its acceptance gate passes. Credentials or private pilot
inputs are not assumed. Public synthetic conformance is separate from a live
provider or enterprise pilot claim.

| ID | Status | Next acceptance work |
|---|---|---|
| NB1-WIRE | Complete | Configured IR pins D08 identities and job columns; real Swagger IR 1.1 baseline reaches durable catalog, resolver wire substitution is rejected. 1,007 offline and 218 PostgreSQL tests pass; independent review found no blocker. |
| NB1-PROFILES | In progress | Exact compiled-in dispatch is implemented and reviewed for five bounded profiles; configured source-manifest paths are pinned and multi-input full-service branch updates pass through D07/D08. Bounded standalone Swagger/OpenAPI document orchestration is also supported with one exact config-pinned input and full reanalysis. Independent runtime receipt/key identity and safe multi-input reuse remain open. Runtime observations are rejected by D08 until separately pinned. |
| NB2 / NB8-DETECT | Complete bounded slice | Offline onboarding inventory resolves production-connected literal imports and controller identities, classifies mixed/unsupported services, and exposes a contained local CLI. Composite extraction and reconciliation remain NB8-COMPOSE. |
| NB3 / NB4 | Open | Cross-adapter hostile-input/invalidation matrix and complete bounded Swagger profile gate. |
| NB5 | Open | Decorator framework conformance and source-to-downstream update gate. |
| NB6 | In progress | Separate bounded OpenAPI 3.0 and 3.1 JSON/YAML profiles and CLIs implemented; broader 2020-12 dialect, resource and reference semantics remain open. |
| NB7 / NB8-COMPOSE | Open | Independent wrapper/framework profiles; explicit composite identity/provenance/deletion design and tests. |
| D13-S1 | Open | One analyzer-backed lifecycle through publication and consistent portal/MCP/export; preserve strict evidence gates. |
| P3-LOGS | In progress | Sanitization, unambiguous environment URL correlation and safe examples. |
| P4-SEMANTICS | In progress | Grounded selected-operation intent discovery and authorized provider adapters; undocumented code context, corpus retrieval, persistence/review and evaluation remain open. |
| D12-S0/S2 | Open | Live provider facts, artifacts, ordering, authentication and environment wiring. |
| P2-JAVA | In progress | Bounded Spring AST profile and actual Git-to-D08 update implemented; broader Spring contracts, two-ecosystem conformance and downstream lifecycle remain. |
| P5-DOCS | Open | Permission-scoped Confluence context and discrepancy review. |
| D13-S2 / P6-OPS | Open | Release hygiene, capacity/recovery/access audits and reproducible operating gates. |

## Current position

| Work | Status | Evidence or next gate |
|---|---|---|
| D01–D07 | Complete | Synthetic constraints/fixtures, executable contracts, local test harness, bounded Express extraction, PostgreSQL catalog, and dependency-aware updates are committed. |
| D08 | Complete: slices 0–7 | PR previews, exact reconciliation, durable scheduling, safe status reads, bounded observer signals, and local lifecycle pass the final gate. |
| D09 | Complete: slices 0–4 | Deployment facts, serving checkpoints, exact-scope repair, authorized views, and the local lifecycle pass 320 offline and 181 PostgreSQL tests. Independent review findings on request races, removed scopes, migration cutover, and stale views are fixed. |
| D10 | Complete: slices 0–4 | Evidence-gated OpenAPI 3.1 compilation, safe `consumes` variant aggregation, durable revision/branch/environment publication, offline official-schema validation, and a local round trip pass full suites. |
| D11–D13 | D11 complete; D12–D13 in progress | Shared authorized query, portal, and MCP gates pass; provider wiring, full lifecycle publication, and release readiness remain. |
| Phases 2–6 | Planned | Java/framework conformance, runtime evidence, semantic discovery, related documents, and operating readiness follow their roadmap gates. |

The first working release requires the complete Phase 1 loop. The implemented
components still need a live provider connection and the full release scenario.
`main` may lag `development` while a task is under review.

## Completed event orchestration

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D08-S6 | Complete | Isolated PR previews; exact branch and PR reconciliation; missed-event repair; confirmed branch absence; configuration-change reconciliation. | Exact branch/PR scope validation, closed-PR protection, base prerequisite, absence, no-work replay, durable scheduler duplicate/conflict, stale-generation and configuration-change races pass PostgreSQL lifecycle tests; 307 offline and 141 PostgreSQL tests pass. |
| D08-S7 | Complete | Local round trip, truthful package and architecture docs, status/observer projections, privacy and failure hardening. | Independent review found missing observer and active-configuration status disclosure; both were fixed with tests. The observer emits fixed, bounded ingress/job/reconciliation/catalog/outbox signals without scope IDs or error text; denied ingress needs no database write. Missing and denied active-configuration status share one error. Full focused orchestration suite passes 85/85; typecheck and privacy checks pass. |

The detailed D08 implementation brief is a local working document. These two
rows remain in this tracked backlog so the outstanding work survives outside
that brief. Reviewed D08 slices 0–5 stay complete; new defects reopen the
affected slice rather than being hidden in a later task.

## First working release gates — D09–D11 complete, D12–D13 open

| ID | Depends on | Work | Acceptance gate |
|---|---|---|---|
| D09 | D08 | Deployment and configuration facts; artifact-to-revision binding; environment and exposure resolution. | UAT-only deployment, partial failed rollout, mixed or unknown serving state, and confirmed rollback resolve without equating a branch tip with deployment. |
| D10 | D08–D09 | OpenAPI compiler and atomic publication manifests. | Known facts export faithfully; same-method/path variants are scoped or rejected with diagnostics; representational gaps never broaden a contract; failed publication preserves the last valid artifact. |
| D11 | D06, D09–D10 | Authorized query layer, minimal environment-aware portal, and initial read-only MCP tools. | Portal, MCP, and export read the same pinned contract and environment; unauthorized and revoked reads fail closed. |
| D12 | D08–D11 | Provider-neutral event/CLI boundary and one public reference CI/deployment fixture workflow. | PR preview, merge, UAT deployment, failed rollout, rollback, duplicate event, and missed-event repair run automatically after baseline without a manual rescan. |
| D13 | D08–D12 | Phase 1 release gate, installation/setup guide, support matrix, and public synthetic demonstration. | The nine-step [Phase 1 scenario](ROADMAP.md#exit-gate-1) passes end to end with test evidence, known limits, and reproducible setup. |

Deliver D09–D13 in reviewable slices. A row closes only when its acceptance gate
passes with committed evidence; a design or passing unit test alone does not
close a product flow.

### D09 slices

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D09-S0 | Complete | Pure resolution from separately supplied attempt, authoritative serving inventory, exact artifact binding, and revision snapshot facts. | UAT-only, confirmed absence, failed mixed rollout, rollback request, unknown/incomplete inventory, missing/conflicting binding, and missing/conflicting analysis pass offline tests. No persistence or current-environment claim. |
| D09-S1 | Complete | Persist immutable deployment attempts and exact artifact-to-revision bindings from D08-authenticated events. | Migration prerequisite/replay/checksum, unauthorized worker/producer, tenant isolation, unknown revision, crash/replay, concurrent duplicate, and conflicting binding pass PostgreSQL tests. Automated outbox consumption is later work. |
| D09-S2 | Complete | Persist ordered serving observations and exact-scope reconciliation. | Immutable observations and serialized checkpoints distinguish absence, mixed state, rollback, and unknown inventory. The explicit provider port queries one exact scope; D08 authenticates its response, and version/configuration CAS rejects stale confirmation. Opaque order can be resolved without inventing order. Unknown/incomplete inventory remains pending. 320 offline and 160 PostgreSQL tests pass; the competing-confirmation race passed three repeated runs. Automatic delivery remains D09-S4 work. |
| D09-S3 | Complete | Bind observed revisions to D06 snapshots and expose authorized environment views. | A repeatable-read query checks active service/environment/source scopes and current snapshot grants, validates D06 snapshot integrity, and binds only exact tenant/repository/service/revision/configuration matches. Missing analysis remains pending; a branch pointer alone yields unknown deployment; UAT-only, confirmed absence, failed mixed rollout, revocation, tenant isolation, and configuration changes pass PostgreSQL tests. 320 offline and 163 PostgreSQL tests pass. |
| D09-S4 | Complete | Local deployment lifecycle workflow, documentation, and final hardening. | The bounded inbox and reconciliation workers use leases and safe retries. A local event-to-view test covers UAT deployment, failed mixed rollout, rollback request, and exact rollback confirmation. Configured environments with no checkpoint are discovered, superseded configurations trigger rechecks, and a configurable periodic exact check repairs a missed event without a code rescan. D08 environment-specific requests schedule immediate repair; older queued events cannot erase them, concurrent requests escape stale backoff, and scopes removed before a claim are retired. Migration cutover preserves concurrent requests. Pending repair withholds a previously resolved snapshot or confirmed absence. Independent review findings are fixed; 320 offline and 181 PostgreSQL tests pass. |

### D10 slices

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D10-S0 | Complete | Validate a D03 snapshot and group candidate OpenAPI operations by projected method/path shape. | Deterministic groups retain every endpoint ID, including distinct selector variants and alternate placeholder names. Unsupported methods and route syntax receive diagnostics; no group is claimed exportable. Independent review findings are addressed; 325 offline tests pass. |
| D10-S1 | Complete | Compile one representable operation, schemas, parameters, bodies, responses, security, and evidence gaps. | Explicit security state and evidence-backed scheme definitions flow through IR, analyzer results, catalog snapshots, and contract differences. Draft compilation diagnoses or omits gaps; strict compilation returns no document for incomplete coverage, unsupported selectors/variants, weak evidence, unknown requiredness/status/security, conflicting path templates, or unverified constraints. Independent review findings on requiredness scope, conditional claims, path templates, and parameter serialization defaults are addressed. 348 offline and 181 PostgreSQL tests pass. |
| D10-S2 | Complete | Faithful variant aggregation or explicitly scoped export. | Concrete, disjoint `consumes` variants with matching required bodies and identical non-request contracts aggregate without losing per-media schemas. Selected-single `consumes` is supported when it exactly matches request media. Header/query/produces selectors, overlapping or malformed media, mismatched response/parameter/security facts, weak evidence, optional bodies, and conflicting path names receive diagnostics and are omitted from draft output; strict export rejects them. Independent review's media-overlap finding is fixed; 355 offline tests pass. Explicit variant-scoped export is not yet supported. |
| D10-S3 | Complete | Immutable validated artifacts and atomic publication manifests. | Pure preparation validates revision/branch/environment assertions and hashes canonical bytes. PostgreSQL stores immutable tenant-scoped artifacts and provenance-bound publications. Revision, branch, and resolved environment publication promote a versioned pointer after checking the authoritative selection, snapshot, grants, and bytes in one transaction. Current reads withhold stale selections, including a deleted branch with a retained catalog pointer. Historical reads recompile and verify manifest provenance; environment reads recheck pinned deployment/source scopes. Migration upgrade, failure rollback, stale CAS, revocation, Unicode scopes, and local UAT publication tests pass. Independent review findings are fixed; 360 offline and 195 PostgreSQL tests pass. External OpenAPI validation is D10-S4. |
| D10-S4 | Complete | Local compiler/publication round trip and documentation. | A synthetic local CLI and integration test exercise strict preparation, deterministic replay, stale-pointer rejection, recovery, and historical read. The publisher validates offline against a pinned official OAI 3.1 document schema plus local references, JSON Schemas, and verifiable examples. External references and unverifiable examples fail closed. 369 offline and 196 PostgreSQL tests pass; clean dependency install, typecheck, and CLI round trip pass. |

### D11 slices

The portal, MCP tools, and export must read one shared authorized query service.
Every current selection names an environment, branch, or exact revision; an
omitted selector never defaults to production. A pending, mixed, unknown, or
confirmed absent environment has an explicit state and no usable current
contract. Historical publications require an explicit publication ID and a
current permission check.

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D11-S0 | Complete | Versioned query selector and environment-state contract. | Plain-data input validation requires tenant, repository, service, and explicit selector. A pure projection yields a usable snapshot pin only for a resolved, deployed, reconciliation-free environment; all other states carry no usable snapshot. Six focused tests and typecheck pass. No database authorization claim. |
| D11-S1 | Complete | Consistent authorized service discovery and contract reads. | Policy-filtered service search and exact endpoint/schema/changes/environment comparison use one resolved pin. Tenant, grant, source-scope, stale branch, and environment ambiguity tests fail closed. The reader checks selection and authorization in one repeatable-read transaction. Eight query unit and ten PostgreSQL integration tests pass; search limits fail explicitly. |
| D11-S2 | Complete | Bind query results to published OpenAPI and historical reads. | Query and export use the same D10 validator in one transaction and agree on publication ID, snapshot, revision, configuration, and selector pin. Strict-export absence is explicit; superseded branch/environment publication is never current. Historical reads recheck grants and stored environment scopes. Integration tests cover supersession, revocation, and concurrent promotion. |
| D11-S3 | Complete | Minimal environment-aware portal. | Host-authenticated service browsing, explicit revision/branch/environment selection, contract summary with coverage and analysis time, endpoint/schema/evidence detail, comparison, and scoped immutable OpenAPI download use the shared query layer. Client tenant spoofing is rejected; unknown states expose no contract. Unit, PostgreSQL HTTP, and real-browser interaction tests cover the selected service, endpoint detail, publication download, unknown state, and revocation; D11-S4 covers cross-surface conformance. |
| D11-S4 | Complete | Read-only MCP tools and cross-surface gate. | Five official-protocol MCP tools cover service search, contract, endpoint, schema, and comparison using explicit selectors and the shared query reader. Inputs/results are bounded, identity is supplied only by the host, and no administrative tools are exposed. Linked protocol tests plus PostgreSQL-backed immutable-revision and UAT-environment tests prove the same portal/MCP/export publication pin and revocation. Safe examples wait for Phase 3 evidence. |

### D12 slices

The reference automation connects the already implemented event and deployment
boundaries to one public, synthetic GitHub Actions workflow. Enterprise CI/CD
products can use the same provider-neutral envelope later. Branch selection is
the configured exact `intended_branches` list; a provider event never expands
it into an all-branches scan.

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D12-S0 | In progress | Provider-neutral local event and deployment adapter. | A bounded local formatter normalizes PR, branch, deployment attempt, explicit serving observation, and reconciliation facts to validated D03 event envelopes. A host-attested local bridge checks exact fact bytes and digest, active configuration, provider/reference, and known artifacts before D08 durable ingestion. A GitHub verifier checks raw-body HMAC-SHA256, bounded bytes, delivery metadata, and atomic replay claims; supported verified push/PR payloads yield only a reconciliation trigger, not invented ordering or branch state. Unit and PostgreSQL tests cover duplicate, stale, rejected, and seven-event delivery. Current-provider lookup, ordered facts, artifact provenance, and live provider wiring remain. |
| D12-S1 | Complete | Reference GitHub Actions workflow and synthetic fixture driver. | The synthetic-only workflow pins actions and Node, uses a read-only token and no persisted checkout credentials, skips forked PRs, applies exact branch selection, and uploads seven validated baseline/PR/merge/UAT/reconciliation envelopes. The local driver and security tests pass; it does not ingest events or deploy. |
| D12-S2 | In progress | Automatic lifecycle and repair verification. | One PostgreSQL-backed synthetic flow now drives baseline, isolated PR preview, merge and branch advancement, UAT-only serving, failed attempt, authoritative mixed observation, rollback request, confirmed serving rollback, duplicate/stale replay, and missed-observation repair through the durable ledger/workers without a manual rescan. D10 honestly reports the analyzer-backed snapshot as not strictly publishable. Live provider wiring and publication/query agreement for that analyzer-backed flow remain. |

### D13 slices

Phase 1 closes only when the complete path works from a fresh checkout and its
limitations are stated plainly. A local synthetic run proves the mechanics;
it does not substitute for a protected enterprise pilot.

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D13-S0 | Complete | Fresh-checkout setup and operator guide. | The local guide records pinned runtime, disposable PostgreSQL, initial configuration and authentication ports, TypeScript/Express support, synthetic extraction-to-catalog and OpenAPI demos, and known limits. A separate clean checkout passed install, offline checks, database startup/readiness, demos, and integration checks. The fixed disposable database was then stopped, restarted, and SQL-readiness checked successfully. No provider key or private source is required. |
| D13-S1 | In progress | Full Phase 1 scenario and cross-surface conformance. | D12's PostgreSQL lifecycle now reaches PR, merge, UAT, failure, rollback, duplicate/stale replay, and missed-observation repair; D11 proves same-pin portal/MCP/export and revocation for a separately strict-publishable snapshot. A combined synthetic scenario now joins real analyzer and configured-host output with PR/merge, actual serving transitions, mixed inventory, rollback, replay/repair and consistent query/portal/MCP/export pins. Live provider/source materialization and the protected pilot remain open. A bounded single-route Express API-key guard now provides source security proof and a real code-extracted snapshot passes strict D10 preparation. The combined analyzer-backed lifecycle uses a local trusted event verifier and fixture source resolver; broader authentication and deployment enforcement remain separate gates. |
| D13-S2 | Open | Public release hygiene and v0.1 readiness review. | Synthetic-only fixtures/artifacts, license/governance/security reporting, supported/unsupported matrix, privacy scan, clean install, all offline/PostgreSQL/protocol/browser tests, and known limits are documented. Publish a release only after the gate passes. |

## Later phases and analyzer coverage

| ID | Phase | Work | Gate |
|---|---|---|---|
| P2-JAVA | 2 | Java/Spring adapter and shared two-ecosystem conformance. | The Java fixture completes the Phase 1 downstream flow; supported syntax/classpath ranges and unknowns are explicit. |
| P2-NODE | Active analyzer priority | Expand Node.js coverage through [NB1–NB8](NODEJS_ANALYZER_BACKLOG.md). | Select a versioned profile explicitly; Swagger/OpenAPI, decorators, and mixed routing each meet their own conformance gate before full support is claimed. |
| P3-LOGS | 3 | Sanitized runtime evidence, deployed URL correlation, and examples. | Ambiguous mappings stay unresolved, sensitive values never persist, and documentation still works when logs or bodies are unavailable. |
| P4-SEMANTICS | 4 | Intent search and semantic understanding using configurable OpenAI, Gemini, and Claude adapters. | Grounded environment-specific answers pass the question evaluation; deterministic tests verify adapters and models neither run nor grade tests. |
| P5-DOCS | 5 | Permission-scoped read-only Confluence links and discrepancies. | Findings retain both sources, versions, scopes, and review state; revocation invalidates dependent views. |
| P6-OPS | 6 | Capacity, backup/restore, access audits, operations, and public v1 release readiness. | The [Phase 6 exit gate](ROADMAP.md#exit-gate-6) passes with published measurements and honest supported ranges. |

`nodejs-swagger2-document@0.13.0` reads a selected JSON or YAML document and emits
declared route facts, flat parameter serialization, and scalar/flat-array form and multipart-file
extraction with incomplete coverage. IR 1.1 encoding and qualified export are implemented; runtime binding and
broader constraint eligibility remain open. Exact eligible inline form
requiredness and direct scalar formats export using original snapshot field
pointers and qualified evidence; source declarations alone remain non-normative. `nodejs-swagger-express-mw@0.32.0`
binds one direct default-file registration and composes valid literal
`basePath`, and records exact CommonJS handler source candidates under default or bounded
static routing configuration declarations. Optional signed captures establish
observed binding in one exact revision/environment/session. Production startup
and runtime enforcement remain unverified. D08 wire-version selection is now
explicit; complete profile dispatch/options conformance remains in NB1–NB4. `nodejs-routing-controllers@0.8.0`
extracts literal decorator declarations, binds direct controller
registrations, and applies literal global prefixes, but cannot prove the
startup entry point. It is the first NB5
profile slice, not the completed NB5 conformance gate.

The Node.js backlog is a detailed child backlog. Its NB1 contract and
authority decisions are prerequisites for full document/decorator conformance; current
`typescript-express@0.6.0` support does not imply broader adapter coverage. Java and Confluence remain planned. Runtime metadata imports and document-grounded semantic adapters have bounded implementations documented below; payload examples, broad retrieval and live-provider acceptance remain open.

## Backlog maintenance

1. Give new work a stable ID, a dependency, and observable acceptance evidence.
   Put implementation detail in a linked task brief or child backlog.
2. Move an item to **in progress** when its first implementation commit starts.
   Mark it **complete** only after tests, independent review where required,
   and a committed result. Record the commit and relevant test counts.
3. Update this file in the same reviewed change that closes or materially
   changes a task. Keep the [project plan](../PROJECT%20PLAN.md) and
   [README](../README.md) linked to it; avoid duplicate status ledgers.
4. Put unsupported framework cases, discovered discrepancies, and failed
   acceptance gates back into the backlog with a reproducible fixture or
   evidence. Do not silently upgrade a proposed capability to supported.


### Middleware version provenance prerequisite — 2026-10-08

Middleware profile `0.6.0` preserves bounded root npm v2/v3 wrapper and nearest
runner lock declarations with exact source pointers. Lock changes invalidate
analysis; handler candidates carry limited lock evidence. The initial
`0.7.0`/`0.7.0` conformance target remains uncertified. Runtime configuration,
transitive behavior, installed-module identity, startup and authoritative
handler binding are still pending in NB4.


### Middleware runtime behavior prerequisite — 2026-10-08

Ten isolated framework conformance tests now exercise synthetic routing on a
pinned Node 22.19.0 runtime with wrapper/runner 0.7.0, Express 4.13.3 and locked
transitive dependencies. The analyzer remains on Node 24.6.0. Tests retain
ambiguity and environment overrides as binding gaps; the negative Node 24
fixture records a real legacy compatibility failure. This is a separate CI job
and local command, `npm run test:swagger:runtime`, after the
[documented setup](../tests/conformance/swagger-runtime/README.md).
Authoritative scanned-service handler binding remains pending in NB4.


### Middleware startup/environment prerequisite — 2026-10-08

Profile `0.7.0` records bounded explicit npm-start and runtime-pin declarations,
and inventories potential configuration-affecting environment access in
contained JS/TS source. Safe key/operation/location evidence carries no values.
Detected inputs suppress source handler candidates and preserve documented
routes. Runtime conformance now includes a source mock-mode override (11 tests).
Production invocation, effective external configuration and authoritative
handler binding remain pending; an empty inventory proves none of them.


### Middleware routing dependency prerequisite — 2026-10-08

Profile `0.8.0` records bounded nearest npm lock declarations for bagpipes,
config and sway, with exact source pointers and tested range/version policy.
Missing, linked, aliased or unsupported dependencies remain diagnosed. Lock
changes invalidate analysis; candidates carry limited dependency evidence.
The complete dependency graph, installed identity, effective configuration,
startup execution and authoritative handler binding remain pending in NB4.


### Middleware controller initialization guard — 2026-10-08

Profile `0.9.0` withholds handler candidates for opaque top-level initialization
and premature const exports. A bounded literal/function-only syntax subset stays
eligible as inferred source evidence. Routes remain available, controller edits
invalidate extraction, and diagnostics omit source/exception text. The runtime
harness now includes one failing controller with a valid export (12 tests).
Actual module execution and authoritative binding remain pending in NB4.


### Middleware local initialization sources — 2026-10-08

Profile `0.10.0` inspects bounded contained CommonJS import graphs without loading
service modules. Missing, cyclic, external, dynamic, incompatible or opaque
imports remain unresolved. Candidates carry limited source/package evidence;
helper edits invalidate extraction without adding authoritative dependencies or
handler-derived facts. Runtime conformance includes working and failing local
imports (14 tests). Effective runtime configuration and binding remain pending.


### Swagger composed schemas and dictionaries — 2026-10-08

Document `0.6.0` and middleware `0.11.0` preserve bounded `allOf` and
boolean/schema `additionalProperties` in inline and reusable schemas.
References remain canonical, recursive references stay bounded, and endpoint
schema dependencies follow compositions and dictionary values. Invalid forms
remain diagnosed with partial coverage. Tests cover source invalidation and
stable endpoint identity. Runtime validation and normative constraint export
eligibility remain open; no handler facts or authority promotion are added.


### Swagger declared numeric and size limits — 2026-10-08

Document `0.7.0` and middleware `0.12.0` preserve finite numeric bounds and
nonnegative safe-integer string/array limits in reusable/inline schemas and
query/path/header declarations. Unsupported strict bounds are not converted to
inclusive ones; conflicting/invalid limits and malformed required arrays stay
diagnosed while preserving routes. Source edits invalidate extraction. Runtime
validation, normative constraint export and form-field limits remain pending.


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


### Metadata-only observation matching (2026-10-09)

The first Phase 3 kernel correlates a bounded inert log record with an existing source snapshot, a resolved environment pin, independent per-record revision/window/source attestation, and explicit gateway routing evidence. Unique public-to-application templates can link an existing endpoint. Missing revision, ambiguous maps/routes and selector variants remain unresolved. Raw URLs, hosts, path values, body/header/cookie/query/trace data and raw-value hashes never enter results or errors. The durable import slice now stores only sanitized metadata in separate append-only tables. Import capability, log opt-in, catalog/scope grants and the exact serving pin are checked before fetching the source and again before writing. Revocation and serving changes during fetch reject without inserts; safe-content replay is idempotent. Ten PostgreSQL integration tests cover authorization, races, privacy and immutable storage. Examples, catalog/query views, ELK connectors, retention and an attestation provider remain open.

### Signed-file imports and current-pin metadata reads (2026-10-09)

An offline normalized-file connector verifies an externally configured Ed25519 signer, exact import/source/environment pin, bounded UTF-8 JSON and explicit file selection. Trusted routing mappings remain outside the file envelope. The real signed-file → import store → PostgreSQL tests verify privacy, tampering and grant revocation. Shared query reads expose only sanitized metadata for the current environment checkpoint; historical branch/revision reads are rejected and older checkpoint records are excluded. Optional portal and MCP capabilities use the same authorized reader and bounded environment selector. This does not infer normative schemas/security, establish an actual log provider, or supply request/response examples. Retention, examples, provider wiring and operational gates remain open.

### Dependency hygiene checkpoint (2026-10-09)

A clean installation exposed GHSA-68fv-2mgg-jv7q in the locked development dependency `source-map-js@1.2.1`. The lock now selects patched 1.2.2 within existing dependency ranges, preserving all other packages and platform artifacts. This closes that advisory only; release governance, capacity, recovery and production deployment checks remain open.

### Immutable local Git sources in durable analysis (2026-10-09)

An explicit tenant/repository allowlist now materializes only a configured service root from a selected immutable local commit. Git transports, hooks, lazy fetch and replacement objects are disabled; unsafe paths, symlinks and submodules reject. Explicit configured branch refs are probed individually without enumeration. Source and manifest digests are measured using the exact compiled analyzer profile, independently of the Git tree digest. One-shot sessions have deterministic request identity, bounded capacity and retryable cleanup. Sixteen connector tests and a real Git → D08 → PostgreSQL baseline/branch-update test cover the bounded Express, routing-controller and Swagger middleware source profiles. Live fetch/provider delivery, document-only orchestration, delta reuse, protected pilot and broader lifecycle materialization remain separate gates.

### Authorized document-grounded semantic suggestions (2026-10-09)

The first Phase 4 kernel projects only selected OpenAPI declaration text and existing endpoint-bound evidence. Structured suggestions remain inferred, unreviewed and non-normative; unknown endpoints/citations/assertion fields reject. Disabled inference and missing context never call a model. The PostgreSQL host checks active configuration, permissions, evidence scopes and exact snapshot/pointer/checkpoint before and after inference. Twelve integration tests cover authorization, revocation and configuration races and constructor mutation. OpenAI, Gemini and Claude ports use explicit configured models, fixed official origins, bounded bytes and a total deadline with deterministic mocked tests; no live credentials or model grading are used. Conservative text exclusion is not a guarantee against arbitrary sensitive prose. Code-context inference, durable review/indexing, intent search, question evaluation and live provider validation remain open.

### Standalone document lifecycle through D07/D08 (2026-10-09)

The exact Swagger 2 document 0.14.0 and OpenAPI 3.0 document 0.1.1 profiles (IR 1.1) now support a single config-pinned, contained manifest through local Git materialization, baseline analysis and durable branch updates. Source-tree profiles keep their existing validation. Runtime receipts, extra inputs, wrong paths/digests/profiles and entrypoints are rejected. Document branch updates always reanalyze in full. Four actual Git/PostgreSQL cases prove both profiles advance for valid documents and preserve the last successful pointer when a selected document is malformed or deleted. These snapshots describe document declarations; they do not prove implementation registration or deployed availability.


### Selected-operation intent discovery — P4-S1 (2026-10-09)

The optional portal form and `api_truth_discover_api` MCP tool compare a bounded task with 1–16 explicitly selected operations from an authorized, pinned contract. The portal sends intent in a bounded POST body; caller identity comes from host authentication. Branch/environment versions are mandatory, and revoked permissions or changed pins discard results. Browser generations discard delayed responses after a new selection or request. Results remain inferred, unreviewed, non-normative and evidence-linked. Models neither run nor grade tests; provider tests use deterministic transport fixtures.

Validation: clean installation with zero audited vulnerabilities, typecheck, 1,254 offline tests, 269 PostgreSQL tests, and four real-browser tests. Actual Swagger 2/OpenAPI 3 snapshots prove summary/description evidence reaches the provider.

This slice does not search an entire enterprise corpus. Undocumented source context, bounded candidate retrieval, durable inference/review, revocation-aware caching, curated question evaluation and live model acceptance remain open. The actual PostgreSQL service is exercised through both HTTP and MCP, including evidence-grant revocation; no fixture-only semantic host substitutes for that boundary.


### Direct Express identifiers — P4-S2 input (2026-10-09)

Express `0.6.0` records composed route registration and a directly bound local named function as narrow, source-backed identifier claims. Aliases, imports, anonymous handlers, reassigned bindings (including shorthand destructuring), and direct eval withhold handler names. Exact source spans, endpoint scope and mount dependencies retain lineage. These facts support later tentative source-metadata inference; they do not describe business workflows or prove deployed handler binding. Actual Git worker and analyzer-backed portal/MCP/publication lifecycle regressions pass with the new exact profile.


### Grounded source identifiers and keyword candidates — P4-S2/S3 (2026-10-09)

Discovery can now use bounded, evidence-backed Express route/handler names and directly registered routing-controller action names alongside declared API-document descriptions. It sends no handler source, request/response literals, runtime captures, schemas or security fields. Source names support tentative interpretation only. Results explicitly list requested, analyzed and omitted endpoints; missing context cannot turn a partial comparison into an enterprise-wide no-match claim.

A deterministic keyword candidate reader resolves one selected service/environment at an exact checkpoint and checks catalog, environment and every snapshot evidence scope before ranking. Actual routing-controller output, source-only Express facts, hostile inputs, exact route/evidence lineage, camelCase tokens, stable ranking and bounded results are tested. Matches are labeled keyword candidates, with separate completeness and truncation. A lexical no-match is scoped to the selected searchable contract; unresolved or incomplete views remain unknown. Validation: clean install with zero audited vulnerabilities, typecheck, 1,292 offline tests, 271 PostgreSQL tests and four browser tests; the follow-up explicit-null limit regression passed with 15 matcher and 18 semantic PostgreSQL tests. Cross-service retrieval, embeddings, raw dependency context, durable inference/review and evaluation remain open.


### Keyword candidate surfaces — P4-S3 (2026-10-09)

The optional `api_truth_search_api_candidates` MCP tool and bounded POST `/api/candidates` portal route search one explicit environment/service without calling a model. The portal labels keyword scores, evidence, incompleteness and result-limit truncation; selected candidates can populate the separate inference selection. Caller identity comes from host authentication, and exact environment checkpoints are required. Real PostgreSQL-backed HTTP and MCP reads return identical pinned candidates and reject revoked evidence grants. Cross-service discovery is the next bounded slice; this interface still requires a selected service.

Validation: 1,296 offline checks, five browser tests and 18 PostgreSQL semantic boundary tests pass. Intent validation rejects URI schemes and known credential patterns before query/model work. Provider output also rejects known credential patterns with a fixed error; ordinary authentication-related API language remains allowed. This conservative filter does not guarantee arbitrary prose is secret-free.


### Cross-service keyword discovery and question corpus — P4-S4 (2026-10-09)

An optional authorized reader, portal POST and `api_truth_search_api_corpus` MCP tool now search current services for one explicit environment. Each candidate carries its own repository, service, endpoint, evidence and exact serving pin. The portal requires an explicit pinned contract load before a separate manual inference request. Revocation omits denied services without identifiers or counts; incomplete scans never imply an enterprise-wide no-match. Limits cover 200 configured services inspected, 20 authorized services searched, 5,000 endpoints, 4 MiB combined selected documents and a ten-second corpus query deadline. The active configuration is validated once in the same repeatable-read transaction. Oversized documents are withheld in SQL; deadline cancellation destroys its connection and returns a fixed unknown result.

Independent reviews and real PostgreSQL HTTP/MCP tests validate the boundary. A 37-question public synthetic corpus checks hand-authored candidate ordering, wrong-action decoys, ambiguity, missing context and scoped no-match against actual analyzer outputs. Scripted provider fixtures test structure and citations; they do not grade live models or measure semantic quality. Durable enrichment/review, embeddings, broader dependency context, live provider evaluation and the remaining phase gates stay open.

Validation: clean installation with zero audited vulnerabilities, typecheck, 1,345 offline tests, 280 PostgreSQL tests and six browser tests pass. The Git cleanup regression now inspects only its own scratch directory so concurrent test processes cannot create false failures.


### Principal-scoped inference metadata history — P4-S5 (2026-10-09)

Optional explicit migrations and opt-in semantic history now retain append-only inferred status, requested/analyzed endpoint IDs, citations and exact provider/model/prompt/configuration/selector provenance. Raw questions, model prose, context and credentials are discarded before persistence. After model I/O, current authorization and pin checks run in the same transaction as insertion. Reads require the same principal and current source scopes, pin and inference configuration; old records remain stored but are excluded after change or revocation. The default service works without the optional history table. These records remain inferred, unreviewed and non-normative; this audit slice does not implement durable guidance, owner review or caching. Independent review and 26 semantic PostgreSQL tests pass.

### Shared analyzer boundary matrix — NB3 bounded slice (2026-10-09)

Thirty conformance cases exercise the five current compiled analyzer profiles with actual source/document inputs. They check scoped provenance, profile/input selection, path and symlink containment, supplied digest mismatch, network policy, malformed content, source nonexecution, resource bounds and changed-byte fingerprints. This proves full-rerun fingerprint invalidation; incremental prior-dependency pruning and broader framework/runtime conformance remain open.


### Inline decorator DTO declarations — NB5 bounded slice (2026-10-09)

Routing-controllers `0.9.0` preserves required and optional properties of supported inline TypeScript object types, including nested objects/arrays. Type-declaration evidence explicitly does not establish runtime validation; top-level query/header presence remains unknown. Unsupported shapes and every duplicate declared name, including an unresolved first member, withhold ambiguous properties and the complete required list. Own JSON property insertion preserves `__proto__` and `constructor` without prototype mutation. Exact analyzer-host and local Git profile pins advance together. Named DTO resolution, inheritance, serialization, validation-group and runtime conformance gates remain open. Forty-seven analyzer/CLI tests pass, including red-to-green duplicate and special-key regressions.


### Tenant-scoped configured provider binding — P4-S6 (2026-10-09)

An optional lazy provider factory binds tenant, provider, model and credential reference from the authorized active installation configuration. Credential references remain private to the trusted host factory and secret resolver; neither references nor values enter model context, responses or history. Disabled, denied and unusable-context calls do not resolve credentials. The connector enforces the exact selected provider/model before key resolution or HTTP, uses fixed official origins and bounded transport, and caches no keys across tenants. Current configuration, source grants and the exact pin are rechecked after model I/O. Hostile getters/coercion, wrong models, tenant isolation and reference rotation are covered by deterministic transport and PostgreSQL tests. Live credential/provider acceptance, data-policy approval, durable guidance/review and semantic-quality evaluation remain open.


### Project-local Java prerequisite and release hygiene (2026-10-09)

The explicit Java setup prepares checksum-pinned Temurin `21.0.12.1+1` under the project cache on macOS/Linux x64/arm64. Offline verification compares the retained verified archive and complete runtime tree before an environment-isolated JVM version probe. Partial caches, symlink paths, oversized metadata and redirected downloads fail closed. Eleven deterministic tests and an actual macOS arm64 offline verification pass. This prerequisite does not execute service code or establish Java analyzer coverage.

GitHub private vulnerability reporting is enabled and verified; `SECURITY.md` documents its route without a response-time promise. The main check workflow pins action commits and adds a read-only Playwright Chromium job. Governance designation, license/distribution authority, full fixture/artifact review and protected lifecycle/release gates remain open.


### Spring MVC AST and actual Git worker — P2-JAVA first slice (2026-10-09)

The exact `java-spring-mvc@0.1.0` IR 1.0 profile reads contained UTF-8 Java sources through a checksum-pinned JavaParser helper on the verified local JDK. It extracts explicit imported controllers, literal class/method paths and bounded selectors with exact source spans and revision evidence. Dynamic property/SpEL paths, conflicting routes, unsupported mappings, local annotation shadowing and inherited routes stay unresolved. All output remains partial: startup binding, classpath, DTO validation, status and security are unverified. Setup compiles only the fixed helper with annotation processing disabled; analysis neither compiles service source nor executes build/startup code.

The configured host and local Git connector accept only that exact profile and one digest-bound source tree. A real PostgreSQL test materializes two immutable Git commits through D08, persists both snapshots and advances the configured branch pointer. Separate Java gates fail on absent prerequisites rather than skipping; the default offline suite needs no JDK. Broader Spring parameter/DTO/schema extraction, runtime framework conformance and the two-ecosystem downstream/pilot gates remain open.

Validation for the first Java slice: clean tracked-source install, typecheck and 1,397 offline tests; 293 PostgreSQL tests; 11 dedicated Java tests and one Java Git/worker PostgreSQL scenario passed. The first Linux Java CI execution is still required; these results do not certify all supported setup architectures.


### OpenAPI 3.1 selected-document profile — NB6 bounded slice (2026-10-09)

The separate `openapi31-document@0.1.0` IR 1.1 profile accepts exactly OpenAPI 3.1.0/3.1.1 and the default base dialect, with ordinary supported schema fields, type unions, const values and bounded prefixItems. Unsupported boolean/custom-dialect/resource/dynamic-reference/reference-sibling semantics withhold the complete affected schema projection and its schema claims. Repeated diagnostics cannot restore withheld claims. Literal const JSON is never treated as a schema reference; tuple references retain component evidence dependencies. The 3.0 profile identity, fingerprint and bounded behavior remain unchanged; the shared package advances to 0.3.0.

The configured host and immutable Git connector require one explicit contained document input. D07/D08 recognize the exact new profile and conservatively reanalyze its complete selected document on branch updates. Actual Git/PostgreSQL tests cover baseline, update, malformed document and deletion without promoting an invalid revision. IR validation now accepts already-represented type unions and prefixItems while rejecting invalid type members. Broader OpenAPI 3.1 and runtime binding remain separate gates.

Validation: exact staged tracked-source archive, clean install, typecheck and 1,429 offline tests; all 295 PostgreSQL tests passed. Linux Java CI at `7caf3e1` also passed the first Java gate. OpenAPI compiler reference closure now traverses schema positions only, preserving literal enum/const JSON as data while retaining genuine nested component dependencies.

Independent review also found percent-encoded local reference ambiguity; the 3.1 profile now rejects these fragments before emitting any endpoint or schema claim. Regression tests prove no wrong component is selected. Object-valued union members are diagnosed without coercing source JSON. The final six Git document worker cases passed again after these fixes.


### Java declaration identifiers in discovery — bounded source projection (2026-10-09)

Keyword search and semantic context accept exactly `java-spring-mvc@0.1.0` route declarations when method, path, selectors and the single endpoint-scoped source/type-declaration evidence match the immutable snapshot. Duplicate, mismatched or unsupported-profile declarations are withheld. Only safe route and handler identifiers enter candidate labels and provider context; selector values, DTO names, response/status/security assumptions and source bodies do not. Incomplete source coverage cannot establish absence. Semantic suggestions remain inferred, unreviewed and non-normative.

Actual Java AST-to-catalog tests exercise distinct selector variants, candidate matching, provider context and hostile evidence mutations. Query advances to 0.1.0 and semantics to 0.6.0 with coordinated exact workspace dependencies. Broader Java contract extraction and runtime proof remain open.

Validation: independent review, clean tracked-source install/typecheck and 1,429 offline tests; all 22 dedicated Java tests (including 11 discovery scenarios) and 42 query/portal/semantic PostgreSQL tests passed.


### Root-lock dependency metadata inventory — release hygiene slice (2026-10-09)

`dependencies:inventory` reads bounded root npm lockfile and installed manifest metadata without importing packages, contacting registries or changing files. It reports exact versions, installation mismatches, optional dependencies and recognized license-expression metadata. Paths and credential-bearing registry URLs are withheld. The current root lock contains 117 third-party entries and 21 workspaces, with no unresolved root-lock license metadata.

This is a scoped metadata check, not legal acceptance or release approval. Isolated framework fixture lockfiles, JDK/parser artifacts, full license texts, ownership and distribution obligations remain open release gates.

Validation: clean tracked-source install, typecheck and 1,438 offline tests passed, including nine hostile-input inventory scenarios. The inventory was run on the clean installed tree and reported complete root-lock metadata without contacting a registry.


### Synthetic schema examples — P3 safe-example core (2026-10-09)

The observations 0.3.0 pure module generates deterministic non-normative placeholders only after explicit endpoint/direction/status/media/property-path opt-in and matching environment/snapshot pins. Required nested properties need their own opted-in paths. Unsupported constraints, formats, unions, compositions, literal const/enum/default/example values, sensitive property names, ambiguous content/status and cycles withhold the complete candidate. Diagnostics contain fixed rule IDs and counts. Fingerprints identify the selected schema closure and policy without storing traffic.

This module neither proves caller authorization nor reads traffic. A host must supply a fresh authorized query view and enforce authorization/current-pin checks at delivery. Observed/redacted examples, request/response correlation, retention/deletion and portal/MCP delivery remain open; generated placeholders cannot establish requiredness or deployed behavior.

Validation: terminal-container constraint bypasses found during review were fixed with regressions. Independent review, exact clean install/typecheck and all 1,450 offline tests passed; 19 observation persistence/import/query PostgreSQL tests also passed.


### Exact configured GitHub branch reader — D12 bounded port (2026-10-09)

A read-only fixed-origin GitHub port binds tenant, repository identity and an explicit intended-branch allowlist before resolving a trusted token. It reads only the exact repository and singular configured reference; no branch enumeration or webhook-derived target is allowed. Responses have strict JSON, byte/node/depth and total-deadline bounds. Redirects and raw response/token errors are withheld; non-success streams are cancelled.

Present results contain an immutable commit and an opaque provider reference without event order. Optional comparison describes only the two requested SHAs as identical/ahead/behind/diverged; it does not establish a former branch head or a history rewrite. A 404 remains unknown, never proof of absence. This standalone port is not a live D08 host: installation/token binding, host source authorization, current-config/lease fencing, provider-source materialization, deletion proof and live provider acceptance remain open.

Validation: independent review, exact clean install/typecheck and all 1,480 offline tests passed. Thirty new reader scenarios cover configured-branch isolation, tenant/repository mismatches, inaccessible refs, response/ancestry inconsistencies, cancellation, byte limits and total timeout. Tests use deterministic transport; no live installation or deployment is certified.


### Reconciliation active-config preflight — D08 defense in depth (2026-10-09)

Both exact branch and pull-request reconciliation verify the active configuration fingerprint in a short transaction before invoking a provider port. A stale leased job fails as superseded with no provider request. Completion still rechecks lease, active configuration and subject generation; no database transaction spans network I/O. Provider-source authorization remains a trusted host responsibility, distinct from catalog reader grants.

Validation: independent lock/transaction review, clean tracked-source install/typecheck and all 297 PostgreSQL tests passed. Branch and PR regression cases preserve an uncancelled lease while changing the active configuration and prove zero provider calls and no state promotion.


### Authorized synthetic-example service — P3 delivery boundary (2026-10-09)

Observations 0.4.0 adds a service using a trusted authorized QueryReader and detached static policies bound to tenant/repository/service/environment. Caller requests contain only a policy ID and an explicit environment selection with expected checkpoint. Policy lookup follows the first authorized read. Generation is followed by another authorized read and exact snapshot/revision/config/checkpoint/source-digest comparison; stale context or revoked grants prevent delivery. No caller-supplied policy, view or traffic is accepted. Fixed errors avoid raw storage/reader details.

Real PostgreSQL tests use the current environment resolver and catalog grants to verify generation, absent policy, revocation before and between reads, and checkpoint advancement. Surface delivery and observed-example lifecycle remain separate gates.

Validation: independent service review, clean tracked-source install/typecheck and all 1,487 offline tests passed; ten observation-query PostgreSQL tests include four real authorized-service scenarios. Delivery is denied after a catalog grant revocation or environment checkpoint change between the two reads.


### Synthetic examples through portal API and MCP — P3 optional delivery (2026-10-09)

Portal 0.1.0 `POST /api/examples` and MCP 0.1.0 `api_truth_get_synthetic_example` expose the authorized service only when the host configures it. Requests name one repository, service, environment, expected checkpoint and policy ID; tenant/principal come from authentication. Caller property paths, schemas, snapshots and policy bodies are rejected. Existing byte bounds and fixed error mapping apply. The read-only tool returns explicitly synthetic, non-normative results. The portal browser UI, observed examples and retention remain separate work.

Validation: independent surface review, exact clean install/typecheck and all 1,491 offline tests passed. Eleven observation-query PostgreSQL tests include equality of direct service, portal and MCP output on the same pin and denial on both surfaces after revocation. Four new surface contract tests cover strict requests, optional capability, fixed errors and byte bounds.


### Repository-restricted GitHub App token resolver — D12 credential boundary (2026-10-09)

A separate trusted host resolver builds short-lived RS256 App JWT claims through a sign-only secret service. Fixed App/installation/account/repository bindings are verified at exact provider endpoints before requesting a token for exactly one numeric repository ID and contents-read permission. Repository installation App identity and suspension are rechecked. The response must retain selected repository scope, bounded future expiry and only contents/metadata read permissions; optional returned repository lists must match exactly. No token cache, persistence, branch/repository enumeration or credential-bearing errors are introduced.

This provider credential flow does not establish this host's source-access authorization or deployment state. A protected live host still needs operator-provisioned App/installation/secret bindings, authorization and lease/configuration fencing. Offline tests verify transport and protocol behavior only; real GitHub credential acceptance remains open.

Validation: independent review and extra regression checks for App/suspension rechecks and invalid final clock; clean tracked-source install/typecheck and all 1,513 offline tests passed. Twenty-two token resolver tests include actual synthetic RSA JWT verification and composition with the exact branch reader; no live credential was minted in these tests.


### Exact IR schema identifiers in synthetic examples — corrective slice (2026-10-09)

Observations 0.4.1 aligns local schema lookup and fingerprint closure with the IR validator's literal schema-ID suffix semantics. Component IDs containing `~1` no longer select a different component containing `/`. Policy property paths still follow JSON Pointer escaping. A parse-valid conflicting-component regression proves the selected example shape and fingerprint depend only on the referenced literal component.

Validation: clean tracked-source install/typecheck and all 1,514 offline tests passed, plus all eleven observation-query PostgreSQL cases. The conflicting identifier regression validates the fixture through the IR parser before generation and proves decoy-schema changes cannot alter the selected schema fingerprint.


### Synthetic workflow startup cost — CI corrective slice (2026-10-09)

Two Linux offline jobs exceeded the 15-second fixture-driver test deadline while every other test passed. The public synthetic driver now reuses the same strict local fact normalizer in-process instead of launching seven Node/IR/validator processes. It preserves all seven event kinds, IDs, provider fixture sequences and previous-event chaining, and refuses unconfigured branches without writing an artifact. Standalone CLI behavior remains covered independently. The test timeout and assertions were not weakened.

Validation: independent review, clean tracked-source install/typecheck and all 1,514 offline tests passed. The driver/CLI focused suite passed 18 tests; the formerly slow fixture test completed within the unchanged deadline. Linux CI rerun remains the final startup-regression gate.
