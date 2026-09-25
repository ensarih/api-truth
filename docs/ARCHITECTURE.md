# API Truth — Architecture and Interface Design

**Status:** D03 IR, D05 TypeScript analyzer, D06 catalog persistence, and the D07 update/difference core implemented; D08–D11 application layers remain design, 2026-09-25.
**Contract:** [product specification](SPECIFICATION.md).  
**Sequence:** [roadmap](ROADMAP.md).

Examples below define design intent. The initial executable IR, evidence, view, configuration, event, and analyzer-exchange contracts are implemented in [`packages/ir`](../packages/ir/README.md). The D06 PostgreSQL migrations and catalog package are implemented in [`packages/catalog`](../packages/catalog/README.md). The D07 pure planner, safe full-service executor, deterministic difference engine, and local comparison CLI are implemented in [`packages/updates`](../packages/updates/README.md). Event/job orchestration, environment resolution, publication, and query transports remain Phase 1 deliverables.

## 1. Components

| Component | Responsibility | Generative LLM? |
|---|---|---|
| Event adapters | Normalize branch, PR, deployment, configuration, and reconciliation events | No |
| Scheduler / worker | Resolve revisions, affected scope, retries, and superseded jobs | No |
| Framework analyzers | Extract contracts, evidence, dependencies, and diagnostics | No |
| Contract comparer | Identify structured changes and potential compatibility issues | No |
| Deployment resolver | Bind environments to artifacts, revisions, configuration, and exposure | No |
| Log connector / sanitizer | Correlate traffic and derive safe observations/examples | No |
| Confluence connector | Fetch scoped pages, versions, permissions, and explicit anchors | No |
| Semantic analyzer | Draft capability descriptions, conditions, and suggested page links | Optional |
| Evidence / review service | Maintain claims, conflicts, corrections, and review state | No; semantic comparisons may call analyzer |
| Publisher / OpenAPI compiler | Produce validated immutable publications and exports | No |
| Query service | Authorize access, resolve views, and retrieve/rank records | No; embeddings optional |
| Portal assistant | Interpret intent and explain retrieved matches | Optional |
| MCP server | Expose read-only structured discovery and retrieval | No; external client supplies reasoning |

Start with a modular service and worker rather than a microservice per component. Portal and MCP use the same query service. Inference stays outside deterministic extraction and publication.

## 2. Logical data model

| Entity | Identity and important fields |
|---|---|
| Repository | Stable ID, provider locator, access scope, configured roots |
| Service | Stable configured ID, repository/root, label, owner assertions, domains |
| Source revision | Repository ID, immutable commit ID, source digest, observed branch refs |
| Endpoint | Service and application route identity; handler locations are references |
| Contract snapshot | Immutable ID, revision, analyzer/config versions, facts, schemas, diagnostics |
| Branch view | Repository/service/branch → eligible snapshot and observed provider reference state |
| Deployment | Service/environment, artifact/revision, configuration digest, lifecycle state, event ordering |
| Environment binding | Active deployments, linked snapshots, resolution status |
| Exposure mapping | Endpoint/deployment, application route, external server/path, predicates, evidence |
| Claim | Subject, predicate, value, source/version, scope, verification, dependencies, access label |
| Observation / example | Endpoint candidate, environment/revision/window, completeness, safe payload or statistics |
| Document / link | Page/version, kind, source URL, permissions, confirmed/suggested relationship |
| Review overlay | Subject/claim, owner correction, evidence fingerprint, review state |
| Finding | Compared claims, category, impact, scope, status, owner, resolution history |
| Publication | Immutable manifest of contracts, claims, examples, indexes, artifacts, and policy version |

A branch is a mutable reference to source history. An environment binding references deployment evidence. Neither is part of contract content identity. Promoting an unchanged artifact can reuse a contract while changing URL mappings, configuration, and examples.

### 2.1 Implemented catalog persistence

D06 stores each validated `success` or `partial` analyzer result as one immutable
D03 contract snapshot. The normalized content digest excludes only top-level
`created_at`; the complete first validated document remains stored. Required
access scope IDs are a canonical immutable array on the snapshot row, and every
snapshot or branch read checks all members against current active scopes and
principal grants in the same SQL statement. Revocation therefore applies to
historical reads. Missing and denied resources share one safe result.

Branch pointers are tenant/repository/service/branch records promoted through
locked transactions. Decimal provider sequences use unbounded text ordering;
opaque provider state uses pointer-version compare-and-swap. D06 stores and
resolves only a branch explicitly supplied by its caller. The v0.1 service
configuration's `intended_branches` is the exact scan allowlist: later D08
orchestration must ignore unlisted branches, and an empty list means scan none.
D06 does not enumerate repository branches or implement scanning.

### 2.2 Endpoint identity

- Service IDs are configured; renaming a label does not invalidate history.
- A versioned route key includes service ID, method, normalized application path shape, and supported routing selectors. Exclude public hosts, branches, line numbers, and deployments.
- Placeholder spelling does not change path shape: `/orders/{id}` and `/orders/{orderId}` can share identity while the parameter-name change remains a contract diff.
- Preserve literal segments and framework routing semantics. Include distinguishing selectors such as content type or header routing where supported; do not collapse different handlers solely because paths look alike.
- A changed method or literal route normally creates a new identity. Explicit aliases may preserve continuity; semantic similarity alone cannot merge histories.
- Identity collisions and unresolved predicates produce diagnostics and block strict export of affected ambiguous operations.
- Version identity algorithms and provide migrations/aliases before changing them. Scope schema components to services; content digests can deduplicate schemas without relying on class names alone.

### 2.3 OpenAPI projection of route variants

Catalog identity and OpenAPI operation identity are different. Distinct, fully resolved handlers may share a method/path while selecting behavior through headers or content types. The compiler groups endpoints by their projected OpenAPI method/path and checks representability even when extraction has no collisions or unknowns.

- Aggregate variants only when the target document preserves their request/response relationships and routing constraints. A union that admits combinations no handler accepts is not a faithful projection.
- When aggregation is not faithful, an explicitly variant-scoped export is allowed only if the selected routing requirements and contract can be represented. Include the selected variant IDs, selector requirements, source publication, and excluded scope in export metadata; do not present it as the complete service contract.
- If faithful aggregation or scoping is unavailable, record a representability diagnostic and reject strict export of the affected scope. A draft may omit affected operations with explicit coverage diagnostics; it must not overwrite handlers, invent paths, or imply broader behavior.
- Retain all variants and their selectors in the catalog and exact retrieval regardless of OpenAPI representability.

Compiler fixtures must include compatible media-type aggregation and header-dependent variants that cannot be faithfully combined into one operation.

### 2.4 Schemas and claims

The IR must support multiple request/response media types, declared status ranges/default responses, recursive references, unions, serialization names, and structured security alternatives. Use JSON Schema-compatible structure plus evidence metadata; a flat list of string types is insufficient.

Illustrative claim:

```json
{
  "claim_id": "claim-payment-currency-required",
  "subject": {
    "service_id": "payments",
    "endpoint_id": "ep-payment-create",
    "schema_pointer": "/properties/currency"
  },
  "predicate": "field_presence",
  "value": "required",
  "verification": "declared",
  "evidence": [{
    "kind": "code",
    "revision": "fixture-commit-42",
    "path": "src/payments/validation.ts",
    "symbol": "CreatePaymentSchema",
    "method": "supported_runtime_validator"
  }],
  "scope": { "contract_snapshot_id": "snapshot-42" },
  "limitations": [],
  "access_policy_id": "policy-payments-read"
}
```

Verification categories distinguish `declared`, `established_by_analysis`, `observed`, `inferred`, and `owner_asserted`. They are not a universal precedence ordering. Review acceptance is separate: approving prose does not prove runtime enforcement.

Represent editorial review and normative-export eligibility separately. Eligibility records the target contract scope, qualifying evidence IDs/fingerprint, and verification-policy version. Qualifying bases include extraction from an applicable supported validator, supported deterministic analysis, or scoped behavioral verification establishing the asserted rule. An owner may attach qualifying evidence, but their approval alone is insufficient. Model confidence, schema-format validation, and request-presence frequency are also insufficient. Unresolved contradictory claims block promotion; changed evidence invalidates eligibility until reverified. Accepted explanations remain sourced guidance while ineligible constraints are excluded from normative schema keywords.

Field presence supports required, optional, conditional, and unknown. Conditions contain a supported predicate tree or a scoped business-rule expression, affected schema paths, sources, and verification state. Sample frequency is a separate claim with denominator, window, and completeness metadata.

### 2.5 Environment axes

| Axis | Illustrative states |
|---|---|
| Branch analysis | pending, current, failed, unsupported |
| Deployment knowledge | unknown, confirmed_not_deployed, deployed, transitional |
| Deployment attempt | pending, succeeded, failed, rolled_back |
| Contract resolution | resolved, pending_analysis, ambiguous, unavailable |
| External exposure | unknown, confirmed_exposed, confirmed_not_exposed, conditional |
| Traffic | observed_in_window, not_observed_in_window, unavailable |
| Publication | current, updating, stale, failed |

Availability is derived from scoped facts, not stored as a universal boolean. Consumer entitlement is distinct from exposure. Multiple active revisions remain explicit during rolling deployments, including a rollout that partially succeeds and then fails. Deployment-attempt status never substitutes for observed serving state.

## 3. Framework plugin boundary

**Input:** read-only source at an immutable revision; service root; analyzer/config versions; controlled type-resolution/classpath inputs; prior dependency index and changed paths if available; resource limits and extraction mode.

**Output:** normalized endpoints and schema components; source-backed assertions; dependency edges and impact-analysis coverage; diagnostics with affected scope; analyzer identity and reproducibility fingerprint.

Plugins must not fetch logs, call models, start applications, publish catalog state, or access the network implicitly. Preparing external dependencies is an explicit runner responsibility with provenance and execution policy. Runtime introspection is a separate optional adapter.

The current TypeScript adapter accepts changed paths but does not expose a
bounded target-extraction contract. D07 therefore uses dependency edges and
ordinary evidence/schema ownership to plan impact while executing each
source-changing update as a complete selected-service scan in
`fallback_full_service` mode.

Use a versioned JSON exchange format across TypeScript and the Java analyzer process. Test the IR against a small second-framework fixture before promising plugin stability.

## 4. Configuration and event contracts

### 4.1 Illustrative configuration

This syntax is proposed. Names are fictional examples, not assumptions about enterprise branches.

```yaml
config_version: 1
repositories:
  - id: commerce-repo
    services:
      - id: payments
        root: services/payments
        analyzer: typescript-express
        access_policy: payments-read
        environments:
          uat:
            intended_branch: uat
            deployment_source: enterprise-cd
          staging:
            intended_branch: staging
            deployment_source: enterprise-cd
          production:
            intended_branch: main
            deployment_source: enterprise-cd
publication:
  pull_requests: preview
  branch_updates: automatic
  environments: deployment_evidence
ci:
  compatibility_policy: report_only
inference:
  enabled: false
logs:
  enabled: false
```

Resolve credentials through deployment secret references, never literal config values. The public project's hosting provider does not determine enterprise CI/CD selection.

### 4.2 Event envelope

Required fields: `event_version`, `event_id`, `event_type`, `producer`, `occurred_at`, `received_at`, subject IDs, provider sequence/reference information where available, and payload. Authenticate producers and verify their authority over the subject.

| Event | Payload / effect |
|---|---|
| `repository.baseline_requested` | Explicit revision and service scope; establish baseline |
| `pull_request.updated` | PR ID, base/head commits, branch refs; isolated preview |
| `branch.updated` | Branch, prior/new commit, provider reference state; branch analysis |
| `deployment.changed` | Environment, deployment ID, lifecycle, artifact/revision, config digest, effective order |
| `configuration.changed` | Versioned config evidence and affected behavior/exposure scope |
| `source_document.changed` | Page/version, permission/deletion changes; derived invalidation |
| `reconciliation.requested` | Provider snapshot/cursor and scope; repair missed events |

Deployment events identify the exact artifact revision, including merge commits where applicable. Unknown artifact revision stays unresolved; do not substitute branch head.

Arrival time is not deployment order. Deduplicate by producer/event ID; advance pointers only after checking provider state or ordering tokens. Reconcile when ordering is unavailable. A confirmed completed rollback selects an older code revision through newer authoritative serving-state evidence.

Deployment adapters must distinguish attempt notifications from authoritative active-revision observations. Record the observation source, effective version/order, active artifact set, and observation completeness. An attempt failure triggers reconciliation; it does not restore a previous binding. If the active set cannot be established, mark it unknown and retain the last observation as stale. Clear a mixed or unknown state only when authoritative evidence establishes the effective serving set.

## 5. Incremental analysis and publication

The implemented D07 boundary covers step 3 and the extract/compare portion of
step 5 for one already-selected service and immutable revision. It computes
reverse-dependency impact, may reuse an identical complete base snapshot, and
otherwise runs the complete service through D05 before comparing full
snapshots. It never merges a targeted or partial result into the prior
snapshot. Incomplete target coverage cannot prove endpoint, schema, claim,
parameter, request-body, or response deletion.

D08 remains responsible for steps 1–2 and job orchestration: event ingestion,
deduplication, scheduling, retry, supersession, reconciliation, and D06 branch
pointer promotion. Before it schedules D07, D08 must select only exact branch
names from `InstallationConfig.repositories[].services[].intended_branches`.
An empty allowlist schedules no branches; D07 itself accepts one selected
service/revision and never enumerates branches. Branch patterns require a future
configuration version. D09–D11 environment resolution, publication/OpenAPI,
query, portal, and MCP behavior remain unimplemented.

1. Validate, persist, and deduplicate the event; create a durable job.
2. Resolve the immutable source/artifact/configuration scope.
3. Compute affected endpoints through reverse dependencies, including deletions and configuration changes.
4. Expand automatically to a service or broader configured scan when dependency coverage is incomplete. Adapter/config/identity changes can require a baseline refresh.
5. Extract and compare facts; preserve diagnostics. A partial scan cannot prove deletion of an unresolved endpoint.
6. Validate the deterministic snapshot. Reuse enrichment only when all supporting fingerprints match; otherwise mark it pending/stale.
7. Prepare artifacts and access-scoped indexes under an immutable publication ID.
8. Atomically promote a manifest only while eligible for its branch/environment pointer. Code updates need not wait for optional inference or logs; stale enrichment is excluded or explicitly labeled.
9. Retain the last valid publication on failure and expose latest source/deployment knowledge plus failed-update status.

Extraction cache keys include source/dependency contents, resolution inputs, analyzer version, config, and IR version. Inference keys additionally include context selection, prompt/output-schema version, model settings, and sanitization policy. Document/traffic enrichment includes source versions, window/scope, and authorization dependencies.

Every read returns a `publication_id` and resolved view. Follow-up reads can pin a publication. Current authorization still applies to historical views; pinned records cannot bypass revocation.

Write immutable files/index material before promoting the database manifest pointer. When storage cannot share a transaction, the pointer is the commit boundary. Clean up unreferenced artifacts separately. Clients must not receive a new contract with silently incompatible old examples.

## 6. Runtime evidence processing

1. Match environment/service/deployment and method.
2. Prefer route templates, operation/handler metadata, and trace linkage.
3. Apply versioned gateway and application prefix/rewrite evidence.
4. Use framework-aware candidate matching only where explicit evidence is unavailable.
5. Confirm mappings or retain ambiguity; never silently break ties.

Preserve observation points: gateway and application logs may record different paths for the same request. Gateway-only errors do not automatically describe handler behavior.

Sanitize before durable ingestion or model use. Generate synthetic values by default, preserving useful cross-field relationships only where safe. Pair requests/responses only through supported correlation. Validate examples against the scoped contract; observed mismatches become findings rather than automatic schema rewrites.

Body-disabled logs still support URL/status/activity evidence. Truncated or redacted fields cannot establish absence. Revision-ambiguous traffic is not evidence for a single deployed contract.

## 7. Read API and MCP contracts

Use a common `ViewSelector`: environment, branch, or immutable revision with service scope as applicable. Responses include resolved scope, publication ID, coverage/freshness, evidence, warnings, and pagination. Define tool-specific executable schemas during implementation.

| Proposed tool | Inputs beyond view | Output |
|---|---|---|
| `list_services` | Domain/owner filters, cursor | Accessible services and environment state |
| `find_endpoint` | Query, service/domain filters, limit | Ranked candidates, matching reasons, coverage |
| `get_endpoint` | Endpoint ID | Exact contract, sources, gaps, exposure mappings |
| `get_schema` | Component ID, bounded expansion depth | Schema and unresolved references |
| `get_integration_context` | Endpoint ID | Pinned contract, prerequisites, security, limitations, examples, sources |
| `get_examples` | Endpoint ID, scenario/status, limit | Scoped safe examples and capture/synthesis metadata |
| `compare_environments` | Service ID and two environments | Presence, revision, exposure, contract differences |
| `get_changes` | Two views/publications | Structured changes and compatibility findings |
| `get_findings` | Subject/category/status filters | Discrepancies and review state |
| `get_related_docs` | Endpoint/service ID | Accessible confirmed/suggested pages, distinguished |

Advertise only implemented tools; unavailable capabilities must not return misleading empty success. Review mutations use a separately authorized administrative API. MCP remains read-only.

Filter by authorization and environment before model context is assembled. Omitted environment context can yield a structured clarification. No-match responses include analyzed scope; exact IDs/contracts always come from the store.

## 8. Confluence and review

Fetch selected content with version, kind, source URL, and access scope. Extract explicit anchors deterministically; use optional models for suggested links and business claims. Owner confirmations are separate records that can become stale.

Compare established subjects with compatible revision/environment scope. Findings reference both original claims. Deleted pages and revoked permissions invalidate derived records, indexes, and caches. During refresh, current-policy filtering must prevent unauthorized retrieval; if permission state cannot be established, fail closed for that source and derived content.

### Semantic provider boundary

Provide `openai`, `gemini`, and `claude` adapters for API semantic understanding. A common analysis request carries the endpoint/dependency context, evidence IDs, output-schema version, and policy-limited generation settings. A common result carries structured explanations/proposed rules, evidence references, actual provider/model identity, and usage metadata where available. Provider adapters own wire-format differences, capability checks, refusals, truncation, timeouts, and error normalization; the application validates every result before accepting it.

Select the provider and model explicitly through installation configuration; credentials come from secret references. Unsupported capabilities produce clear errors, not silently weakened schema validation. Cache keys include provider/model/settings. Cross-provider fallback is disabled unless explicitly configured by the installation's data policy. None of these providers is an automated test runner or pass/fail judge.

Unit and adapter contract tests inject deterministic synthetic transport responses to exercise actual normalization, validation, and failure behavior without making model API calls. See [the local test design](TESTING.md).

Native structured-output features differ by provider and model; adapter support must be verified against pinned model/API capabilities rather than assuming every JSON Schema keyword is portable. References: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

## 9. Proposed implementation baseline and references

- **Core/CLI/worker/query:** TypeScript on Node.js with deterministic domain logic separate from transports.
- **Node.js extraction:** TypeScript compiler API plus framework adapters. Its type checker supplies type/symbol reasoning. [Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
- **Java extraction:** separate Java process using JavaParser and symbol resolution. Validate classpath handling and supported syntax against pilot fixtures. [JavaParser](https://github.com/javaparser/javaparser).
- **Storage/jobs:** PostgreSQL for metadata, job state, policies, and manifest pointers; filesystem artifacts locally and an object-store boundary for larger deployments. This is a proposed baseline, not a capacity claim.
- **Portal:** TypeScript client over the shared query service; minimal browse/detail/environment views first.
- **Search:** exact/full-text first; embeddings behind the same authorized candidate interface later.
- **Packaging:** local container composition for the first demonstration. Add enterprise deployment packaging after measuring requirements; introduce a separate queue broker only if justified.

Pin supported runtime/framework/tool versions during Phase 0. Relevant standards:

- OpenAPI 3.1's JSON Schema alignment supports richer conditions; validate actual compiler/renderer compatibility. [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html#schema-object).
- Pin a released MCP protocol/SDK combination. Remote transport must implement the applicable authorization requirements; do not pass unrelated connector tokens through to clients. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
- When available, OpenTelemetry `http.route` provides matched route-template evidence; it is optional input. [HTTP attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/http/).
- Implement Confluence Cloud or Data Center explicitly. Cloud permission interfaces only apply to Cloud connectors. [Cloud content permissions](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content-permissions/).
