# API Truth — Development backlog

**Updated:** 2026-09-30
**Source of truth for work status:** this file
**Scope:** public synthetic-fixture development; an enterprise pilot requires separately authorized inputs.

This backlog tracks delivery work and its acceptance gates. The [product
specification](SPECIFICATION.md) defines the intended behavior, the [roadmap](ROADMAP.md)
defines phase gates, and the [Node.js analyzer backlog](NODEJS_ANALYZER_BACKLOG.md)
contains the detailed adapter expansion. A **complete** status means implemented,
reviewed, and validated; it does not imply that a later phase is complete.

## Current position

| Work | Status | Evidence or next gate |
|---|---|---|
| D01–D07 | Complete | Synthetic constraints/fixtures, executable contracts, local test harness, bounded Express extraction, PostgreSQL catalog, and dependency-aware updates are committed. |
| D08 | Complete: slices 0–7 | PR previews, exact reconciliation, durable scheduling, safe status reads, bounded observer signals, and local lifecycle pass the final gate. |
| D09 | Complete: slices 0–4 | Deployment facts, serving checkpoints, exact-scope repair, authorized views, and the local lifecycle pass 320 offline and 181 PostgreSQL tests. Independent review findings on request races, removed scopes, migration cutover, and stale views are fixed. |
| D10 | Complete: slices 0–4 | Evidence-gated OpenAPI 3.1 compilation, safe `consumes` variant aggregation, durable revision/branch/environment publication, offline official-schema validation, and a local round trip pass full suites. |
| D11–D13 | D11 started; D12–D13 open | Shared authorized access, portal/MCP, reference workflow, and release gates remain. |
| Phases 2–6 | Planned | Java/framework conformance, runtime evidence, semantic discovery, related documents, and operating readiness follow their roadmap gates. |

The first working release requires the complete Phase 1 loop. D08 progress is
not a claim that deployment, OpenAPI publication, the portal, or MCP tools work
yet. `main` may lag `development` while a task is under review.

## Now — finish event orchestration

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D08-S6 | Complete | Isolated PR previews; exact branch and PR reconciliation; missed-event repair; confirmed branch absence; configuration-change reconciliation. | Exact branch/PR scope validation, closed-PR protection, base prerequisite, absence, no-work replay, durable scheduler duplicate/conflict, stale-generation and configuration-change races pass PostgreSQL lifecycle tests; 307 offline and 141 PostgreSQL tests pass. |
| D08-S7 | Complete | Local round trip, truthful package and architecture docs, status/observer projections, privacy and failure hardening. | Independent review found missing observer and active-configuration status disclosure; both were fixed with tests. The observer emits fixed, bounded ingress/job/reconciliation/catalog/outbox signals without scope IDs or error text; denied ingress needs no database write. Missing and denied active-configuration status share one error. Full focused orchestration suite passes 85/85; typecheck and privacy checks pass. |

The detailed D08 implementation brief is a local working document. These two
rows remain in this tracked backlog so the outstanding work survives outside
that brief. Reviewed D08 slices 0–5 stay complete; new defects reopen the
affected slice rather than being hidden in a later task.

## Next — complete the first working release

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
| D11-S3 | In progress | Minimal environment-aware portal. | Host-authenticated service browsing, explicit revision/branch/environment selection, contract summary with coverage and analysis time, endpoint/schema/evidence detail, comparison, and scoped immutable OpenAPI download use the shared query layer. Client tenant spoofing is rejected; unknown states expose no contract. Unit and PostgreSQL-backed HTTP tests cover publication bytes and revocation. Browser interaction and cross-surface conformance remain. |
| D11-S4 | In progress | Read-only MCP tools and cross-surface gate. | Five official-protocol MCP tools cover service search, contract, endpoint, schema, and comparison using explicit selectors and the shared query reader. Inputs/results are bounded, identity is supplied only by the host, and no administrative tools are exposed. Linked protocol tests and a PostgreSQL-backed portal/MCP/export same-publication and revocation test pass for an immutable revision. Environment-specific cross-surface and browser gates remain; safe examples wait for Phase 3 evidence. |

### D12 slices

The reference automation connects the already implemented event and deployment
boundaries to one public, synthetic GitHub Actions workflow. Enterprise CI/CD
products can use the same provider-neutral envelope later. Branch selection is
the configured exact `intended_branches` list; a provider event never expands
it into an all-branches scan.

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D12-S0 | In progress | Provider-neutral local event and deployment adapter. | A bounded local formatter normalizes PR, branch, deployment attempt, explicit serving observation, and reconciliation facts to validated D03 event envelopes. A host-attested local bridge checks exact fact bytes and digest, active configuration, provider/reference, and known artifacts before D08 durable ingestion. Unit and PostgreSQL tests cover duplicate, stale, rejected, and seven-event delivery. Actual provider authentication and artifact provenance remain host responsibilities; provider wiring remains. |
| D12-S1 | Complete | Reference GitHub Actions workflow and synthetic fixture driver. | The synthetic-only workflow pins actions and Node, uses a read-only token and no persisted checkout credentials, skips forked PRs, applies exact branch selection, and uploads seven validated baseline/PR/merge/UAT/reconciliation envelopes. The local driver and security tests pass; it does not ingest events or deploy. |
| D12-S2 | Open | Automatic lifecycle and repair verification. | A local runner proves PR preview isolation, merged branch update, UAT-only deployment, failed mixed rollout, authoritative rollback, duplicate event, and missed-event repair without a manual rescan after baseline. PostgreSQL state and published/query views agree at each step. |

### D13 slices

Phase 1 closes only when the complete path works from a fresh checkout and its
limitations are stated plainly. A local synthetic run proves the mechanics;
it does not substitute for a protected enterprise pilot.

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D13-S0 | Open | Fresh-checkout setup and operator guide. | Pinned runtime, disposable PostgreSQL startup/teardown, initial configuration, authentication ports, supported framework constructs, and local demo commands work without undocumented manual steps or API keys. |
| D13-S1 | Open | Full Phase 1 scenario and cross-surface conformance. | The nine-step [Phase 1 scenario](ROADMAP.md#exit-gate-1) passes from baseline through PR, merge, UAT, failure, rollback, replay/repair, publication failure, and same-pin portal/MCP/export reads. Denied and revoked access fail on every surface. |
| D13-S2 | Open | Public release hygiene and v0.1 readiness review. | Synthetic-only fixtures/artifacts, license/governance/security reporting, supported/unsupported matrix, privacy scan, clean install, all offline/PostgreSQL/protocol/browser tests, and known limits are documented. Publish a release only after the gate passes. |

## Later phases and analyzer coverage

| ID | Phase | Work | Gate |
|---|---|---|---|
| P2-JAVA | 2 | Java/Spring adapter and shared two-ecosystem conformance. | The Java fixture completes the Phase 1 downstream flow; supported syntax/classpath ranges and unknowns are explicit. |
| P2-NODE | 2 / measured pilot demand | Expand Node.js coverage through [NB1–NB8](NODEJS_ANALYZER_BACKLOG.md). | Select a versioned profile from an authorized inventory; Swagger/OpenAPI, decorators, and mixed routing each meet their own conformance gate before support is claimed. |
| P3-LOGS | 3 | Sanitized runtime evidence, deployed URL correlation, and examples. | Ambiguous mappings stay unresolved, sensitive values never persist, and documentation still works when logs or bodies are unavailable. |
| P4-SEMANTICS | 4 | Intent search and semantic understanding using configurable OpenAI, Gemini, and Claude adapters. | Grounded environment-specific answers pass the question evaluation; deterministic tests verify adapters and models neither run nor grade tests. |
| P5-DOCS | 5 | Permission-scoped read-only Confluence links and discrepancies. | Findings retain both sources, versions, scopes, and review state; revocation invalidates dependent views. |
| P6-OPS | 6 | Capacity, backup/restore, access audits, operations, and public v1 release readiness. | The [Phase 6 exit gate](ROADMAP.md#exit-gate-6) passes with published measurements and honest supported ranges. |

The Node.js backlog is a detailed child backlog. Its NB1 contract and
authority decisions are prerequisites for document/decorator adapters; current
`typescript-express@0.1.0` support does not imply those adapters exist. Java,
logs, semantic providers, and Confluence are planned capabilities, not current
implementation claims.

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
