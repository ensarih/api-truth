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
| D08 | In progress: slices 0–6 of 0–7 complete | PR previews, exact branch/PR reconciliation, durable scheduler requests, and configuration-change races pass the slice 6 gate. Slice 7 remains. |
| D09 | Complete: slices 0–4 | Deployment facts, serving checkpoints, exact-scope repair, authorized views, and the local lifecycle pass 320 offline and 181 PostgreSQL tests. Independent review findings on request races, removed scopes, migration cutover, and stale views are fixed. |
| D10 | In progress: slices 0–1 complete | Evidence-gated OpenAPI 3.1 compilation passes tests and independent review. Variant representation and atomic publication remain. |
| D11–D13 | Open | Authorized access, reference workflow, and release gates remain. |
| Phases 2–6 | Planned | Java/framework conformance, runtime evidence, semantic discovery, related documents, and operating readiness follow their roadmap gates. |

The first working release requires the complete Phase 1 loop. D08 progress is
not a claim that deployment, OpenAPI publication, the portal, or MCP tools work
yet. `main` may lag `development` while a task is under review.

## Now — finish event orchestration

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D08-S6 | Complete | Isolated PR previews; exact branch and PR reconciliation; missed-event repair; confirmed branch absence; configuration-change reconciliation. | Exact branch/PR scope validation, closed-PR protection, base prerequisite, absence, no-work replay, durable scheduler duplicate/conflict, stale-generation and configuration-change races pass PostgreSQL lifecycle tests; 307 offline and 141 PostgreSQL tests pass. |
| D08-S7 | In progress | Local round trip, truthful package and architecture docs, status/observer projections, privacy and failure hardening. | Local workflow and status projections implemented; clean install and dependency audit pass; 307 offline, 142 PostgreSQL, 84 focused orchestration, and three repeated 7-test race runs pass; teardown and privacy scan pass. Independent adversarial review remains before closure. |

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
| D10-S2 | Open | Faithful variant aggregation or explicitly scoped export. | Compatible media-type variants preserve request/response relationships. Header-dependent or incompatible variants cannot overwrite each other or broaden the accepted combinations. |
| D10-S3 | Open | Immutable validated artifacts and atomic publication manifests. | Branch/revision/environment selectors pin exact snapshot/configuration; failed compilation or publication preserves the prior valid manifest. |
| D10-S4 | Open | Local compiler/publication round trip and documentation. | Draft/strict, reference/schema validation, deterministic bytes, rollback on failure, and recovery tests pass using public synthetic fixtures. |

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
