# Controlled Swagger runtime handler binding

Middleware profile `nodejs-swagger-express-mw@0.19.0` accepts an optional signed
runtime observation. It emits `handler.binding` with verification `observed`
for matching operations actually dispatched to a normal handler in that capture.
The claim is scoped to the named environment, session, timestamp and runtime
fingerprint. It does not prove current deployment availability, future dispatch,
all routes, request validation or handler-derived contract fields. Unobserved
operations keep their existing source candidates and limitations.

## Trust contract

The Ed25519 public key is an **external trust anchor** selected by the analyzer
caller or protected CI policy. Never take the trust key from an untrusted checkout
or let a pull request replace it. A signature proves the signer's approval of the
payload; it does not independently prove its origin or the collector's integrity.

A trusted capture producer must run a controlled, immutable service tree, compute
its canonical analyzer `source_digest`, verify the actual build revision and
service identity, and derive or validate the environment label. These labels are
supplied to the collector, not independently discovered by it. The producer must
verify the tree remains unchanged throughout capture and sign only output from
that controlled process. The signing CLI validates structure and signs bytes;
it is not a build attestation service and does not perform these policy checks.
Do not accept arbitrary uploaded JSON for automatic signing. This protocol does
not isolate instrumentation from hostile service code.

Keep private signing keys outside the service process and checkout. The collector
needs no key. Transfer its unsigned output to a trusted signing step outside the
service process. Store unsigned output outside the analyzed service tree.

## Supported capture

The collector currently supports Node **22.19.0** and the exact pinned
`swagger-node-runner@0.7.0` controller-router bytes used by the conformance
fixture. See [runtime conformance](../tests/conformance/swagger-runtime/README.md)
for the complete tested dependency set. Analyzer and signing tools use Node
**24.6.0**. Other framework/runtime combinations require their own profile.

Install before loading the framework or controller modules. The opt-in collector
wraps CommonJS compilation, module loading and controller function dispatch.
It observes own data function exports invoked by the pinned router; it skips
mock routing and missing/nonfunction/accessor exports. Previously cached handlers
cannot establish a compiled-source observation. The instrumentation changes
module/function identity and is intended for a controlled test environment.
Always restore the hooks after the capture.

```js
const {installSwaggerRuntimeBindingCapture} = require(
  '@api-truth/analyzer-nodejs-swagger2-document/runtime-binding-capture'
);
const capture = installSwaggerRuntimeBindingCapture({
  serviceRoot: '/controlled/service',
  repository_id: 'local', service_id: 'orders',
  immutable_revision: verifiedBuildRevision,
  source_digest: verifiedAnalyzerSourceDigest,
  environment: 'test', session_id: 'capture-001'
});
try {
  // Start the service and exercise known operations using controlled requests.
  // Send capture.receipt() to the trusted signing step; never pass a private key here.
} finally {
  capture.stop();
}
```

The canonical digest can be obtained from a baseline middleware analysis (`result.source.source_digest`) of that
same tree before placing the signed receipt in it. The producer must attest that
this tree is the one executing. Compilation hashes of observed handlers are
checked separately by the offline verifier. Requests and responses, headers,
credentials and configuration values are not stored in receipts. Configuration
and module context contribute hashes only; controller/export names, application
paths and service-relative handler paths are included intentionally.

## Sign and analyze

After the producer validates provenance, run these commands from this repository
with Node 24.6.0. Replace paths and the revision with your verified values.

```sh
node scripts/sign-runtime-binding.mjs \
  --capture /trusted/capture-001.json \
  --private-key /trusted/signing-private.pem \
  --output /controlled/service/api-truth.runtime-binding.json

npm run extract:swagger2-middleware -- \
  --source /controlled/service --service orders --revision VERIFIED_COMMIT \
  --binding-receipt api-truth.runtime-binding.json \
  --binding-public-key /trusted/signing-public.pem
```

The CLI uses repository identity `local`; programmatic analyzer callers provide
their own repository/service identities. Both identities must match the receipt.
Programmatic callers supply `trustedRuntimePublicKey` to `createAnalyzer` and add
an explicit third resolution input of kind `runtime_observation` with the fixed
receipt path and SHA-256 digest. Middleware requires IR 1.1.0.

Only the explicitly selected `api-truth.runtime-binding.json` is excluded from
the canonical source-tree digest, avoiding a self-reference. Its own digest and
the trust key participate in the reproducibility fingerprint. Reserve this file
for generated capture metadata. Changing the receipt, key or source invalidates
analysis. Missing trust configuration or a mismatched receipt input digest rejects
the request. Invalid signatures, source/revision mismatches or stale handler bytes
preserve endpoints, withhold binding and report an unresolved receipt.

## Receipt format and limits

The file contains exactly `payload` (base64 JSON bytes) and `signature` (base64
Ed25519 signature over those bytes). Payload version `1.0.0` includes source
identity, environment/session/time, pinned node/router identity, a runtime
fingerprint and operation bindings. Each binding names method, composed
application path, controller, operation/export, handler path/hash and
`mock_mode: false`. It must match the API document and analyzed handler bytes.

The verifier rejects extra fields, duplicate operations, malformed signatures,
unsupported versions, path traversal and invalid timestamps. Receipt size is at
most 1 MB, key size 10 KB and binding count 1,024. Capture bounds compiled modules,
contexts and runtime-module hashing. Exceeding limits or observing conflicting
handlers prevents receipt issuance. Source analysis retains its existing limits.
A valid receipt can establish only its listed operations; it never converts
partial service coverage into complete coverage or makes OpenAPI facts normative.

## Validation

Unit tests cover signatures, trust-key changes, stale source/revisions, payload
constraints, deterministic fingerprints and handler/receipt dependencies.
Fresh-process runtime cases cover actual dispatch, missing exports, mocks,
stale source and first-directory precedence. The fixture driver invokes the
framework directly; it does not certify a production application's entrypoint.
