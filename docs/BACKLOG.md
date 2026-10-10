# API Truth — Development backlog

**Updated:** 2026-10-10
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
| NB1-PROFILES | In progress | Configured profile/source-manifest dispatch, immutable Git document orchestration and full multi-input reanalysis are implemented. Protected receipt pinning, Git handler-byte verification, immutable capture provenance/results and scoped admission/lease/execution/cancellation are implemented separately. A bounded Swagger document-value correspondence port and unsigned controlled runtime document-loading capture are implemented. Protected signed document-load verification and same-session Git/document composition are implemented. Separate immutable loaded-document summaries bind that composition to existing capture/handler verification. Separate loaded-document admission fixes host load bindings to the active configuration epoch and existing capture/handler summaries. Separate loaded-document claims/renewals validate the current epoch and bound worker capacity. Loaded-document bounded execution commits its safe summary and successful lease state atomically. Supersession maintenance cancels active jobs from older configuration epochs under separate manager permission. Downstream qualified reads and safe incremental multi-input reuse remain open. D08 still rejects runtime observations. |
| NB2 / NB8-DETECT | Complete bounded slice | Offline onboarding inventory resolves production-connected literal imports and controller identities, classifies mixed/unsupported services, and exposes a contained local CLI. Composite extraction and reconciliation remain NB8-COMPOSE. |
| NB3 / NB4 | In progress | Cross-adapter hostile-input tests are implemented; incremental invalidation/pruning and the complete bounded Swagger profile gate remain. |
| NB5 | In progress | Bounded decorator declarations, inline DTO presence and controlled capture tests are implemented; broader DTO/framework conformance and authoritative source-to-downstream update remain. |
| NB6 | In progress | Separate bounded OpenAPI 3.0 and 3.1 JSON/YAML profiles and CLIs implemented; broader 2020-12 dialect, resource and reference semantics remain open. |
| NB7 / NB8-COMPOSE | Open | Independent wrapper/framework profiles; explicit composite identity/provenance/deletion design and tests. |
| D13-S1 | Open | One analyzer-backed lifecycle through publication and consistent portal/MCP/export; preserve strict evidence gates. |
| P3-LOGS | In progress | Metadata sanitization and environment URL correlation, synthetic examples and value-free field-presence projection are implemented. A bounded host-authorized body-read boundary, owner approval, authenticated derived presence import, authorized value-free queries, optional portal/MCP presentation and bounded retention maintenance are implemented; live adapters, durable distributed scheduling and reviewed samples remain separate gates. Bounded in-process cleanup scheduling is implemented. |
| P4-SEMANTICS | In progress | Grounded selected-operation discovery, source identifiers, authorized cross-service keyword candidates, bounded per-service semantic shortlist comparison with optional portal/MCP access, provider binding and private history metadata are implemented; a semantic corpus index, durable review and live evaluation remain. |
| D12-S0/S2 | In progress | Exact configured GitHub branch and repository-restricted App token ports are implemented offline; authenticated live host, artifacts, provider ordering and environment wiring remain. |
| P2-JAVA | In progress | Bounded Spring AST profile and actual Git-to-D08 update implemented; broader Spring contracts, two-ecosystem conformance and downstream lifecycle remain. |
| P5-DOCS | Open | Permission-scoped Confluence context and discrepancy review. |
| D13-S2 / P6-OPS | In progress | Private reporting, pinned toolchains/CI and root-lock metadata inventory are implemented; ownership/legal review, capacity/recovery/access audits and reproducible operating gates remain. |

## Current position

| Work | Status | Evidence or next gate |
|---|---|---|
| D01–D07 | Complete | Synthetic constraints/fixtures, executable contracts, local test harness, bounded Express extraction, PostgreSQL catalog, and dependency-aware updates are committed. |
| D08 | Complete: slices 0–7 | PR previews, exact reconciliation, durable scheduling, safe status reads, bounded observer signals, and local lifecycle pass the final gate. |
| D09 | Complete: slices 0–4 | Deployment facts, serving checkpoints, exact-scope repair, authorized views, and the local lifecycle pass 320 offline and 181 PostgreSQL tests. Independent review findings on request races, removed scopes, migration cutover, and stale views are fixed. |
| D10 | Complete: slices 0–4 | Evidence-gated OpenAPI 3.1 compilation, safe `consumes` variant aggregation, durable revision/branch/environment publication, offline official-schema validation, and a local round trip pass full suites. |
| D11–D13 | D11 complete; D12–D13 in progress | Shared authorized query, portal, and MCP gates pass; provider wiring, full lifecycle publication, and release readiness remain. |
| Phases 2–6 | In progress | Bounded Java, runtime metadata, semantic discovery and release-hygiene slices are implemented; complete conformance, related documents and operating readiness still follow their roadmap gates. |

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

Validation: independent review, clean tracked-source install/typecheck and all 1,514 offline tests passed. The driver/CLI focused suite passed 18 tests; the formerly slow fixture test completed within the unchanged deadline. The corrected development commit passed Linux CI, and the subsequent portal commit also passed the unchanged Linux offline gate.


### Synthetic example portal form — P3 optional UI (2026-10-09)

Portal 0.2.0 shows the policy-ID form only when the host enables the example service, and enables generation only for a resolved environment checkpoint. It posts the currently displayed pin and clears pending/results when the policy or contract changes. Returned tenant, source digest, full pin and endpoint membership must match the loaded contract. The actual returned endpoint is labeled; the form does not claim the policy targets a user-selected endpoint. All example content is rendered as text, and malformed or stale responses clear the display. These are synthetic placeholders, not captured traffic.

Validation: independent UI/scope review, clean tracked-source install/typecheck and all 1,514 offline tests passed. All eight real-browser tests and twelve portal/observation PostgreSQL tests passed. Browser regressions cover malicious text, invalid tenant/endpoint/source digest, malformed withheld results, stale policy/contract replies and the absent optional capability.


### External runtime receipt pin — NB1 protected provenance boundary (2026-10-09)

Git source connector 0.8.0 exposes a separate runtime-capture-pin subpath. Trusted host configuration binds one tenant/repository/service/revision/source digest/environment to protected artifact and signer references plus exact receipt/SPKI hashes. The resolver rejects source-tree paths, proxy/accessor inputs, changed artifacts or signer keys, malformed receipts and invalid signatures. Host authorization runs before reads and again before delivery. A bounded total deadline passes cancellation signals to protected ports; those ports must cancel their own underlying I/O.

The returned `pinned_envelope` identifies only a verified external signed envelope. Repository/service/revision/source digest/environment are signed; tenant and policy remain independently host-bound. Handler source bytes, actual registration, deployment and capture-process identity are not established. D08 still rejects runtime observations; separate durable capture associations, authorized scheduling and full handler verification remain open. Existing revision snapshots and analysis checkpoints are not reused for receipts.

Validation: independent boundary review, clean tracked-source install/typecheck and all 1,529 offline tests passed. Focused authorization/revocation, proxy, substitution, signature, hostile JSON and stalled-port regressions passed. No live capture or deployment is certified.


### Separate capture provenance associations — NB1 durable identity (2026-10-09)

Migration 0006 records external receipt provenance in a separate append-only table keyed by tenant and capture identity. The trusted store recomputes the exact identity, authorizes before resolving protected artifacts, and locks/checks writer grants through a DB-local authorization port inside insertion. Exact replay returns the existing association; an identity collision is rejected. Captures at the same source revision retain distinct receipt/signer identities. Source revision snapshots, analysis checkpoints and branch/environment pointers are untouched.

This association is not a runtime analysis job or a verified handler contract. Protected host authorization/grant provisioning, separate capture scheduling and full source/handler verification remain open; D08 runtime input rejection remains in place.

Validation: independent review, clean tracked-source install/typecheck and all 1,529 offline tests passed. All 309 PostgreSQL tests passed, including seven new capture-association cases covering migration/replay, identity collision, denied/revoked writer, hostile input, append-only rows, concurrent duplicate collapse, separate authorized tenants and grant-lock serialization. No capture-specific job or deployed handler claim is enabled.


### Active environment lease cleanup race — CI corrective slice (2026-10-09)

Linux PostgreSQL CI exposed a concurrent drain clearing an unexpired reconciliation lease after its owning worker applied the provider checkpoint but before it finished the task. Checkpoint cleanup now leaves active leases to their owner; expired abandoned leases remain eligible for cleanup. Configuration removal and new checkpoint-generation supersession retain their separate behavior. The regression gates the actual provider reconciliation after checkpoint application, then runs the competing drain; the active token survives and the owner resolves the task.

Validation: the deterministic regression failed before the fix and passed afterward. Independent review, clean tracked-source install/typecheck, all 1,529 offline tests and all 310 PostgreSQL tests passed. The focused environment suite passed 40 tests, including active-lease preservation and expired abandoned-lease cleanup. The corrected main commit passed all Linux CI gates, including PostgreSQL, pinned Swagger, browser, offline and Java checks. No timeout or expected result is weakened.


### Protected capture handler-byte verification — NB1 source boundary (2026-10-09)

Git connector 0.9.0 adds a separate protected-capture-verification port. A trusted host fixes one repository/service root, immutable revision/source digest/environment and expected capture identity. The port verifies protected receipt/signer hashes against an independently resolved pin, materializes committed Git blobs without executing service code, and compares the source digest and receipt-listed handler bytes. Committed reserved receipts are rejected. Success cleanup finishes before final pin/authorization rechecks, preventing delivery after revocation during tree disposal. Simultaneous sessions are bounded; errors are fixed and temporary trees are disposed on success and failure.

The `verified_handler_bytes` result does not prove document-operation correspondence, deployment, future dispatch or collector integrity. No IR, catalog snapshot, job or branch/environment pointer is written; D08 runtime inputs stay rejected. External callback phases are deadline bounded, while Git materialization retains its own 120-second bound and is awaited to prevent late-tree leaks. Capture-qualified analysis records and authorized scheduling remain open.

Validation: independent review, clean tracked-source install/typecheck and all 1,537 offline tests passed. All 36 focused runtime/pin/verification tests passed, including real Git materialization, changed protected references, stale source/handler bytes, reserved receipt poison, distinct capture identities, session limits and cleanup-time revocation. Actual pinned-framework capture-to-protected-verifier conformance remains a separate gate.


### Actual capture to external pin and Git verifier — NB1 conformance (2026-10-09)

The pinned Swagger fixture now commits its complete synthetic source before measuring the digest and capturing actual request dispatch with Node 22.19.0. The signed receipt and key stay outside the Git service tree. A Node 24.6.0 helper independently computes the configured capture identity, verifies protected provenance, and matches signed handler bytes to that commit. Exact commit/source/handler hashes, external artifact separation, unchanged execution marker and owned temporary-tree cleanup are asserted. The verifier emits no IR claim payload; document mapping, deployment and live host authorization remain unverified.

Validation: independent review and the focused protected scenario passed. An exact clean tracked-source tree installed locked root and isolated fixture dependencies and passed all 60 pinned framework cases with no skips or failures. The default offline suite remains separate and needs no legacy framework dependencies.


### Capture-qualified verification summaries — NB1 durable result boundary (2026-10-09)

Migration 0007 links an append-only `protected-handler-bytes-1` verification summary to the separate capture identity. The host supplies the trusted byte verifier; requests contain only capture identity and exact source/environment scope. Parent pin identity is recomputed before verification and under the insertion lock. Writer authorization is rechecked through the same DB-local transaction. A detached, bounded result must match parent context/digests and fixed limitations. Exact replay is idempotent; changed service roots or results conflict.

Only canonical result digest, handler count, relative root/profile and parent hashes are persisted. Handler identifiers and receipt payloads are withheld from this table. The storage layer trusts the host verifier; it establishes neither deployed behavior nor document mapping. No query surface, capture analysis job or mainline catalog/serving promotion is enabled.

Validation: independent review, clean tracked-source install/typecheck, all 1,537 offline tests and all 316 PostgreSQL tests passed. Six focused cases include the actual Git/Ed25519/external-pin/byte-port/storage assembly, scope/hash consistency, replay, cleanup, no source execution and no catalog/pointer writes. Hostile oversized arrays are rejected before bulk descriptor enumeration.


### Synthetic example browser completion assertion — CI corrective slice (2026-10-09)

The browser test previously matched a lowercase substring that could occur in the loading message but failed against the capitalized final result. It now waits for the exact completed synthetic-result message and endpoint identity before checking rendered content. Application behavior, timeouts and hostile-content assertions are unchanged.

Validation: independent review and all eight browser tests passed on the clean verification tree. The pinned protected-capture case, PostgreSQL, offline and Java Linux gates at the earlier commit passed; only this browser assertion failed there. The corrected latest main/development CI runs at `1054b46` passed all checks, including the browser gate; the main synthetic lifecycle run also passed.


### Separate capture verification admission — NB1 scheduling boundary (2026-10-09)

Migration 0008 adds a separate immutable queued intent for an existing 0006 capture association. The host fixes tenant/principal and checks capability before database reads. Admission validates the active configuration document hash, configured repository/service/environment/root and canonical capture identity. A DB-local host callback must lock and check independent source/environment/capture permissions and explicit opt-in bound to the exact configuration fingerprint, document hash and activation checkpoint. Catalog reader grants are preliminary restrictions only.

A tenant advisory transaction lock serializes replay and the bounded queued quota. The active configuration and grants remain share-locked through insertion. Historical capture revisions remain historical inputs; configuration switchback produces a distinct epoch-bound admission. No verifier, 0007 result, D08 job, snapshot or serving pointer is created. The queued quota does not drain until the separate worker lifecycle is implemented.

Validation: independent review, a clean locked install/typecheck and all 1,537 offline tests passed. All 325 PostgreSQL tests passed, including nine new admission cases covering exact replay, historical revisions, denied/revoked grants and host policy, configuration corruption/switchback, concurrent quota enforcement, grant/configuration lock serialization and tenant isolation.


### Separate capture job leases — NB1 worker boundary (2026-10-09)

Migration 0009 preserves immutable admissions and adds a separate lifecycle table with atomic trigger/backfill. A host-scoped worker with explicit `capture.verify.execute` permission claims one bounded candidate and renews a 30-second lease. Canonical capture/job/configuration identities, current configuration epoch, reader restrictions and independent host execution permissions are rechecked under transaction locks. Only a token hash is stored; PostgreSQL decides expiry. Three expired attempts produce terminal failure and release quota; capacity is bounded to two live leases per tenant and one per service.

No-work results report partial coverage. Superseded epoch rows are unclaimable but remain until later cancellation/quota cleanup. This slice invokes no verifier and writes no 0007 summary or D08 catalog state. Atomic result insertion and successful completion remain the next execution boundary.

Validation: independent review, a clean locked install/typecheck and all 1,537 offline tests passed. All 333 PostgreSQL tests passed, including eight new lease cases covering competing workers, capacity, token fencing, three-attempt expiry, terminal quota release, permission/configuration revocation and switchback, host clock skew, migration backfill, lock serialization and expiry during authorization.


### Atomic capture verification finalization — NB1 execution persistence seam (2026-10-09)

The trusted 0007 store may now invoke an optional DB-local finalizer on the same transaction after exact insert/replay validation and before commit. It receives frozen scope and the bounded verification receipt. A strict true commits; false or a thrown callback rolls back both the verification result and callback writes, with fixed errors. The public append request and no-callback behavior remain unchanged. This seam does not itself prove a live worker lease; runner permission/configuration fencing and actual Git execution remain separate integration work.

Validation: independent review, a clean locked install/typecheck and all 1,537 offline tests passed. All 337 PostgreSQL tests passed, including four new atomic finalization cases covering successful combined writes, false/throw rollback, exact replay and failed replay rollback, and hostile callback configuration. Lease-aware runner integration remains open.


### Protected capture verification runner — NB1 bounded execution (2026-10-09)

A host-scoped runner claims the separate capture job, revalidates its canonical association/job/configuration identities and execution authority, then invokes a trusted capture-bound byte-verifier factory outside database transactions. Ten-second heartbeats preserve the 30-second lease while verification is pending; timer cleanup and outstanding renewal finish before persistence. Revoked permissions, changed configuration epochs or reclaimed/expired tokens suppress late results. Unknown verifier failures and storage faults remain fixed transient outcomes; explicit unverified content becomes terminal capture-only failure.

Migration 0010 atomically links the succeeded lifecycle to its owning immutable job and exact 0007 result digest. The final transaction locks current configuration/grants/lease and inserts or replays 0007, then finishes only if the database still sees the same live worker token. A failed completion rolls back both writes. The runner adds no document correspondence, deployed behavior, D08 catalog snapshot or serving-pointer claim. Superseded-job cancellation remains open.

Validation: independent review, a clean locked install/typecheck and all 1,537 offline tests passed. All 350 PostgreSQL tests passed, including 13 runner cases covering real Git/Ed25519/pin-to-admission execution, revoked/reclaimed/expired authority, finalization locks, wrong-owner result rejection, UTF-8 grant ordering, transient storage/host-policy errors, falsy unknown throws and controlled heartbeat cleanup. The final explicit constraint-name correction passed all 30 focused migration/runner cases.


### Superseded capture-job cancellation — NB1 bounded lifecycle cleanup (2026-10-09)

Migration 0011 and a host-scoped maintenance operation cancel bounded old-epoch queued/leased/retry-waiting jobs with a separate `capture.verify.manage` permission. The host supplies explicit repository/service scope and a DB-local independent manager grant applicable to the old service even when it was removed and reader rights were revoked. The active configuration hash/epoch is validated and share-locked; tenant serialization and lifecycle/grant locks keep cancellation atomic with configuration and manager-authority changes.

Cancellation clears live lease credentials and frees active-state quota while preserving immutable admission and verification history. Late old workers cannot finalize. Current-epoch jobs and terminal outcomes remain unchanged. The output contains only a bounded count and partial coverage flags; denied candidates may require narrower authorized host scopes to avoid bounded-window starvation. No protected artifact lookup, source execution, verification append or D08 catalog mutation occurs.

Validation: independent review, a clean locked install/typecheck and all 1,537 offline tests passed. All 357 PostgreSQL tests passed, including seven new maintenance cases covering queued/live cancellation and quota release, current jobs, configuration switchback, removed services and independent manager authority, denied/corrupt configuration, late worker suppression and grant/configuration lock serialization.


### Protected Swagger document-value correspondence — NB1 bounded comparison (2026-10-09)

Git connector 0.10.0 adds a separate `swagger-document-value-1` port. A trusted host selects the default `api/swagger/swagger.yaml` path under one service root and pins its raw-byte SHA-256. The port first verifies the protected signed capture and handler bytes, then materializes the same immutable commit again and checks the whole-service source digest and selected document bytes. Existing pinned middleware, startup, routing configuration and contained handler-candidate helpers constrain matching. A match requires the captured method, composed application path, controller, operation ID, export and handler path to agree with one supported document operation. Duplicate route shapes, duplicate operation IDs, unsupported references or middleware policies remain unresolved; unobserved document operations do not assert runtime absence.

The result carries separate capture, source, document and profile identities, bounded matches and fixed diagnostics. Temporary trees are disposed before final authorization and pin rechecks. The version-1 receipt does not attest which document the runtime loaded; this comparison does not prove deployment, normative contracts or future dispatch. It does not write capture result summaries, catalog snapshots, serving pointers or query surfaces. Arbitrary JSON/YAML document selectors and qualified downstream persistence remain later work.

Validation: independent review found and resolved operation-reference and raw-byte hashing defects. A clean locked root install/typecheck passed all 1,552 offline tests; seven relevant PostgreSQL assembly/lifecycle tests and all 60 pinned framework cases passed. The actual framework capture fixture now exercises this correspondence port while checking that verification performs no extra service execution. A pending-authorization deadline regression confirms fixed failure and session release. The preceding `58f1d31` main/development CI and main synthetic lifecycle gates are green.


### Ordered analysis-input fingerprints — NB1 reuse prerequisite (2026-10-09)

Migration 0012 adds a nullable fingerprint to immutable revision associations. Baseline, branch and preview completion hash the exact validated ordered resolution-input vector with a versioned canonical representation. Completion checks any existing non-null value inside the same transaction; a different input vector cannot replace an existing association. Branch and preview base selection retain that fingerprint for the next reuse gate.

Existing associations remain NULL, meaning unknown. An otherwise exact replay remains compatible and leaves NULL unchanged. This slice preserves existing source-only reuse and still performs full analysis for extra manifests and document profiles. It neither enables partial extraction/pruning nor treats a source digest alone as proof of unchanged additional inputs.

Validation: independent review and a clean locked install/typecheck passed. All 1,552 offline and 358 PostgreSQL tests pass, including real completion replay/conflict checks, legacy NULL compatibility and preserved source-only reuse. Two migration-ledger assertions were updated for the twelfth migration. The preceding `775eda9` main/development checks and main synthetic lifecycle passed all CI gates.


### Direct document resolution and source-session release — NB1 lifecycle (2026-10-09)

Git connector 0.11.0 resolves the configured Swagger 2, OpenAPI 3.0 or OpenAPI 3.1 document directly from bounded immutable Git bytes, avoiding a preliminary analyzer call. An explicitly selected base commit yields an exact selected-document delta only when its contained document is readable and parses with the expected version. Missing or malformed base documents leave the proof incomplete; source profiles retain their existing fallback.

An exact-request release hook makes disposable sessions available for cleanup even when analysis is skipped or resolution validation fails. Recent successful releases are idempotent, substituted requests are rejected, and failed cleanup remains retryable. D08 releases owned resources before its final authority check and completion transaction; failure withholds snapshots and pointers.

All standalone document profiles remain partial because application/runtime binding is unverified. Unchanged bytes still trigger full analysis and fresh evidence for the target revision. This slice enables no partial-snapshot reuse, complete differences or runtime absence claim. Declaration caching requires a separate boundary; the existing complete source-reuse query selectors also require verification when selected and evidence revisions differ.

Validation: independent review, 22 focused Git-port unit cases and nine real-Git PostgreSQL lifecycle cases cover all three profiles, full-analysis fallbacks, capacity release, release failure and supersession during cleanup. A clean locked install/typecheck passed all 1,562 offline and 367 PostgreSQL tests.


### Qualified complete source-reuse reads — NB1 selected/evidence revision boundary (2026-10-09)

The query layer resolves an existing complete source-only D07 reuse association without pretending that its original evidence was collected at the later selected revision. Public revision, branch and environment contract reads retain `pin.revision` for the evidence snapshot and add `pin.selectedRevision` only for the qualified later selection. The helper validates the successful producing job, immutable base association, exact source/profile/configuration identities and complete reuse plan/difference set; branch selection additionally checks its selected revision and association key. Current grants and environment serving checkpoints remain required. Chained reuse preserves the same evidence revision.

Ordinary pins keep their existing shape. Legacy NULL fingerprints remain compatible only with the established complete source-only proof; extra manifests and partial document snapshots are excluded. Current publication and metadata observations are withheld for qualified selections. Keyword corpus matching and transaction consumers used by semantic services and observation imports fail closed until their contracts explicitly adopt both revisions. This does not enable document snapshot caching or deployment claims from branch pointers.

Validation: the real-Git PostgreSQL regression exercises complete Express analysis followed by two actual D08 reuse completions, exact revision/branch/environment reads, stale checkpoint and revoked-grant rejection, legacy NULL compatibility, corrupted plan rejection and withheld downstream operations. A clean locked install/typecheck passed all 1,562 offline and 368 PostgreSQL tests.


### Optional evidence-neutral document parse cache — NB1 bounded optimization (2026-10-09)

Git connector 0.12.0 adds an explicit host opt-in bounded in-memory cache for successful strict JSON/YAML parser trees. Each ports instance owns its cache; LRU entry and serialized-byte bounds apply, and disposal clears retained trees after active work drains. Scope includes tenant/repository/service/root/configuration, adapter and IR/parser versions, selected path and verified digest. The concrete fixed parser rejects substitute/proxy cache objects; scope is inert, detached and frozen at factory creation.

Swagger 2, OpenAPI 3.0 and OpenAPI 3.1 still reread and verify current selected bytes before lookup, run all projection/diagnostic/output checks, and rebuild evidence and result identities for the current request and revision. Failed parsing is not retained. Immutable parsed trees prevent later mutation from changing hits. The byte budget measures serialized JSON size rather than exact heap usage. This cache skips syntax parsing only; partial coverage, runtime unknowns and full D08 analysis remain unchanged. No snapshot reuse, migrations or deployment claims are added.

Validation: independent review resolved proxy/parser substitution and mutable factory-scope findings. Focused tests cover all three profiles, byte/scope invalidation, bounded eviction, failed parsing, post-factory mutation, real Git sessions and disposal. A clean locked install/typecheck passed all 1,572 offline and 368 PostgreSQL tests.


### CI PostgreSQL mirror at the existing immutable digest — P6 operating gate repair (2026-10-10)

The `034e11e` and `77f8dd8` CI PostgreSQL/Java gates failed before integration tests because Docker Hub rejected unauthenticated image pulls. A CI-only Compose override now selects the Docker Official Images repository on AWS ECR Public at the exact existing PostgreSQL 18.6-bookworm OCI index digest. The index bytes and Linux amd64 manifest were verified against the same Docker Hub digest. The default local Compose file, fixed project, loopback-only port, synthetic credentials, temporary storage, readiness and teardown remain unchanged.

Validation: read-only Compose configuration comparison confirmed the registry image reference is the only service-setting change; independent review and a clean locked install/typecheck passed all 1,573 offline tests. No local database was restarted or reset. At `8645fe8`, main CI successfully started the mirrored image and passed all offline, PostgreSQL, Java, Swagger runtime and browser gates.


### Qualified source-reuse keyword candidates and portal pin checks — NB1 downstream read boundary (2026-10-10)

Selected-operation and cross-service keyword matching now retain a qualified source-reuse pin's evidence revision and later selected revision. Snapshot identity and all cited evidence still bind to the original evidence revision; relabeled evidence, malformed selected revisions and extra pin fields are rejected. The pure matcher continues to require caller-authorized resolved context; it does not authorize reads or prove that a keyword match fulfills the task.

Portal candidate reloads and server-side candidate/discovery result checks compare the selected revision as part of the exact pin. Corpus output accepts only the expected environment pin fields, with the optional selected revision constrained to the shared immutable-revision format. The portal shows the selected revision alongside the evidence revision, and the MCP transport preserves both fields. Semantic services, observation imports, metadata samples and current OpenAPI publication for these qualified selections remain withheld until their own contracts adopt both revisions.

Validation: TDD reproduced a dropped selected-revision field being accepted by the browser and server, then verified rejection. Unit and HTTP tests cover malformed, missing and swapped qualification; real Git/D08 PostgreSQL tests cover per-service and cross-service candidates; browser cases cover original and qualified pins; an MCP protocol test preserves both revisions. Independent review and a clean locked install/typecheck passed all 1,589 offline, 368 PostgreSQL and nine browser tests. The preceding `8645fe8` main CI passed all gates.

### Unsigned controlled document-load gate — NB1 prerequisite (2026-10-10)

A separate internal collector supplies the exact bounded default Swagger document
bytes to the pinned parser and observes the canonical parsed definition through
handler dispatch. It rejects unsupported sources and references, withholds changed
values, and checks pinned framework files before loading them. Raw BOM/CRLF bytes
remain distinct from the parsed-value digest. The emitted metadata is unsigned;
signing, protected verification, durable admission and catalog promotion remain
open. Trusted-process instrumentation does not isolate hostile application code.

Validation: independent review resolved a pre-load integrity ordering defect.
A clean locked install/typecheck passed 1,592 offline tests; all 67 pinned framework
cases passed, including a modified-module sentinel that must never execute.

### Pure observed field-presence projection — P3 prerequisite (2026-10-10)

Observations 0.5.0 adds a bounded raw-JSON presence projector for owner-selected
literal schema paths under an exact environment, revision and snapshot pin. It
rejects duplicate members and only uses complete, unredacted bodies with matching
primitive declarations. Results contain states and selected static paths, never
values or value hashes, and cannot alter requiredness or other source contracts.
Host authorization and the completeness assertion remain trusted inputs. No body
source adapter, persistence, retention, portal/MCP or model integration is enabled.
Those lifecycle and authorization gates remain open.

### Qualified revision boundary for synthetic examples (2026-10-10)

Observed field-presence projection passed independent review and 1,608 offline
tests on a clean locked install. A downstream regression test then demonstrated
that existing synthetic examples discarded the selected/evidence revision
qualification. The pure generator and authorized service now withhold such
views; the final read compares the qualifier and discards stale candidates.
Supporting both revisions in example scopes remains later work.

### Numeric correspondence hardening — P3 projection (2026-10-10)

Three failing tests demonstrated unsafe integral rounding, rounded fractional
numbers and numeric underflow being accepted as integer type evidence. The
projector now checks safe integral representations and lexical decimal/exponent
scale before correspondence. Exact integral exponent/decimal forms remain
supported. This does not infer constraints or normative requiredness.

### Host-authorized observed field-presence reads — P3 boundary (2026-10-10)

Observations 0.6.0 adds a read-only host service with immutable scoped selector
policies, exact environment/checkpoint selection and caller-selected opaque
record IDs. Independent authority precedes schema preflight and body access.
Source attestations must match full pin, endpoint, direction, media type and
response status. A fresh final contract read and full pin comparison precede
independent final authorization; the host must atomically revalidate current
pin and all relevant grants. Callback deadlines suppress late results.

The service's host contracts are not a live log adapter or database authority.
No bodies, samples, retention tables, providers or catalog contracts are written.
Standalone projection input checking was also tightened after a failing test
showed malformed completeness could escape as a generic coercion error.

Validation: independent source review and public-export review passed; a clean
locked install/typecheck passed all 1,633 offline tests. Fourteen service tests
cover source denial, cross-operation attestations, exact response status,
qualified and changed pins, immutable policies, final-query revocation and
timeout suppression. Live transport and host database authority remain unproved.

### Revoked source/reader proxy rejection — P3 boundary fix (2026-10-10)

Two failing tests showed revoked Proxy objects could escape configured-reader
or source-attestation checks as generic JavaScript errors. The service now checks
proxy identity before array/object operations and returns the fixed configuration
or storage error. The source is not projected and no callback text is exposed.

### Explicit field-presence storage policy — P3 prerequisite (2026-10-10)

Observations 0.7.0 adds a pure versioned opt-in compiler and value-free storage
proposal gate. Owner revision, configuration activation epoch, endpoint selector,
selected paths, retention and budget are explicit and included in the static
policy fingerprint. Proposals require a resolved, untruncated query result supplied by the trusted
host, exact confirmed parent, independently supplied source digest and matching
projection. Qualified revisions and pointer-version views withhold.

Eleven focused tests cover strict policy limits, canonical fingerprints, malformed
paths/dates, parent ambiguity, unrelated unresolved records and projection scope.
Independent source review is complete. This is consistency checking, not database
authorization or source-to-record attestation. PostgreSQL owner approval,
DB-clock expiry, atomic quotas, opt-out and replay-safe deletion remain open.

### Owner-policy journal and pinned authority prerequisites — P3 (2026-10-10)

Observations 0.8.0 adds checksum-locked migration 0002 for immutable scoped owner
policy revisions and current heads. Policy heads cannot regress, change identity,
be deleted or re-enable a disabled generation. Configuration and owner access
scope references are explicit; no traffic or presence rows are stored here.

The internal observation transaction helper now accepts an exact activation epoch
and additional owner grants. Two PostgreSQL tests failed against the historical
helper (owner grant omitted and not locked), then passed with the extension.
These checks reuse the existing serving/configuration/catalog/source authority
transaction; importer behavior keeps its original default scope requirements.

Host-authenticated policy approval/CAS, derived presence storage, database-clock
retention, quotas and replay-safe deletion remain open. Schema constraints alone
are not an owner approval service.

### Derived presence retention integrity — P3 database prerequisite (2026-10-10)

Observations 0.9.0 adds migration 0003 with value-free derived rows and immutable
replay tombstones. Exact metadata/policy/source lineage and complete static
presence paths are checked. Database-clock lifetime starts at source window end;
exact retries cannot restart TTL. Policy-head locking enforces a policy-wide
unexpired-row budget across generations. Disabled/replaced/expired rows are hidden
from the live SQL view. Head-first deletion atomically tombstones and deletes only
derived rows; metadata remains append-only.

The first six integration tests failed before storage existed. Fourteen focused
PostgreSQL cases now cover TTL/replay, concurrent budgets, opt-out/replacement,
privacy/lineage, atomic rollback and real database-time expiry. Review exposed standalone tombstone poisoning; two additional failing tests
now require an existing result at tombstone insertion and completed deletion at
transaction commit. Public persistence
and authorized query/maintenance services are still required; a SQL view or delete
primitive does not grant authority. Physical cleanup is now available through the
authenticated maintenance store and bounded in-process runner documented below;
durable distributed scheduling remains open.

### Host-authenticated owner-policy approval — P3 authority (2026-10-10)

Observations 0.10.0 adds an owner-policy store with immutable host scope bindings,
independent manager authentication/capability and owner grants. Approval locks
exact configuration epoch, current serving pin and catalog/source/owner authority
before schema preflight and policy-head CAS. Exact live retries are idempotent;
a disabled generation requires a new revision. Disable uses independent owner
authority even when source/catalog read grants are withdrawn.

Nine focused PostgreSQL tests cover denial before connection, callback failures,
late-result suppression, inert identities, detached policies/bindings, stale pins,
valid concurrent CAS contenders, replay and revocation. Root review corrected a
race test whose second contender originally failed schema preflight rather than
CAS. Body provenance, authenticated derived imports/queries, retention maintenance
and public owner-management surfaces remain separate gates.


### Authenticated value-free presence persistence and maintenance — P3 (2026-10-10)

Observations 0.11.0 adds an independently authenticated import capability with
immutable host owner/import scope bindings. Pre-read and final transactions check
current unqualified serving/configuration pins, the policy activation epoch,
enabled immutable policy, exact confirmed parent and independent grants. The
trusted source port must establish exact body-to-import/record correspondence;
supplied identifiers alone are not proof. Bodies are read outside database locks,
bounded and projected to selected field states; only value-free states reach SQL.
Safe retries preserve database-clock expiry, quotas and deletion tombstones.

Migration 0004 adds a non-unique scoped record index for ambiguity detection across
imports. A PostgreSQL query-plan regression failed without it. Internal transaction
constraints reject qualified pins before callbacks and set local lock/statement
deadlines before authority locks. Existing metadata importer defaults are retained;
owner approval opts into both constraints.

The separate maintenance capability authenticates against immutable host bindings
and independent current owner grants. It deletes at most 100 expired, disabled or
superseded rows atomically, preserving metadata and permanent replay tombstones.
It does not need catalog/source reader access or current log configuration. Nine
focused PostgreSQL tests cover batch bounds, database expiry, live-row preservation,
revocation, detached bindings, inert identities, authorization deadlines, concurrent
cleanup, rollback and quota release after generation replacement.

At this checkpoint, public queries, automatic cleanup and downstream presentation
were separate gates; their bounded implementations are documented below. Live
provider correspondence, durable distributed scheduling and reviewed samples remain
open. This slice does not infer required fields, promote observations to normative
contracts or complete P3.

#### Authorized presence read acceptance

- Authenticate an independent `observations.presence.read` capability before any
  database access. Use detached host scope bindings with independent owner/read
  access scopes; never accept caller identities or access-scope names.
- Read under the current unqualified serving/configuration pin and locked
  catalog/source/owner/read grants. Compare the immutable enabled policy's
  activation epoch to the locked current configuration, not an earlier cache.
- Join derived rows to the exact immutable metadata parent/import and current
  policy generation. Filter expiry using database time and retain complete pin,
  policy and parent provenance in value-free output. Deny stale or revoked views.
- Bound the first result page explicitly and report truncation; no hidden history
  scan, raw SQL result passthrough, raw body access or observations-to-contract
  promotion. Cover current serving changes, opt-out, generation replacement,
  expiry, grant revocation, scope isolation and malformed requests with PostgreSQL
  tests before exposing the read service to portal/MCP.

### Authorized value-free presence queries — P3 (2026-10-10)

Observations 0.12.0 adds an independently authenticated read capability with
detached host bindings and current locked owner/read grants. The transaction
rechecks the unqualified serving pin, configuration, enabled immutable policy,
schema paths, source adapter and exact confirmed metadata/import lineage. Only
the current policy generation and serving checkpoint can appear in bounded output;
expiry uses the database clock and reads do not renew TTL or write records.

Independent review found an incorrect equality between configuration activation
epoch and environment serving checkpoint. These counters now remain independent:
policy activation matches the configuration epoch, while observation imports match
the current serving checkpoint. Additional checks withhold ambiguous UUIDs,
unsupported source-window precision and malformed stored lineage. Results retain
full scope/pin, source digest, policy fingerprint and exact parent provenance, and
explicitly mark field presence as non-normative. No raw body or value is returned.

A locked clean install passes 1,650 offline tests and 444 PostgreSQL tests. The
18 focused query cases include real database expiry, independent serving/config
epochs and a grant-lock/revocation race; four offline boundary cases cover
authorization deadlines, inert identities, detached bindings and fixed errors.
Restoring the erroneous counter equality in an isolated test copy reproduces the
stale-pin failure; the reviewed implementation passes the same regression.

#### Portal/MCP presence presentation acceptance

- Bind independently authenticated presence-reader credentials to the same
  tenant/principal authenticated by the transport before accessing storage;
  supplied identities alone cannot authorize a read.
- Derive tenant from the host principal. Require the exact current environment
  pin, policy generation and explicit result limit; reject qualified views and
  caller-supplied credentials, access scopes or capabilities.
- Expose only value-free observed states with full provenance and explicit
  non-normative/truncation labels. Recheck displayed selection and suppress stale
  responses when users change the selected service, environment or policy.
- Cover denied/mismatched principals, stale pins, output limits, malformed input,
  transport error sanitization and stale browser responses before closing this
  gate. Owner writes, live source adapters, scheduled cleanup and reviewed samples
  remain separate work.

### Principal-bound portal/MCP field presence — P3 (2026-10-10)

Observations 0.13.0 adds a shared `readForPrincipal` path: transport credentials
must independently authenticate as the same tenant/principal before storage is
contacted. An inert detached principal anchor alone cannot authorize a read.
Existing current pin, policy and grant checks remain in the same transaction.

Portal 0.3.0 and MCP 0.2.0 expose optional read-only presence surfaces with exact
environment pin, policy generation and explicit 1–100 limit. Tenant comes from
transport authentication; caller credentials, identities, access scopes,
capabilities and qualified fields reject. Output caps and sanitized fixed errors
apply. No owner approval, import or cleanup write is exposed.

The portal's optional form checks the displayed unqualified pin, source digest,
policy generation, endpoint membership and exact value-free result shapes. It
shows provenance and present/absent states as text with non-normative/truncation
labels. Contract or policy changes suppress pending replies; malformed, denied or
stale responses clear output. Controlled browser tests include vendor JSON media,
native timestamp precision, forbidden extra values and delayed responses.

A locked clean install passes 1,672 offline tests, 445 PostgreSQL tests and
10 browser tests. Transport regressions first fail without the new surfaces;
principal isolation, fixed errors and stale browser replies pass with them.

#### Next P3 acceptance: bounded automatic retention cleanup

- Schedule only immutable explicitly configured policy/scope bindings; do not
  discover all branches or scan a policy history to decide what to clean.
- Use the authenticated maintenance store and independent host credentials for
  each bounded batch. Retain grants, tombstones, database-clock TTL and live-row
  protection; scheduling alone grants no authority.
- Rotate through configured policies fairly with a bounded count per pass and
  one in-flight pass. Schedule the next interval after settlement; avoid overlap
  and accumulated catch-up work.
- Abort bounded credential reads on stop and suppress late results. Drain an
  already-started cleanup before stop returns rather than reporting cancellation
  while database mutations continue unseen.
- Report only frozen numeric summaries and fixed status; withhold scope IDs,
  credentials, traffic values and callback/database error text. Prove timer,
  stop/start, overlap, fairness and real PostgreSQL retention behavior. Durable
  multi-process scheduling, live source adapters and reviewed samples remain
  separate gates.


### Bounded in-process retention runner — P3 (2026-10-10)

Observations 0.14.0 adds an opt-in runner over the authenticated maintenance store.
Only explicitly configured immutable scope/policy bindings are visited, fairly
and within bounded per-pass/per-batch limits. Manual and automatic triggers share
one active pass; the next interval begins after settlement with no catch-up queue.
Credential reads have a ten-second abortable deadline. Stop cancels pending reads,
ignores late credentials and drains already-started cleanup before returning;
restart waits for that drain. Numeric-only frozen summaries and isolated observers
withhold credentials, scope identifiers and callback/database errors.

Real PostgreSQL composition covers live-row preservation, disabled-row cleanup,
permanent tombstones, unchanged metadata, credential denial before storage, owner
grant revocation/restoration and database-clock expiry. This closes bounded
in-process scheduling only. Durable distributed scheduling, live source adapters,
independently verified body correspondence and reviewed samples remain open.

Validation: independent lifecycle/configuration review found no remaining blocker.
A locked clean install passes 1,683 offline tests and 447 PostgreSQL tests. Eleven
focused runner tests cover overlap, fair rotation, deadlines, stop/drain/restart,
inert configuration, malformed cleanup results and observer isolation.


### Combined local presence lifecycle — P3 validation (2026-10-10)

`npm run test:presence` runs the focused database-backed owner/import/query/
maintenance suites plus one combined lifecycle. The combined case uses public
owner approval, metadata import, body-field import, principal-bound read, disable
and runner-cleanup factories. SQL only bootstraps the synthetic catalog and checks
stored results; policies, metadata parents and derived rows are created through
their services. Different host credentials have independently bounded grants.

The in-memory synthetic capture matches independently configured parent IDs,
full pin, source window and exact response selector. It does not derive its
attestation from a read request. The test checks exact retries, value-free current
pin/provenance, reader grant revocation/restoration, disabled-policy withholding,
physical deletion with tombstones, and original metadata preservation. It proves
local composition, not live collector trust or reviewed request/response samples.
Local setup now distinguishes the separate bounded Java and OpenAPI 3.1 profiles.

Validation: an independent review and a locked clean install/typecheck pass;
`npm run test:presence` passes all 57 focused PostgreSQL cases across five files.
The combined response-field case uses distinct credential and grant boundaries.


### Selected signed field-presence file source — P3 bounded adapter (2026-10-10)

Observation-file connector 0.2.0 adds a selected-parent source port for the
presence importer. An externally configured Ed25519 key verifies a purpose-bound
signed envelope containing independent full-pin/source/parent/selector facts and
one bounded complete payload. The host scope allowlist is immutable; the file
cannot choose its key, paths or scope. The reader touches only the exact selected
UUID filename, rejects symlinks/nonregular/oversized/growing files and malformed
UTF-8/strict JSON, honors aborts and returns fixed errors without values or paths.

The signed source digest is checked against the current authorized snapshot by
the importer; signature verification alone does not authorize a read or prove a
real collector. The connector writes nothing and does not retain payloads. The
host remains responsible for signer/source trust and retention of its source
files. Live log providers, collector isolation and reviewed samples stay open.
The composed PostgreSQL lifecycle now covers a genuine signed file and body
alteration retaining the old signature, alongside the in-memory fixture.

Validation: independent review, locked clean install/typecheck, 1,708 offline
tests and 451 PostgreSQL tests pass. Twenty-five focused source-reader cases and
four composed lifecycle cases cover valid request/response selectors, purpose/key
mismatch, tampering, full lineage checks, active-source digest mismatch, bounds,
abort and inert inputs. Restoring duplicate-capability acceptance in an isolated
copy makes the identity regression fail; the reviewed reader passes it.


### Bounded cross-service semantic shortlist — P4 (2026-10-10)

Semantics 0.7.0 composes authorized current-environment keyword retrieval with
configured per-service discovery. At most sixteen candidates and four service
groups are compared; unsupported qualified pins and excess groups are withheld
before provider work. Results keep each repository/service namespace and pin,
including identical endpoint IDs in different services. Current contract/evidence
checks precede inference, and the same authorized corpus query runs again after
all calls. A changed shortlist or authority discards the whole response.

Keyword shortlist coverage and analyzed semantic context remain separate. Empty
keyword results do not establish enterprise-wide API absence. Suggestions remain
inferred, unreviewed and non-normative; an embedding index, durable review, live
provider evaluation and an overall operation deadline remain open. The public
factory cannot accept caller-selected provider credentials or identity.

Validation: independent implementation review, locked clean install/typecheck,
1,719 offline tests and 457 PostgreSQL tests pass. Eleven focused unit cases and
fifteen corpus database cases cover all three synthetic configured providers,
cross-service endpoint-ID collisions, mid-call grant revocation, no-context
shortlists, disabled inference, inert inputs and grounded output validation.


### Portal/MCP semantic corpus comparison — P4 (2026-10-10)

Portal 0.4.0 and MCP 0.3.0 expose optional host-bound cross-service comparison.
The HTTP route and MCP tool accept only environment, task and a required bounded
limit. Host authentication supplies identity; strict parsing and fixed errors
withhold raw provider failures. Capability absence hides the form/tool and leaves
the route unavailable. External inference is explicitly non-idempotent/open-world.

The browser action is explicit, renders provider text safely, separates service
namespaces and pins, labels incomplete/truncated shortlists and partial semantic
context, and discards late replies after input changes. Suggested contract loads
reauthorize the exact checkpoint and withhold mismatched source pins. Empty keyword
shortlists never imply enterprise-wide API absence. Semantics 0.7.1 additionally
requires actual discovery context coverage and an incomplete-shortlist reason;
malformed ports cannot silently omit those disclosures.

Validation: independent review, locked clean install/typecheck, 1,726 offline
tests, 459 PostgreSQL tests and eleven real-browser checks pass. Real database
composition exercises both portal HTTP and MCP protocol calls using the configured
semantic service. Red/green regressions establish the optional route/tool and
required coverage gates. The browser rejects malformed group/candidate namespaces,
checks exact pins, renders HTML-shaped prose as text and suppresses late answers.
A corpus embedding index, durable review and live model evaluation remain open.


### Analyzed-context consistency and curated decoys — P4 (2026-10-10)

Semantics 0.7.2 rejects inferred suggestions or ambiguity naming an operation
omitted from analyzed context. Inference statuses require nonempty analyzed
context; `no_context` requires zero analyzed operations. Valid partial suggestions
remain available with their omitted IDs. Red regressions demonstrate that the
previous port validator accepted contradictory coverage before this correction.

The 35-question analyzer-backed corpus now explicitly executes every discovery
outcome. Similar entity names with delete/cancel/refund actions, mixed order/invoice
intents, representative exact keyword ranks/scores, missing context, ambiguity and
closed-scope no-match remain distinct. Wrong-environment analyzer candidates are
withheld before contract/provider access. Scripted model outcomes verify protocol
and citation handling only; they do not measure live semantic understanding.

Validation: independent review and a locked clean install/typecheck pass all
1,733 offline tests and seventeen focused PostgreSQL corpus cases. Eighteen direct
corpus validation cases and forty-two question/manifest boundary checks pass.
The preceding `57e94ec` main commit passes all five CI jobs, including the full
459-case database suite, eleven browser cases, pinned Swagger runtime and Java.
Live model evaluation, semantic indexing and durable owner review remain open.


### Protected signed document-load verification — NB1 boundary (2026-10-10)

Git connector 0.13.0 adds a separate purpose-bound Ed25519 verifier over canonical
`{scope, observation}` data, including tenant identity. A trusted host pins the
external envelope/key hashes and independently establishes the complete expected
source/session/framework/document/handler observation. Authorization precedes
reads and is checked again before delivery; one abortable deadline, strict
structure/size bounds and fixed errors constrain the port. No source code runs.

The actual pinned Node/Swagger fixture captures document loading during request
dispatch, signs outside the checkout, then verifies in a separate Node process.
Expected document and handler bytes come independently from the committed Git
revision; framework hashes come from the locked fixture. An unchanged execution
marker proves verification does not dispatch the handler again. The output is
separate metadata, with no IR claims or catalog promotion. Durable composition
with capture provenance and document correspondence, qualified downstream reads,
production capture isolation and normative authority remain open.

Validation: TDD first reproduced missing protected runtime delivery. The reviewed
implementation passed a clean locked install/typecheck with 1,750 offline tests,
17 focused verifier tests including the exact signed-wrapper byte boundary, and
all 68 pinned framework cases. Existing D08 runtime rejection remains intact.


### Same-session loaded-document and handler composition — NB1 (2026-10-10)

Git connector 0.14.0 composes the concrete signed-load and immutable Git/document
correspondence ports. It requires one exact scope and shared host authorization,
stable protected load evidence before/after comparison, the same capture session,
raw and parsed document hashes, ordered handler bindings and complete unambiguous
matches for those bindings. Unsupported or ambiguous comparison withholds the
result. Unobserved declarations remain explicit and do not establish API absence.

The internal controlled collector exposes an unsigned handler receipt only after
its document-load gate succeeds. The pinned fixture signs both observations from
one actual request outside the checkout, compares them against committed source
in a separate process, and checks that source trees are cleaned and the handler
is not run again. The result is separate metadata. Durable admission/association,
qualified downstream catalog reads, production capture isolation and normative
contract promotion remain open.

Validation: TDD reproduced the missing gated receipt and missing session/value
metadata. Independent review and a clean locked install/typecheck passed 1,763
offline tests; all 68 pinned framework cases passed. Thirteen new real-Git tests
cover two ordered handlers, stable external evidence, canonical/raw/session/router
mismatches, unsupported/ambiguous declarations, hostile configuration and shared
authority revocation. Preceding `78150b7` main CI passed all five gates.


### Immutable loaded-document verification summaries — NB1 (2026-10-10)

The orchestration store accepts an exact host-bound source/environment/capture
identity and invokes the installed composed verifier only after checking both
existing capture and handler-byte verification. It validates the detached result,
then rechecks permission and locks both parents inside the write transaction.
Concurrent exact replay creates one summary; changed proof at the same load
identity fails. Optional database-local finalization rolls back on denial/error.

Migration `0013_loaded_document_verifications` stores scope, opaque references,
digests, session/root and bounded counts. Parent foreign keys and immutable
triggers retain provenance without document prose, route/handler paths, bodies
or key bytes. These are historical verification summaries. Loaded-document job
admission/execution, current qualified readers and catalog/environment promotion
remain open.

Validation: TDD exposed the migration count and reviewed public-export list
changes. Independent review and a clean locked install/typecheck passed all 1,763
offline tests; the complete PostgreSQL suite passed all 461 tests. Real-Git and
signed-load composition, concurrent replay, conflicting/distinct load identities,
missing/forged parents, scoped denial, atomic finalization, immutable rows and
configured-schema lookups are covered.


### Separate loaded-document admission — NB1 scheduling (2026-10-10)

A distinct `swagger-loaded-document-1` intent fixes capture/load identity and
source/environment/root to trusted host bindings. Callers cannot choose artifact
references, keys, profile or proof. Capability denial precedes database access.
The admission transaction locks active configuration, capture/handler parents
and configured catalog grants; host policy independently locks source,
environment and artifact permissions plus opt-in for that exact configuration
hash/activation checkpoint.

Load identity agrees with the loaded-summary formula. Job identity also pins the
configuration epoch/root, so switchback requires fresh opt-in and a distinct job.
Tenant locking serializes quota and exact replay. Migration `0014` records
immutable queued intents separately; it invokes no verifier and writes no loaded
summary, catalog snapshot or environment pointer. Typed leases, bounded
execution with atomic summary completion, supersession cleanup and qualified
reads remain open.

Validation: the initial TDD run rejected the absent admission module. Independent
review fixed a concurrency-test ordering assumption. A clean locked installation
and typecheck passed all 1,763 offline tests; all 466 PostgreSQL tests passed from
the staged archive. Five focused PostgreSQL cases exercise concurrent replay and
quota, exact load identity, epoch switchback, missing parents, malformed/hostile
inputs, mismatched artifact opt-in, revoked grants and immutable intents.


### Loaded-document worker claims and renewal — NB1 (2026-10-10)

A distinct lease store checks `swagger.document.verify.execute` before storage,
then validates the current configuration epoch, recomputed load/job identities,
capture/handler parents, configured grants and independent source/environment/
artifact execution permission. Worker/instance identity and bounded repository/
service allowlists are fixed by the host.

Migration `0015` creates separate lifecycle state and immutable claim history,
backfills existing admissions and enqueues new ones by trigger. Admission quota
now counts active lifecycle rows. Shared tenant locking limits two live leases
per tenant and one per repository/service/environment. Scans stop at 32 and
no-work results have partial coverage. Database-clock leases last 120 seconds;
only token hashes persist. Renewal rechecks authority and exact ownership;
reclaim rotates tokens and expiry after three attempts becomes a fixed failure.

This step claims/renews work without executing a verifier, storing a loaded
summary or changing catalog/environment pointers. Atomic verification execution,
retry scheduling, supersession cleanup and qualified reads remain open.

Validation: TDD exposed the absent module and incomplete policy fixture.
Independent review corrected environment binding, capacity assertions and legacy
backfill setup. A clean locked install/typecheck passed all 1,763 offline tests;
all 472 PostgreSQL tests passed from the staged archive, including the final
frozen full-binding return. Six focused cases cover upgrade/backfill, independent
environments, concurrent tenant capacity, ownership/token expiry/reclaim, three
attempts, current epoch/grant/artifact fences and immutable token-free history.


### Atomic loaded-document verification execution — NB1 (2026-10-10)

A separate worker runs a host-configured verification port outside database
transactions, renews ownership and supplies a deadline/abort signal. The host
port must cooperate with cancellation and complete cleanup before settling;
late results are fenced from persistence. Factory bindings include the exact
capture, load artifact, source, environment and configuration epoch.

Finalization shares the admission tenant lock and rechecks configuration,
capture/byte parents, configured grants, independent artifact execution policy
and live ownership. Migration `0016` requires the immutable result, safe summary
and successful state to agree on identity, digest, counts, attempt and database
completion time. Failed finalization rolls back all completion writes. Fixed
unverified proofs fail terminally; transient failures use database-clock retry
backoff with at most three claims. No raw error, token or source content persists.

This records historical controlled-load evidence. It does not publish a catalog
snapshot or establish deployment presence or normative API behavior. Superseded
job cleanup and downstream qualified reads remain separate follow-up work.

Validation: a clean locked installation/typecheck passed all 1,765 offline tests;
all 481 PostgreSQL tests passed from the staged archive. Nine focused PostgreSQL
cases cover composed signed-load/Git proof, atomic success, deterministic failure,
deadline/abort cleanup, deadline during factory creation, retry backoff and the
three-claim limit, revoked execution policy, injected result-write rollback,
missing-result constraints and immutable successful records. Two offline tests
check denied execution and hostile configuration without storage/protected reads.


### Superseded loaded-document job maintenance — NB1 (2026-10-10)

A separate `swagger.document.verify.manage` capability permits bounded cleanup
of queued, leased or retry-wait jobs from older configuration epochs. The host
fixes manager identity and repository/service allowlists. Independent manager
permission must be locked in the cancellation transaction, including for a
service removed from the current configuration. Current execution grants do not
implicitly confer management permission.

Maintenance shares the admission/lease tenant lock, validates the active
configuration and old job identity, and authorizes only the configured scan
window. One extra candidate reports partial coverage without triggering another
manager callback. Migration `0017` records a fixed supersession reason. Cancelled
jobs release quota and ownership; late worker output cannot complete them.
Switching back to a previous fingerprint creates a new checkpoint epoch and does
not revive cancelled jobs. Results are count-only; protected artifact/key
references are never selected. Historical proofs and completed results remain.

Qualified downstream reads and safe incremental multi-input reuse remain open.

Validation: independent review found and corrected a lookahead callback-window
violation. A clean locked installation/typecheck passed all 1,765 offline tests;
all 488 PostgreSQL tests passed from the staged archive. Seven focused cases
cover live lease cancellation/quota release, removed-service manager permission,
checkpoint switchback, late worker rejection, strict denied-first scan bounds,
unchanged completed proof/result history and pre-storage hostile-input denial.
