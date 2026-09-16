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

`jsonSchemas` exposes the six public wire-boundary schemas by name. `jsonSchemaCatalog` exposes those schemas plus their referenced definitions, each with a stable `$id`, for registration in an independent Draft 2020-12 validator or serialization for a Java consumer.

## Version and identity constants

The current supported values are `IR_VERSION`, `EVENT_VERSION`, `VIEW_VERSION`, `CONFIG_VERSION`, `IDENTITY_VERSION`, and `ANALYZER_EXCHANGE_VERSION`, all currently `1.0.0`. The parsers reject unsupported versions rather than silently accepting a future wire shape.

`deriveEndpointIdentity(input): EndpointIdentity` and `normalizeApplicationPathShape(path): string` implement route identity v1. The route key contains stable service ID, method, normalized application path shape, and sorted supported routing selectors. Placeholder spelling is removed from the path shape while the endpoint's `application_path` and parameter names preserve it as a diffable fact. Labels, hosts, branches, line numbers, and deployments are not inputs. Literal path, method, or selector changes produce different identities.

## Contract semantics

- `Evidence.method` distinguishes `type_declaration`, `runtime_validator`, `observation`, `behavioral_verification`, `deterministic_analysis`, `inference`, and `owner_assertion`. Every record carries source, source version, location, scope, limitations, and access label.
- Field presence is `required`, `optional`, `conditional`, or `unknown`. Conditional presence requires either a predicate tree or a scoped business expression.
- Request parameters/bodies and response content have separate serialization records. Responses retain exact/range/default/unknown statuses and media types. Security uses OR alternatives containing AND requirements.
- `editorial_reviews` and `export_eligibility` are independent. Eligible records require qualifying runtime-validator, deterministic-analysis, or behavioral-verification evidence. Inference, ordinary observations, owner assertions, and editorial acceptance do not establish normative eligibility.
- Incomplete snapshots require unresolved roots, a reason, and affected diagnostic IDs. Partial analyzer results preserve endpoints and diagnostics rather than dropping unresolved scope.
- `ViewSelector` contains an explicit service ID and exactly one of environment, branch, or immutable revision; publication pinning is optional.
- Omitted `inference` and `logs` config sections mean disabled. Enabling either requires an explicit adapter/provider and a `secret_ref`; literal credential fields are rejected.
- `deployment.changed` uses tagged `attempt` and `serving_observation` payloads. Attempts cannot carry active inventory. Only a complete empty serving inventory establishes absence; unknown revisions remain unknown. A rollback request is an attempt until newer authoritative serving evidence confirms the active set.
- Analyzer requests identify an immutable source, controlled service root, explicit resolution inputs/resource limits, and a no-network/no-side-effect execution policy. Analyzer results reuse the canonical endpoint, schema, evidence, dependency, coverage, and diagnostic shapes.

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

This package defines and validates wire contracts. It does not extract source, persist catalog state, execute analyzers, resolve deployments, compile OpenAPI, publish artifacts, call models, or migrate stored versions. Schema support is a bounded JSON Schema-compatible IR subset; unsupported keywords require a versioned contract change.
