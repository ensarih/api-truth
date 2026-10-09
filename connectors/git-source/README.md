# Local Git source connector

`@api-truth/connector-git-source@0.11.0` reads one explicit local repository,
one immutable 40-character commit ID, and one normalized service-tree path. It
reads the committed tree and blobs directly; working-tree edits, staged changes,
untracked files, ignored files, branch names, and remote refs do not select
source content.

The reader invokes fixed Git plumbing commands with argument arrays, no shell,
network prompts, lazy fetching, replacement refs, or checkout. Every Git
transport protocol is denied even if repository-local configuration enables
one. It does not run hooks, filters, build steps, project code, or package managers. Symlinks,
submodules, unsafe paths, non-UTF-8 paths or blob contents, unsupported modes,
invalid commits, and file/byte/timeout limit violations fail with one generic
error. Executable mode bits are preserved on extracted files; files are never
executed.

Successful materialization returns a temporary project root, the contained
service path, per-file digests and modes, a deterministic `tree_digest`, and an
idempotent asynchronous `dispose()` function. A failed operation removes its
temporary tree.

`tree_digest` identifies this connector's path/mode/blob inventory. It is not an
analyzer `source_digest`; analyzer source projections and configured manifests
must be measured separately by the host. Opaque binary assets are preserved,
while UTF-8 is required for TypeScript, JavaScript, JSON, and YAML source files.
`.git` path components are rejected case-insensitively.

`readConfiguredBranches(repoPath, names)` probes only the exact caller-provided
branch allowlist and returns each selected ref's commit or `null` if missing.
It never lists branches. This is a trusted local source reader only; it does
not implement remote provider lookup, branch policy, resolver integration, or
end-to-end provider event verification.

## D08 local analysis ports

`createLocalGitAnalysisPorts({ repositories, limits })` adapts the materializer
to orchestration's `AnalysisWorkerPorts` contract. The caller supplies an
explicit `(tenantId, repositoryId) → absolute local repository path` allowlist;
the configured repository locator is never interpreted as a filesystem path.
Resolve accepts only a full immutable commit ID and a source profile compiled
into the analyzer host: Express, routing-controllers, swagger-express-mw,
standalone Swagger 2, OpenAPI 3.0, or OpenAPI 3.1. Runtime observations are
rejected. Standalone document profiles require an explicit IR 1.1 selection
and exactly one owner-configured, contained `type_manifest`; their request has
that manifest only, with no `source_tree`, entrypoint, or extra inputs. The
source and manifest digest both use the selected project-relative path, a NUL
separator, and the exact UTF-8 document bytes. Those profiles describe
declarations only and do not establish application route binding. Configured
routing-controller manifests and the middleware's exact default Swagger
document retain their adapter-specific digest formats.

Standalone document resolution reads and hashes the selected committed bytes
directly, without a preliminary analyzer call. Source profiles still ask the
compiled analyzer host to measure their selected projection; those profiles
may run once during resolution and again for the exact submitted request. The deterministic request ID
fingerprints the tenant, repository, service, commit and optional base,
configuration fingerprint, selected analyzer, and a frozen copy of the limits.
The analyzer port accepts that exact canonical request once; changed fields,
substituted requests, and duplicate active request IDs are rejected. The host
is bound to the disposable materialization, which is removed after analysis,
rejected substitution, exact-request `resolver.release(request)`, or `dispose()`.
Release is idempotent for the most recent 1,024 completed request identities;
substituted requests are rejected. Failed cleanup remains retryable for the
exact request or through `dispose()` and surfaces a fixed safe error. D08
releases the session before its final authority check and durable completion;
a cleanup failure prevents snapshot and branch promotion.

For standalone documents, an explicitly selected base commit is materialized
and its contained document is parsed and hashed within the same bounds. Equal
bytes produce a complete empty selected-document delta; different bytes name
the selected path. Missing or malformed base documents leave the delta
incomplete. This proof covers only the selected document. Source profiles
still report incomplete empty deltas. Requests use baseline mode without a
base revision and full-service fallback with one. All three document profiles
still require full analysis because their runtime binding and coverage are
unverified; this delta does not authorize snapshot reuse or absence claims. Active
materializations are capped (eight sessions by default, with a lower cap
configurable), and all reads remain offline and non-executing. This provides a
local source-to-analyzer bridge, not remote-provider acquisition, branch
selection, or proof of deployment/runtime behavior.

The exact `java-spring-mvc@0.1.0` profile accepts one source tree and no classpath, manifest or startup options. Its AST toolchain must be prepared explicitly in the host project before immutable Git sessions are analyzed. The source checkout cannot select a compiler or dependency runtime.

## External runtime capture pin boundary

`createRuntimeCapturePinResolver` is a separate, optional boundary for an
externally protected Node runtime receipt. The trusted host supplies an exact
tenant/repository/service/revision/source-digest/environment binding, policy
version, opaque receipt and key references, and the expected SHA-256 hashes of
the receipt and Ed25519 public key's SPKI bytes. It must authorize the scope
before the protected receipt and key readers are called, then reauthorize
after verification before returning a pin. These readers must resolve
host-managed artifacts; repository paths, committed receipt/key files, and
references from the receipt or caller are never accepted as authority. The
resolver enforces one total deadline (10 seconds by default, configurable up
to 30 seconds) and passes an abort signal to each trusted port. Ports must
honor the signal and enforce their own underlying I/O deadline: a promise
race cannot cancel an uncooperative read.

The resolver checks bounded strict JSON, the receipt signature and format,
the configured signer, the exact signed repository/service/revision/source
digest/environment, and the independent host hashes. It returns only receipt
and signer hashes, opaque references, context, and an identity hash. Tenant and
policy are **host-bound**, not fields signed by the existing receipt format.
The result is `pinned_envelope`: it does not verify handler source bytes,
deployment, capture-process identity, or observed route behavior. Runtime
observations remain rejected by the D08 local analysis ports until a separate
authorized job/checkpoint association and full verification gate exists.


## Protected capture handler-byte verification

The `./protected-capture-verification` subpath exports
`createProtectedCaptureVerificationPort`. A trusted host fixes the repository
path, service root, immutable source/environment scope and expected external
capture identity. The port authorizes before work, pins and rereads protected
receipt/key bytes, materializes only committed Git blobs, verifies the middleware
source digest and receipt-listed handler hashes, and rechecks pin/authorization
before delivery. A committed reserved receipt is rejected. Service code is never
executed; disposable source trees are cleaned on success and failure.

The returned `verified_handler_bytes` describes matches for receipt-listed files.
Document-operation correspondence, deployment and future dispatch remain
unverified. This standalone port creates no IR, jobs, snapshots or serving
pointers; D08 runtime inputs remain rejected. Concurrency defaults to two sessions
and can be bounded between one and eight by the trusted host. Callback ports must
honor AbortSignal and enforce their own underlying I/O deadlines. The configured
`timeoutMs` is checked across verification phases, but Git materialization is
awaited under its own 120-second bound so a late disposable tree cannot leak;
it is not an exact end-to-end wall-clock bound.
