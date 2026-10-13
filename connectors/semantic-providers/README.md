# Semantic provider adapters

This package supplies bounded HTTP adapters for the semantic provider port. Each adapter uses a caller-supplied model and API-key resolver, contacts only that provider's fixed HTTPS API origin, disables redirects, limits request and response bytes, and returns fixed error codes without exposing provider response bodies or credentials. There are no retries, tools, execution requests, or fallback models.

The adapters ask for a strict JSON object containing the port's result union. The semantics kernel still validates endpoint membership, citation provenance, and every output field; provider structured-output support is not treated as proof. Suggestions remain inferred and unreviewed.

For `semantic-discovery-1`, the bounded (512 character) intent query is passed separately from endpoint documentation as untrusted user data. A version-specific fixed system instruction asks the model to match only documented selected endpoints. The older `semantic-grounding-1` request shape does not accept an intent query.

The separate `semantic-discovery-source-1` profile accepts only whitelisted source-context document kinds: literal route text, handler symbols, or controller/action names. Credential-shaped values are rejected by the shared conservative text checks; ordinary API names are not rejected by keywords alone. Its fixed instruction permits tentative endpoint naming only and forbids conclusions about business workflow, behavior, schemas, security, or requiredness. This is distinct from document-grounded profiles and does not change their request shapes.

Tests use mocked `fetch` responses only. They never contact provider services or read credentials.

## Provider request formats

- OpenAI Responses: `text.format` JSON schema, strict mode, and `store: false`.
- Gemini GenerateContent: JSON MIME type and schema in `generationConfig.responseFormat.text`.
- Claude Messages: JSON schema in `output_config.format`.

API-key resolution stays outside the request and result types. Callers should resolve secrets from their own trusted credential store and must not log them.

`createConfiguredSemanticProviderFactory` is the optional host bridge for `createSemanticService({providerFactory})`. It receives a trusted secret resolver at construction. For each authorized, usable inference, the service passes the active tenant/provider/model and configured `env` or `vault` secret reference to the factory. The adapter resolves the key only when making that provider call, without a cross-tenant key cache. The resolver must authenticate its own backing secret store; a reference alone is not a credential. Factory and resolver failures return fixed errors, and neither the reference nor key is added to model requests or stored results.

Document text is checked using the shared conservative exclusion patterns. These patterns do not certify arbitrary prose as free of sensitive information; the host remains responsible for its document egress policy.

Wire formats follow the official [OpenAI structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs), [Gemini structured output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), and [Claude structured output guide](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Model support and deployment access must be configured explicitly.

## Direct OpenAI models and embeddings

The selected interpretation model is `gpt-6.1-sol`, using the existing direct
OpenAI Responses API adapter. Set the installation's inference provider/model and
server-side credential reference:

```json
{
  "enabled": true,
  "provider": "openai",
  "model": "gpt-6.1-sol",
  "credential": {"secret_ref": {"scheme": "env", "locator": "OPENAI_API_KEY"}}
}
```

Meaning retrieval uses OpenAI's separate Embeddings API via
`createOpenAiEmbeddingPort`. Default is `text-embedding-3-small` with 256
dimensions; `text-embedding-3-large` is also supported. This is independent of the
Responses model. Both APIs may use the same server-side OpenAI project key:

```ts
const embedding = createOpenAiEmbeddingPort({
  resolveApiKey: () => process.env.OPENAI_API_KEY ?? "",
});
const retrieval = createSemanticRetrievalService({
  query: authorizedQueryReader,
  context: authorizedSemanticService,
  embedding,
});
```

Keys come from the OpenAI Platform project, not a ChatGPT/Codex session token.
Do not put a key in browser requests, committed configuration or test fixtures.
The connector uses the fixed HTTPS endpoint, disallows redirects, bounds inputs
and streamed responses, checks model/dimensions/indices, reorders vectors by their
input index and exposes fixed failures without response text or credentials.
No live request is made by constructing the port. Offline tests inject synthetic
fetch responses; live account access and quality are separate checks.

Official references: [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[project key setup](https://developers.openai.com/api/docs/quickstart),
[embeddings](https://developers.openai.com/api/docs/guides/embeddings).
