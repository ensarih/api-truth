# Local setup and operator guide

**Scope:** a fresh checkout and the public synthetic test environment. This is
not an enterprise installation or a v0.1 release. Run the commands below from
the repository root. They need no provider account, API key, Java runtime, or
private source code.

## 1. Install the pinned tools

Use Node.js **24.6.0** and npm **11.5.1**. The repository's `.node-version`,
`package.json`, and lockfile fix these versions and dependencies. Docker Engine
with Docker Compose is needed only for PostgreSQL tests and the database-backed
demos. The local setup was checked with Docker Engine 29.3.1 and Compose 5.1.1.

```sh
node --version  # v24.6.0
npm --version   # 11.5.1
npm ci
npm run check
```

`npm run check` runs type checking and the offline unit and contract suites. It
does not need Docker or external credentials. A version mismatch should be
fixed before diagnosing test failures; `npm ci` installs from the committed
lockfile rather than updating dependencies.

The portal's real-browser test uses an installed Chrome or Chromium executable:

```sh
npm run test:browser
```

If browser discovery fails, set
`API_TRUTH_BROWSER_EXECUTABLE=/absolute/path/to/chrome` for that command. The
test fails clearly when no browser exists; it is separate from the offline
`npm run check` suite.

## 2. Start the disposable PostgreSQL service

The test controller accepts only the fixed `api-truth-test` Compose project and
database at `127.0.0.1:55432`. It uses the pinned PostgreSQL 18.6 image,
synthetic credentials, loopback-only access, and a 2 GiB temporary filesystem.
It must not be used for enterprise data. Run:

```sh
npm run test:env:up
npm run test:env:ready
```

`ready` checks both PostgreSQL readiness and an SQL query; it fails if Docker
or the database is unavailable. The integration suites create isolated random
schemas and remove them after each test. Run `npm run test:integration` for the
full database suite, or a focused example below.

When all local tests and demos using this shared test service have finished,
remove its container, network, and temporary data:

```sh
npm run test:env:down
```

The teardown targets only this fixed Compose project. Do not run it while
another checkout or test process is using the same local service.

## 3. Run the source-to-catalog demo

This demo extracts the checked-in synthetic Express service, validates its
result, registers synthetic catalog access, promotes its configured `main`
branch, reads the snapshot back, and drops its temporary database schema.
Run it after PostgreSQL is ready:

```sh
result_file="$(mktemp -t api-truth-analyzer-result.XXXXXX)"
npm run --silent extract -- \
  --source fixtures/typescript/orders/baseline/src \
  --service orders \
  --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$result_file"
npm run --silent catalog:roundtrip -- \
  --input "$result_file" \
  --tenant local-demo \
  --principal local-developer \
  --branch main
rm "$result_file"
```

The final JSON summary contains `round_trip_valid: true`. Analyzer warnings on
stderr identify unresolved facts; they are not silently made into contract
claims. The `main` branch is an exact configured value. A pattern-looking
branch such as `release/*` does not select every `release/…` branch.

To exercise strict OpenAPI preparation, atomic publication, replay, and a
historical read in another disposable schema, run:

```sh
npm run openapi:roundtrip
```

The command prints a synthetic JSON summary with `outcome: "passed"`. It does
not publish to a remote service.

## 4. Format the synthetic delivery sequence

The reference driver creates seven validated event envelopes in order:
baseline, PR open, PR merge, branch update, UAT deployment attempt, explicit
UAT serving observation, and reconciliation. Its revisions, artifact IDs,
provider references, and configuration are fixed public fixtures.

```sh
event_file="$(mktemp -t api-truth-reference-events.XXXXXX)"
node connectors/reference/fixture-driver.mjs \
  --branch main --output "$event_file"
node -e 'const fs=require("node:fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({demonstration_only:x.demonstration_only,event_count:x.events.length}))' "$event_file"
rm "$event_file"
```

The summary reports `demonstration_only: true` and seven events. The exact
configured branch gate rejects an unconfigured branch. These are formatted
fixtures, not authenticated GitHub deliveries or actual deployments. A
successful attempt alone does not establish a serving revision; the separate
inventory observation is the serving evidence. The reference workflow in
`.github/workflows/reference-synthetic.yml` also formats only synthetic
events. It has read-only repository permission and skips forked PR jobs.

To check the bounded local bridge against D08's real durable event ledger,
with PostgreSQL running:

```sh
npx vitest run --config vitest.integration.config.ts \
  tests/integration/reference-bridge.test.ts
```

This test proves accepted, duplicate, stale, and rejected deliveries in a
temporary schema. It does not authenticate a live provider or complete the
full source-to-portal deployment lifecycle.

## 5. Initial configuration and identity boundaries

The local demos supply and activate their own synthetic configuration. For an
embedded installation, the host must supply a validated installation document
and an authenticated control context to D08's
`registerConfiguration(context, { fingerprint, document })`, then call
`activateInitialConfiguration(context, { fingerprint })`. The document binds
each repository to a provider, locator, access scope, and services. Each
service declares its root, analyzer adapter/version, exact
`intended_branches`, and optional environments with a named deployment
authority. The checked-in synthetic example is in
`connectors/reference/src/fixture.ts`; its `main` branch and `uat`
environment are examples, not defaults for new tenants.

| Port | What the embedding host must provide |
|---|---|
| Configuration control | An authenticated tenant/principal with `configuration.admin`; the host chooses and stores the configuration fingerprint. |
| Event delivery | An authenticated producer with `event.ingest` and exact repository, service, event-type, and deployment-authority grants. The reference bridge accepts host-attested complete fact bytes and a host-verified artifact manifest, then hands the event to D08's durable `ingestEvent`. |
| Workers | A host-issued worker identity with `jobs.execute` and the source, analyzer, and exact provider reconciliation ports. |
| Catalog and query reads | A host-authenticated tenant/principal plus current source-scope grants. Query reads recheck authorization and the selected snapshot in one database transaction. |
| Portal and MCP | The embedding host supplies `authenticate` callbacks that return a tenant/principal. Neither surface treats a client-provided tenant or arbitrary header as authority. |

There is no production identity provider, deployed GitHub webhook host,
artifact provenance service, or general installation CLI in this checkout.
The bounded GitHub HMAC verifier checks signed raw bytes in local tests; it is
not wired to a live provider or deployment source.
The local fixture policy file is operator supplied and does not confer
authority. A deployment host must implement those ports before it can accept
real events. Do not paste credentials into fixtures or configuration committed
to the repository.

## 6. Supported source scope and known gaps

The executable Express analyzer is `typescript-express@0.6.0` on TypeScript 5.9.3.
Its bounded profile supports literal Express app/router registrations for
`get`, `post`, `put`, `patch`, `delete`, `options`, and `head`, including exact
literal `route(path).method(...)` chains on known apps/routers; literal mount
prefixes and imported routers; named path and accessed query fields; declared
body/response/query types; selected top-level runtime guards; explicit
response status/media facts; and source/dependency evidence. It records
unresolved dynamic routes, conditional registrations, unsupported type
members, unknown presence/status/media, and security guarantees as unknown or
diagnostics. See the [detailed analyzer matrix](../analyzers/typescript/README.md#support-matrix).

Other explicit profiles are `nodejs-routing-controllers@0.8.0`, standalone
Swagger 2 `0.15.0`, Swagger middleware `0.33.0`, and OpenAPI 3.0
`0.2.0`. Document profiles read only an explicitly selected contained
JSON/YAML document; OpenAPI 3.1 input remains unsupported. These profiles have
separate limits and do not automatically select an adapter or prove deployed
startup. See their adapter READMEs for exact support and diagnostics.

For an advisory source/document inventory, select one tree and entrypoints or
document paths explicitly:

```sh
npm run inventory:nodejs -- \
  --project-root /path/to/project \
  --service-root services/orders \
  --entrypoint src/main.ts \
  --document api/openapi.json
```

The offline inventory does not run code, enumerate branches, or choose an
analyzer. It reports supported, unsupported, mixed, or unresolved evidence for
the selected service only. See the [inventory guide](../analyzers/nodejs/INVENTORY.md).

The D12 local Git connector can materialize a configured service subtree from
an immutable local commit for selected compiled profiles and feed it to D08's
baseline or full branch-update path. It does not fetch Git remotes, provide
webhook authentication, or establish a production source provider.

The [routing-controllers profile](../analyzers/routing-controllers/README.md)
can also be tried against its synthetic fixture:

```sh
npm run --silent extract:routing-controllers -- --source fixtures/nodejs/routing-controllers/orders/src --service orders --revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The default declaration-oriented profile does not identify a production
startup entry point. A host may opt into a bounded selected-entrypoint mode;
that proves static source reachability only and does not establish that a
deployment starts that file.

Java/Spring and additional Node.js frameworks are not supported by this
adapter. Runtime-log examples, a production CI/deployment connector, and a
protected enterprise pilot remain separate work. Portal and MCP packages are
host-embedded read surfaces, not a ready-to-run authenticated installation.
The nine-step Phase 1 release scenario, including failed rollout, rollback,
missed-event repair, and cross-surface same-pin reads, remains the D13-S1
gate. The portal and MCP can expose current-environment, cross-service keyword
candidates when the host supplies the corpus query capability. Each candidate
must be reloaded at its exact checkpoint pin before use; this path makes no
model call. Separate selected-operation semantic suggestions require an
explicit user action and a configured provider, and remain inferred,
unreviewed, and non-normative. Current-pin metadata observations expose only
sanitized records from an explicit import, not raw logs or payload examples.
The local demos above do not satisfy the D13-S1 gate or authorize a release.
