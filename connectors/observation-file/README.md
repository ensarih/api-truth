# Signed observation file connector

`createSignedObservationFileReader` reads one explicitly selected `<UUIDv4 importId>.json` file from a trusted root. It never scans a directory, runs source code, or contacts a network service. The connector rejects symlinks, files above 1 MiB, malformed UTF-8 or strict JSON, duplicate decoded keys, excessive depth, and more than 100 records.

The file is an envelope with `payload` and a base64 Ed25519 `signature`. The signature covers the UTF-8 bytes of `canonicalJsonStringify(payload)`. The payload contains `importId`, the full `expectedPin`, per-batch `attestation`, and `records` with opaque UUIDv4 record IDs. The verifier uses only the externally configured Ed25519 public key; a key named inside the file grants no authority. Import ID, pin, revision, and configured source ID must match exactly. Route mappings come from trusted constructor configuration, never from the file.

The returned function matches the observation store's `readBatch` port. The signing key attests provenance only when the host controls the signer and binds the signed batch to the claimed source, revision, and observation window. It does not infer a deployed revision from log content. The observation store still performs its own authorization, serving-pin checks, sanitization, and safe persistence. Errors use fixed codes and do not echo file paths or log values.
