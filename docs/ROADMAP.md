# API Truth — Phases and Release Gates

**Status:** all phases unstarted; planning documents are the current deliverable.  
**Date:** 2026-09-15  
**References:** [specification](SPECIFICATION.md), [architecture](ARCHITECTURE.md), [implementation plan](../PROJECT%20PLAN.md).

Phases are acceptance-gated. Version numbers below are proposed milestones, not published releases or time estimates. Continuous updates and environment support are mandatory in Phase 1; later phases deepen them rather than introduce them.

## Overview

| Phase | Milestone | Outcome |
|---|---|---|
| 0 | Development preparation | Fixtures, decisions, data/event contracts, and public-project foundations |
| 1 | v0.1 — Continuous environment-aware catalog | One framework, CI/CD lifecycle, OpenAPI, basic portal and MCP |
| 2 | v0.2 — Java and framework conformance | Second ecosystem validates the shared model and plugin boundary |
| 3 | v0.3 — Runtime evidence | Deployed URL correlation and sanitized examples |
| 4 | v0.4 — Semantic discovery | Intent-based discovery, integration context, and owner review |
| 5 | v0.5 — Related documentation and discrepancies | Read-only Confluence and scoped cross-source findings |
| 6 | v1.0 — Enterprise operating readiness | Measured capacity, access/recovery hardening, and supported distribution |

Release a smaller honest scope when a connector cannot meet its gate; do not label unavailable features as supported. No phase waives earlier invariants.

## Phase 0 — Development preparation

**Purpose:** remove implementation ambiguity without trying to model every framework in advance.

### Deliverables

- Record actual or provisional Node.js/Java frameworks, CI/CD platform, deployment evidence, log fields, Confluence edition, and inference policy.
- Create original synthetic fixtures: a Node.js service, a small Java design fixture, nested schemas, shared validators, security declarations, unresolved routing, same-method/path routing variants, and revision histories.
- Create event histories for PR/merge, UAT-only deployment, missing deployment information, promotion, failure before any rollout, failure after partial rollout without rollback, confirmed rollback, mixed revisions, and configuration changes.
- Define executable IR, evidence, view, configuration, and event schemas with valid/invalid examples.
- Record identity, unknown-state, publication, source-permission, and normative-constraint eligibility decisions. Keep editorial approval separate from verification evidence. Test the design against the Java fixture before promising stable plugin compatibility.
- Select toolchain versions, initial support ranges, storage baseline, and implement the reproducible local test profile described in [Testing and local validation](TESTING.md). Establish red → green → refactor as the implementation workflow before product functions are written.
- Define pilot corpus size and numeric targets for full/incremental scans, publication lag, query latency, and acceptable model cost. If enterprise scale is unknown, record fixture targets separately from unvalidated enterprise targets.
- Prepare license selection, maintainer/security contacts, contribution rules, governance, and a public-data policy. Names and GitHub organization must be chosen before actual publication, not guessed.

### Exit gate

- Agreed requirements can be represented by executable fixtures, including service availability in UAT only.
- A dependency change and deployment event have unambiguous expected outcomes.
- A focused test can be run locally without API credentials; an isolated dependency check confirms the test database is reachable or reports its unavailability without silently skipping the selected integration suite.
- Provisional choices are recorded; no hidden assumption that GitHub hosting determines enterprise CI/CD.
- Public fixtures contain no private source, logs, documentation, hostnames, or credentials.

**Dependency:** none. Naming and repository ownership need not block private implementation, but block public release preparation where applicable.

## Phase 1 — Continuous environment-aware catalog

**Purpose:** prove the full product maintenance loop for one supported framework.

### Deliverables

- Baseline extraction of supported routes, parameter/body/response schemas, selected validators, security declarations, source evidence, and diagnostics.
- Versioned catalog with branch views, dependency tracking, impact analysis, full-service fallback, and deterministic contract differences.
- Provider-neutral CLI/event ingestion and one reference CI workflow. PR previews remain isolated; merged branches publish automatically.
- Durable jobs, duplicate/stale-event handling, replay, automatic reconciliation, and visible failures.
- Deployment records tied to artifact revisions; environment views, UAT-only states, rollback, failed attempts, config/exposure uncertainty, and transitional mixed deployments.
- OpenAPI 3.1 export, route-variant representability checks, provenance/coverage diagnostics, draft/strict modes, and atomic publication. Compiler fixtures exercise faithful aggregation, explicit variant scoping, and strict rejection when no faithful projection exists, independently of first-adapter coverage.
- Shared authorized query layer, minimal portal with environment selector, and initial MCP tools: service search, endpoint/schema retrieval, changes, and environment comparison.
- Local synthetic demonstration plus a protected shared-pilot configuration. Optional LLMs and logs are not required.

### Exit gate

Run one reproducible scenario without a manual rescan after the baseline:

1. Open a PR adding an endpoint and changing a shared validator.
2. Show all affected APIs and documentation in its preview; existing environment views remain unchanged.
3. Merge; branch documentation advances.
4. Deploy to UAT only; production does not advertise the new API as available.
5. Partially roll out a subsequent revision, then fail without rollback; reconcile and show the observed mixed revisions or unknown serving state, together with the failed attempt.
6. Request a rollback; select the restored environment contract only after authoritative evidence confirms completion.
7. Replay stale/duplicate events and omit an event; state remains correct or is repaired by reconciliation.
8. Fail analysis/publication; preserve the last valid snapshot with visible stale/pending state.
9. Read the same pinned contract through portal, MCP, and export; verify unauthorized access is denied.

Pass A01–A07, A16–A17, A19–A22; pass A12 for surfaces available in this phase. A08's no-log operation and A11's environment filtering must already hold, even before conversational evaluation exists.

**Excluded:** payload ingestion, generative summaries, Confluence, advanced conditional inference. A static-only CLI release does not satisfy this phase.

## Phase 2 — Java and framework conformance

**Purpose:** validate the shared model against a different language and framework.

### Deliverables

- Java/Spring adapter, subject to pilot confirmation, with explicit supported framework/syntax/classpath ranges.
- Shared conformance suite for identity, schemas, evidence, dependencies, diagnostics, and environment views.
- Framework-specific fixtures for controller prefixes, DTO serialization, validation groups where supported, inherited/shared types, and exception/security handling.
- Plugin documentation and version compatibility policy, refined using both adapters.
- OpenAPI import for pre-existing specs as a separate evidence source where useful.

### Exit gate

- Both ecosystems complete the Phase 1 lifecycle through the same downstream core.
- Unsupported Java/Node.js patterns are reported rather than silently guessed.
- Request and response representations remain distinct where serialization differs.
- Repeated deterministic extraction produces stable facts and artifacts on the same configured inputs.

**Dependency:** Phase 1 and the Phase 0 Java design fixture. Additional Node.js frameworks require separate adapter gates; they are not implied by TypeScript support.

## Phase 3 — Runtime evidence

**Purpose:** enrich code-discovered endpoints with deployment addresses and usable examples.

### Deliverables

- Normalized file-based evidence import for reproducible tests and one pilot log connector, provisionally ELK.
- Explicit field mapping for environment/service, method, route/path, trace/request ID, revision, status, and body completeness.
- Confirmed/candidate/unresolved URL mappings using routing and trace evidence; support public versus application paths.
- Sanitization boundary, synthetic examples, safe correlation, audit counts, and a hostile/sensitive-payload corpus.
- Environment/window/revision-scoped observations and paired or explicitly unpaired examples.
- Portal/MCP example views and optional OpenAPI enrichment; mapping/contract mismatches become findings.

### Exit gate

- Pass A08–A10; extend A12 to example artifacts and retrieval.
- A rewritten gateway path is mapped correctly with evidence; ambiguous matches stay unresolved.
- Log bodies can be disabled without breaking documentation updates.
- Known sensitive test values do not survive into catalog, exports, prompts, diagnostic logs, or indexes.
- Traffic presence does not mutate requiredness; incomplete payloads do not establish field absence.

**Dependency:** Phase 1 deployment/evidence model. Phase 2 and this phase can be scheduled independently after Phase 1 if team capacity permits; v1 requires both.

## Phase 4 — Semantic discovery and owner review

**Purpose:** answer business-intent questions with the correct environment-specific integration context.

### Deliverables

- A semantic-analysis provider interface with OpenAI, Gemini, and Claude API adapters, selected by configuration. Deterministic transport fixtures test each adapter without live calls. These providers perform semantic understanding, not test execution or grading. Prove a local/self-hosted inference path before claiming that additional capability supported.
- Evidence-backed capability summaries, synonyms, prerequisites, limitations, side effects, and suggested conditional rules.
- Dependency-aware context selection, structured outputs, bounded retries, cost tracking, and full-context cache invalidation.
- Exact/full-text search with optional embeddings, environment/access filtering, and grounded portal answers.
- MCP integration-context retrieval for external agents; exact record retrieval remains model-free.
- Owner overlays and a focused review queue for ambiguous claims, stale corrections, and proposed rules.

### Exit gate

- Pass A11, A13, A15, A23, A25; extend A12 to summaries, embeddings, and model context. Apply A24 to every functional change from Phase 0 onward.
- Evaluate at least 30 curated questions covering positive matches, similar-but-wrong APIs, environment mismatches, ambiguity, and no-match cases. This is a proposed minimum evaluation set, not an accuracy claim.
- No evaluated answer invents an endpoint or parameter or substitutes the wrong environment. Record retrieval accuracy and clarification/no-match behavior against the agreed benchmark targets.
- Every promoted conditional constraint has a recorded qualifying verification basis for its target revision/scope under a versioned policy. Owner approval alone accepts guidance, not a normative constraint; format validation, model confidence, and presence frequency cannot promote a rule. Test exclusion after editorial approval, promotion after qualifying verification, and invalidation when evidence changes or contradictions remain unresolved.
- A provider outage leaves code docs and exact tools usable; unrelated code changes do not invalidate every enrichment.

**Dependency:** Phase 1; examples improve answers after Phase 3 but are not required for semantic discovery.

## Phase 5 — Related documentation and discrepancies

**Purpose:** connect enterprise intent to implementation and expose meaningful disagreements.

### Deliverables

- One read-only Confluence connector for the selected edition, scoped to pilot spaces/pages.
- Page versions/kinds, confirmed and suggested links, source permissions, refresh and deletion handling.
- Deterministic field/contract comparisons plus LLM-assisted business-rule comparisons over confirmed subjects.
- Scoped findings with both sources, owners, deduplication, status, dismissal/resolution reasons, and re-review behavior.
- Related documents and discrepancy views in portal/MCP; no automatic Confluence writes.

### Exit gate

- Pass A14 and A18; extend A12 to page links, source metadata, derived claims, and historical publications.
- A proposal is not automatically labeled an implementation defect; an unrelated page cannot create confirmed drift.
- Revocation/deletion invalidates dependent answers and artifacts under the defined policy, with fail-closed behavior when permissions cannot be established.
- Findings remain tied to compatible versions/environments; accepting one assertion does not erase conflicting evidence.

**Dependency:** Phase 4 evidence review and Phase 1 access/publication foundations.

## Phase 6 — Enterprise operating readiness

**Purpose:** make the assembled product supportable for a shared enterprise installation and public v1 distribution.

### Deliverables

- Verified identity integration, least-privilege connectors, authorization audits, retention/deletion behavior, and inference/data policies.
- Migration tooling, backup/restore procedures, deployment upgrades, disaster recovery, and documentation of supported infrastructure.
- Capacity measurements against the Phase 0 workload targets, bounded queues/retries, large-monorepo and multi-environment tests.
- Operational dashboards for job failures, freshness, publication lag, unresolved mappings, and coverage; avoid rebuilding general service observability.
- Developer and operator guides, connector/plugin conformance documentation, release artifacts, dependency/license inventory, and vulnerability reporting.
- Public synthetic demonstration, honest support matrix, known limitations, and upgrade notes.

### Exit gate

- All applicable A01–A25 scenarios pass across supported adapters and surfaces.
- Numeric benchmark results, hardware/configuration, workload sizes, and limitations are published for the reference setup.
- Restore/replay recovers a consistent catalog without leaking revoked data or selecting incorrect environment revisions.
- No critical information-boundary or publication-consistency defects remain open.
- License, project identity, maintainer contacts, repository hygiene, and release checks are complete before public publication.

**Dependency:** Phases 1–5. Authorization, provenance, redaction at ingestion, and environment correctness are earlier phase gates; this phase hardens them and does not introduce them for the first time.

## Requirements coverage

| Requirement | First delivery / completion |
|---|---|
| FR-01 onboarding; FR-02 extraction; FR-03 schemas | Phase 1 baseline, Phase 2 Java, Phase 4 inferred conditions |
| FR-04 continuous updates; FR-05 environments | Phase 1; operational hardening Phase 6 |
| FR-06 runtime evidence | Phase 3 |
| FR-07 evidence; FR-08 OpenAPI | Phase 1, extended with each evidence source |
| FR-09 semantic discovery | Phase 4; deterministic retrieval Phase 1 |
| FR-10 portal/MCP | Phase 1, expanded through Phases 3–5 |
| FR-11 Confluence | Phase 5 |
| FR-12 discrepancies/review | Phase 1 contract changes, Phase 3 traffic findings, Phase 4 review, Phase 5 documents |
| NFR-01 access/information handling | Phase 1 core policies; source-specific controls gate Phases 3–5; harden Phase 6 |
| NFR-02 reliability/scale | Phase 0 targets, Phase 1 event/publication reliability, Phase 6 measured operating profile |
| NFR-03 openness/extensibility | Phase 0 preparation, Phase 2 conformance, Phase 6 supported release |
| NFR-04 TDD/local validation | Phase 0 harness and A24 workflow; extend with each implemented component |

## Deferred beyond v1

- Additional languages/frameworks selected by demonstrated demand.
- GraphQL, gRPC, and event-driven contracts.
- Consumer mapping and richer evidenced service dependency diagrams.
- Multi-step workflow recommendations with separate verification criteria.
- Generated documentation write-back to Confluence or repositories.
- Hosted multi-tenant distribution and specialized graph infrastructure.

Do not expand scope merely to match a platform category. Prioritize features that improve a user's ability to select and correctly integrate an API.
