# Synthetic conformance fixtures

These compact, fictional inputs are design fixtures for the API Truth pilot. They do not run an application, model a provider wire format, or claim support beyond the declarations and evidence shown in the source.

- `typescript/orders/` compares immutable `baseline` and `changed` Express/TypeScript snapshots. Each snapshot has source and adjacent `expected.json` facts.
- `java/orders/` is a small Spring MVC source fixture and its expected route facts.
- `lifecycle/cases.json` is design data for D03. It is intentionally not a canonical event schema or transport format.
- `tests/validate-fixtures.mjs` performs the static consistency checks documented below.

The examples use the D01 vocabulary: `orders`, `uat`, `staging`, `production`, and fictional revisions such as `rev-a`. A deployment attempt, serving observation, exposure configuration, and contract resolution are separate facts. `unknown` is intentional where the evidence cannot establish a fact.

Run the fixture checks with:

```sh
node fixtures/tests/validate-fixtures.mjs
```

No source is intended to be started, compiled, or connected to an external system.
