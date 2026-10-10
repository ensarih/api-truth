# Signed observation file connector

`createSignedObservationFileReader` reads one explicitly selected `<UUIDv4 importId>.json` file from a trusted root. It never scans a directory, runs source code, or contacts a network service. The connector rejects symlinks, files above 1 MiB, malformed UTF-8 or strict JSON, duplicate decoded keys, excessive depth, and more than 100 records.

The file is an envelope with `payload` and a base64 Ed25519 `signature`. The signature covers the UTF-8 bytes of `canonicalJsonStringify(payload)`. The payload contains `importId`, the full `expectedPin`, per-batch `attestation`, and `records` with opaque UUIDv4 record IDs. The verifier uses only the externally configured Ed25519 public key; a key named inside the file grants no authority. Import ID, pin, revision, and configured source ID must match exactly. Route mappings come from trusted constructor configuration, never from the file.

The returned function matches the observation store's `readBatch` port. The signing key attests provenance only when the host controls the signer and binds the signed batch to the claimed source, revision, and observation window. It does not infer a deployed revision from log content. The observation store still performs its own authorization, serving-pin checks, sanitization, and safe persistence. Errors use fixed codes and do not echo file paths or log values.


## Selected signed field-presence source

`createSignedFieldPresenceFileReader({root, publicKeyPem, sourceId, bindings})`
provides the internal `createFieldPresenceImportStore` source port. `bindings`
contains at most 128 unique tenant/repository/service/environment tuples, detached
at construction. The store authenticates the importer and checks owner policy,
parent, current pin and grants before invoking this port, and repeats those checks
before persistence. A caller-supplied identity or capability is not authority.
This reader is not a public body-download endpoint.

For one exact selected parent it reads only
`<importId>.<recordId>.presence.json` under the configured local root. There is no
scan, network request, service execution or write. It rejects symlinks, nonregular
files, file substitution/growth, files above 1 MiB, invalid UTF-8, duplicate JSON
keys, malformed inputs and aborted reads with fixed errors. The host owns the
local source directory and its retention; this port does not isolate a hostile
filesystem process or delete source files.

The envelope has exactly `payload` and a canonical-base64 Ed25519 `signature`.
The payload has exactly `version: "field-presence-source-1"`, `attestation`,
`payloadText` (at most 256 KiB UTF-8) and
`payloadCompleteness: "complete_unredacted"`. The signature covers UTF-8 bytes of
`"api-truth:field-presence-source-1\n" + canonicalJsonStringify(payload)`.
This signing purpose differs from the metadata reader's signing bytes. The public
key is supplied by the host; the file cannot select a key or extend the allowlist.

The signed attestation must match the complete expected pin, both parent UUIDs,
endpoint/direction/media/exact response status and configured source ID/version/
window. It additionally signs a well-formed source digest; the import store
compares that digest against the current authorized snapshot. Returned attestations
come from the signed file, never by echoing the read request. Only the selected
frozen attestation/body/completeness object is returned to the projector. Source
bodies, signatures and traffic-value hashes are not stored by this connector.

The host must control the signer and independently bind its captures to the
metadata parents, revision/environment and source window. A valid signature from
an untrusted or incorrectly configured collector does not establish that trust.
This is a bounded local signed-source adapter, not a live provider integration,
proof of collector isolation or reviewed request/response examples. Real-key
synthetic tests and PostgreSQL composition cover valid imports and signed-body
tampering without using external credentials.
