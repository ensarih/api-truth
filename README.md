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

Development is underway. D01–D07 and D08 slices 0–6 are complete. D08 now runs durable branch analysis, isolated PR previews, exact branch/PR reconciliation, and configuration-change repair against the local PostgreSQL test environment. Its independent final review remains. D09 has pure environment resolution, durable deployment-attempt/artifact records, ordered serving checkpoints, an exact-scope provider reconciliation port, authorized views, and workers for event consumption, immediate environment requests, and periodic repair. D10 now has a method/path projection planner and evidence-gated OpenAPI 3.1 compilation for representable single operations; variant handling and atomic publication remain. The TypeScript/Express analyzer covers a published bounded subset. The portal and MCP tools are later Phase 1 work. Java and additional Node.js framework adapters have separate conformance gates.

Start with:

- [Product specification](docs/SPECIFICATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Project plan](PROJECT%20PLAN.md)
- [Maintained development backlog](docs/BACKLOG.md)
- [Phased roadmap](docs/ROADMAP.md)
- [Testing and local validation](docs/TESTING.md)
- [TypeScript/Express analyzer and support matrix](analyzers/typescript/README.md)
- [Catalog package and local round-trip](packages/catalog/README.md)
- [Orchestration package and local lifecycle test](packages/orchestration/README.md)
- [Environment-resolution core](packages/environment/README.md)
- [OpenAPI planner and compiler](packages/openapi/README.md)

## Development direction

Functional development follows test-driven development. `npm run check` uses deterministic fixtures and contract assertions without Docker, databases, network access, or provider credentials. The separate PostgreSQL suite uses a pinned, loopback-only, disposable Compose service. OpenAI, Gemini, and Claude are application providers for semantic API understanding; they are not test runners or test judges.

The current local workflow can extract the synthetic baseline and round-trip it through an ephemeral schema in the fixed Docker-backed test database. Later phases add CI/CD adapters, runtime evidence connectors, the portal, and the read-only MCP server.

## Open-source principles

- Public fixtures use synthetic services and data.
- Enterprise source code, logs, hostnames, credentials, and private documentation stay outside the repository.
- Every catalog fact carries provenance, status, and timestamps.
- Generated documentation is versioned and reviewable.
- Connectors and framework adapters are replaceable and independently testable.

## License

This repository is licensed under [Apache-2.0](LICENSE).
