# Testing and Local Validation

**Status:** offline TypeScript harness implemented; database, Java, integration, and end-to-end harnesses pending.
**Date:** 2026-09-16
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

The initial workspace was validated on Node.js 24.6.0 and npm 11.5.1. TypeScript 5.9.3 supports Node 14.17 and later; Vitest 5.0.1 declares support for Node 24. The Docker engine was not reachable during the earlier readiness check; D04a does not require or start it.

No database, application server, API key, integration environment, or Java analyzer is required by the implemented offline checks.

## 3. Suite boundaries

| Suite | What it validates | Dependencies |
|---|---|---|
| Unit | Function outputs, failure behavior, state transitions, pure schema/identity logic | Native runtime; no network or Docker |
| Contract | IR/event schemas, plugin output, actual semantic-adapter request/response normalization | Synthetic fixtures and mocked provider transports; no API keys |
| Integration | Persistence, jobs, migrations, publication, access filtering | Isolated local PostgreSQL plus real implemented components |
| End-to-end | CLI/event → catalog → OpenAPI/portal/MCP lifecycle | Local application and fixture services, as implemented |
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

The commands marked available are runnable now:

| Command | Intended behavior |
|---|---|
| `npm test` | **Available:** offline unit and contract suites; no external API calls |
| `npm run test:unit -- <file>` | **Available:** focus the unit project; missing selections fail |
| `npm run test:watch` | **Available:** rerun relevant offline tests during development |
| `npm run test:contract` | **Available:** validate reviewed fixture integrity through the D02 checker |
| `npm run test:coverage` | **Available:** report coverage for implemented source behavior; there is no product source yet |
| `npm run check` | **Available:** strict type checks and all offline suites used by CI |

Introduce suite commands only when they exist; an advertised suite with no tests must fail clearly. The first D04a scaffold provides unit/contract execution only. Database readiness arrives in D04b. Integration, end-to-end, environment-control, and Java commands are added alongside actual components rather than populated with empty success tests.

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
- In D04b, start the isolated database, verify readiness/connectivity and test isolation, and stop it without touching unrelated resources. If Docker remains unavailable, report that gate as incomplete.
- Document all commands that actually exist and record fresh results. Application-level scenarios remain pending until their components are implemented.
- Keep the same offline checks available in CI; add container-backed jobs as integration suites are introduced.

The offline D04a scaffold is implemented. Database and Java portions remain pending D04b; application-level checks remain pending their implementations.
