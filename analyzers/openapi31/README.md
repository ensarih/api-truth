# OpenAPI 3.1 document analyzer

`openapi31-document@0.1.0` reads one explicitly selected OpenAPI document and emits bounded API declarations. It accepts only OpenAPI `3.1.0` and `3.1.1`, uses the default OpenAPI 3.1 base dialect, and resolves local component references only. It does not bind declarations to application runtime behavior.

The profile projects ordinary object and primitive schemas, type unions, `const`, and `prefixItems`. Unsupported Schema Object semantics withhold that schema projection and add diagnostics. This includes boolean schemas, unknown keywords, reference siblings, `$id`, `$anchor`, `$dynamicRef`, `$dynamicAnchor`, and `$schema`. A non-default top-level `jsonSchemaDialect` withholds all schema projections. References do not trigger network or filesystem access.

Other JSON Schema 2020-12 vocabularies, resource-relative references, anchors, recursive/dynamic references, boolean schemas, schema annotations not represented by IR, and custom dialects are outside this profile. Results with unsupported fields remain partial and must not be treated as complete schema validation. The OpenAPI 3.0 analyzer remains a separate exact profile.

Run `node scripts/extract-openapi31.mjs --source <project-root> --document <relative-document-path> --service <service-id> --revision <immutable-revision>` to analyze one selected document. The command reads only the selected contained document and does not execute project code.

Percent-encoded reference fragments are rejected for the complete selected document; this profile does not implement URI-fragment decoding. Literal percent characters in enum/const data remain ordinary data.
