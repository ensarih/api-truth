# Testing and Local Validation

**Status:** Offline TypeScript, protocol, isolated PostgreSQL, and browser suites cover bounded source/document analyzers, D08/D09 persistence, D10 publication, authorized portal/MCP reads, metadata-only observations, explicit keyword operation search, and selected-operation semantic service boundaries. The full provider-to-pilot lifecycle and Java execution remain open.
**Date:** 2026-10-09
**Related:** [specification](SPECIFICATION.md), [implementation plan](../PROJECT%20PLAN.md), [roadmap](ROADMAP.md).

## 1. Purpose

Develop API Truth through test-driven development and validate its functions on the developer's machine. Use ordinary automated tests with deterministic assertions. OpenAI, Gemini, and Claude are application providers for semantic API understanding; they are not test runners, code checkers, or test judges.

The harness must be in place before functional implementation. As each component is added, its tests join the relevant suite. Do not represent an empty suite as verification of functionality that does not exist yet.

## 2. Environment choices

| Approach | Trade-off |
|---|---|
| **Native TypeScript tests + Docker PostgreSQL — recommended** | Fast focused tests without Docker; real isolated database behavior for integration tests |
| Everything in containers | More uniform tooling, but Docker is required even for a single function test and edit/watch setup is heavier |
| Native tests + locally installed PostgreSQL | Avoids Docker, but requires careful local database setup and stronger protection against touching unrelated data |

Choose the first approach for implementation. The offline workspace pins Node.js 24.6.0, npm 11.5.1, TypeScript 5.9.3, Vitest 5.0.1, and the matching V8 coverage provider 5.0.1. Vitest projects separate the current unit and contract suites; Java-native tests join through the Java build wrapper when the Java analyzer is implemented. [Vitest test projects](https://vitest.dev/guide/projects).

### Machine observations

The workspace was validated on Node.js 24.6.0, npm 11.5.1, Docker Engine 29.3.1, and Docker Compose 5.1.1. The D04b PostgreSQL image is pinned by tag and multi-architecture digest to `postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af`.

The machine's discovered system Java executable is an incompatible legacy binary (`Bad CPU type in executable`). Phase 1 checks do not invoke Java. The Phase 2 Java analyzer will use a pinned JDK and build wrapper and must pass the shared analyzer protocol conformance suite.

No database, application server, API key, integration environment, or Java analyzer is required by the offline `npm run check` command.

## 3. Suite boundaries

| Suite | What it validates | Dependencies |
|---|---|---|
| Unit | Function outputs, failure behavior, state transitions, pure schema/identity logic | Native runtime; no network or Docker |
| Contract | IR/event schemas, plugin output, and linked MCP client/server tool behavior | Synthetic fixtures and local protocol transport; no API keys |
| Integration | PostgreSQL connectivity/isolation; D06 snapshots/access; D08 events/jobs/reconciliation and selected local Git source materialization; D09 serving lifecycle; D10 publication/revocation/round trip; D11 portal/MCP/export pins; D12 metadata imports and current-pin reads; P4 semantic authorization, explicit-environment corpus search and portal/MCP corpus inference composition | Isolated local PostgreSQL plus real implemented components |
| End-to-end | Explicit local source/document profile → D08 analyzer host → catalog/serving state → OpenAPI/portal/MCP reads; combined Phase 1 scenario | Local application and synthetic fixtures; live provider, protected pilot, and complete Phase 1 scenario remain open |
| Java | Java extractor behavior and common plugin conformance | Pinned JDK/build wrapper when the Java adapter is added |

Do not mock the function under test. Mock only external boundaries when needed, such as model API transports; assert the actual adapter result or failure. Database tests exercise real database transactions rather than in-memory substitutes.

## 4. TDD workflow

For each new behavior or bug fix:

1. Select the requirement and observable behavior. Identify what production change would make the test fail.
2. Write the smallest focused test for that behavior, including boundary/error cases as separate tests when needed.
3. Run it and observe the intended failure. A setup error or missing dependency is not evidence that the behavior is tested.
4. Implement the minimum behavior needed to pass.
5. Rerun the focused test and relevant existing suite.
6. Refactor while keeping those tests green.
7. Record the commands and red/green evidence in the development task or PR.

Every function with product behavior must be covered directly or through its public caller. Avoid tests that duplicate implementation or only assert that a mock was called. Coverage reports help identify omissions; they are not correctness proofs and should exclude generated files and external dependencies.

## 5. Local database isolation

- Define a dedicated Compose test project and test-only PostgreSQL service with loopback-only published access.
- Use a pinned image, explicit readiness checks, and disposable test storage. Do not mount enterprise data or developer database directories.
- Allocate independent test schemas/databases per run or worker so parallel tests cannot share mutable state accidentally.
- Keep test connection settings separate from application/enterprise configuration. Reject reset operations outside the known local test project and designated test database namespace.
- Setup must report an unreachable Docker engine or database as a dependency failure. Explicitly requested integration suites must not silently skip to green.
- Teardown/reset targets only resources created for this test project. No broad container, volume, or database pruning.

The test environment is local to this project and has no relationship to the enterprise environments named UAT, staging, or production.

## 6. Intended developer commands

The commands marked available are runnable now. Environment commands always target the fixed `api-truth-test` Compose project and `127.0.0.1:55432`; they do not accept a database URL or reset target.

| Command | Intended behavior |
|---|---|
| `npm test` | **Available:** offline unit and contract suites; no external API calls |
| `npm run test:unit -- <file>` | **Available:** focus the unit project; missing selections fail |
| `npm run test:watch` | **Available:** rerun relevant offline tests during development |
| `npm run test:contract` | **Available:** validate reviewed fixture integrity and linked read-only MCP protocol behavior |
| `npm run test:browser` | **Available:** require an installed Chrome/Chromium executable and exercise portal search, contract selection, detail, download, unknown state, keyword candidates, and exact pinned cross-service loading in a real browser; no silent skip. CI installs locked dependencies and Playwright Chromium, then runs this suite. |
| `npm run test:extractor` | **Available:** run the TypeScript/Express analyzer unit and CLI contract suite |
| `npm run inventory:nodejs -- --project-root <root> --service-root <path> --entrypoint <path>` | **Available:** print an advisory bounded inventory for an explicit service root and production entrypoint; use `--document <path>` for an explicitly selected API document. It executes no source and selects no analyzer automatically. |
| `npm run --silent extract:openapi3 -- --source <service-tree> --service <id> --revision <immutable-hex-revision> --document <contained-path>` | **Available:** run the bounded OpenAPI 3.0 document-only profile on one selected document; it does not verify runtime registration. |
| `npm run test:updates` | **Available:** run the D07 planner, difference, execution, contract, and local CLI suites without Docker or provider credentials |
| `npm run test:environment` | **Available:** run D09 pure environment-resolution and serving-order scenarios without Docker or provider credentials |
| `npm run test:environment:integration` | **Available:** require the fixed PostgreSQL service, then test D09 immutable attempts, artifact bindings, ordered serving checkpoints, replay, authority, and conflicts |
| `npm run test:orchestration` | **Available:** require the fixed PostgreSQL test service, then run the focused D08 event, worker, analysis, PR, reconciliation, and configuration lifecycle suites |
| `npm run openapi:roundtrip` | **Available:** publish a synthetic strict OpenAPI contract in an isolated local PostgreSQL schema; verify replay, stale-pointer rejection, recovery, and historical read |
| `npm run --silent extract -- --source fixtures/typescript/orders/baseline/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | **Available:** emit a validated fixture `AnalyzerResult` as stdout JSON and diagnostics on stderr |
| `npm run --silent changes -- --base-source fixtures/typescript/orders/baseline/src --changed-source fixtures/typescript/orders/changed/src --service orders --base-revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --changed-revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` | **Available:** compare two source trees and emit one safe validated `ContractChangesOutput` document |
| `npm run --silent catalog:roundtrip -- --input <file> --tenant <id> --principal <id> --branch <configured-branch>` | **Available:** use only the fixed local test database, create/migrate/drop one random schema, seed synthetic policy, ingest/promote/read, and emit a safe JSON-only summary |
| `npm run test:coverage` | **Available:** report coverage for implemented source behavior |
| `npm run check` | **Available:** strict type checks and all offline suites used by CI |
| `npm run test:env:up` | **Available:** start the pinned disposable PostgreSQL service and wait up to 60 seconds for health |
| `npm run test:env:ready` | **Available:** verify Docker, `pg_isready`, and a real SQL query |
| `npm run test:presence` | **Available:** require the existing fixed PostgreSQL service and validate owner approval, metadata/body imports, exact-pin value-free queries, revocation and retention cleanup through public factories in isolated schemas; synthetic-only source facts, no provider credentials |
| `npm run test:integration` | **Available:** require the running fixed database, then run real isolation and rollback tests with up to two workers |
| `npm run test:env:down` | **Available:** remove only the fixed Compose project's containers, network, and volumes |

The integration suite fails nonzero with a distinct dependency message when Docker or PostgreSQL is unavailable. Its schemas use a random `api_truth_test_` prefix per run/worker and its `finally` cleanup drops only those schemas. The Compose service publishes only on loopback, stores PostgreSQL data on a 2 GiB tmpfs, and uses synthetic test-only credentials. Run `test:env:down` between repeated complete suites to reset this disposable storage. The catalog and OpenAPI round-trip commands accept no database target or reset option. D08 uses the v0.1 `intended_branches` array as the exact per-service scan allowlist; empty means scan none. Query/portal/MCP tests now run in the existing suites; standalone authenticated host and Java analyzer commands will be added with their implementations rather than as empty successful placeholders.

### D05-to-D06 developer round-trip

```sh
npm run test:env:up
npm run test:env:ready
result_file="$(mktemp -t api-truth-analyzer-result).json"
npm run --silent extract -- --source fixtures/typescript/orders/baseline/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$result_file"
npm run --silent catalog:roundtrip -- --input "$result_file" --tenant local-demo --principal local-developer --branch main
rm "$result_file"
npm run test:env:down
```

The extractor reads the synthetic baseline at an immutable revision. The
round-trip validates D03 input before connecting, then migrates an isolated
schema, uses the trusted control-plane API to create synthetic scope/grant
state, ingests the snapshot, promotes the selected branch, performs authorized
reads, reparses the returned D03 snapshot, and drops the schema in `finally`.
Its complete stdout contains only snapshot ID, branch, pointer version, and
`round_trip_valid`. Npm's silent mode suppresses the lifecycle banner and keeps
the input path, tenant, and principal out of stdout.

### D08 local event-to-catalog round-trip

```sh
npm run test:env:up
npm run test:orchestration
npm run test:env:down
```

This focused integration suite drives synthetic authenticated events through
PostgreSQL scheduling, worker leases, the TypeScript analyzer, immutable D06
snapshots, and guarded branch promotion. It also checks PR previews against
their declared base, exact branch/PR reconciliation, duplicate scheduler
requests, confirmed branch absence, and configuration-change races. This is
an executable test workflow, not a deployed CI connector or API portal.

### D07 source-revision comparison

Use a disposable file when inspecting the complete D02 comparison:

```sh
changes_file="$(mktemp -t api-truth-contract-changes).json"
npm run --silent changes -- \
  --base-source fixtures/typescript/orders/baseline/src \
  --changed-source fixtures/typescript/orders/changed/src \
  --service orders \
  --base-revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --changed-revision bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  > "$changes_file"
node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({plan:value.plan,difference_count:value.differences.differences.length},null,2))' "$changes_file"
rm "$changes_file"
```

The command reads both source trees through the D05 boundary, computes the
changed-path union from names and bytes, and runs only local deterministic
analysis. Successful stdout has no banner and excludes source roots, changed
paths, digests, fingerprints, evidence, source values/locations, and raw
analyzer results. D07 does not require PostgreSQL, API keys, provider
credentials, network access, logs, models, or source execution.

## 7. Semantic provider contract tests

OpenAI, Gemini, and Claude adapters implement the same application-level analysis contract. Each adapter's fixtures cover:

- Correct mapping of context, evidence references, output schema, and configured model.
- Successful normalization and local validation of structured analysis results.
- Invalid JSON/schema, unknown field references, and unsupported capabilities.
- Provider refusal, incomplete/truncated output, authentication errors, rate limiting, and timeouts.
- Cancellation/retry limits and no unconfigured cross-provider fallback.
- Provider/model identity in results and cache fingerprints; secret values excluded from logs.

These are deterministic tests of software behavior against synthetic transport responses. No live model calls are required for routine validation. Semantic usefulness is evaluated separately with curated API-intent questions and human-established expected outcomes; a model's opinion is not the software-test oracle.

## 8. Requirement scenarios

Maintain a requirement-to-test index as implementation proceeds. Initial high-value cases include:

| Specification scenario | Test behavior |
|---|---|
| A03 | Shared-validator change invalidates every affected endpoint |
| A04–A06 | Branch changes do not imply deployment; confirmed serving evidence determines rollback state |
| A07, A20 | Duplicate/out-of-order/missed events preserve or recover the correct view |
| A19, A22 | Incomplete or unrepresentable exports fail strict mode without inventing contract facts |
| A21 | Failed partial rollout retains mixed/unknown serving state until reconciled |
| A23 | Editorial approval alone cannot promote a normative constraint |
| A24 | Test-first local development does not require API credentials |
| A25 | All three semantic providers obey the common result/error boundary |

## 9. Scaffold acceptance gate

- Document the supported runtime and exact dependency versions; install reproducibly through a lockfile.
- Run a focused sample through the test runner and demonstrate that an intentional failing assertion returns nonzero, then verify the passing run. This checks the harness, not unimplemented product functions.
- Confirm test selection and watch configuration; default tests make no external requests and require no provider keys.
- Start the isolated database, verify readiness/connectivity and test isolation, and stop it without touching unrelated resources.
- Document all commands that actually exist and record fresh results. Application-level scenarios remain pending until their components are implemented.
- Keep offline, browser, and container-backed checks available in CI as their suites are introduced.

The current tree also contains bounded Swagger 2/OpenAPI 3.0 document and middleware profiles, a routing-controllers declaration profile, a Node.js onboarding inventory, selected Git-to-D08 source/document materialization, metadata-only current-environment observations, and keyword/semantic search surfaces. These profiles do not establish deployed startup or general framework support. Query keyword search makes no model call; semantic suggestions require an explicit user action and a configured provider, and remain inferred/unreviewed. Live Git/provider wiring, OpenAPI 3.1 analyzer input, broader framework conformance, Java executable conformance, durable semantic review, and the protected D13 pilot remain open. The Java process boundary is documented in `analyzers/PLUGIN_API.md`; Java executable conformance is pending. Exact commands and construct-level support are documented in the relevant analyzer and package READMEs.


## Pinned Swagger framework behavior

The isolated [Swagger runtime conformance package](../tests/conformance/swagger-runtime/README.md)
exercises real framework routing with synthetic services and compares the
analyzer's conservative candidate results. Setup installs its own locked
framework dependencies and Node 22.19.0 fixture binary; the analyzer and normal
checks keep Node 24.6.0. Run `npm run test:swagger:runtime` after the documented
setup. This is a separate local and CI suite, not part of `npm run check`.
No scanned service code is executed by extraction.

## Java AST and durable worker checks

Prepare the project-local prerequisites explicitly while online:

```sh
npm run java:env:up
npm run java:parser:up
npm run test:java
npm run test:env:up
npm run test:java:integration
```

Java tests have separate configurations so the default offline suite requires no installed JDK. Missing or invalid prerequisites fail the Java gates; they are not skipped. Extraction reads synthetic Java syntax using the fixed AST helper and never builds or runs the analyzed service. The CI Java job installs the pinned prerequisites, checks AST containment and uncertainty, and exercises actual Git revisions through the PostgreSQL worker. macOS arm64 is checked locally; the other installation targets require their own actual execution evidence.

The opt-in `extract:openapi31` CLI targets the separate bounded OpenAPI 3.1.0/3.1.1 document profile. Its unit/CLI tests run in the ordinary offline gate; the Git document worker suite covers its actual PostgreSQL baseline, update and rejected malformed/deleted document revisions.

The dedicated `test:java` gate also exercises actual AST declarations through catalog conversion, keyword matching and semantic source projection, including selector/body egress canaries and mismatched evidence/profile cases. It uses deterministic provider stubs; no model API is called.


## CI PostgreSQL image source

CI starts the isolated PostgreSQL service with both `deploy/compose.test.yml`
and `deploy/compose.test.ci.yml`. The override uses the public
[Docker Official Images repository on AWS ECR Public](https://gallery.ecr.aws/docker/library/postgres)
at the exact same PostgreSQL 18.6-bookworm OCI index digest as the local image.
Only the registry reference changes. The fixed project, synthetic credentials,
loopback port, temporary storage and health checks remain in the base file;
normal readiness and teardown commands operate on that same project.

This avoids the Docker Hub unauthenticated pull quota that prevented CI
PostgreSQL and Java integration jobs from starting. Local startup still uses
the base Compose file. Registry availability remains a CI prerequisite;
an image pull failure does not count as passing integration tests.


### Semantic question conformance

`npx vitest run tests/unit/semantic-question-corpus.test.ts` checks 35 curated
synthetic questions plus boundary assertions using actual analyzer-produced
snapshots. The fixture pins keyword route ranks and representative scores and
supplies deterministic provider outcomes for protocol/citation checks. Similar
entity names with different actions, mixed intent, ambiguity, incomplete context,
closed-scope no-match and wrong-environment candidates are covered. Every curated
case executes a discovery outcome. These checks are not a live model accuracy
benchmark or evidence that an inference understands business behavior.


### Protected document-load boundary

`tests/unit/protected-document-load.test.ts` exercises scope, signature/purpose,
key and independent expected-observation matching, authorization revocation,
configuration/artifact limits, inert hostile objects, cancellation and late
results. These are deterministic offline checks. The separate
`document-load-protected` case in `npm run test:swagger:runtime` verifies a real
controlled load in the pinned framework with a separate verifier process and
Git-derived source bytes. It requires the existing explicit fixture prerequisites
and makes no deployment or normative-contract claim.


`tests/unit/protected-swagger-loaded-document.test.ts` checks the concrete
composition against committed synthetic Git services and separately signed
captures. Exact scope/session/document/handler mismatches, revocation, unstable
external evidence and incomplete/ambiguous matches must withhold a result.
`protected-document-correspondence.test.ts` additionally distinguishes raw BOM/CRLF
bytes from the canonical parsed value and preserves the pinned session/handlers.
The pinned runtime case exercises both signatures from one actual request.
