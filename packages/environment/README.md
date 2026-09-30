# `@api-truth/environment`

Private D09 environment-resolution core and durable deployment ledger. The pure
projection consumes facts already authenticated and scoped to one tenant,
service, and environment. The repository consumes only D08 events that have
already passed its producer and deployment-authority checks. It does not yet
select the latest provider observation or serve an environment query.

`resolveEnvironment` keeps deployment attempts separate from authoritative
serving observations. A branch tip, succeeded or failed attempt, and requested
or reported rollback cannot establish the serving revision. A complete empty
inventory establishes confirmed absence. A complete inventory with one artifact
resolves a contract only when that exact artifact is bound to its observed
immutable revision and that revision has exactly one analyzed snapshot. Missing
or conflicting bindings and snapshots remain pending. Multiple active artifacts
or incomplete/transitional inventory remain transitional and do not select one
contract, even when snapshots are known.

The input associations must be pre-filtered to the same tenant, repository,
service, and configuration context by the future D09 repository. This package
does not authorize callers or infer artifact bindings from branch names.

`applyEnvironmentMigrations` requires the D08 ledger and creates an independent
checksum-checked migration record. `recordAttempt` requires a `jobs.execute`
worker identity and an exact stored event identity. It records immutable
deployment attempts and first-seen artifact-to-revision bindings in one
transaction. Replaying the same event is idempotent; a conflicting binding
rolls back the attempt. Unknown revisions remain unbound. The D08 event remains
durable if consumption has not happened yet, so a host can replay it after a
crash. Automatic delivery from the D08 outbox is a later integration slice;
no active serving revision is inferred from an attempt.

`classifyServingObservation` compares the authoritative source and canonical
effective order, independently of event arrival time. `recordServingObservation`
persists immutable observations and advances one serialized checkpoint per
tenant/repository/service/environment. Old observations do not replace current
state. Opaque or conflicting order retains the current observation and records
a pending exact-scope reconciliation requirement. An observation from an old
installation configuration cannot become current. Unknown or incomplete
inventories remain current evidence but keep reconciliation pending until a
newer complete observation establishes the serving set. Unknown revision
reasons are omitted from D09's safe inventory. The exact provider reconciler
and automatic request delivery
remain open work; a pending flag is not evidence that reconciliation ran.

From the repository root, run `npm run test:environment` for the focused offline
suite. Start the fixed local PostgreSQL test service with `npm run test:env:up`,
run `npm run test:environment:integration`, then stop it with
`npm run test:env:down`. `npm run check` covers all offline suites. Provider
exact provider reconciliation, automatic delivery, and authorized environment
queries are later D09 slices in the [backlog](../../docs/BACKLOG.md).
