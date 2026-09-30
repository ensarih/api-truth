# `@api-truth/query`

The shared read layer for API Truth's portal, MCP, and exports. D11-S0/S1
implement explicit tenant/repository/service selectors and authorized reads;
the transport surfaces and OpenAPI publication binding are later D11 slices.

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
complete. Semantic ranking, pagination, portal/MCP transport, and publication
ID binding are not yet implemented.

From the repository root, run `npm run typecheck`,
`npx vitest run tests/unit/query-selection.test.ts`, and
`npx vitest run --config vitest.integration.config.ts tests/integration/query-read.test.ts --maxWorkers=1`
with the fixed local PostgreSQL test service running.
