# @api-truth/updates

Versioned contracts for planning one already-selected service update and
reporting deterministic contract differences. Branch selection and repository
enumeration belong to the orchestration layer; this package accepts one
immutable target revision.

Planning input paths are project-relative paths under that service root. The
public parser rejects duplicate or non-UTF-8-byte-sorted `changed_paths` with
`semantic.noncanonical_order`, so equivalent path sets have one boundary form.

Safe difference projections apply the same rejection rule to every declared
set-like IR array. Diagnostic fact keys embed the canonical affected-endpoint
array directly, for example `["diagnostic","code",["endpoint-a"]]`.
