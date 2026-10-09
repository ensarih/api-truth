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

## Selected revisions and evidence revisions

A completed source-only D07 reuse can select a later immutable revision while
retaining the original complete snapshot. Revision, branch and environment
contract reads validate the immutable revision association, successful producing
job, complete reuse plan/differences, exact profile/configuration/source identity
and current grants before resolving it. Branch reads also bind the last
successful selected revision and association key to the current checkpoint.

For these qualified reads, `pin.revision` remains the snapshot's evidence
revision; `pin.selectedRevision` names the later revision selected by the view.
The snapshot and its evidence are never relabeled. Ordinary reads keep their
existing pin shape. Legacy NULL input fingerprints remain compatible only with
the proven complete source-only path; non-null fingerprints must match exactly.
Extra manifests and partial document snapshots are not admitted by this path.

Qualified reads currently withhold current OpenAPI publication and metadata
observations. Keyword matching accepts the qualified pin and retains both revision fields
while checking citations against the evidence revision. Model services and
observation imports still require their original single-revision contract
and fail closed. The
transaction helper used by imports and model services returns `unknown` for a
qualified reuse selection before those consumers can use it. Adopting both
revision fields across those surfaces is separate acceptance work.

Service search scans configured repository/service IDs, not arbitrary branches.
It returns no deployment claim unless the caller names an environment. Results
are capped at 50, and configurations with more than 10,000 services or a result
set over the requested limit raise an explicit error instead of appearing
complete. A resolved contract includes either its validated current OpenAPI
publication ID or an explicit `absent` status when strict export is unavailable.
Query and OpenAPI reads share D10's validation in one database transaction.
Historical publication reads recheck current grants and source scopes; they
do not claim the historical contract is current. Portal and MCP use this shared read layer. Pagination and broad semantic
retrieval remain separate work.

The `readMetadataObservations` capability is also exposed by `createQueryReader` for an explicit environment selector only. It returns records only when the environment resolves to one current snapshot and checkpoint, applies the same repository, deployment, source, and snapshot grants as contract reads, and filters persisted records to the exact snapshot, revision, configuration fingerprint, and checkpoint version selected in that transaction. A moved checkpoint therefore cannot mix observations from an older serving pin into the current result. Historical revision and branch selectors are rejected. The caller must pass a limit from 1 to 100; results have stable ordering and an explicit `truncated` flag. The output contains only sanitized status/method/status-code and endpoint/mapping identifiers with import/source/window lineage; it never returns log URLs, payloads, credentials, raw hashes, or inferred contract claims. Run the observations migration before using this capability; missing storage fails with a fixed query storage error.

From the repository root, run `npm run typecheck`,
`npx vitest run tests/unit/query-selection.test.ts`, and
`npx vitest run --config vitest.integration.config.ts tests/integration/query-read.test.ts --maxWorkers=1`
and `npx vitest run --config vitest.integration.config.ts tests/integration/query-publication.test.ts --maxWorkers=1`
with the fixed local PostgreSQL test service running.


## Operation keyword candidates

The optional `QueryOperationReader.readOperationCandidates(context, selection, {intentQuery, limit?})` capability requires an explicit environment and expected checkpoint version. It reuses authorized contract resolution and additionally requires all snapshot evidence scopes in the same read transaction. Invalid options fail before database access. The pure `searchOperationCandidates` matcher does not authorize inputs on its own.

Candidates rank bounded declared document text or qualified source route/handler/action identifiers. Results retain the exact pin, evidence IDs, `matchMode: "keyword"`, completeness and truncation. `no_match` means no keyword overlap in a complete searchable selected contract; it does not assert that no API implements a business task. Unknown or incomplete context is explicit. This capability performs no model calls.

The optional `QueryCorpusOperationReader.searchOperationCandidatesAcrossServices(context, {tenantId, environment, intentQuery, limit?})` searches only services configured for that explicit environment in the active configuration. One repeatable-read transaction resolves each service's current serving checkpoint and authorized snapshot. Repository and deployment grants are filtered before reading service context; source, snapshot, and all evidence grants are checked before matching. Each candidate carries its repository, service, endpoint, own exact environment selector and checkpoint pin. Results are deterministically ordered by lexical score, then repository, service, and endpoint ID. This is a keyword candidate list over visible authorized current services, not a semantic enterprise index or a claim that the operation fulfills the user's task.

The reader inspects at most 200 configured services, searches at most 20 authorized services and 5,000 total endpoints, bounds combined configuration/snapshot JSON to 4 MiB, and applies a 10-second cumulative database deadline. It reads and validates the active configuration once in the repeatable-read transaction, then reuses that validated copy for each service. Before each corpus query it resets PostgreSQL's statement timeout to the remaining deadline and races the query against that deadline; an expired or cancelled query returns a generic `unknown` with `scan_limit` and destroys the pending database connection. Configuration and snapshot queries check serialized size in PostgreSQL and withhold oversized documents before sending them to the reader. It returns at most 20 candidates. Limits and unresolved or partial contracts make `complete: false` or a generic `unknown` result; denied services contribute no identifiers or counts. `no_match` is returned only for a complete scan of at least one visible authorized service and means no lexical match in that scope. A result pin can become stale after the search; consumers must reauthorize and check that exact pin before a later operation. This capability performs no model calls and does not scan branches or unconfigured repositories.
