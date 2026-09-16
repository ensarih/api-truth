# `@api-truth/ir`

Private workspace package containing API Truth's versioned JSON boundaries. TypeBox definitions are the canonical source for runtime validation, TypeScript types, and JSON Schema. Ajv 2020 performs shape validation; focused semantic passes then check identity, duplicate IDs, references, service scope, coverage, serving observations, and normative eligibility.

## Public parsers and validators

Every parser accepts `unknown` and returns `ValidationResult<T>`:

```ts
type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ValidationError };

type ValidationError = {
  kind: "validation_error";
  issues: Array<{ path: string; code: string; message: string }>;
};
```

Errors contain JSON-pointer-like field paths and controlled messages. They never include rejected payload values.

| Parser | Alias validator | Result type | Canonical schema |
|---|---|---|---|
| `parseContractSnapshot` | `validateContractSnapshot` | `ValidationResult<ContractSnapshot>` | `ContractSnapshotSchema` |
| `parseEvent` | `validateEvent` | `ValidationResult<EventEnvelope>` | `EventSchema` |
| `parseViewSelector` | `validateViewSelector` | `ValidationResult<ViewSelector>` | `ViewSelectorSchema` |
| `parseConfig` | `validateConfig` | `ValidationResult<InstallationConfig>` | `InstallationConfigSchema` |
| `parseAnalyzerRequest` | `validateAnalyzerRequest` | `ValidationResult<AnalyzerRequest>` | `AnalyzerRequestSchema` |
| `parseAnalyzerResult` | `validateAnalyzerResult` | `ValidationResult<AnalyzerResult>` | `AnalyzerResultSchema` |
| `parseEndpointIdentityInput` | — | `ValidationResult<EndpointIdentityInput>` | `EndpointIdentityInputSchema` |

`jsonSchemas` exposes the six public wire-boundary schemas by name. `jsonSchemaCatalog` exposes those schemas plus their referenced definitions, each with a stable `$id`, for registration in an independent Draft 2020-12 validator or serialization for a Java consumer.

## Version and identity constants

The current supported values are `IR_VERSION`, `EVENT_VERSION`, `VIEW_VERSION`, `CONFIG_VERSION`, `IDENTITY_VERSION`, and `ANALYZER_EXCHANGE_VERSION`, all currently `1.0.0`. The parsers reject unsupported versions rather than silently accepting a future wire shape.

`deriveEndpointIdentity(input): EndpointIdentity` and `normalizeApplicationPathShape(path): string` implement route identity v1. The helper validates runtime input and throws `EndpointIdentityInputError` with a structured `validation` property when malformed. The route key contains stable service ID, method, normalized application path shape, and canonical supported routing selectors. Header names and media types use case-insensitive set semantics; query selector names and selector values retain case. Placeholder spelling is removed while supported Express/Spring placeholder constraints are retained; the endpoint's `application_path` and parameter names remain diffable facts. Labels, hosts, branches, line numbers, and deployments are not inputs. Literal path, constraint, method, or selector changes produce different identities.

## Contract semantics

- `Evidence.method` distinguishes `type_declaration`, `runtime_validator`, `observation`, `behavioral_verification`, `deterministic_analysis`, `inference`, and `owner_assertion`. Every record carries source, source version, location, scope, limitations, and access label.
- Field presence is `required`, `optional`, `conditional`, or `unknown`. Conditional presence requires either a predicate tree or a scoped business expression.
- Request parameters/bodies and response content have separate serialization records. Responses retain exact/range/default/unknown statuses and media types. Security uses OR alternatives containing AND requirements.
- `editorial_reviews` and `export_eligibility` are independent. Eligible records require evidence already attached to the claim, scoped to its snapshot and subject, with a basis matching the evidence method and a scope containing the subject endpoint. Unresolved contradictory claims block eligibility. Contradictions are proven when otherwise matching claims have different values under the same canonical condition (including both unconditional); distinct conditions are retained as separate branches because D03 does not include a predicate-overlap solver. Inference, ordinary observations, owner assertions, and editorial acceptance do not establish normative eligibility.
- Incomplete snapshots require unresolved roots, a reason, and affected diagnostic IDs. Partial analyzer results preserve endpoints and diagnostics rather than dropping unresolved scope.
- `ViewSelector` contains an explicit service ID and exactly one of environment, branch, or immutable revision; publication pinning is optional.
- Omitted `inference` and `logs` config sections mean disabled. Enabling either requires an explicit adapter/provider and a structured allowlisted `secret_ref` (`env` variable name or `vault` path/field locator); literal credential fields and untagged secret strings are rejected. An environment's intended branch must be in its service's intended branch set.
- `deployment.changed` uses tagged `attempt` and `serving_observation` payloads. Attempts cannot carry active inventory. Envelope and payload environments must agree when both are present, and an authoritative inventory maps each artifact once. Only a complete empty serving inventory establishes absence; unknown revisions remain unknown. A rollback request is an attempt until newer authoritative serving evidence confirms the active set.
- Analyzer requests identify a 12–128 hexadecimal immutable revision, normalized project-relative service/changed/resolution paths, explicit resolution inputs/resource limits, and a no-network/no-side-effect execution policy. External classpaths require a tagged Maven coordinate plus digest. Failed and partial results require incomplete coverage with affected diagnostics. Analyzer results reuse the canonical endpoint, schema, evidence, dependency, coverage, and diagnostic shapes.

## D02 normalization map

D02 files remain design histories rather than being relabeled as canonical wire data. The contract tests map them as follows:

| D02 fact | Canonical field |
|---|---|
| `fixture_kind`, `service_id`, `revision_alias` | snapshot service/source metadata; aliases become fixture-only immutable revision examples |
| Express/Spring `routes[]` | `endpoints[]` with derived `identity`, retained `application_path`, parameters, request bodies, responses, and selectors |
| `declaration-schemas.json` | `schemas` JSON-Schema-compatible components plus declaration evidence |
| runtime validator annotations/maps | distinct runtime-validator evidence and presence/constraint claims |
| `statuses: unknown_not_declared` | response status `{ kind: "unknown", reason }` plus diagnostic |
| computed route `unresolved[]` | incomplete coverage and affected diagnostics |
| lifecycle deployment steps | `deployment.changed` attempt payloads |
| lifecycle serving/reconciliation steps | `deployment.changed` authoritative serving-observation payloads |
| rollback request / later observation | attempt / serving observation, never one implicit state change |

The Spring contract test performs this representative mapping directly from the original D02 Spring records and proves header-selected handlers retain separate route identities.

## Deliberate limits

This package defines and validates wire contracts. It does not extract source, persist catalog state, execute analyzers, resolve deployments, compile OpenAPI, publish artifacts, call models, or migrate stored versions. Schema support is a bounded JSON Schema-compatible IR subset. Component references use only `#/schemas/<component-id>`; the parser rewrites that namespace into an isolated `$defs` graph and compiles it with Ajv. External and other reference namespaces are rejected. Adding keywords or reference catalogs requires a versioned contract change.
