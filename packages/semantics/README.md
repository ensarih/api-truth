# Grounded semantic suggestion kernel

`runGroundedSemanticAnalysis` accepts a contract snapshot and exact query pin already authorized by a trusted host, an explicit endpoint selection, and an inference setting with explicit provider and model. Credentials are excluded from this input and belong only in the host's provider adapter configuration. When inference is disabled or the selected endpoints lack documented text, the kernel does not call the provider port. There is no default provider or model.

The provider receives a bounded projection of selected endpoint method/path and existing OpenAPI document declarations with local document evidence: operation summaries or descriptions, response descriptions, and operation IDs. Source blobs, comments, logs, credentials, schemas, requiredness, security, and unrelated claims are excluded. Documentation text is untrusted data; the port has no tool or execution interface. This package performs no HTTP calls and never runs or grades tests.

The provider must return one exact structured shape: cited endpoint suggestions, ambiguity among selected endpoints, or no match. The kernel rejects unknown fields, unknown endpoints, evidence IDs outside the selected endpoint's documented context, and oversized or non-JSON output. Successful results are explicitly `inferred`, `unreviewed`, and `normative: false`, with the selected pin, selector, provider, model, and prompt version. They do not mutate snapshots, qualify export eligibility, or assert deployed behavior. Citation IDs validate reference linkage, not the truth of free-form prose; owner review and further verification remain separate.

`runGroundedSemanticDiscovery` compares one bounded user intent with at most 16 explicitly selected endpoints using the same document-only evidence projection. Its separate `semantic-discovery-1` prompt version preserves the existing `semantic-grounding-1` description profile. The intent is checked for credential-like content before egress. The host's `discover(context, selection, endpointIds, intentQuery)` method checks it before database access, then uses the same authorization and post-provider pin checks as `analyze`. This is selected-endpoint comparison, not search over an entire tenant, repository, or indexed corpus.

Discovery uses the separate `semantic-discovery-source-1` profile when any selected endpoint has eligible source claims; otherwise it uses the document profile. The source profile can include both eligible document declarations and source identifiers for a given endpoint, and keeps document-only selected endpoints when their peers have source context. It projects only a directly established Express route plus a bound handler symbol, or a declared routing-controllers route plus controller/action identifiers. Every cited source item must be source-code evidence for the same repository, immutable revision, service, snapshot, and endpoint; ambiguous, owner-asserted, inferred, credential-shaped, or mismatched claims are withheld. The provider receives literal route text and identifiers only, never implementation text or comments. Document prose is limited to extracted API declarations; identifiers support tentative naming only and do not establish business workflow, behavior, schema, security, or requiredness. Ordinary names such as `resetPassword` and paths such as `/auth/token` are not treated as credentials by keyword alone. Every discovery result includes `contextCoverage` with requested, analyzed, and omitted endpoint IDs. A `no_match` result with partial coverage applies only to the analyzed endpoints. If neither profile has safe context, the kernel returns `no_context` without calling the provider. Results remain inferred and unreviewed.

The authorized host service, `createSemanticService`, takes only a trusted caller context, an explicit query selection with exact expected checkpoint/pointer version, and selected endpoint IDs. It resolves the current snapshot and inference setting from PostgreSQL under reader grants, then calls the provider outside a transaction. Before delivering a suggestion, it rechecks the current pin, grants, active configuration, provider, and model. A changed context discards the result with a fixed error. By default the service does not store suggestions or credentials.

The service accepts exactly one trusted provider mode: a fixed `providerPort`, or a `providerFactory` bound to the selected tenant's active inference configuration. Factory bindings contain only tenant ID, provider, model, and the configured secret reference. They are created after authorization and only when the kernel has usable selected endpoint context. Secret references never enter kernel requests, responses, history, or caller input. Credential resolution and network calls remain outside database transactions; post-provider authorization also checks the active credential reference and configuration before returning a result. The fixed-port mode remains available for trusted synthetic and custom adapters.

## Optional inferred history metadata

Call `applySemanticHistoryMigrations(pool, {schema})` explicitly, then construct the service with `archiveHistory: true` to append a private audit record for successful `suggestions`, `ambiguous`, and `no_match` inference. The record is inserted in the **same final transaction** that rechecks the current pin, configuration, model, repository/source/evidence grants, and selected endpoints. The provider call remains outside any database transaction. A failed archive rolls back and returns a fixed storage error; disabled inference, missing context, provider errors and stale results insert nothing. The table is append-only and separate from contracts, claims and export eligibility.

Archived data contains only status, cited endpoint/evidence IDs, optional context coverage, the exact selector/pin, provider/model/prompt version, configuration hash, and the authenticated principal. It never stores the user's intent text, provider request or raw response, model credentials, suggestion prose, ambiguous reason, source text or log data. A canonical hash binds the safe result to its principal, source pin, configuration and provider provenance and detects stored tampering on reads. This is **metadata-only history**, so it cannot replay the full suggestion wording or serve as an owner review record.

`service.readHistory(context, selection, endpointIds, limit)` requires the archive option and a limit of 1–20. It reauthorizes the exact current selection and all selected endpoint evidence scopes in one transaction. It returns only records for the same authenticated principal, current pin, active configuration and current provider/model, with archived endpoints contained in the requested set. Revocation, a moved branch/environment pin, or a changed active configuration prevents older records from appearing. No cache or cross-principal sharing is provided.

This is an initial Phase 4 slice. Durable enriched prose, cache invalidation, owner review workflow, and curated question evaluation are separate work.

Free-form document text uses conservative exclusion patterns for credential-looking content, including inline Bearer values. Pattern matching cannot guarantee that arbitrary prose contains no sensitive information. Apply the organization’s document egress policy before enabling an external provider; permission to read a document alone is not a content-safety certification.

## Bounded cross-service discovery

`createSemanticCorpusService({corpusReader, semanticService})` composes the
public authorized query reader with the existing configured semantic service.
`discoverAcrossServices(context, {environment, intentQuery, limit})` uses the
host-authenticated tenant/principal and a required limit of 1–16. It first finds
keyword candidates among visible authorized services in that environment, then
compares the intent separately within at most four service groups. More groups
produce `unknown: group_limit` before any model call. Qualified multi-input pins
are currently withheld as `unsupported_pin`.

Each group keeps its repository/service namespace, exact environment checkpoint,
candidates, cited evidence and semantic result. Identical endpoint IDs in different
services remain distinct. No ranking across provider answers is claimed.
`shortlistCoverage` describes the bounded keyword search; each result's
`contextCoverage` describes the selected context actually analyzed. A complete
empty keyword shortlist yields `shortlist_no_match` without calling a model;
it does not establish that no suitable API exists in the enterprise.

The service checks each current contract and evidence before inference and repeats
the same authorized corpus query after all group calls. A changed shortlist, pin
or authority discards the whole response. The existing selected semantic service
also rechecks its own grants and configuration around each provider call. All
outputs remain inferred, unreviewed and non-normative. Inputs cannot select a
provider, model, credentials, tenant, endpoint IDs or source pins. This bounded
composition adds no embedding index, durable enriched prose, owner approval or
transport cancellation. OpenAI, Gemini and Claude remain host configuration
choices; local tests use synthetic provider ports only.


## Offline question conformance versus model quality

The synthetic curated question file contains 35 cases exercised against actual
Express, routing-controllers and Swagger analyzer outputs. Expected lexical route
ordering and representative scores are authored independently in the fixture.
Wrong-action decoys, mixed intents, incomplete context, ambiguity and closed-scope
no-match are explicit cases. A separate analyzer-derived environment mismatch is
rejected before contract/provider access; PostgreSQL composition checks duplicate
endpoint IDs across service namespaces.

Scripted provider outcomes exercise citation/status/coverage handling only. They
do not demonstrate that a real model understands the question, and no LLM grades
these tests. The kernel validates citations rather than the truth of inferred
prose. Live provider accuracy, benchmark targets, corpus indexing and owner review
remain separate acceptance gates. Corpus orchestration requires inferred answers
to name analyzed operations only; `no_context` requires zero analyzed operations,
and partial answers must retain their omitted endpoint list.


## Cross-service response deadline

Semantics 0.7.3 applies one shared 30-second monotonic deadline to corpus discovery: initial authorized candidate search, contract/evidence checks, all service-group comparisons, and final authorization/pin recheck. The host can set `deadlineMs` to an integer from 1 through 60,000; callers cannot override it. Expiry returns only `SEMANTIC_CORPUS_UNAVAILABLE`, stops further orchestration calls, withholds partial/late answers, and releases its timer. Success and ordinary failures also release the timer.

This bounds how long the caller waits and whether the orchestrator starts another phase. It does not interrupt synchronous JavaScript or cancel a query/provider port already in flight. Such a port can finish its own transport work or append its independently authorized history. Hosts remain responsible for underlying query/transport cancellation and cleanup. No provider fallback, new model calls, persistent index or owner-review status is introduced.

## Private history owner annotations

Semantics 0.7.4 adds optional, durable metadata decisions for an authenticated
principal's own archived inference history. Enable `archiveHistory: true` and
supply `historyReviewPolicy(client, binding)`. Without both, the review methods
reject requests. Apply the checksum-verified history migrations explicitly;
0002 upgrades an existing 0001 installation without changing its checksum.

The policy must return exactly `true` for the independent
`semantic.history.review` capability, action, current configuration and source
pin. Implement it as a promptly settling, read-only database policy using the
provided transaction client: lock and recheck the relevant owner grant and scope
rows through commit. Ordinary API read permission is insufficient. This callback
is trusted host code, not a caller-controlled authorization override or an
external network request. Review operations make no inference/provider call.

- `recordHistoryReview(context, selection, endpointIds, request)` accepts only
  `{historyId, decision, expectedVersion}`. Decisions are `acknowledged`,
  `follow_up`, or `dismissed`; IDs and versions are canonical decimal strings.
  The first expected version is `"0"`; a successful append returns version `"1"`.
  Use the latest returned version for the next decision. Repeating the same
  decision at the same expected version replays the existing receipt; a changed
  decision or stale version returns `SEMANTIC_REVIEW_CONFLICT`.
- `readHistoryReviews(context, selection, endpointIds, historyId, limit)` reads
  the latest 1–20 records, descending by version, with a truncation indicator.
  The read rechecks both source access and the independent owner capability.

Rows are append-only, serialized per tenant/principal/history, and integrity
checked against the immutable private history, exact source pin, configuration,
provider/model/prompt provenance and original endpoint subset. An owner grant
cannot expose another principal's private history. Revoked access, changed
configuration, or a moved serving checkpoint withhold the old records; persistence
does not imply that a decision applies to the new API version.

Every result stays `metadataOnly: true`, `nonNormative: true`, and inferred.
The original inference history remains `review: "unreviewed"`: these annotations
cannot approve provider prose that the existing privacy-preserving archive does
not retain. No intent, provider prose, credential, comment or reviewer-selected
identity is stored in the annotation. Shared review workflows, retained prose
approval, portal/MCP review transports and normative promotion are separate work.
