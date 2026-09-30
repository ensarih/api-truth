# `@api-truth/environment`

Private D09 environment-resolution core and durable deployment ledger. The pure
projection consumes facts already authenticated and scoped to one tenant,
service, and environment. The repository consumes only D08 events that have
already passed its producer and deployment-authority checks. It records a
current serving checkpoint and serves an authorized environment resolution.

`resolveEnvironment` keeps deployment attempts separate from authoritative
serving observations. A branch tip, succeeded or failed attempt, and requested
or reported rollback cannot establish the serving revision. A complete empty
inventory establishes confirmed absence. A complete inventory with one artifact
resolves a contract only when that exact artifact is bound to its observed
immutable revision and that revision has exactly one analyzed snapshot. Missing
or conflicting bindings and snapshots remain pending. Multiple active artifacts
or incomplete/transitional inventory remain transitional and do not select one
contract, even when snapshots are known.

The pure function's input associations must already be scoped. The view
repository supplies those associations under current access checks and never
infers deployment from a branch name.

`applyEnvironmentMigrations` requires the D08 ledger and creates an independent
checksum-checked migration record. `recordAttempt` requires a `jobs.execute`
worker identity and an exact stored event identity. It records immutable
deployment attempts and first-seen artifact-to-revision bindings in one
transaction. Replaying the same event is idempotent; a conflicting binding
rolls back the attempt. Unknown revisions remain unbound. The D08 event remains
durable if consumption has not happened yet, so a host can replay it after a
crash. The D09 deployment inbox backfills existing D08 events and captures new
ones in the same ingestion transaction. `createEnvironmentInboxWorker.drain`
consumes a bounded batch with expiring leases, retries transient storage
failures, and records safe terminal errors for permanent conflicts. Its host
must call `drain` on a schedule. No active serving revision is inferred from an
attempt.

`classifyServingObservation` compares the authoritative source and canonical
effective order, independently of event arrival time. `recordServingObservation`
persists immutable observations and advances one serialized checkpoint per
tenant/repository/service/environment. Old observations do not replace current
state. Opaque or conflicting order retains the current observation and records
a pending exact-scope reconciliation requirement. An observation from an old
installation configuration cannot become current. Unknown or incomplete
inventories remain current evidence but keep reconciliation pending until a
newer complete observation establishes the serving set. Unknown revision
reasons are omitted from D09's safe inventory. `createEnvironmentReconciler`
requests one literal tenant/repository/service/environment from a provider port,
ingests that response through D08 authorization, then confirms it using the
checkpoint version and active configuration. A stale provider response cannot
replace a newer checkpoint. Complete known inventory can resolve opaque order;
unknown or incomplete inventory remains pending. A pending flag alone is not
evidence that reconciliation ran.

`createEnvironmentReconciliationWorker.drain` discovers configured environments
without a serving checkpoint, stale configurations, and pending checkpoints.
It also refreshes old serving evidence after a configurable interval (one hour
by default), so a missed deployment event is eventually repaired without
rescanning code. It leases one exact scope at a time and calls a trusted
reconciliation port. A host can supply `createEnvironmentReconciler` with its
authenticated deployment adapter. Transient errors and incomplete provider
responses back off; new checkpoint versions supersede old leases. A D08
environment-specific `reconciliation.requested` event schedules an immediate
exact check in the same ingestion transaction. Replays do not schedule twice.
An explicit request survives delivery of an older queued serving event and is
cleared only after a complete exact provider confirmation. A request arriving
during an incomplete check starts a fresh attempt rather than inheriting its
backoff. Scopes already removed before a worker claim are retired without provider access;
if reactivated while still pending, they are scheduled again.

`createEnvironmentViewRepository.getEnvironment` reads one tenant, repository,
service, and environment under a consistent database snapshot. It checks the
active configuration, repository and deployment access scopes, observation
source label, and current grants for candidate analyzed snapshots. It verifies
each candidate through D06's stored-snapshot integrity check and requires the
observed revision and active configuration to match. A missing binding or
analysis remains pending. Confirmed empty inventory, mixed serving, and unknown
serving stay distinct; the latest attempt is shown only when its order is
unambiguous. Revocation takes effect on the next query. The view returns a
resolution and snapshot ID, not the full contract document. While an exact
reconciliation is pending, a previously resolved snapshot is withheld rather
than presented as current.

From the repository root, run `npm run test:environment` for the focused offline
suite. Start the fixed local PostgreSQL test service with `npm run test:env:up`,
run `npm run test:environment:integration`, then stop it with
`npm run test:env:down`. `npm run check` covers all offline suites. A concrete
deployment-provider adapter and query transports are later work in the
[backlog](../../docs/BACKLOG.md).
