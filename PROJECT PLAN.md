# API Truth — Implementation Plan

**Status:** development preparation; no application implementation exists yet.  
**Updated:** 2026-09-15  
**Working name:** API Truth (`api-truth`), pending public naming checks.  
**License:** Apache-2.0 proposed, pending selection before publication.

This replaces the initial proposal with the agreed code-first, continuously updated, environment-aware product. See the [specification](docs/SPECIFICATION.md), [architecture](docs/ARCHITECTURE.md), and [phased roadmap](docs/ROADMAP.md).

## 1. Outcome

Give enterprise developers, architects, and their AI assistants a dependable answer to: **“Which API supports what I want to do in this environment, and how do I use it?”**

Create missing documentation from code, enrich it with deployed URLs and safe examples from logs, add business context from code and selected Confluence pages, and maintain it through development/deployment flows. Publish the same versioned catalog through OpenAPI, a portal, and MCP.

## 2. Established decisions

1. Code discovers exposed APIs. Logs subsequently resolve deployed URL mappings and provide examples.
2. Initial language focus is TypeScript/JavaScript on Node.js and Java. Framework coverage must be explicit.
3. CI/CD integration, contract differences, dependency invalidation, provenance, and environment state belong in the first working release.
4. Establish an initial baseline, then update automatically through events and reconciliation. Full-service fallback is necessary where incremental analysis is insufficient.
5. Branch documentation and deployed-environment documentation are distinct. Represent promotion, rollback, failed deployments, and APIs available only in UAT.
6. The shared catalog is richer than OpenAPI. OpenAPI, portal, and MCP consume consistent views.
7. Deterministic extraction and exact retrieval work without an LLM. Models add semantics and interpret intent.
8. Observations, declarations, inferences, and owner assertions remain distinguishable; unknowns and contradictions stay visible.
9. Confluence contributes context and evidenced discrepancies through read-only integration.
10. Open-source publication is intended. This planning task does not create or publish a GitHub repository.
11. Functional development follows TDD, with a reproducible local test environment established before implementing product behavior.
12. OpenAI, Gemini, and Claude APIs are the initial semantic-understanding providers. Software tests use deterministic fixtures and ordinary assertions; models do not execute or grade tests.

## 3. Delivery strategy

Build one complete development-to-documentation flow before broad framework coverage. The first demonstration includes a changed shared validator, a PR preview, merge, UAT deployment, production query, and rollback. This tests the central promises before optional logs and inference.

Use original synthetic public fixtures plus an authorized private pilot where available. Keep private evidence outside the public tree. Lack of enterprise access need not block fixture-based implementation, but fixture results must not be presented as enterprise pilot results.

Phases are acceptance-gated rather than calendar promises. Estimate effort after the framework/pipeline discovery spike; the initial proposal's unvalidated 6–8 week estimate is retired.

## 4. Workstreams

| Workstream | Deliverables | Dependencies |
|---|---|---|
| Catalog core | IR, identities, claims, migrations, diagnostics, snapshots | Fixture-driven model design |
| Extraction | Framework adapters, dependencies, conformance fixtures | IR/plugin contract |
| Continuous integration | Events, PR reports, deployment bindings, retries/reconciliation | Core and first extractor |
| Publication | Differences, OpenAPI, manifests, authorized query layer | Snapshot contracts |
| User access | Basic portal, MCP, environment comparison, integration context | Query layer and authorization |
| Runtime evidence | Log mapping, sanitization, observations, examples | Deployment/evidence model |
| Semantics | Provider boundary, context analysis, evaluations, owner overlays | Evidence and access filtering |
| Related documents | Confluence links, permission propagation, discrepancy review | Evidence, semantics, review |
| Open-source operations | License/governance, CI, fixtures, releases, security reporting | Maintainer decisions and runnable baseline |

These are logical workstreams, not a requirement for separate teams or services.

## 5. Proposed technical choices

| Area | Starting point | Status |
|---|---|---|
| Core, CLI, worker, query/MCP service | TypeScript on Node.js | Proposed |
| First Node.js adapter | Express; replace with pilot's actual framework if different | Provisional |
| First Java adapter | Spring MVC / Spring Boot, separate Java analyzer process | Provisional |
| IR exchange | Versioned JSON, executable schemas, conformance fixtures | Required approach |
| Storage/jobs | PostgreSQL and immutable artifact storage | Proposed |
| Portal | TypeScript client; browse/detail/environment views first | UI framework to select at setup |
| CI/CD interface | Provider-neutral CLI/event envelope and deployment records | Required |
| Reference CI | GitHub Actions for public synthetic fixtures | Proposed; enterprise CI remains unconfirmed |
| Logs | Normalized file fixtures, then one ELK connector if applicable | Backend/version to confirm |
| Confluence | One read-only connector for pilot edition | Cloud/Data Center to confirm |
| Semantic inference | Common interface with OpenAI, Gemini, and Claude API adapters | Providers required; model IDs and data policy to configure |
| Local tests | Native TypeScript/Vitest checks plus isolated Docker PostgreSQL for integration | Design proposed in [TESTING.md](docs/TESTING.md); setup pending |

Pin runtime/library versions and support ranges when creating the code skeleton. Interfaces in these documents are proposed and not runnable commands.

## 6. First development backlog

All tasks are unstarted. Split into smaller reviewable pull requests where needed.

| ID | Task | Completion evidence |
|---|---|---|
| D01 | Record pilot constraints and architecture decisions | Support matrix, branch/environment examples, event/log field inventory |
| D02 | Create synthetic Node.js and small Java design fixtures | Expected routes, shared changes, event histories, unsupported cases |
| D03 | Define executable IR, evidence, view, config, and event schemas | Valid/invalid fixtures; identity/version rules; separate editorial acceptance and verified export eligibility |
| D04 | Scaffold workspace, local test harness, and Java adapter boundary | Reproducible build, pinned dependencies, focused/watch checks, isolated test DB setup, red/green harness verification |
| D05 | Implement baseline extractor and diagnostics | Supported fixture facts correct; unsupported patterns visible |
| D06 | Implement catalog snapshots, branch pointers, and access scopes | Immutable round-trip; unauthorized reads denied |
| D07 | Add dependency-aware updates and structured differences | Shared changes reach every affected API; fallback demonstrated |
| D08 | Add events, durable jobs, deduplication, and reconciliation | Duplicate, stale, missed-event cases pass |
| D09 | Add deployment/configuration and environment resolution | Merge/deploy separation, UAT-only, partial-rollout failure, authoritative active-set reconciliation, confirmed rollback |
| D10 | Build OpenAPI compiler and publication manifests | Valid exports, faithful route-variant aggregation/scoping, strict rejection of representation gaps, recovery |
| D11 | Build query layer, minimal portal, initial MCP tools | Same pinned contract/environment across surfaces |
| D12 | Connect reference CI and deployment fixture workflow | Automatic preview, merge, deployment, rollback updates after baseline |
| D13 | Complete first release gate and setup documentation | Repeatable walkthrough and Phase 1 acceptance suite |

D01–D03 test the model before the full second adapter; do not permanently freeze a plugin contract designed from one framework. D05–D12 together constitute the first working product. A static-only exporter is insufficient.

## 7. Proposed repository structure

Only planning documents currently exist. This is the intended implementation layout.

```text
api-truth/
├── README.md
├── PROJECT PLAN.md
├── LICENSE                         # selected before publication
├── CONTRIBUTING.md
├── GOVERNANCE.md
├── SECURITY.md
├── docs/
│   ├── SPECIFICATION.md
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   ├── decisions/
│   └── operations/
├── packages/
│   ├── ir/
│   ├── catalog/
│   ├── analysis/
│   ├── compiler/
│   ├── changes/
│   ├── query/
│   └── events/
├── apps/
│   ├── cli/
│   ├── server/                     # query, administrative API, MCP
│   ├── worker/
│   └── portal/
├── analyzers/
│   ├── typescript/
│   ├── java/
│   └── PLUGIN_API.md
├── connectors/
│   ├── ci-cd/
│   ├── logs/
│   └── confluence/
├── enrichment/
├── fixtures/
├── tests/
├── deploy/
└── .github/
```

## 8. Validation strategy

Use the red → green → refactor workflow for each new or changed function's behavior. Write and observe a failing regression test before fixing a bug. See [Testing and local validation](docs/TESTING.md) for the proposed local environment, suite boundaries, and setup acceptance criteria.

- **Extraction:** labeled routes and assertions over nested schemas, validation, serialization, and middleware. Measure correctness on supported fixture scope; report unsupported patterns separately.
- **Behavior:** controlled synthetic-service checks for selected requiredness/conditional rules. Golden OpenAPI alone does not prove behavior. Verify that editorial approval cannot promote an unverified rule, qualifying scoped evidence can establish eligibility, and evidence changes invalidate it.
- **Continuous updates:** shared dependencies, deletion, force-push/rebase, stale events, failures, missed events, rollback, and configuration changes.
- **Environment accuracy:** source intent, attempt status, authoritative active artifact set, exposure, and observation remain independently testable. Include failure after partial rollout without rollback and distinguish requested from confirmed rollback.
- **Publication:** validation, faithful projection of same-method/path routing variants, reproducible artifacts, pinned cross-surface reads, and failure recovery. Verify that unrepresentable variants produce explicit diagnostics and strict rejection without overwriting handlers or broadening contracts.
- **Information boundaries:** cross-policy queries, exports, historical views, source revocation, and hostile document/comment content.
- **User questions:** expected API/environment, constraints, sources, clarification, and no-match outcomes.
- **Semantic adapters:** deterministic transport fixtures exercise OpenAI, Gemini, and Claude request mapping, output validation, refusals, invalid results, timeout/rate-limit handling, and absence of unconfigured fallback. LLMs do not grade these assertions.
- **Performance:** set fixture/pilot sizes and numeric targets in Phase 0; measure incremental and fallback runs with hardware, configuration, and limitations recorded.

Test observable behavior and real failure modes rather than mirroring implementation.

## 9. Open-source publication preparation

Before public GitHub publication:

- Choose names and check availability; current project/package names are placeholders.
- Select the license and add its exact text; Apache-2.0 remains the proposal.
- Add maintainer identities, governance, contribution/setup instructions, and a private security reporting route.
- Add issue/PR templates and an honest support matrix with exclusions.
- Inspect contents and history for enterprise data, credentials, proprietary code, and internal URLs.
- Add CI for builds, meaningful tests, documentation links, and dependency review once code exists.
- Define package, IR, plugin, and event-schema version policy and migration expectations.
- Provide a synthetic demonstration; do not advertise unimplemented commands.
- Define release provenance, dependency/license inventory, and reporting before v1 distribution.

Provider-neutral interfaces must remain usable from enterprise CI/CD systems independently of the public project's GitHub workflows.

## 10. Risks

| Risk | Response |
|---|---|
| Dynamic routes or unresolved types cause incomplete extraction | Explicit support boundaries and diagnostics; optional runtime evidence |
| Branch tips mistaken for deployments | Artifact binding, separate views, authoritative lifecycle sources |
| Shared dependencies break incremental correctness | Reverse dependencies, full-service fallback, reconciliation |
| Logs lack bodies or public URLs | Keep code docs usable; report gaps; accept gateway/trace evidence |
| Requiredness/business rules overstated | Separate claim categories; verify supported rules; preserve unknowns |
| Event races overwrite current views | Provider-aware ordering, durable jobs, immutable manifests |
| Private content leaks through derived outputs | Boundary sanitization, evidence access labels, revocation tests |
| Scope grows into a general platform | Phase gates, limited framework coverage, read-only MCP |
| Owner corrections decay | Evidence-bound overlays with review invalidation |
| Scale assumed without measurements | Record targets and workload results before enterprise claims |

## 11. Next action

Begin [Phase 0](docs/ROADMAP.md#phase-0--development-preparation): record provisional decisions, create synthetic fixtures, and define executable data contracts. Then build Phase 1 with continuous documentation and environment tracking included. Feature implementation starts in the next development task; this deliverable is the specification and plan.
