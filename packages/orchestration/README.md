# `@api-truth/orchestration`

Private application-layer contracts and pure policy for durable API Truth
event and job orchestration. This package treats normalized events and all
identity contexts as untrusted input, selects only explicitly configured
branches, and exposes privacy-safe operational projections.

The package persists immutable configurations and normalized events in
PostgreSQL. It advances branch and pull-request checkpoints only from
comparable provider evidence, schedules generation-keyed analysis and exact
reconciliation jobs, and records transactional outbox notifications.

Every scheduling transaction acquires its complete, canonically ordered
advisory-lock set before locking rows. It stages work so checkpoint rows are
written before immutable events and targets, jobs and dependencies follow,
and outbox records are last. Branch selection is exact and case-sensitive.
Incomparable evidence preserves the current desired state and requests
exact-scope reconciliation; stale evidence is retained without changing a
checkpoint. Workers can now claim and heartbeat durable jobs, recover expired
leases, apply bounded retries and concurrency limits, propagate dependency
failure, and deliver the transactional outbox with independent permissions.
Analyzer execution and reconciliation result application follow in later D08
slices.

PR checkpoints keep authoritative state and evidence separate from a pending
opaque reconciliation request. A first opaque PR observation creates an
explicit `pending` checkpoint with no authoritative base, head, or state; a
later opaque observation can only replace that request generation. It cannot
open, close, or otherwise rewrite the authoritative PR fields before exact-PR
reconciliation confirms them.

A newer comparable observation of the same branch revision advances the
checkpoint evidence without creating a new generation or retrying terminal
failed work. Worker completion must therefore validate the job's full key,
revision, and generation against the current checkpoint, use
`isMonotoneProviderConfirmation` to accept its newer comparable confirmation,
and promote with the checkpoint evidence instead of requiring byte equality
with the job's originating event.
