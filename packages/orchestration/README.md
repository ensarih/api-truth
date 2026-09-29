# `@api-truth/orchestration`

Private application-layer contracts and pure policy for durable API Truth
event and job orchestration. This package treats normalized events and all
identity contexts as untrusted input, selects only explicitly configured
branches, and exposes privacy-safe operational projections.

The first slice is deliberately pure. Persistence, scheduling, workers, and
commands are added by later D08 slices.
