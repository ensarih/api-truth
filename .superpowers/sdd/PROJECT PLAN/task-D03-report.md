# D03 completion report — executable catalog and event contracts

**Task:** D03
**Base:** `607d43b`
**Commit:** `d69f160` (`feat: add executable IR contracts`)
**Branch/worktree:** `development` / `.worktrees/api-truth-development`

## Delivered

- Added the private `@api-truth/ir` workspace package with exact-pinned TypeBox `0.34.41`, Ajv `8.17.1`, and ajv-formats `3.0.1` dependencies.
- Defined one canonical TypeBox source for TypeScript types, runtime validation, and Draft 2020-12-compatible JSON Schema exports. An independent Ajv instance validates the schema catalog and representative wire data.
- Added runtime parsers and validator aliases for contract snapshots, events, view selectors, installation config, analyzer requests, and analyzer results. Every parser accepts `unknown` and returns a discriminated `ValidationResult<T>` with controlled path/code/message issues and no raw rejected values.
- Added semantic validation for duplicate IDs, dangling references, cross-service/source scope, route identity consistency, schema references, incomplete coverage diagnostics, editorial claim references, and qualifying normative evidence.
- Kept owner editorial acceptance independent from normative export eligibility. Runtime-validator, deterministic-analysis, and behavioral-verification evidence may qualify; inference, ordinary observation, owner assertion, and editorial approval do not.
- Added endpoint identity v1 with stable service/method/normalized application path/selector inputs. Placeholder spelling is ignored for identity but retained in `application_path` and parameter facts; labels, hosts, branches, and deployments are excluded.
- Added recursive JSON-Schema-compatible IR for refs, unions, nested objects/arrays/maps, enums, null, request/response serialization, status variants, media types, and security OR/AND groups. Presence remains required/optional/conditional/unknown.
- Added all architecture §4.2 event types and tagged deployment attempt versus authoritative serving-observation payloads. Complete empty inventory may establish absence; incomplete empty inventory is rejected; mixed sets and unknown artifact revisions remain explicit; rollback request remains an attempt.
- Added immutable source/analyzer exchange contracts with controlled service roots, immutable revisions, explicit resolution inputs and resource limits, literal no-network/no-side-effect policy, coverage, dependencies, diagnostics, and reproducibility fingerprint.
- Added an Express canonical JSON fixture, invalid mutation fixtures, and a Spring normalization test driven by the original D02 design records. The Spring case retains header-selected route variants and unknown request-body presence.
- Documented public interfaces, D02-to-canonical normalization, identity/version rules, and deliberate scope limits in `packages/ir/README.md`. Updated architecture and implementation-plan status.

## Public interface

| Name | Type / return |
|---|---|
| `parseContractSnapshot`, `validateContractSnapshot` | `(unknown) => ValidationResult<ContractSnapshot>` |
| `parseEvent`, `validateEvent` | `(unknown) => ValidationResult<EventEnvelope>` |
| `parseViewSelector`, `validateViewSelector` | `(unknown) => ValidationResult<ViewSelector>` |
| `parseConfig`, `validateConfig` | `(unknown) => ValidationResult<InstallationConfig>` |
| `parseAnalyzerRequest`, `validateAnalyzerRequest` | `(unknown) => ValidationResult<AnalyzerRequest>` |
| `parseAnalyzerResult`, `validateAnalyzerResult` | `(unknown) => ValidationResult<AnalyzerResult>` |
| `deriveEndpointIdentity` | `(EndpointIdentityInput) => EndpointIdentity` |
| `normalizeApplicationPathShape` | `(string) => string` |
| `jsonSchemas` | six named public boundary schemas |
| `jsonSchemaCatalog` | boundary schemas plus referenced `$id` definitions |

The package also exports named component schemas/types and the six supported version constants. Exact shapes and semantics are listed in `packages/ir/README.md`.

## TDD evidence

All RED runs loaded valid modules and exercised deliberately nonvalidating stubs or an intentionally missing validation branch; no missing-import/dependency error was counted as RED.

| Group | RED command and observed result | GREEN command and observed result |
|---|---|---|
| View/config/identity | `npm run test:unit -- --run tests/unit/ir-view-config-identity.test.ts` → 9 tests, 6 expected failures against stubs | same command → 9/9 passed |
| Snapshot/evidence | `npm run test:contract -- --run tests/contract/ir-snapshot.test.ts` → 8 tests, 7 expected failures against stub | focused snapshot suite → 8/8 passed; later JSON-only value RED was 1 failure/9 and returned 9/9 green |
| Events | `npm run test:contract -- --run tests/contract/ir-events.test.ts` → 12 tests, 3 expected failures against stub | focused event suite → 12/12 passed |
| Analyzer exchange | `npm run test:contract -- --run tests/contract/ir-analyzer.test.ts` → 5 tests, 3 expected failures against stub | focused analyzer suite → 5/5 passed |
| JSON Schema exports | `npm run test:contract -- --run tests/contract/ir-json-schema.test.ts` → 3 tests, 2 expected export failures | focused JSON Schema/Spring suite → 3/3 passed |

## Files

- `packages/ir/package.json`, `packages/ir/README.md`
- `packages/ir/src/{analyzer,api-schema,config,endpoints,events,evidence,identity,index,json-schema,json-value,snapshot,validation,versions,views}.ts`
- `tests/fixtures/ir/express-snapshot.json`
- `tests/unit/ir-view-config-identity.test.ts`
- `tests/contract/ir-{analyzer,events,json-schema,snapshot}.test.ts`
- `package-lock.json`, `docs/ARCHITECTURE.md`, `PROJECT PLAN.md`

## Supported shapes and deliberate gaps

- The schema node supports the bounded keywords currently needed by Express/Spring fixtures: `$ref`, scalar/object/array/null types, nested properties/items/maps, required, enum/const, composition, format/pattern, and common numeric/string/array limits. It is not an arbitrary JSON Schema passthrough; adding keywords requires a versioned IR change.
- Conditions preserve predicate trees or scoped business expressions but this package does not evaluate business expressions.
- Analyzer `failed` results may still carry diagnostics and any safely recovered partial facts; worker retry/job semantics are outside D03.
- Deployment events describe evidence only. They do not update pointers, deduplicate deliveries, reconcile providers, or resolve serving state.
- Omitted inference/log config means disabled; the package validates configuration but does not resolve secret references or start adapters.
- No database, extraction, jobs, models, OpenAPI compilation, publication, migration engine, or network work was added.

## Final verification

| Command | Result |
|---|---|
| `npm run check` | TypeScript strict NodeNext check passed; 7 files and 44 tests passed. |
| `npm run test:coverage` | 44/44 passed; package coverage 90.47% statements, 73.46% branches, 95.83% functions, 92.24% lines. |
| `node fixtures/tests/validate-fixtures.mjs` | Existing D02 checker passed with its expected success message. |
| `npm ci --dry-run --ignore-scripts` | Lockfile accepted. |
| `git diff --check` | Passed with no output. |

## Self-review

- Rechecked required distinctions against the brief: evidence methods, source/version/location/scope/limitations/access, four presence states, editorial versus normative status, view exclusivity, route variants, partial coverage, attempt versus serving authority, complete versus incomplete empty inventory, mixed/unknown revisions, exact versions, and explicit analyzer execution policy are represented and tested.
- Confirmed errors do not embed rejected values; semantic duplicate errors were reduced to controlled generic messages.
- Confirmed the D02 fixture checker and original design histories were not changed.
- Confirmed lockfile retains the root harness optional package records while adding only the new exact package dependency graph. `npm ci --dry-run --ignore-scripts` accepts the lock.

## Fix round 1 — review contract hardening

**Review source:** `task-D03-review.md`
**Starting commit:** `d69f160`
**Fix commit:** `4f7ce7b` (`fix: harden IR contract validation`)

### Corrections

- Bound eligible export records to the referenced claim: basis evidence must be on the claim, evidence scope must cover the claim's service/snapshot/endpoint, eligibility scope must contain the subject endpoint, and basis kind must match the evidence method. An unresolved claim with the same subject/predicate and a different value blocks eligibility.
- Validate embedded API schemas as an isolated Draft 2020-12 graph. The supported reference namespace is exactly `#/schemas/<component-id>`; it is rewritten to `$defs` before Ajv compilation. Invalid regexes, duplicate enum members, missing components, and external/other reference namespaces are rejected with controlled errors.
- Require deployment envelope/payload environments to agree and each authoritative inventory to map an artifact ID once.
- Made selectors discriminated (`equals` requires a value; `present`/`absent` forbid it), canonicalized header/media case and set semantics, preserved Spring/Express placeholder constraints, and made `deriveEndpointIdentity` validate runtime input through `EndpointIdentityInputError`.
- Restricted analyzer roots and source/generated/changed paths to normalized project-relative paths, immutable revisions to 12–128 hexadecimal IDs, and external classpaths to tagged Maven coordinates with digests. Failed results now require incomplete coverage and an affected diagnostic.
- Replaced free-form secret strings with allowlisted structured `env`/`vault` locators. Isolated tests prove accepted references, rejected literal strings, and non-echoing errors.
- Added duplicate checks for review and eligibility IDs, route-identity collision rejection, field-accurate presence evidence paths, and environment intended-branch membership validation.

### RED / GREEN evidence

The first review-regression run used the existing `d69f160` implementation with no missing imports or dependency errors:

| Command | RED result |
|---|---|
| `npm run test:contract -- --run tests/contract/ir-snapshot.test.ts tests/contract/ir-events.test.ts tests/contract/ir-analyzer.test.ts` | 38 tests: 12 failed and 26 passed. Failures reproduced eligibility relation/basis/scope/contradiction, invalid schema graph, deployment conflicts, analyzer paths/revision/failed coverage, duplicate IDs/route keys, and the incorrect evidence path. |
| `npm run test:unit -- --run tests/unit/ir-view-config-identity.test.ts` | 14 tests: 5 failed and 9 passed. Failures reproduced structured secret references, intended-branch mismatch, malformed/duplicate selectors, and constraint collapse. |
| `npm run test:contract -- --run tests/contract/ir-analyzer.test.ts -t 'failed result'` after isolating mutable fixture state | 1 focused failure: the unchanged parser accepted a failed result with complete coverage. |

Final GREEN evidence:

| Command | Result |
|---|---|
| Focused contract and unit suites | 55/55 passed before the isolated cases were expanded. |
| `npm run check` | Strict NodeNext typecheck passed; 7 files and 69 tests passed. |
| `npm run test:coverage` | 69/69 passed; 92.84% statements, 83.07% branches, 98.03% functions, and 94.23% lines. |
| `node fixtures/tests/validate-fixtures.mjs` | Existing D02 fixture validation passed unchanged. |
| `npm ci --dry-run --ignore-scripts` | Lockfile accepted. |
| `git diff --check` | Passed with no output. |

### Remaining limits / concerns

- Analyzer revisions deliberately accept only provider-neutral hexadecimal commit/content IDs. Installations using a non-hex immutable VCS identifier need a future versioned revision variant rather than weakening this boundary.
- The only approved external classpath locator is a Maven coordinate plus digest. Other resolvers require explicit tagged variants in a later contract version.
- Embedded API schema references are local component references only. There is no external schema registry in D03.

## Fix round 2 — syntax-aware route shapes and conditional contradictions

**Review source:** `task-D03-rereview1.md`
**Starting commit:** `4f7ce7b`

### Corrections

- Replaced slash-splitting placeholder normalization with a conservative balanced delimiter parser. It preserves the exact regular-expression constraint while removing Spring and Express placeholder spellings, including slash-containing and escaped character classes. Unmatched delimiters, invalid names, empty constraints, invalid regular expressions, and unsupported nested Spring braces fail through a controlled `/application_path` semantic issue. Snapshot validation emits that path error without adding an identity-mismatch error for the same malformed source.
- Made export-eligibility contradiction matching condition-aware. Different values conflict only for the same canonical structured condition, including the unconditional case. Different structured conditions remain separate branches. D03 intentionally does not solve predicate overlap, so it does not infer contradictions across distinct condition objects.

### RED / GREEN evidence

| Command | Result |
|---|---|
| `npm test -- tests/unit/ir-view-config-identity.test.ts tests/contract/ir-snapshot.test.ts` with the implementation temporarily reverted | RED: 7 expected failures — one slash-containing Spring identity mismatch, five malformed/unsupported path forms accepted, and distinct conditional branches incorrectly conflicted. |
| Same focused command after restoration and malformed-path regression | GREEN: 47/47 passed. |
| `npm run check` | Passed: strict typecheck and 79/79 tests. |
| `npm run test:coverage` | Passed: 79/79 tests; 92.71% statements, 83.84% branches, 98.07% functions, and 93.99% lines. |
| `git diff --check` | Passed with no output. |
