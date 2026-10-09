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
