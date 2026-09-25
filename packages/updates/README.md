# @api-truth/updates

`@api-truth/updates` is the pure D07 core for planning an update to one
already-selected service revision, running the existing analyzer safely, and
producing deterministic structured contract differences. It does not select or
enumerate branches, persist jobs, promote catalog pointers, call a network or
model, read logs, or execute analyzed source.

All three public contract versions are `1.0.0`:

- `UPDATE_PLAN_VERSION`
- `CONTRACT_DIFFERENCE_VERSION`
- `CONTRACT_CHANGES_OUTPUT_VERSION`

## Public API

The package exports TypeBox schemas, their static types, and parsers for:

- `AnalysisKey` and `UpdatePlanningInput`
- `UpdatePlan`
- `ContractDifference` and `ContractDifferenceSet`
- `ClaimConditionAssignment`
- `ContractChangesSnapshotSummary`, `ContractChangesPlanSummary`, and
  `ContractChangesOutput`

Every nested contract object rejects unknown properties. The parsers also
enforce canonical set ordering, unique semantic keys, content-derived IDs, and
cross-field agreement. Public failures use `UpdateError` with a stable code,
constant message, retryability, and safe `{ path, code }` issues.

The main functions are:

- `planUpdate(input: unknown)` validates the input and returns a deterministic
  impact plan.
- `compareContractSnapshots(input: unknown)` validates two snapshots and
  returns a deterministic difference set.
- `executeUpdate(input, analyzer)` validates the plan and request, executes one
  safe analyzer call when required, converts the result through the catalog's
  snapshot converter, and compares the complete snapshots.
- `parseUpdatePlan`, `parseContractDifferenceSet`, and
  `parseContractChangesOutput` validate values received at trust boundaries.

## Planning and endpoint ownership

Planning paths are project-relative paths under the selected service root.
Duplicate or non-UTF-8-byte-sorted paths are rejected rather than normalized at
the public boundary.

The reverse ownership index closes endpoint impact through:

- endpoint evidence and endpoint-scoped evidence;
- parameter and request-body presence evidence;
- endpoint-owned claims, conditions, and export-eligibility evidence;
- endpoint parameter, body, response, and header schemas;
- transitive local component references and component evidence; and
- explicit endpoint, schema, and evidence dependency edges.

Optional D03 dependency edges improve the graph but are not required for the
ordinary evidence and schema ownership routes. Orphaned or ambiguous records,
unindexed paths, pathless endpoints, incomplete prior coverage, incomplete path
lists, and changed digests without paths remain visible as incomplete dependency
coverage and fallback reasons.

The fallback reasons, in canonical order, are:

1. `adapter_incremental_targets_unsupported`
2. `prior_coverage_incomplete`
3. `changed_paths_incomplete`
4. `changed_paths_digest_mismatch`
5. `changed_path_unindexed`
6. `dependency_index_incomplete`
7. `analyzer_changed`
8. `config_changed`
9. `ir_changed`
10. `identity_changed`

Equal source and analysis inputs with complete coverage and an empty complete
change list may reuse the base snapshot. Every source-changing plan uses
`analyze_full_service` with `fallback_full_service`. D07 records precise impact
but does not implement bounded target extraction or merge a partial analyzer
fragment into a prior snapshot. No incremental performance claim is made.

## Difference taxonomy and compatibility

The exact taxonomy, exported as `DIFFERENCE_KINDS` and validated by
`DifferenceKindSchema`, is:

```text
endpoint.added
endpoint.removed
endpoint.absence_unconfirmed
endpoint.path_parameter_names_changed
parameter.added
parameter.removed
parameter.changed
request_body.added
request_body.removed
request_body.changed
response.added
response.removed
response.changed
security.changed
schema.added
schema.removed
schema.changed
claim.added
claim.removed
claim.changed
condition.added
condition.removed
condition.changed
fact.absence_unconfirmed
analysis.coverage_changed
analysis.identity_changed
analysis.diagnostic_added
analysis.diagnostic_resolved
```

Compatibility is a total three-label classification:

- `non_breaking` for additions or relaxations that the implemented rules can
  establish safely;
- `potentially_breaking` for removals, constraints, required inputs, response
  changes, security changes, schema changes, and other established risks; and
- `unknown` when incomplete coverage or claim meaning prevents a safe result.

Input fields use presence-aware rules: adding an optional member is
non-breaking, adding a required or conditional member is potentially breaking,
and unknown presence remains unknown. Grouped claim-condition comparison keeps
each value and verification partition attached to its condition, emits at most
one record per owning claim tuple and difference kind, and uses sorted unique
`ClaimConditionAssignment` arrays.

A target with incomplete coverage cannot prove deletion. Missing endpoints use
`endpoint.absence_unconfirmed`; missing parameters, request bodies, responses,
schemas, and claims use `fact.absence_unconfirmed`. Confirmed removal kinds are
emitted only when target coverage is complete. Duplicate semantic comparison
keys fail with `UPDATE_COMPARISON_INCOMPATIBLE` instead of being overwritten.

Difference, difference-set, and plan IDs are SHA-256 hashes of canonical
semantic content. Evidence IDs, source spans, completion times, claim IDs, and
input ordering do not change the result.

## Execution safety

`executeUpdate` reparses and detaches the plan, base snapshot, request, and
analyzer result. Before adapter access it checks repository, service, root,
revision, source digest, analyzer identity, exchange/IR/identity/config
versions, configuration fingerprint, resolution input, changed paths, and
action/mode agreement. A full analysis always forces
`fallback_full_service`; reuse never invokes the analyzer.

The analyzer result must agree with the validated private expectation before
conversion. D07 converts the result as a complete target snapshot and never
fills missing facts from the base. This keeps a partial target partial and
preserves the deletion guard. The package has no catalog mutation, database,
branch promotion, network, log, model, or application-execution hook.

## Branch boundary

D07 accepts exactly one service and one immutable revision selected by its
caller. D08 must read
`InstallationConfig.repositories[].services[].intended_branches` as the exact
v0.1 per-service scan allowlist before scheduling D07. Unlisted branches are
ignored and an empty list schedules no scans. Branch patterns are deferred to a
future configuration-version extension.

## Local comparison

Compare the synthetic D02 source revisions with the read-only CLI:

```sh
npm run --silent changes -- \
  --base-source fixtures/typescript/orders/baseline/src \
  --changed-source fixtures/typescript/orders/changed/src \
  --service orders \
  --base-revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --changed-revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

Successful stdout is one compact `ContractChangesOutput` document plus a
newline. It contains exactly `contract_changes_output_version`, `plan`, `base`,
`target`, and `differences`. It excludes filesystem and source paths, source
digests, configuration fingerprints, evidence and dependencies, source values
and locations, raw analyzer results, and unprojected diagnostics. Application
paths and schema pointers may appear only as contract facts in differences.

Run all focused D07 tests with:

```sh
npm run test:updates
```
