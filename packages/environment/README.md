# `@api-truth/environment`

Private D09 environment-resolution core. The current implementation is a pure
projection from facts already authenticated and scoped to one tenant, service,
and environment. It does not persist deployments, select the latest provider
observation, or serve an environment query yet.

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

From the repository root, run `npm run test:environment` for the focused offline
suite or `npm run check` for all offline suites. Durable event handling, provider
ordering/reconciliation, storage, and authorized environment queries are later
D09 slices in the [backlog](../../docs/BACKLOG.md).
