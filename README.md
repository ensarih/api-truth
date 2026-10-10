# API Truth

> Evidence-backed API discovery and documentation from code, runtime, and delivery history.

API Truth is an open-source platform for enterprises that need to discover undocumented APIs, keep their contracts current, and make them usable by developers, architects, portals, and AI assistants.

## Why API Truth?

API knowledge is often spread across source repositories, deployment branches, gateways, logs, and internal documentation. API Truth brings these sources together while preserving where each fact came from and how confident it is.

## Planned capabilities

- **Code-first discovery** for TypeScript/Node.js and Java services
- **Contract extraction** for routes, parameters, request/response schemas, validation, security, and conditional rules
- **CI/CD updates** on pull requests, merges, and deployments
- **Environment awareness** across development, UAT, staging, and production
- **Runtime enrichment** from sanitized logs to map deployed URLs and provide request/response examples
- **OpenAPI 3.1 generation** with evidence and representability checks
- **Portal and MCP access** for human users and AI assistants
- **Optional semantic analysis** through selectable OpenAI, Google Gemini, or Anthropic Claude adapters
- **Documentation context** from Confluence and other enterprise sources, with discrepancy reporting

## Evidence model

API Truth keeps these facts separate:

1. What the source code exposes
2. What was built from a branch or commit
3. What was deployed to an environment
4. What the gateway or platform exposes
5. What runtime traffic has observed
6. What documentation or an LLM suggests

Unknown information stays unknown. Inferred statements remain distinguishable from verified contract facts.

## Project status

Development is underway. D01–D10 are complete. D08 runs durable branch analysis, isolated PR previews, exact branch/PR reconciliation, and configuration-change repair against the local PostgreSQL test environment. D09 tracks deployment facts and authoritative serving state. D10 compiles evidence-gated OpenAPI 3.1, validates it offline against a pinned official schema, and publishes revision, branch, and environment contracts atomically. D11 now has a shared authorized query layer, a host-authenticated portal, and initial read-only MCP tools. D12 has a bounded synthetic reference workflow and a local host-attested event bridge; provider wiring and the full lifecycle gate remain. The TypeScript/Express analyzer covers a published bounded subset. Java and additional Node.js framework adapters have separate conformance gates.

Start with:

- [Fresh-checkout local setup and operator guide](docs/LOCAL_SETUP.md)
- [Product specification](docs/SPECIFICATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Project plan](PROJECT%20PLAN.md)
- [Maintained development backlog](docs/BACKLOG.md)
- [Phased roadmap](docs/ROADMAP.md)
- [Testing and local validation](docs/TESTING.md)
- [TypeScript/Express analyzer and support matrix](analyzers/typescript/README.md)
- [routing-controllers decorator analyzer](analyzers/routing-controllers/README.md)
- [Swagger 2 document analyzer](analyzers/nodejs/README.md)
- [OpenAPI 3.0 document analyzer](analyzers/openapi3/README.md)
- [Offline Node.js onboarding inventory](analyzers/nodejs/INVENTORY.md)
- [Catalog package and local round-trip](packages/catalog/README.md)
- [Orchestration package and local lifecycle test](packages/orchestration/README.md)
- [Environment-resolution core](packages/environment/README.md)
- [OpenAPI planner and compiler](packages/openapi/README.md)
- [Portal host interface](apps/portal/README.md)
- [Read-only MCP host interface](apps/mcp/README.md)

## Development direction

Functional development follows test-driven development. `npm run check` uses deterministic fixtures and contract assertions without Docker, databases, network access, or provider credentials. The separate PostgreSQL suite uses a pinned, loopback-only, disposable Compose service. OpenAI, Gemini, and Claude are application providers for semantic API understanding; they are not test runners or test judges.

The current local workflow can extract the synthetic baseline and round-trip it through an ephemeral schema in the fixed Docker-backed test database. A synthetic CI fixture formats validated events; the local bridge can deliver host-attested facts to the durable ledger. Production provider authentication and the full CI/deployment lifecycle remain open Phase 1 work. Bounded runtime observations and configured semantic discovery are implemented; live collectors, a semantic corpus index, reviewed enrichment and related-document connectors remain open. See the [semantic package](packages/semantics/README.md) for the bounded cross-service discovery profile. Protected Swagger document-load verification also has separate durable admission, leasing and atomic worker completion. It records scoped historical evidence; deployment presence and normative API behavior require separate evidence.

## Open-source principles

- Public fixtures use synthetic services and data.
- Enterprise source code, logs, hostnames, credentials, and private documentation stay outside the repository.
- Every catalog fact carries provenance, status, and timestamps.
- Generated documentation is versioned and reviewable.
- Connectors and framework adapters are replaceable and independently testable.

## License

This repository is licensed under [Apache-2.0](LICENSE).
