# API Truth — Development backlog

**Updated:** 2026-09-29
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
| D08 | In progress: slices 0–5 of 0–7 complete | Slice 6 PR preview execution is implemented; exact branch/PR reconciliation and slice 7 remain. |
| D09–D13 | Open | Phase 1 environment, publication, access, reference workflow, and release gates remain. |
| Phases 2–6 | Planned | Java/framework conformance, runtime evidence, semantic discovery, related documents, and operating readiness follow their roadmap gates. |

The first working release requires the complete Phase 1 loop. D08 progress is
not a claim that deployment, OpenAPI publication, the portal, or MCP tools work
yet. `main` may lag `development` while a task is under review.

## Now — finish event orchestration

| ID | Status | Work | Acceptance gate |
|---|---|---|---|
| D08-S6 | In progress | Isolated PR previews; exact branch and PR reconciliation; missed-event repair; confirmed branch absence; configuration-change reconciliation. | PR preview execution and close-during-analysis race now pass PostgreSQL integration tests. Next: exact branch/PR reconcilers, missed-event repair, absence, configuration-change races, and full lifecycle gate. |
| D08-S7 | Open | Local round trip, truthful package and architecture docs, status/observer projections, privacy and failure hardening. | Clean install, full offline/PostgreSQL suites, required repeated race gates, teardown, safe status visibility, and independent review pass. |

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
