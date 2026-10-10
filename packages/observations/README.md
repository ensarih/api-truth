# Bounded metadata observation matching

`correlateMetadataObservation(raw, context)` is a pure first Phase 3 slice. A trusted caller supplies one authorized catalog snapshot, its resolved single-revision environment pin, a per-record provenance attestation (`revision`, `sourceId`, `sourceVersion`, `windowStart`, `windowEnd`), and explicit gateway routing mappings for that same pin. The raw record supplies only a URL, uppercase HTTP method, status code, and revision to cross-check with the attestation. Other inert JSON fields are size-checked and discarded; getters, proxies, non-JSON objects, cycles, and oversized values are rejected.

A confirmed result contains only the existing endpoint ID, trusted mapping ID, method, status code, `metadata_only` completeness, and policy version. Unresolved/rejected results contain fixed reason codes. Results never include raw URL, origin, path, query, headers, cookies, body, trace IDs, raw values, exception text, or hashes of those values.

Matching requires an exact literal public origin and explicit public-to-application path templates. It rejects encoded path separators and dot segments, userinfo, fragments, ambiguous mappings, missing or selector-specific endpoints, and revision mismatch. It never selects a first server or route, discovers a new endpoint from logs, or infers schema, requiredness, authentication, examples, or source contract facts from samples.

The caller must establish authorization, routing evidence, and a trustworthy independent attestation from verified transport, container, or artifact metadata; application-provided revision fields alone are insufficient. The caller must not derive the attestation from the untrusted log record itself. The pure matcher does not read logs, query stores, persist observations, or promote observations into contract claims or runtime deployment assertions.

## Durable import

`applyObservationMigrations` creates separate append-only import and record tables after the catalog and environment migrations. `createObservationStore(pool, {schema, authorizeImporter, readBatch})` accepts only an opaque import ID and an expected full environment pin from the caller. The host authenticates the importer independently and must grant `observations.import`. Its trusted `readBatch` port supplies bounded records, routing mappings, and source attestation from a verified log source; it receives only the detached import ID and expected pin, never a raw URL or log payload from the caller. Import IDs and record IDs must be independently generated UUIDv4 values, not values or hashes derived from log content.

The store checks log opt-in, reader grants, and the exact resolved catalog/environment pin in a short transaction **before** it calls `readBatch`. It releases that transaction for the source read, then repeats the same authorization and pin checks in the write transaction. A grant revocation or serving change between the two checks aborts without an insert. Each transaction uses the environment serving advisory lock, locks the active configuration and serving checkpoint, and locks the required scope and principal-grant rows before the authorized query. The resulting SQL parameters contain only sanitized matcher results and trusted lineage IDs/window/pin. Duplicate imports with identical safe content are idempotent; changed safe content under the same import ID is rejected. Rejected records abort the whole import. The store does not change snapshots, claims, requiredness, deployment state, or export eligibility. Host verification of transport provenance and the log source’s retention policy remain outside this package.

## Synthetic schema examples

`buildSyntheticExample(resolvedView, selectedEndpointId, policy)` creates a deterministic, non-normative placeholder object from an explicit request body or exact-status response schema. The policy is a trusted static opt-in (`synthetic-examples-1`) naming the endpoint, JSON media type, direction, response status when applicable, and at most 64 JSON Pointers to allowed properties. For arrays, a path continues through the item schema without a numeric pointer segment; generated repeated items are identical placeholders. It generates fixed type-shaped values such as `"string"`, `0`, and `false`; it never reads or accepts traffic samples and never copies schema `const`, `enum`, defaults, or examples. The snapshot and policy are not modified. Generated results carry the exact environment and snapshot scope plus schema and policy fingerprints. Unsupported schema keywords, ambiguous body/status/media matches, cycles, unknown paths, invalid constraints, or required properties that cannot be represented within the opt-in withhold the entire candidate using fixed rule IDs and counts.

This pure generator validates bounded input shape and matching snapshot/pin fields only. It cannot prove authorization, freshness, or caller identity. A host must invoke it only with a fresh result from an authorized `QueryReader` environment read, and must repeat its ordinary authorization and serving-pin checks at the surface boundary. The passed resolved-view object is not itself proof of authorization. No generated examples are persisted, sent to a model, or promoted to contract claims. These placeholders are not evidence that a live request or response will pass runtime validation.

`createSyntheticExampleService({queryReader, policies})` supplies that bounded read path. A trusted host configures immutable policy bindings for exact tenant, repository, service, environment, and policy ID. The caller supplies only its identity context, an environment selection with an expected serving checkpoint, and a policy ID; it cannot submit property paths. The service reads the contract through `QueryReader` before looking up the policy, withholds when no policy is configured, and reads again after generating a candidate. A grant loss or any change to the snapshot, revision, configuration, or checkpoint discards the candidate with a fixed error. This service does not persist or publish examples and does not accept traffic or model input.

The initial schema subset is intentionally conservative: local `#/schemas/...` references, scalar types, objects, arrays, required members, and bounded string/numeric/item limits. Composition, unions, formats, patterns, `const`, `enum`, `additionalProperties`, and other unsupported semantics withhold the example when they affect an opted-in value. Selectors for query/path/header parameters, observed examples, retention, and portal/MCP delivery are outside this module.

## Observed field presence (pure projection)

`projectObservedFieldPresence(input)` accepts an exact resolved environment pin,
contract snapshot, host-authorized owner policy, bounded raw `payloadText` and
`payloadCompleteness`. The host must authorize the source read and exact policy
before reading a body, then recheck authorization and the current pin before
using the result. The function checks consistency; it does not grant authority.

The policy selects at most 32 literal RFC 6901 property paths in one request
schema or exact-status response schema and JSON media type. Only directly declared
object paths ending in primitive types are supported. References, arrays, unions,
constraints and ambiguous or undocumented paths withhold the whole projection.
Prototype keys, wildcards and the documented implementation's conservative PII
label subset are rejected. Credential field names can be selected because only
presence is returned, never their values.

Only `complete_unredacted` payloads may produce `present` or `absent`; this flag is
a trusted caller assertion, not independently verified traffic completeness.
Duplicate JSON keys, malformed bodies, wrong value types, incomplete or masked
bodies and unsupported shapes yield fixed withheld diagnostics. Input is bounded
to 256 KiB payload text, depth 32 and 10,000 parsed nodes. Results contain selected
static paths, states and scope, with no payload values or value hashes. Invalid
input shapes throw `FieldPresenceInputError` with a fixed message.

These observations are explicitly non-normative and cannot establish requiredness
or modify contracts. This slice has no source reader, durable body import, sample
storage, retention, provider, portal or MCP integration. Those require separate
authorization, versioned policy and lifecycle gates.

Synthetic examples currently withhold qualified source-reuse views that carry
`selectedRevision` separately from the evidence revision. Their output scope
cannot yet represent both revisions. A qualifier appearing or changing on the
final authorized read invalidates an earlier candidate. Keyword/API detail reads
can carry this qualification; examples do not silently discard it.

The raw payload parser also withholds unsafe integral numbers and fractions or
underflow values that JavaScript would round to integers, preventing false
integer type correspondence. Exact integral decimal/exponent forms remain
supported. This is conservative numeric type checking, not value validation.

## Host-authorized field-presence reads

`createFieldPresenceService({queryReader, policies, authorize, readObservation})`
exposes `read(context, {selection, policyId, observationId})`. The host fixes the
authenticated tenant/principal, configured owner policies and trusted source
ports. The selection must name an environment and expected serving checkpoint.
The request cannot supply bodies, paths or a policy. Record IDs must be UUIDv4;
the trusted source adapter must generate them independently from content. Format
validation alone cannot establish that provenance.

Policies are detached and immutable within one service instance. Each binds
tenant/repository/service/environment to a static endpoint, direction, JSON media
type, selected property paths and exact response status when applicable. Current
snapshot/revision/source/configuration/checkpoint fields are injected from an
authorized QueryReader result. Qualified selected/evidence revision views remain
unsupported. The schema/path preflight runs after independent authorization and
before the body read; unsupported paths do not trigger source access.

The trusted source port returns bounded raw JSON text, completeness and an exact
attestation binding the record ID, full source pin (including pointer version
when present), endpoint, direction, media type and response status. The adapter
must establish these fields from independently verified transport and metadata
correlation. Copying application/body fields into an attestation is insufficient.
The port must enforce the 256 KiB source-read bound itself; returned text is checked
again. This module supplies neither a live log adapter nor transport verification.

The independent `authorize` port runs before source access and again after the
final fresh QueryReader read and full pin comparison. It must atomically verify
the expected current environment pin and catalog, source, record and owner-policy
authority under the host's own transaction/locks on **every invocation**. A
source-only permission check is insufficient. The final authorization is the last
awaited external operation; there is no later source/query call before returning
the sanitized result. These are trusted host obligations, not database authority
implemented by this package.

External authorization/source callbacks have fixed ten-second deadlines and an
AbortSignal. Timers clear on completion; timed-out late results are ignored. The
QueryReader remains responsible for its ordinary bounded database execution.
Denied, stale, invalid or failed reads use fixed error codes and never include
raw bodies, record IDs or callback exception text. No raw source content is
persisted, sent to a provider, or delivered to portal/MCP by this service. Durable
body imports, reviewed samples and retention remain separate backlog gates.

## Storage policy and value-free eligibility

`compileFieldPresenceStoragePolicy(input)` compiles an explicit
`field-presence-storage-1` opt-in policy. It binds tenant, repository, service,
environment, active configuration fingerprint and activation checkpoint, a positive
owner-policy revision, endpoint/direction/media type, exact response status when
applicable, and at most 32 literal property paths. Retention must be explicitly
60–2,592,000 seconds and the live-record budget 1–10,000. There are no defaults.
Its fingerprint hashes only this static policy, never traffic or payload values.

`buildFieldPresenceStorageProposal({queryResult, projected, policy, parent, host})`
checks a resolved, untruncated environment metadata query, exact import/record
UUIDv4 parent, confirmed metadata-only endpoint/status correspondence, and the
projected scope and selected presence states. The trusted host separately supplies
the expected source digest, active configuration epoch and policy fingerprint.
Views carrying `selectedRevision` or `pointerVersion` currently withhold.
Malformed dates, windows ending after import, duplicate record IDs, extra values,
getters and proxies also withhold. Eligible proposals are detached and frozen,
containing lineage, static paths, presence states, retention and budget only.

This pure gate checks consistency of trusted inputs. It does not establish that a
projection came from the selected record, authenticate the caller, approve an
owner policy, enforce the live budget, or write rows. The host must independently
prove source-to-record correspondence and revalidate authority and current state
in a storage transaction. No expiry is computed from a caller clock. The next
durable slice must use database time and source-window-end-based lifetime, so
replay cannot restart retention. Opt-out, policy replacement, deletion and replay
tombstones remain unimplemented here. Metadata imports remain append-only.

## Owner-policy journal (database prerequisite)

Observation migration `0002_field_presence_owner_policies` adds separate static
owner-policy revisions and current heads. Revisions carry exact scope, policy
fingerprint, configuration activation epoch, selector, bounded property paths,
retention/budget and an independent owner access scope. Revisions cannot be
updated or deleted. A head can advance monotonically or disable its current
revision; a disabled revision cannot be re-enabled without advancing. Heads
cannot be deleted or moved to another scope. Composite foreign keys bind a head
to its exact immutable revision, configuration and owner access scope.

The internal pinned transaction helper can additionally require the exact active
configuration epoch and owner scope grants. It locks these grants with existing
catalog/source grants before the transaction callback, so concurrent revocation
waits and subsequent calls deny. This helper is not a public policy-management
API and assumes the host independently authenticated the required capability.

These tables store static policy only. They do not yet approve policies through a
host service, persist presence results, enforce TTL/budgets or delete derived
rows. Those lifecycle operations remain separate implementation gates; adding a
schema does not establish traffic provenance or owner authorization.

## Derived presence retention integrity (database prerequisite)

Migration `0003_field_presence_retention` adds separate value-free presence rows
and immutable replay tombstones. Inserts bind the exact confirmed metadata parent,
source snapshot digest, static policy generation, endpoint and response status.
Only the policy's complete canonical path list with `present`/`absent` states is
accepted. Rows cannot be updated. No bodies or payload-value hashes are stored.

The database computes expiry as the immutable import's source window end plus the
policy's TTL. Future, unverified-after-import, nonfinite and already expired windows
reject; callers cannot supply expiry or restart retention with exact retries.
The policy-head lock serializes inserts against a policy-wide unexpired-row budget,
including hidden older generations. Changing revisions cannot multiply that budget.

The internal invoker-rights SQL function `observation_field_presence_delete` locks
the policy head first, creates a permanent generation/parent tombstone, then deletes
the derived row in the same transaction. A tombstone requires an existing result at insertion and completed deletion at
transaction commit, preventing standalone markers from poisoning unwritten keys.
Raw deletion without a tombstone rejects.
A replay under that deleted generation rejects. Original metadata stays immutable.
The live view filters expired rows and disabled or replaced generations using
database time; it is not an authorized query API.

These are storage integrity primitives, not an authenticated persistence service.
The host must still approve policies, establish body-to-parent correspondence,
recheck current configuration/serving pins and grants atomically, bound source
reads, and authorize retention maintenance independently. Expiry hides rows;
physical cleanup requires the separate maintenance runner, which is not implemented
here. Tombstones are not pruned; any future pruning needs a proven replay horizon.
