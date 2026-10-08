# Pinned Swagger runtime conformance

This isolated test package runs synthetic services against the actual legacy
framework. It is outside the workspace dependency graph; its dependencies are
not used by the analyzer, portal, or normal offline tests.

## Run locally

From the repository root, using Node 24.6.0 and npm 11.5.1:

```sh
npm ci
npm --prefix tests/conformance/swagger-runtime ci --ignore-scripts --no-audit --no-fund
npm --prefix tests/conformance/swagger-runtime rebuild node --foreground-scripts
npm run test:swagger:runtime
```

Installation needs the npm registry. General dependency lifecycle scripts are
disabled; only the pinned `node` package is rebuilt to install its platform
binary. After setup, scenarios use local modules and loopback HTTP only. The
harness never scans branches, loads enterprise handlers, reads logs, or calls
models. The default `npm run check` remains separate; CI runs conformance in
its own job.

## Tested versions

| Part | Pin |
|---|---|
| Analyzer/test driver | Node 24.6.0 |
| Legacy fixture runtime | Node 22.19.0 |
| swagger-express-mw | 0.7.0 |
| swagger-node-runner loaded by wrapper | 0.7.0 |
| Express | 4.13.3 |
| Runner's bagpipes | 0.1.2 |
| Runner's config | 1.31.0 |
| Runner's sway | 1.0.0 |

All framework dependencies have a separate checked-in npm lockfile. Tests
assert the versions actually resolved from the wrapper and runner, including
key transitive packages. The Node runtime package pins the platform binary's
version; each scenario verifies it. Local validation uses macOS arm64; CI adds
Linux validation. Other Node, framework, dependency, and platform combinations
are not certified by this fixture.

A negative test records that the unmodified pinned config stack fails on
Node 24 because its `util.isRegExp` dependency is absent. No compatibility shim
or dependency patch is used to hide that failure.

## Behavior checked

Fourteen tests cover the default controller directory and basePath; operation-level
override of a path controller; a configured directory; first-directory
precedence; fallback when a first controller throws during initialization;
missing modules and exports; explicit mock mode; an environment override to
mock mode; a source-declared mock override that suppresses the static candidate;
and the Node 24 incompatibility.

Each behavior scenario starts a fresh child process, constructs only known
synthetic files in a temporary directory, and binds an ephemeral port on
`127.0.0.1`. The scenario closes its server and removes its temporary service. The parent
also owns and removes a per-case temporary sandbox, including after child
failure or timeout.
Framework caches cannot carry across cases. Child environment input is bounded;
one scenario deliberately sets `swagger_mockMode` to exercise precedence.

The driver calls framework `create`/`register` directly; the synthetic `app.js`
is a source input for analysis, not a production startup proof.

The same synthetic tree is analyzed separately with Node 24. Analyzer assertions
check candidate paths and diagnostics, incomplete coverage, and the absence of
`handler.binding` without explicitly supplied signed observations. In particular, the runtime can choose the first of two
controllers while the analyzer conservatively reports ambiguity; environment
configuration can select a mock while the source candidate remains a normal
controller. Neither case is promoted to a verified binding.

## Remaining binding gates

This suite proves the listed behavior for this locked fixture. It does not
establish the deployed entrypoint, effective environment/configuration,
installed artifacts, arbitrary controller initialization, all transitive
semantics, or handler-derived contract authority for a scanned service.
Those gates remain in NB4. Future binding profiles must declare their tested
version/runtime range and reject or diagnose cases outside it.

Upstream semantics references: [wrapper entrypoint](https://github.com/apigee-127/swagger-express/blob/v0.7.0/lib/index.js),
[runner configuration and pipe selection](https://github.com/apigee-127/swagger-node-runner/blob/v0.7.0/index.js),
[controller router](https://github.com/apigee-127/swagger-node-runner/blob/v0.7.0/fittings/swagger_router.js).

A single controller that throws before exporting a valid handler returns a runtime failure;
the analyzer preserves its documented route and withholds the source candidate.

Working and throwing local helper imports validate the bounded source graph policy
against the pinned framework while preserving inferred candidate authority.

Two additional scenarios verify literal create-option `mockMode: true` and
`mockMode: false` overriding a static file setting of true (16 total tests).
These fixture results do not certify arbitrary application environments.

Two production-environment scenarios verify file selection for mockMode false
and true (18 total tests). They set the declared environment in a fresh isolated
process; npm startup execution and deployment environment are not certified.

A production directory-override scenario verifies that the environment
controllersDirs array replaces the default array (19 total tests).

Two router mock-mode scenarios verify environment-selected mock directories,
router/global OR behavior, and disabling default router mocks (21 total tests).


Five controlled-capture scenarios add actual normal dispatch, missing exports,
mock routing, stale handler source and first-directory precedence (26 total
tests including the Node 24 incompatibility). Only normal, fresh, explicitly
trusted captures emit `handler.binding` with verification `observed`. The signer
runs separately from the instrumented service; the private key is outside the
service tree. These synthetic receipts attest the fixture's tree and session,
not production startup or deployment. See the
[capture trust contract](../../../docs/SWAGGER_RUNTIME_BINDING.md).


Three additional signed-capture cases exercise handlers returning literal 201
with a documented 200, documented 201 and documented default (29 total tests).
The analyzer records an inferred source status declaration and reports only the
200/201 discrepancy, while preserving the original documented response list.
Observed runtime fixture responses validate this bounded syntax; they do not
promote the source declaration into a runtime response contract for other services.


Three more signed-capture cases exercise literal JSON response-body type matching,
a property-type discrepancy and a referenced document schema (32 total tests).
They assert inferred type-only body claims, exact discrepancy paths and unresolved
reference comparison. Documented endpoint schemas remain the API document's facts.


Three required-field cases exercise missing, present and null-valued literal
JSON fields under documented required lists (35 total tests). Only the missing
field case emits an inferred required-field discrepancy at `/name`. The source
body shape and documented contract keep their separate authority categories.


The existing local-reference fixture now compares successfully. Three additional
cases exercise referenced type and required-field discrepancies and a cyclic
schema (38 total tests). Assertions verify definition evidence dependencies for
resolved comparisons and withholding them for unresolved cycles. No referenced
schema is promoted to a runtime contract.


Three reusable-response cases exercise matching schemas, type differences and
missing required fields through a default response alias (41 total tests).
Assertions retain both response-chain and definition dependencies. The same fixtures also verify reusable catalog content and scalar header
declarations. Response-object dependency assertions select object pointers
separately from terminal field evidence. Header claims remain declared; the
fixture does not establish runtime header emission.


Three composed-response cases add matching types, a type discrepancy and a
missing required field through the default response (44 total tests). Each uses
local `allOf` definition references and verifies all three definition dependency
pointers. Comparisons remain source declarations under an observed handler
binding; no response schema is promoted to a runtime contract.


Four linear-response cases exercise a local literal body with matching types,
a type discrepancy, a missing documented field, and a separate status statement
(48 total tests). The analyzer still emits inferred body/status declarations;
actual dispatch verifies the fixture behavior without promoting the response
contract or persisting body values.


The existing binding and matching-status cases also assert explicit root anonymous
security and an operation anonymous override of inherited basic security. Both
remain declared despite an observed handler binding; other fixtures retain unknown
security. Total runtime cases remain 48. This is not an authentication-enforcement
test or proof of production access policy.


The existing body cases verify that document response-schema/media claims remain
declared alongside inferred handler bodies and observed binding. Reusable cases
assert terminal schema pointers; media evidence points to root `produces`.
Total runtime cases remain 48.
