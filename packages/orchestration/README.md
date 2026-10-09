# `@api-truth/orchestration`

Durable PostgreSQL event and job orchestration for the supported API Truth
configured analyzer profiles. This package is the deterministic maintenance core;
it does not connect to an SCM provider, deploy services, publish OpenAPI, or
serve portal/MCP requests.

## Implemented flow

1. Register and activate a validated installation configuration. Each
   service's `intended_branches` is an exact, case-sensitive allowlist. An
   empty list scans no branches.
2. Ingest authenticated D03 events. Immutable event identities, provider
   ordering, checkpoints, job dependencies, and outbox records survive process
   restart. A scheduled reconciliation submits the same durable event through
   `createReconciliationScheduler`; retries reuse its idempotency key and
   occurrence time.
3. Claim jobs with a worker carrying `jobs.execute`. `runJob` accepts an
   immutable source resolver and D05 analyzer for baseline, branch, and PR
   preview jobs. Exact branch and PR reconcilers observe one literal subject
   each; neither lists branches or PRs.
4. Branch analysis pins the desired revision and generation. Eligible success
   or partial snapshots are stored through D06 and promoted only while the
   branch checkpoint, configuration, lease, and provider evidence still agree.
   An unchanged target may reuse an existing snapshot through a separate
   immutable revision association.
5. PR previews compare the declared base revision from the revision association
   index with the head revision. A missing base creates a shared baseline
   prerequisite. Preview results have `pr_preview` scope and never promote a
   branch or change environment state. Close and merge cancel outstanding
   previews.
6. Exact reconciliation repairs missed branch updates, records confirmed
   absence without deleting the last D06 pointer, and resolves opaque PR
   observations. A closed PR cannot reopen from a stale or incomparable open
   observation. Configuration changes cancel obsolete work and queue exact
   reconciliation for configured branches.

Workers use database-time leases, bounded retries, dependency propagation,
capacity limits, and a transactional outbox. The package uses canonically
ordered advisory locks before checkpoint/job rows. Operational projections
expose safe states and error codes; raw source, provider responses, and
credentials are not returned in status records.

`getEventStatus`, `getJobStatus`, `getOutboxStatus`, and
`getActiveConfigurationSummary` require `orchestration.status.read`. Event
status uses an opaque hashed identity. Missing and cross-tenant records share
one denial code, and status reads never return stored event documents or job
result payloads. An optional `OrchestrationObserver` receives fixed, bounded
ingress, job, reconciliation, catalog, and outbox signals after durable
transitions; the default is a no-op. Denied ingress emits a signal without a
database write. Signals contain no tenant, repository, service, event, or
error text, and observer failures cannot change orchestration results. The
transactional outbox separately carries durable integration notifications;
its delivery requires a worker capability.

## Local validation

From the repository root:

```sh
npm run test:env:up
npm run test:orchestration
npm run test:env:down
```

`test:orchestration` runs the real PostgreSQL event → job → analyzer → D06
snapshot/pointer lifecycle plus PR preview, reconciliation, retry, ordering,
and configuration races against synthetic fixtures. It requires the fixed
loopback-only test service. Its disposable schemas are dropped by the tests;
`test:env:down` removes the Compose test service and its tmpfs data. The
complete offline suite is `npm run check`, and the full PostgreSQL suite is
`npm run test:integration`.

The application host must implement the resolver and exact provider ports.
No GitHub adapter, production scheduler, deployment binding, OpenAPI compiler,
portal, or MCP endpoint is shipped by this package. The maintained
[backlog](../../docs/BACKLOG.md) tracks those later gates.


## Explicit analyzer wire selection

A service still selects an exact `analyzer.adapter_id` and `adapter_version`.
Optional `analyzer.ir_version` selects `1.0.0` or `1.1.0`. Omission preserves
legacy `1.0.0` behavior; Swagger middleware requires an explicit `1.1.0`.
The protocol version enters durable job columns, semantic identities and
revision association keys. The worker checks stored configuration, resolver
request and analyzer result before recording a snapshot. Changing the version
is a configuration change and invalidates the service's analysis.

This is a closed additive field in installation configuration 1.0. Existing
configurations retain their previous semantics. It does not auto-select a
framework or certify an unsupported adapter/version combination. The host must
supply the selected adapter and digest-bound resolution inputs through its
existing resolver/analyzer ports; no project execution or branch enumeration
is introduced.
