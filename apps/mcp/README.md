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
