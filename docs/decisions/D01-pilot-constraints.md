# D01 — Pilot constraints and evidence boundaries

**Status:** provisional for the Phase 0 pilot, 2026-09-15.  
**Authoritative product requirements:** [Specification](../SPECIFICATION.md), especially FR-01, FR-04 through FR-07, and NFR-01.  
**Consumers:** D02 synthetic fixtures; D03 executable event/evidence/configuration schemas; later deployment, log, and CI work.

This record fixes the pilot vocabulary and the facts that must remain separate. It deliberately does not define executable types, database tables, transport adapters, or an enterprise-provider integration. Pilot discovery may replace a provisional adapter choice through a new decision record without changing the evidence boundaries below.

## 1. Pilot support matrix

| Target | Pilot position | Discovery boundary | Evidence expected from a fixture or source | Confirmation needed before promising support |
|---|---|---|---|---|
| TypeScript on Node.js | Initial target | Read-only static code analysis; do not start the application, execute build scripts, or run repository hooks | Immutable revision, route registration, mounted prefix, handler, relevant type/validator references, and diagnostics | Actual pilot repository versions, routing patterns, build layout, and construct coverage |
| Express | **Provisional initial Node.js framework choice** | Follow supported `app`/`router` registrations, mounts, methods, paths, and documented middleware/handler references | Source location and revision for every extracted fact; diagnostics for dynamic or unsupported registration | Pilot inventory confirms Express and the supported registration forms |
| TypeScript framework other than Express | Not supported in the initial pilot unless explicitly selected | Preserve as unsupported/analyzer-not-configured; do not infer Express semantics | Service/revision/scope and a coverage diagnostic | A separate decision, fixture, analyzer boundary, and conformance cases |
| Java | Initial target | Separate read-only analyzer process; controlled classpath/type-resolution inputs; no application startup | Immutable revision, controller mapping, method, DTO/validator references, and diagnostics | Compatible pilot JDK/build layout, framework version, and classpath resolution evidence |
| Spring MVC / Spring Boot | **Provisional initial Java framework choice** | Follow supported controller and request-mapping forms plus documented DTO/validation references | Source location and revision for every extracted fact; diagnostics for unresolved mappings or type resolution | Pilot inventory confirms Spring MVC/Spring Boot and selected annotations/forms |
| Java framework other than Spring MVC/Spring Boot | Not supported in the initial pilot unless explicitly selected | Preserve as unsupported/analyzer-not-configured | Service/revision/scope and a coverage diagnostic | A separate decision, fixture, analyzer boundary, and conformance cases |
| Public reference CI | GitHub Actions is the reference public CI | Receive provider-normalized PR, merge/branch, and report-only publication events | GitHub event identity, revision references, ordering/reference data, and scoped results | Workflow implementation and fixture evidence in later work |
| Enterprise CI/CD | Provider-neutral | Normalize authority, ordering, artifact/revision, environment, and serving observations; do not assume GitHub Actions | Provider identity, authority, event/reconciliation evidence, and limitations | Pilot provider and authoritative deployment source are selected |
| Semantic providers | OpenAI, Gemini, and Claude are semantic-understanding providers only | They may interpret bounded evidence after deterministic discovery; they neither run tests nor decide test pass/fail | Provider/model identity, sanitized input scope, output, validation result, and limitations | Installation data policy and pinned API/model capabilities |

The support claim is intentionally narrower than the platform list: “initial target” means a planned fixture/analyzer target, not that every framework construct or enterprise repository is supported. Unsupported or unconfirmed material becomes a visible coverage diagnostic.

## 2. Branch, environment, and lifecycle decisions

### 2.1 Configurable source intent

Environment labels are installation configuration. The pilot examples use `uat`, `staging`, and `production`; no universal branch convention is implied.

| Service | Environment | Configured intended branch | What this fact means | What it cannot prove |
|---|---|---|---|---|
| `orders` | UAT | `release/uat` | The branch expected to supply UAT changes | A successful deployment or the active revision |
| `orders` | staging | `release/staging` | The branch expected to supply staging changes | A successful deployment or the active revision |
| `orders` | production | `main` | The branch expected to supply production changes | A successful deployment or the active revision |

Branch documentation is tied to the exact analyzed commit. An environment view is tied to authoritative serving-state evidence. Promotion of an unchanged artifact may change environment, configuration, URL exposure, or observations without changing its code revision.

### 2.2 Synthetic lifecycle examples

All IDs, revisions, hosts, URLs, trace IDs, and values below are synthetic. `rev-a`, `rev-b`, and `rev-c` stand for immutable artifacts/source revisions; they are not branch names.

| Case | Source intent | Deployment attempt fact | Authoritative serving / mixed-state fact | Exposure fact | Observation fact | Correct environment conclusion |
|---|---|---|---|---|---|---|
| PR preview | `feature/refund` at `rev-b`, base `main` at `rev-a` | No environment deployment attempt | No environment serving assertion | Preview URL may exist as a separate preview fact | Preview scan completes for `rev-b` | Show an isolated preview only; production remains unchanged |
| Merge without deployment | `main` advances from `rev-a` to `rev-b` | Merge is not a deployment attempt | Production authoritative inventory still reports `{rev-a}` | Existing production mapping remains confirmed exposed | Production traffic window is scoped to `rev-a` | Branch docs can advance to `rev-b`; production resolves to `rev-a` |
| UAT-only deployment | `release/uat` contains `rev-b` | Attempt `dep-uat-101` succeeded for UAT | UAT inventory reports active set `{rev-b}` | UAT gateway maps `/api/orders` to application `/orders` | UAT observations are revision-scoped to `rev-b` | UAT resolves to `rev-b`; staging/production are either `confirmed_not_deployed` only with authoritative evidence or remain `unknown` |
| Promotion | `release/staging` contains `rev-b` | Attempt `dep-stg-102` succeeded | Staging inventory reports active set `{rev-b}` | Staging route is conditionally exposed by a feature flag | Traffic has no eligible observations in the window | Staging has `rev-b`, while availability remains conditional and traffic remains not observed, not absent |
| Failure before rollout | `main` contains `rev-c` | Attempt `dep-prod-201` failed before any rollout | Authoritative production inventory reports `{rev-b}` | Production mapping remains confirmed exposed | Observations remain scoped to `rev-b` | Production resolves to `rev-b` because inventory says so, not because `dep-prod-201` failed |
| Failed partial rollout | `main` contains `rev-c` | Attempt `dep-prod-202` failed after a partial rollout; no rollback event | Inventory reports active set `{rev-b, rev-c}` during the observation window | Same production URL maps to both active revisions | Samples carry a revision only when trace/deployment evidence permits; ambiguous samples are excluded from revision claims | Mark production transitional/mixed. Never replace it with `rev-b` alone or claim one universal contract |
| Serving state unknown after failure | `main` contains `rev-c` | Attempt `dep-prod-203` failed | Reconciliation cannot establish the active set | Prior public mapping is historical/stale, not evidence of current serving | New traffic lacks usable revision linkage | Mark active revision state `unknown`; retain the last valid publication as stale with the failed attempt visible |
| Rollback requested | Rollback request names target `rev-b` | Attempt `rb-prod-301` is requested/pending | Latest authoritative inventory still reports `{rev-c}` | Production mapping has not changed as an established fact | Traffic remains scoped to `rev-c` where known | Keep `rev-c` as current; a rollback request is not confirmation |
| Rollback confirmed | Rollback target is `rev-b` | Attempt `rb-prod-301` completes | Newer authoritative inventory reports `{rev-b}` | Production mapping is confirmed for the restored deployment | New observations are scoped to `rev-b` | Resolve production to `rev-b`; retain both the request and confirmation in history |

### 2.3 State rules

1. Record **source intent**, a **deployment attempt**, and the **authoritative active revision set** as different subjects. An attempt can fail while the serving set is `{rev-b, rev-c}` or unknown.
2. `failed` describes an attempt. It never proves the prior revision is serving and must trigger reconciliation when serving evidence is absent or incomplete.
3. Record a rollback request, rollback attempt outcome, and a later authoritative serving observation separately. Only the last one can change an environment’s resolved contract.
4. Preserve every active revision during a rolling rollout. If the source can only establish incomplete serving state, use `unknown` or `transitional`, retain the latest valid view as stale, and expose the limitation.
5. Exposure is independent from active code. It can be `unknown`, `confirmed_exposed`, `confirmed_not_exposed`, or `conditional`; a feature flag or gateway rule can make the same revision differently reachable.
6. Observations are evidence scoped by environment, window, and revision where known. No traffic, redaction, truncation, or a revision-ambiguous sample cannot prove an endpoint or field is absent.

## 3. Event and log field inventory

All fields are a **provisional inventory**, not an executable envelope. D03 must define versions, cardinality, validation, and migration semantics. “Source/owner” identifies the producer or authority that supplies the fact; “consumer” identifies the first product component that needs it. Sensitivity describes the durable-catalog treatment: `operational` is non-payload operational metadata, `restricted` is access-scoped metadata, `sensitive` is never retained raw, and `sanitized` is safe derived content only after ingestion-boundary processing.

### 3.1 Common envelope and source/revision fields

| Field | Applies to | Source / owner | Sensitivity | Consumer |
|---|---|---|---|---|
| `event_version` | every event | emitting adapter / event-contract owner | operational | event validator, replay/migration |
| `event_id` | every event | provider or adapter | operational | deduplication, audit |
| `event_type` | every event | provider-normalizing adapter | operational | router, durable jobs |
| `producer` | every event | adapter configuration | operational | authority checks, audit |
| `occurred_at` | every event | source provider | operational | ordering, time scope |
| `received_at` | every event | receiving service | operational | lag metrics, diagnostics |
| `provider_sequence_or_cursor` | ordered provider events | provider | operational | ordering, reconciliation |
| `authority_reference` | every event | provider authorization/configuration | restricted | ingestion authorization, audit |
| `repository_id` | source/PR/branch events | configured repository registry | operational | source resolution, access filter |
| `service_id` | source/deployment/log events | configured service registry or authoritative deployment source | operational | analyzer, deployment resolver, URL correlator |
| `revision_id` | source/deployment/observation | source control or artifact inventory | operational | immutable contract and revision-scoped claims |
| `artifact_id` | deployment/serving evidence | build/deployment authority | operational | artifact-to-revision resolution |
| `configuration_fingerprint` | deployment/exposure evidence | deployment/configuration authority | restricted | exposure resolver, change invalidation |
| `evidence_reference` | every derived fact | source adapter | restricted | evidence links, audit, freshness |

### 3.2 Pull request, merge, and branch-update fields

| Field | Applies to | Source / owner | Sensitivity | Consumer |
|---|---|---|---|---|
| `pull_request_id` | PR event | SCM provider | operational | preview identity, audit |
| `pull_request_url` | PR event | SCM provider | restricted | authorized portal/source link |
| `head_branch` | PR/branch event | SCM provider | operational | branch analysis |
| `base_branch` | PR event | SCM provider | operational | preview comparison |
| `head_revision_id` | PR event | SCM provider | operational | isolated scan |
| `base_revision_id` | PR event | SCM provider | operational | structured diff |
| `changed_paths` | PR/branch event | SCM provider | restricted | impact analysis |
| `merge_commit_id` | merge event | SCM provider | operational | branch/environment separation |
| `previous_branch_revision_id` | branch update | SCM provider | operational | incremental comparison |
| `new_branch_revision_id` | branch update | SCM provider | operational | branch snapshot publication |
| `branch_reference_state` | branch update | SCM provider | operational | stale/out-of-order detection |
| `review_or_merge_outcome` | PR/merge event | SCM provider | operational | workflow reporting; never deployment resolution |

### 3.3 Deployment, rollback, and reconciliation fields

| Field | Applies to | Source / owner | Sensitivity | Consumer |
|---|---|---|---|---|
| `environment_name` | deployment/serving event | configured environment registry | operational | environment resolver |
| `deployment_id` | deployment attempt | CI/CD provider | operational | attempt history, deduplication |
| `deployment_attempt_state` | deployment attempt | CI/CD provider | operational | status display, reconciliation trigger |
| `attempt_effective_order` | deployment attempt | CI/CD provider | operational | stale-event handling |
| `attempt_started_at` | deployment attempt | CI/CD provider | operational | lifecycle/audit |
| `attempt_finished_at` | deployment attempt | CI/CD provider | operational | lifecycle/audit |
| `attempted_artifact_id` | deployment attempt | CI/CD provider | operational | artifact resolution |
| `attempted_revision_id` | deployment attempt | CI/CD provider or resolved artifact evidence | operational | deployment history; unresolved when unavailable |
| `rollback_request_id` | rollback request | authorized deployer/CI-CD provider | operational | lifecycle history |
| `rollback_target_artifact_or_revision_id` | rollback request | authorized deployer/CI-CD provider | operational | requested intent only |
| `rollback_request_state` | rollback request | CI/CD provider | operational | lifecycle display |
| `serving_observation_id` | active-state observation | authoritative deployment inventory | operational | serving-state history |
| `serving_observed_at` | active-state observation | authoritative deployment inventory | operational | freshness, ordering |
| `serving_effective_order` | active-state observation | authoritative deployment inventory | operational | state resolution |
| `active_artifact_set` | active-state observation | authoritative deployment inventory | operational | mixed/unknown environment resolution |
| `active_revision_set` | active-state observation | authoritative deployment inventory plus artifact resolver | operational | contract selection |
| `serving_state_completeness` | active-state observation | authoritative deployment inventory | operational | mixed/unknown labeling |
| `authoritative_source_kind` | active-state observation | deployment inventory configuration | operational | authority validation |
| `reconciliation_id` | reconciliation event | scheduler / reconciliation adapter | operational | replay, audit |
| `reconciliation_scope` | reconciliation event | scheduler / operator-configured policy | operational | resolver scope |
| `reconciliation_cursor_or_snapshot_ref` | reconciliation event | provider | restricted | missed-event repair, audit |
| `reconciliation_outcome` | reconciliation event | reconciliation worker | operational | freshness and failure display |

### 3.4 URL mapping and traffic-observation fields

| Field | Applies to | Source / owner | Sensitivity | Consumer |
|---|---|---|---|---|
| `mapping_id` | routing/configuration evidence | gateway/configuration authority | operational | exposure history |
| `public_server_template` | routing evidence | gateway/configuration authority | restricted | environment URLs, OpenAPI server projection |
| `public_path_template` | routing evidence | gateway/configuration authority | operational | URL mapping |
| `application_path_template` | code/routing evidence | analyzer or gateway/configuration authority | operational | route correlation |
| `http_method` | code/log/routing evidence | analyzer, gateway, or application telemetry | operational | endpoint matching |
| `routing_predicates` | routing evidence | gateway/configuration authority | restricted | conditional exposure and variant selection |
| `mapping_verification` | mapping evidence | resolver | operational | candidate/ambiguous/confirmed display |
| `mapping_evidence_reference` | mapping evidence | source adapter | restricted | provenance, audit |
| `observation_window_start` | traffic aggregate/sample | log connector | operational | evidence scope |
| `observation_window_end` | traffic aggregate/sample | log connector | operational | evidence scope |
| `observed_environment_name` | traffic aggregate/sample | telemetry resource attributes or connector mapping | operational | environment filter |
| `observed_service_id` | traffic aggregate/sample | telemetry resource attributes or connector mapping | operational | endpoint correlation |
| `observed_revision_id` | traffic aggregate/sample | trace/deployment correlation | operational | revision-scoped claims; unknown remains unknown |
| `trace_or_correlation_id` | pairable traffic sample | telemetry/log source | sensitive | request/response pairing only; minimize retention |
| `matched_route_template` | traffic sample | framework telemetry or gateway | operational | explicit route correlation |
| `observed_status_code` | traffic sample/aggregate | gateway or application telemetry | operational | status distributions, examples |
| `sample_completeness` | traffic sample/aggregate | log connector | operational | limitations and absence safeguards |
| `sampling_metadata` | traffic aggregate | log connector | operational | denominators, interpretation |
| `redaction_or_truncation_flags` | traffic sample | sanitizer | operational | limitations; no absence inference |

### 3.5 Sanitized request and response example fields

| Field | Applies to | Source / owner | Sensitivity | Consumer |
|---|---|---|---|---|
| `example_id` | derived example | sanitizer/example builder | operational | portal, MCP, OpenAPI export |
| `example_kind` | derived example | sanitizer/example builder | operational | label observed, synthetic, paired, or unpaired |
| `request_method` | request example | sanitized telemetry or synthetic generator | sanitized | contract/example display |
| `request_url_template` | request example | sanitized mapping + telemetry | sanitized | contract/example display |
| `request_headers_sanitized` | request example | ingestion-boundary sanitizer | sanitized | contract/example display |
| `request_query_sanitized` | request example | ingestion-boundary sanitizer | sanitized | contract/example display |
| `request_body_sanitized` | request example | ingestion-boundary sanitizer | sanitized | contract/example display |
| `response_status_code` | response example | sanitized telemetry | sanitized | contract/example display |
| `response_headers_sanitized` | response example | ingestion-boundary sanitizer | sanitized | contract/example display |
| `response_body_sanitized` | response example | ingestion-boundary sanitizer | sanitized | contract/example display |
| `pairing_state` | example | correlator | operational | prohibit apparent transactions from unrelated samples |
| `pairing_evidence` | paired example | correlator | restricted | audit and pair validity |
| `sanitization_policy_version` | example | sanitizer configuration | operational | reproducibility, policy review |
| `redaction_report` | example | sanitizer | operational | safe counts/rules/paths; excludes original values |
| `example_scope` | example | example builder | operational | environment/revision/window/access scope |
| `example_limitations` | example | sanitizer/example builder | operational | visibly state omitted, truncated, redacted, or unknown material |

## 4. Handling and evidence rules

- Raw request/response bodies, authorization values, cookies, session identifiers, credentials, internal hostnames, and private source/log references are `sensitive` and do not enter the durable catalog, model prompts, embeddings, or public examples. Derive `sanitized` fields at ingestion or omit/quarantine suspicious content.
- `restricted` metadata remains access-scoped. A derived link or summary cannot broaden source access.
- A synthetic example must say `synthetic`; an observed example must say `observed` and include scope/completeness. A request and response become `paired` only with supported correlation evidence. Otherwise label them `unpaired`.
- Keep declaration, observation, inference, and owner assertion as separate claim categories. A source can contribute several categories but no category silently upgrades another.
- Unknown is a first-class value. Missing source data, no traffic, failed reconciliation, unknown revision, or a disabled log field must remain visible rather than being converted into absence, success, or an inferred value.

## 5. Consequences for the next tasks

D02 uses these framework labels and synthetic lifecycle names, but may not turn them into an enterprise claim. D03 defines executable schemas from the inventory while retaining attempt versus serving observations, rollback request versus confirmation, state completeness, and evidence scope. Later work can add a provider-specific adapter only after recording its authority, ordering, artifact identity, routing evidence, and sanitization capabilities.

