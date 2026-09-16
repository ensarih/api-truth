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

The unit smoke test proves that the configured runner executes asynchronous
assertions and cleanup. Contract tests invoke the D02 fixture checker against
the reviewed fixtures and independently mutated copies. They verify fixture
JSON, evidence source paths, route expectations, and lifecycle consistency.
They do not prove endpoint extraction, schema behavior, database integration,
Java analyzer behavior, or application lifecycles.

Integration, end-to-end, and Java suite commands will be added with their real
implementations and prerequisites. There are no empty successful placeholders
for those suites.
