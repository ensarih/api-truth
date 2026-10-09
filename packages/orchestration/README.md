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

## External capture provenance associations

`createObservedCaptureAssociationStore` appends protected receipt provenance to
`orchestration_observed_capture_associations`. Its trusted host pin resolver
verifies an externally stored signed envelope; callers supply only an exact
source/environment scope. Writer authorization runs before resolution and again
in the insertion transaction. The transaction authorization port must lock and
check its grant rows using the supplied client, with no network I/O; host ports
and the PostgreSQL pool must enforce their own connection/callback deadlines.
SQL statements have a local ten-second timeout.

Capture identities contain tenant, source scope, protected artifact/key references,
policy version and receipt/signer hashes. Two captures of the same revision remain
separate. Exact replays are idempotent; mismatched stored identities fail closed.
Rows are append-only. This records `pinned_envelope` provenance only: it does not
verify handler bytes, schedule runtime analysis, or promote branch/environment
pointers. D08 continues rejecting runtime observation inputs.

`createObservedCaptureVerificationStore` records a separate append-only
`protected-handler-bytes-1` verification summary linked to that capture identity.
The trusted host supplies the capture-bound verification port; callers cannot
submit results, handler paths or signing keys. Parent pin identity is recomputed
before verification and again inside insertion, together with a DB-local writer
grant check. The detached result must match the parent source/environment and
receipt/signer hashes. Exact replay is idempotent; changed roots/results conflict.

Only the canonical result hash, handler count, relative service root, profile and
parent hashes are stored. Handler paths, controller/export identifiers and receipt
payloads are not persisted in this table. The storage boundary trusts the host
byte verifier and adds no deployment or document correspondence proof. No query
surface, runtime analysis job, catalog snapshot or serving pointer is created.
Host callbacks and pool acquisition retain their own deadline responsibilities;
write SQL uses the same local statement timeout as capture associations.

`createCaptureVerificationAdmissionStore` adds an immutable queued admission
intent for a previously associated 0006 capture. The request contains only its
opaque capture identity. The host fixes tenant and principal at construction,
checks their capability before any database lookup, and supplies a DB-local
authorization callback. That callback must lock and check an explicit capture
opt-in bound to the **current configuration fingerprint, document SHA, and
activation checkpoint**, plus independent source, environment, and protected
capture permissions. It may use only bounded SQL on the supplied transaction
client. Catalog source/environment access-scope grants are checked and locked
first, but those reader grants alone do not authorize capture execution.

Admission verifies the immutable 0006 association identity, configured
repository/service/environment and exact service root. An older captured Git
revision may be admitted; admission does not assert a current branch head,
deployment, handler verification, or API-document match. The job identity
includes the capture, verifier profile, service root and active configuration
epoch. A tenant advisory lock serializes the bounded queued quota and replay;
the active configuration and relevant grants remain share-locked through
insertion. The immutable 0008 `queued` row records admission; the separate
0009 state row is the current lifecycle state. The admission quota counts only
queued, leased, and retry-waiting state rows, so terminal failure releases it.
No 0007 result, catalog snapshot or serving pointer is written by admission.

`createCaptureVerificationLeaseStore` claims at most one admitted job and
renews its 30-second lease. The host fixes tenant, principal, worker and
instance identities plus permitted repository/service IDs. Its separate
`capture.verify.execute` preflight runs before database access. Claim and
heartbeat lock the active configuration, validate its canonical document hash
and activation checkpoint, recompute the 0006 and 0008 identities, lock
source/environment reader grants, and require a DB-local host check of
independent source, environment and protected-capture execution permissions.
No network callback runs in the transaction. A lease token is returned to the
worker; only its hash is stored. The database clock decides expiry, and a lost
or expired token cannot be renewed. Expired leases may be reclaimed up to
three attempts, then become failed. At most two live capture leases per tenant
and one per service are admitted.

Claims search a bounded window filtered to the worker's configured scope and
the current configuration epoch. `no_work` reports partial coverage; it does
not assert that no other authorized work exists. Jobs from an old epoch stay
queued but cannot be claimed; cancellation and quota cleanup for stale jobs
remain separate work. This lease slice does not invoke the byte verifier or
write 0007. A future executor must fence the live lease, current grants and
configuration in the same transaction that appends 0007 and commits success.

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


Use `@api-truth/analyzer-host` to supply an exact configured analyzer port.
The real Swagger middleware IR 1.1 baseline/catalog integration exercises this
host. Runtime observation inputs are currently rejected before analyzer access;
independent capture receipts need a pinned job input before durable reuse is
safe. This does not remove standalone controlled-capture analysis.
