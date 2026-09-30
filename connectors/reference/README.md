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

The [synthetic reference workflow](../../.github/workflows/reference-synthetic.yml)
uses `fixture-driver.mjs` to format a baseline, PR updates, branch update,
UAT attempt, explicit UAT serving observation, and reconciliation. It writes
only synthetic envelopes. Run the same driver locally with
`node connectors/reference/fixture-driver.mjs --branch main --output /tmp/api-truth-reference-events.json`.

Run the focused tests with
`npx vitest run tests/unit/reference-connector.test.ts tests/unit/reference-workflow.test.ts`.

## GitHub webhook verification boundary

`verifyGitHubWebhookDelivery` accepts the original request bytes, the
`X-Hub-Signature-256`, `X-GitHub-Delivery`, and `X-GitHub-Event` header values,
and a host-owned secret. It checks the HMAC-SHA256 signature against the exact
bytes and caps bodies at 1 MiB (or a smaller configured limit). The host must
implement `replay.claim` as an atomic, durable claim of both the delivery ID
and body SHA-256 digest in the webhook's own namespace; a repeat of either must
return false. An in-memory set is suitable only for tests. The HMAC covers
the body, not the event or delivery headers, so the host must not treat those
headers as independently signed. A successful call returns copied bytes and
fixed metadata, not a parsed or normalized provider event. The host remains
responsible for safe HTTP body collection, provider semantics, artifact
provenance, and durable event ingestion.

`normalizeVerifiedGitHubEvent` accepts the verifier's output and a
host-trusted repository ID/name plus exact configured branches. Supported
`push` and `pull_request` payloads produce a bounded reconciliation trigger.
They do not establish a branch revision or PR state by themselves: GitHub's
delivery ID and event time are not a monotonic branch order. The host must
query current provider state under its own authority, then produce an ordered
fact for the durable event bridge. Treat the `VerifiedGitHubWebhookDelivery`
TypeScript type as an integration contract, not as proof of authenticity if a
caller constructs it without the verifier.
