# Contributing

## Local requirements

Use Node.js 24.6.0 and npm 11.5.1. The repository pins the Node version in
`.node-version` and pins every direct development dependency exactly in
`package.json`; `package-lock.json` pins the transitive dependency graph.

Install the checked-in dependency graph:

```sh
npm ci
```

If either runtime version is unavailable, report that prerequisite failure
instead of treating skipped checks as successful.

## Offline checks

The currently implemented checks need no Docker service, database, network
connection, or provider API key:

```sh
npm test
npm run test:unit -- tests/unit/harness.test.ts
npm run test:contract
npm run test:watch
npm run test:coverage
npm run typecheck
npm run check
```

`npm test` runs the unit and contract Vitest projects once. The focused unit
form accepts a file selector after `--`; a selector that matches no tests is a
failure. `npm run test:watch` stays open and reruns affected offline tests until
you stop it. `npm run check` is the CI gate: strict type checking followed by
all offline tests.

The offline suite checks the TypeScript/Express analyzer, IR and event
contracts, updates, orchestration decisions, OpenAPI compilation, portal HTTP
behavior, and linked MCP protocol behavior against synthetic fixtures. It does
not prove Java extraction, a real provider webhook, or an enterprise install.

## PostgreSQL integration checks

Docker-backed checks use only the fixed `api-truth-test` Compose project. The
database listens on `127.0.0.1:55432`, uses synthetic credentials, and stores its
data in a disposable tmpfs. Start, test, and stop it with:

```sh
npm run test:env:up
npm run test:env:ready
npm run test:integration
npm run test:env:down
```

`test:integration` deliberately fails when the service is stopped. The teardown
command removes only resources belonging to the fixed test project; do not replace
it with broad Docker prune commands. Integration tests create random schemas under
the `api_truth_test_` prefix and remove only the schemas they created.

The database suite covers snapshot access, durable events and workers,
environment resolution, publication, revocation, and a portal/MCP/export
cross-surface read. The complete nine-step Phase 1 lifecycle remains an open
release gate. The Java analyzer and end-to-end suite commands will be added
with their real implementations and prerequisites. The analyzer process
boundary is documented in `analyzers/PLUGIN_API.md`; Phase 1 does not require
the system JDK.
