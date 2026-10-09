# `@api-truth/query`

The shared read layer for API Truth's portal, MCP, and exports. D11-S0–S2
implement explicit tenant/repository/service selectors, authorized reads, and
OpenAPI publication binding; the portal and MCP transport surfaces follow.

`parseQuerySelection` requires an explicit environment, branch, or immutable
revision. `createQueryReader(pool, { schema })` reads the selector, current
policy, and snapshot in one PostgreSQL repeatable-read transaction. It offers
service search, exact contract/endpoint/schema retrieval, and contract
comparison. Branch reads check the orchestration checkpoint and can require
an expected pointer version. Environment reads check the active configuration,
repository and deployment authority, current source scope, serving checkpoint,
artifact binding, and exactly one authorized snapshot. Unknown, transitional,
absent, and ambiguous states expose no contract. A supplied expected version
fails if the pointer or checkpoint changed.

Service search scans configured repository/service IDs, not arbitrary branches.
It returns no deployment claim unless the caller names an environment. Results
are capped at 50, and configurations with more than 10,000 services or a result
set over the requested limit raise an explicit error instead of appearing
complete. A resolved contract includes either its validated current OpenAPI
publication ID or an explicit `absent` status when strict export is unavailable.
Query and OpenAPI reads share D10's validation in one database transaction.
Historical publication reads recheck current grants and source scopes; they
do not claim the historical contract is current. Semantic ranking, pagination,
and portal/MCP transports are not yet implemented.

The `readMetadataObservations` capability is also exposed by `createQueryReader` for an explicit environment selector only. It returns records only when the environment resolves to one current snapshot and checkpoint, applies the same repository, deployment, source, and snapshot grants as contract reads, and filters persisted records to the exact snapshot, revision, configuration fingerprint, and checkpoint version selected in that transaction. A moved checkpoint therefore cannot mix observations from an older serving pin into the current result. Historical revision and branch selectors are rejected. The caller must pass a limit from 1 to 100; results have stable ordering and an explicit `truncated` flag. The output contains only sanitized status/method/status-code and endpoint/mapping identifiers with import/source/window lineage; it never returns log URLs, payloads, credentials, raw hashes, or inferred contract claims. Run the observations migration before using this capability; missing storage fails with a fixed query storage error.

From the repository root, run `npm run typecheck`,
`npx vitest run tests/unit/query-selection.test.ts`, and
`npx vitest run --config vitest.integration.config.ts tests/integration/query-read.test.ts --maxWorkers=1`
and `npx vitest run --config vitest.integration.config.ts tests/integration/query-publication.test.ts --maxWorkers=1`
with the fixed local PostgreSQL test service running.
