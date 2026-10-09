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
