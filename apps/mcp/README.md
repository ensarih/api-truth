# API Truth MCP tools

`createApiTruthMcpServer({ query, authenticate })` exposes five read-only tools:
service search, contract, endpoint, schema, and contract comparison. The server
requires a host-supplied `QueryReader` and authentication callback. Tool inputs
never accept a tenant or principal. Every contract read selects an explicit
revision, branch, or environment; resolved results include catalog and OpenAPI
publication pins. Unknown environment states remain explicit.

`serveApiTruthMcpStdio(options)` connects the same server to the official MCP
stdio transport. The host must wire its own trusted identity and database
connections before serving clients. There is no bundled unauthenticated
standalone process.

Inputs are bounded, search is capped at 50 services, and serialized tool output
defaults to 64 KiB. An oversized result returns `RESULT_TOO_LARGE`. MCP tools
cannot mutate configuration or catalog state.

Run `npm run test:contract` for the linked MCP protocol tests. The
PostgreSQL-backed cross-surface integration test is in
`tests/integration/portal-query.test.ts`.

## Runtime metadata

When the host supplies `readMetadataObservations`, the server registers the read-only `api_truth_get_observations` tool. Reads require an explicit environment, optionally its expected checkpoint version, a limit of 1–100 and an optional existing endpoint ID. The shared reader rechecks grants and returns only sanitized metadata with the exact current serving pin. Logs do not establish request/response schemas, required fields or authentication. No import/write tool is exposed.

## Semantic intent discovery

A host may pass `semantic: { discover }` to conditionally register the read-only `api_truth_discover_api` tool. Its input requires repository, service, an explicit revision/branch/environment view, 1–16 unique endpoint IDs, and intent text no longer than 512 characters. Branch and environment views must include the expected pointer/checkpoint version. The host authentication callback supplies identity; tool input has no tenant or principal fields. The tool may send selected endpoint documentation, eligible source route/handler identifiers, and intent text to the configured inference provider; consumers receive the provider-backed inference as a non-idempotent, open-world read. `contextCoverage` reports requested, analyzed, and omitted endpoint IDs, so a no-match result over partial context is not presented as global. The semantic service rechecks access and the selected pin around provider inference.

Results remain advisory: suggestions are inferred, unreviewed and non-normative, with evidence IDs. Discovery does not choose an analyzer, edit a contract, or create deployment evidence. The tool is absent unless the host explicitly enables the semantic capability.

## Keyword candidate search

When the host supplies `readOperationCandidates`, the server registers `api_truth_search_api_candidates`. It requires repository, service, an environment and exact expected serving checkpoint version, plus a bounded intent query and a limit of 1–20 results. Authentication supplies the tenant and principal. The tool is read-only, idempotent and closed-world: it searches the current authorized contract deterministically and never calls an inference provider.

Candidates include evidence IDs, scores, completeness, truncation, selector and pin. A `no_match` result describes keyword overlap in the selected contract only; it does not establish that no API could satisfy the intent. The tool is absent unless the host supplies the search reader.

When the host also supplies `searchOperationCandidatesAcrossServices`, the separate `api_truth_search_api_corpus` tool accepts an explicit environment, bounded intent query and 1–20 result limit. The authenticated host supplies tenant and principal; callers cannot choose them. It searches only currently serving, configured services visible to that principal. Each lexical candidate includes its repository, service, endpoint, evidence IDs, and its own exact environment checkpoint pin. Completeness and truncation describe the visible authorized scope only. The tool is read-only, idempotent and closed-world, and makes no inference-provider call. A later action must reload and reauthorize the candidate's exact pin.

## Synthetic schema examples

When the host supplies `examples: {generate}`, the read-only `api_truth_get_synthetic_example` tool accepts only repository, service, environment, expected serving checkpoint, and a host-configured policy ID. Authentication supplies tenant and principal. The service authorizes and rechecks the current pin; callers cannot provide property allowlists or snapshots. A generated result is a deterministic, non-normative placeholder, not observed traffic or runtime validation proof. No model or source execution is involved. The tool is absent unless the host enables it.

## Observed field presence

Supplying `presence: {readForPrincipal}` registers the read-only
`api_truth_get_field_presence` tool. Inputs require repository, service,
environment, snapshot ID, revision, configuration fingerprint, serving checkpoint,
policy ID, owner-policy revision and a limit of 1–100. Identity, credential,
capability and access-scope arguments are rejected, as are qualified views.

Use `createFieldPresenceQueryStore` for this port. MCP authentication supplies the
transport principal; the store independently authenticates the opaque
`ServerContext` through its host manager and requires that same tenant/principal.
A model-supplied principal never authorizes access. The host must provide both
authentication integrations; there is no bundled login or live log provider.

Output contains only owner-selected present/absent states, current full pin,
policy/source provenance and truncation. Observations are explicitly non-normative
and do not establish requiredness or validation. Existing output limits and fixed
errors apply. Owner policy, import and cleanup writes remain unavailable.

## Cross-service semantic comparison

Configure `corpusSemantic: {discoverAcrossServices}` to register the optional
`api_truth_discover_api_corpus` tool. Its strict input contains only `environment`,
`intentQuery` and required `limit` of 1–16. Host authentication supplies identity;
the tool cannot select tenant, provider, model, credentials or source pins.

The semantic corpus factory first retrieves authorized keyword candidates, then
compares eligible context within at most four service groups. Each group preserves
its namespace, checkpoint pin, cited evidence, analyzed context and inferred,
unreviewed, non-normative result. Shortlist coverage is separate from semantic
context coverage. A complete empty keyword shortlist does not prove API absence.
Changed authority or shortlist discards the complete response. The tool has
`readOnlyHint: true`, `idempotentHint: false`, and `openWorldHint: true` because
it may call the host-configured inference provider. Fixed error mapping and the
existing output bound apply; the tool is absent without host configuration.
