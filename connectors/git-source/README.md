# Local Git source connector

`@api-truth/connector-git-source@0.7.0` reads one explicit local repository,
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
standalone Swagger 2, or standalone OpenAPI 3.0. Runtime observations are
rejected. Standalone document profiles require an explicit IR 1.1 selection
and exactly one owner-configured, contained `type_manifest`; their request has
that manifest only, with no `source_tree`, entrypoint, or extra inputs. The
source and manifest digest both use the selected project-relative path, a NUL
separator, and the exact UTF-8 document bytes. Those profiles describe
declarations only and do not establish application route binding. Configured
routing-controller manifests and the middleware's exact default Swagger
document retain their adapter-specific digest formats.

The adapter asks the compiled analyzer host to measure the selected source
projection, then returns a normalized request containing those measured
digests. Adapter analysis may therefore run once during resolution and again
when orchestration submits the exact request. The deterministic request ID
fingerprints the tenant, repository, service, commit and optional base,
configuration fingerprint, selected analyzer, and a frozen copy of the limits.
The analyzer port accepts that exact canonical request once; changed fields,
substituted requests, and duplicate active request IDs are rejected. The host
is bound to the disposable materialization, which is removed after analysis,
rejected substitution, or `dispose()`. Cleanup failures remain recorded for a
later `dispose()` retry and are surfaced as a fixed safe error.

Changed paths are intentionally reported as incomplete and empty. Requests use
baseline mode without a base revision and full-service fallback mode with one;
the adapter does not infer changes or authorize incremental reuse. Active
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
