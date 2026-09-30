# Local reference event formatter

`normalizeLocalFact(fact, policy)` turns one bounded, synthetic source or
deployment fact into a validated API Truth event envelope. The host supplies
the installation configuration, authenticated event context, known artifact
manifest, and optionally the prior provider event. Branches match the exact
`intended_branches` list. A successful deployment attempt remains an attempt;
only an explicit authoritative serving observation can establish what runs.

The local fixture CLI accepts a policy JSON file as its argument and one fact
JSON object on standard input:

```sh
node connectors/reference/cli.mjs path/to/local-policy.json < path/to/fact.json
```

It writes one validated event JSON object to standard output or a safe error
code to standard error. The CLI is a fixture formatter. Its policy file is
operator supplied and does not authenticate callers, deliver events, or prove
artifact provenance. A production host must authenticate provider input and
pass trusted policy/artifact evidence to the adapter, then use D08's durable
ingestion and ordering checks and D09's serving evidence flow.

Run the focused tests with `npx vitest run tests/unit/reference-connector.test.ts`.
