# `@api-truth/catalog`

`@api-truth/catalog` is the D06 PostgreSQL persistence boundary for immutable
D03 contract snapshots, current access scopes and grants, and branch pointers.
It accepts a validated D05 `AnalyzerResult`, materializes a D03
`ContractSnapshot`, and keeps authorization decisions tied to current database
policy state.

This package is private workspace code. It has no HTTP or administrative
transport.

## Public API

```ts
import type { Pool } from "pg";
import {
  applyCatalogMigrations,
  contractSnapshotFromAnalyzerResult,
  createAccessPolicyStore,
  createCatalogStore,
  CatalogError,
} from "@api-truth/catalog";

await applyCatalogMigrations(pool, { schema });

const access = createAccessPolicyStore(pool, { schema });
await access.putScope({ tenantId }, { scopeId, active: true });
await access.putGrant(
  { tenantId },
  { principalId, scopeId, active: true },
);

const catalog = createCatalogStore(pool, { schema });
const converted = contractSnapshotFromAnalyzerResult(
  analyzerResult,
  configFingerprint,
);
const write = await catalog.ingestAnalyzerResult({
  tenantId,
  result: analyzerResult,
  configFingerprint,
});
const stored = await catalog.getSnapshot(
  { tenantId, principalId },
  write.snapshotId,
);
const promotion = await catalog.promoteBranch({
  tenantId,
  repositoryId,
  serviceId,
  branch,
  snapshotId: write.snapshotId,
  provider: {
    provider: "delivery-adapter",
    provider_reference: "delivery-42",
    order: { kind: "sequence", value: "42" },
  },
});
const resolution = await catalog.resolveBranch(
  { tenantId, principalId },
  { repositoryId, serviceId, branch },
);
```

| Export | Contract |
|---|---|
| `applyCatalogMigrations(pool, { schema })` | Apply or verify the ordered schema-local migration manifest |
| `contractSnapshotFromAnalyzerResult(result, configFingerprint)` | Return a validated snapshot, canonical required scopes, and eligible analyzer status |
| `createAccessPolicyStore(pool, { schema })` | Return trusted transactional `putScope` and `putGrant` operations |
| `createCatalogStore(pool, { schema })` | Return `ingestAnalyzerResult`, authorized `getSnapshot`, `promoteBranch`, and authorized `resolveBranch` operations |
| `CatalogError` | Stable `code`, constant safe `message`, optional projected `issues`, and `retryable` |

The public package also exports the context, snapshot, branch, provider,
result, store, and error types in [`src/types.ts`](src/types.ts). Every catalog
domain operation carries `tenantId`. In D06 this is an installation/security
partition; it is not a hosted multi-tenant provisioning claim.

`AccessPolicyStore` is a trusted control-plane API. A caller must authenticate
and authorize administrative scope and grant mutations before exposing those
operations outside its process.

## Snapshot identity and immutability

`contractSnapshotFromAnalyzerResult` parses the D05 result, rejects `failed`
results, maps `success` or `partial` results to the D03 snapshot contract, and
parses the materialized snapshot again. Required scope IDs come from the
analyzer source `access_label` and every evidence `access_label`. D06 treats
those labels as exact scope IDs.

Snapshot identity is `(tenant_id, snapshot_id)`. An exact replay returns
`existing` only when these values all agree with the stored row:

- the identity digest;
- the normalized contract-content digest;
- analyzer status; and
- the exact canonical required-scope array.

The identity digest covers snapshot, repository, service, immutable revision,
analyzer, IR version, identity version, and configuration fingerprint fields.

`contentSha256` hashes canonical contract content after removing only the
top-level `created_at`. Nested timestamps and every other field, value, and
array order remain content. The digest is not a byte digest of the stored JSON
document. If a replay differs only in top-level `created_at`, the first full validated
document remains stored and is never replaced. Any other identity or content
difference produces `SNAPSHOT_IDENTITY_CONFLICT`.

The database rejects `UPDATE` and `DELETE` on snapshot rows with an
immutability trigger. Because `required_scope_ids` is stored on that row, its
members cannot later be added, removed, replaced, or reordered. A check
constraint requires a nonempty array with nonempty, unique members in UTF-8
byte order, matching PostgreSQL `COLLATE "C"`. A deferred constraint trigger
requires every member to name an existing scope in the same tenant before the
transaction can commit.

## Current authorization

`getSnapshot` and `resolveBranch` authorize inside their catalog read SQL. They
unnest the immutable `required_scope_ids` array, left join each member to a
current active `access_scopes` row and a current active
`principal_scope_grants` row, and deny when the anti-join finds any missing
scope or grant. The read also requires the array cardinality to remain greater
than zero.

Caller-asserted scope lists are not accepted. Deactivating a scope or grant
immediately denies both current and historical reads. Missing snapshots,
branches, tenants, principals, scopes, and grants all return the same
`CATALOG_NOT_FOUND_OR_DENIED` error so the response does not disclose resource
existence or required policy IDs.

## Branch pointers and provider order

D06 stores one pointer for an explicitly supplied tenant, repository, service,
and branch key. It does not enumerate repository branches or decide what to
scan. The executable v0.1 configuration's `intended_branches` array is the
exact service scan allowlist: orchestration added in D08 must ignore unlisted
branches, and an empty array means scan none.

Promotion runs in one transaction, locks the branch key, verifies that the
target is an eligible stored snapshot for the same tenant/repository/service,
and advances the pointer atomically. Exact replays return `existing` without
incrementing `pointerVersion`.

The D03 spelling `provider_reference` maps directly to the database text
column. Canonical decimal `sequence` values for the same provider compare as
unbounded text: digit count first, then ASCII digit order for equal lengths.
They are never converted to a JavaScript or PostgreSQL numeric type. Older
values are stale and equal values with different reference state conflict.
Cursor and effective-version values have no D03 comparator, so D06 treats them
as opaque and requires compare-and-swap with the expected pointer version.
Provider, order-kind, and noncanonical-sequence changes also require
compare-and-swap.

## Migrations and transactions

`applyCatalogMigrations` accepts a validated PostgreSQL schema identifier. It
serializes migration work with a schema-keyed advisory lock, hashes each exact
migration file, rejects checksum drift, and records applied versions in the
schema-local `catalog_schema_migrations` ledger.

Every policy mutation, snapshot ingestion, and branch promotion uses an
explicit transaction and a transaction-local schema search path. Snapshot
ingestion locks required scopes in canonical order before insertion. Branch
promotion uses an advisory transaction lock even before the pointer row exists,
then locks an existing row before validating and writing. A failure rolls back
without replacing an existing snapshot document or regressing a branch
pointer.

## Safe errors

All public failures use `CatalogError` with a stable code and constant message.
Validation issues contain only `{ path, code }`; storage causes are retained
only as non-enumerable internal details.

| Code | Meaning |
|---|---|
| `INVALID_CATALOG_INPUT` | A catalog context, identifier, provider value, or CLI argument is invalid |
| `INVALID_SNAPSHOT` | The analyzer result or materialized/stored D03 snapshot is invalid |
| `SNAPSHOT_INELIGIBLE` | A valid failed analyzer result cannot be stored |
| `UNKNOWN_ACCESS_SCOPE` | A required scope is missing or inactive |
| `SNAPSHOT_IDENTITY_CONFLICT` | An existing snapshot ID has different immutable content or metadata |
| `BRANCH_TARGET_INELIGIBLE` | The full-key branch target is missing or ineligible |
| `BRANCH_POINTER_STALE` | A comparable provider sequence moves backward |
| `BRANCH_POINTER_CONFLICT` | Provider state or compare-and-swap state conflicts |
| `CATALOG_NOT_FOUND_OR_DENIED` | One generic result for a missing or unauthorized read |
| `CATALOG_STORAGE_ERROR` | Migration, transaction, or stored-row verification failed safely |

Messages and serialized issues do not contain snapshot documents, evidence
values, scope or principal IDs, provider references, SQL, database URLs,
credentials, or raw PostgreSQL errors.

## Local D05-to-D06 round-trip

The demonstration requires the fixed D04b test PostgreSQL service. It accepts
no database URL or reset target and creates one random validated
`api_truth_test_...` schema, which it drops in `finally` on success or failure.

```sh
npm run test:env:up
npm run test:env:ready
result_file="$(mktemp -t api-truth-analyzer-result).json"
npm run --silent extract -- --source fixtures/typescript/orders/baseline/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$result_file"
npm run catalog:roundtrip -- --input "$result_file" --tenant local-demo --principal local-developer --branch main
rm "$result_file"
npm run test:env:down
```

The script validates the analyzer result before connecting, migrates its schema,
seeds the synthetic scopes and grants through `AccessPolicyStore`, ingests the
snapshot, promotes the supplied branch, performs authorized branch and snapshot
reads, reparses the returned D03 documents, and emits this safe summary:

```json
{"snapshot_id":"snapshot-...","branch":"main","pointer_version":"1","round_trip_valid":true}
```

Use `npm run --silent catalog:roundtrip -- ...` when another process must parse
stdout without npm's lifecycle banner. The command still requires the four
named arguments and rejects duplicates or unknown arguments.

## Tests and limits

- `npm run check` runs strict type checks and all offline unit/contract tests.
- `npm run test:integration` requires the fixed running D04b database and
  exercises real migrations, immutability, access revocation, branch ordering,
  concurrency, and the CLI round-trip.
- `npm run test:integration -- tests/integration/catalog-roundtrip-cli.test.ts`
  focuses the round-trip command.
- `npm run test:env:down` removes only the fixed Compose project resources.

D06 does not implement D07 differences/dependency invalidation, D08 event or
job orchestration, D09 deployment/environment resolution, D10 publication or
OpenAPI output, or D11 query, portal, and MCP surfaces. It also provides no
production database CLI, network administration API, hosted tenant
provisioning, model/provider call, or Java analyzer. Java executable behavior
remains a later phase.
