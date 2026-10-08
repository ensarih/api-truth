# Controlled Swagger runtime handler binding

Middleware profile `nodejs-swagger-express-mw@0.30.0` accepts an optional signed
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


## Optional source response-status inspection

After accepting a binding, middleware `0.20.0` checks a small CommonJS subset for
a literal returned response status. It records an inferred
`handler.response.status.declaration` and warns if that status is absent from
the document's response keys and no `default` response exists. This inspection
adds exact handler-source evidence and dependencies. It never changes the
endpoint's response contract or establishes actual HTTP response behavior.

Only one returned sendStatus/status-chain expression with literal payloads is
supported. Conditional branches, aliases, dynamic arguments, other statements,
external helpers and unsupported export forms report
`handler_response_status_unresolved`. Static candidates without accepted runtime
observations do not enter this inspection. The collector still captures binding
only; it does not capture response statuses or response data.


## Literal JSON response bodies

Middleware `0.21.0` additionally records the type-only shape of a returned literal
JSON argument as inferred source evidence. It omits values and field constraints.
The collector still captures only dispatch, not response bytes or body schemas.
Only the bounded direct `.json(literal)` form is supported; dynamic values and
unsupported literal constructs stay unresolved.

A separate bounded comparison checks explicit types in the selected exact-status
or default response schema. It records clear differences at matching field paths,
without asserting general compatibility. References/compositions remain unresolved;
requiredness, value constraints and extra fields are not compared. Observed
binding does not prove Express response-method integrity, serialization or an
actual body being sent. These declarations never replace the documented schema.


## Documented required fields

Middleware `0.22.0` separately compares literal object keys against documented
required lists. Missing fields yield inferred discrepancy claims naming paths
and warnings with source-body and document-schema evidence. Null-valued keys
count as present; empty arrays do not invent item omissions. No source required
constraints are inferred and no endpoint schema is changed. Malformed required
lists, unresolved references/compositions and comparison limits suppress partial
findings. As with type differences, these are declaration discrepancies, not
proof of response serialization or runtime validation.


## Local definition references

Middleware `0.23.0` resolves exact local `#/definitions/<escaped-name>` schema
references through properties/items before type and required-field comparisons.
It records definition provenance and endpoint dependencies while preserving the
original documented schema and source claim authority. Expansion is bounded;
cycles, missing definitions, siblings, unsupported pointers and external/file
references remain unresolved. Metadata references are not interpreted as schema
references. Compositions and response-object references remain unsupported by
this comparison profile, and no reference is fetched.


## Reusable response objects

Middleware `0.24.0` can select a local reusable `#/responses/<escaped-name>`
object for an exact or default status, follow bounded response aliases, and
compare its schema using the definition resolver. Concrete response and selector
provenance is retained alongside definition dependencies. Unsupported chains
remain unresolved. This does not expand the general document parser's catalog
responses and does not establish runtime serialization or validation.


## Catalog extraction of reusable responses

Middleware `0.25.0` and document profile `0.10.0` also expand resolved local
response aliases into endpoint content and scalar header declarations. Selector
and terminal field provenance remain separate; descriptions are status-scoped
claims. Unknown media types remain unknown. Cycles and other unsupported chains
keep the selector but withhold response details. Header extraction has a
128-declaration cap and rejects arrays, unsupported schemas, invalid or
case-conflicting names and Content-Type. These document facts do not prove that
the captured handler emits the declared headers or validates its response.


## Composed response comparisons

Middleware `0.26.0` follows local definition references inside `allOf` and checks
all branches and sibling type/required declarations against the literal source
body shape. It preserves the document composition and definition dependencies.
Compositions have 1–32 branches and share the bounded reference resolver's depth,
node and definition limits. Unsupported alternatives, cycles and malformed or
oversized compositions withhold partial findings. This is an inferred comparison
of declarations, not validation of captured response bodies.


## Local literals and separate status statements

Middleware `0.27.0` also accepts a final returned response call preceded only by
up to 16 single-name, inert literal `const` declarations and one direct literal
status assignment. `json(body)` can use such a local constant; body evidence
points to its initializer, while status evidence points to the status argument.
Aliases, mutation, calls, parameter shadowing, multiple statuses and control flow
stay unresolved. All literal parsing shares the existing depth and node limits.
This extends the initial single-return subset without changing binding trust or
promoting source response declarations to runtime or normative contract facts.


## Security declaration authority

Middleware `0.28.0` records explicit root/operation anonymous declarations and
referenced scheme provenance as declared source facts with endpoint dependencies.
Unknown or unsupported declarations remain unknown. Even when a signed capture
proves handler binding, it does not prove that authentication is enforced or that
an anonymous operation is actually public. Security evidence and strict OpenAPI
qualification are unchanged.


## Response declaration provenance

Middleware `0.29.0` retains document schema and selected media declarations as
status-scoped claims, separately from inferred handler body shapes and observed
binding. Schema evidence points to its inline or reusable declaration; media
evidence points to operation/root `produces`. Unknown media keeps schema facts
and definition dependencies but cannot create response content or media claims.
No document response fact is promoted by accepting a signed handler capture.


## Response selection and missing schema

Middleware `0.30.0` selects exact Swagger 2 status before default, never falling
back from a present but unresolved exact response. Ranges are not accepted by
this Swagger 2 profile. A concrete selected response with no schema and a bound
literal JSON source body yields an inferred schema-missing finding with exact
response/alias provenance. It records whether examples are present; examples
are not interpreted. This is not an assertion that the whole body is undocumented
or proof of runtime response behavior. Invalid responses/schemas remain unresolved.
