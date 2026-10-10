# API Truth portal

`createPortalServer({ authenticate, query })` serves a small service browser,
explicit revision/branch/environment selection, contract and endpoint details,
schema and evidence views, contract comparison, and immutable OpenAPI download.
It uses the shared query layer and
requires the host to supply an authentication callback; there is no default
principal or request header that grants access. The tenant ID comes from that
callback, never from a query parameter. The browser can select an environment
to see a resolved, unknown, transitional, unavailable, or ambiguous state.
The page displays returned names as text rather than HTML.

The host must provide its own login/session integration and deployment. OpenAPI
downloads use a publication ID plus exact repository/service scope and recheck
authorization. A downloaded publication is an immutable historical version; a
second request does not assert that it is still current after a branch or
environment advances.

Run `npx vitest run tests/unit/portal-server.test.ts tests/unit/portal-detail.test.ts`
for the HTTP boundary and `npm run test:integration` for database-backed
publication and revocation coverage.

## Runtime metadata

When the host supplies `readMetadataObservations`, the portal exposes `GET /api/observations` and an environment-only runtime activity button. Reads require an explicit environment, optionally its expected checkpoint version, a limit of 1–100 and an optional existing endpoint ID. The shared reader rechecks grants and returns only sanitized metadata with the exact current serving pin. Logs do not establish request/response schemas, required fields or authentication. No import/write tool is exposed.

## Semantic intent discovery

A host may pass `semantic: { discover }` to enable the **Find an API for this task** form and `POST /api/discover`. The browser starts from the resolved contract currently on screen. It asks the user to check 1–16 endpoint boxes (contracts with 16 or fewer operations start fully selected only when both keyword candidate searches are unavailable), then submits the task text and explicit revision, branch, or environment view. Branch and environment requests carry the displayed pointer/checkpoint version; the service rechecks authorization and the exact pin before and after provider inference.

The form tells users that selected endpoint documentation, eligible source route/handler identifiers, and task text may be sent to the host-configured inference provider. The route accepts only `application/json`, at most 8 KiB, with duplicate-key/depth/field checks. Identity always comes from `authenticate`; the request cannot supply a tenant or principal. It does not use a snapshot identifier from the browser to authorize access. Responses label suggestions as inferred, unreviewed and non-normative, include evidence IDs, and report requested/analyzed/omitted endpoint IDs in `contextCoverage`. A no-match result with partial coverage applies only to analyzed operations. This read-only feature does not choose an analyzer profile, change a contract, or establish a deployment fact. The host must configure the semantic service and its provider separately.

## Keyword candidate search

When the host supplies `readOperationCandidates`, the portal shows **Find candidate APIs** and accepts `POST /api/candidates`. It searches only the current authorized environment with an exact serving checkpoint version, a bounded task query, and at most 20 results. The request body is strict JSON capped at 8 KiB; task text stays in the body, not the URL. The portal compares returned selector and pin to the displayed contract before showing candidates.

Results are deterministic keyword candidates with evidence IDs, a completeness flag, and a truncation flag. A `no_match` result means no keyword overlap in that selected contract; it does not rule out a semantic match. Candidate checkboxes start clear and can populate the separate provider discovery selection, which still requires the user to press its own button. Candidate search itself calls no inference provider.

When the host supplies `searchOperationCandidatesAcrossServices`, the portal shows a separate **Find API candidates across services** form and accepts strict `POST /api/corpus-candidates` with only environment, intent query, and optional result limit. Tenant and principal come from host authentication. It does not require a previously displayed service: the reader resolves current authorized service pins in one read transaction. The browser labels the results as lexical candidates in the visible authorized scope, shows each repository, service, evidence and serving checkpoint, and marks incomplete or truncated scans. It makes no inference-provider call.

Choosing **Load pinned contract** requests that candidate's exact environment checkpoint, then checks the returned snapshot, revision, configuration, checkpoint and endpoint before showing it. Editing the search or contract while a request is pending invalidates that result. Semantic discovery remains a separate explicit action after the pinned contract is loaded; it never runs automatically from a corpus candidate.

## Synthetic schema examples

When the host supplies `examples: {generate}`, `POST /api/examples` accepts strict JSON with only repository, service, environment, expected serving checkpoint, and a host-configured policy ID. The same authenticated, bounded request-body path as discovery applies. Tenant and principal come from the host, and the request cannot supply property allowlists or a snapshot. The service authorizes and rechecks the current pin before returning a deterministic, non-normative placeholder. Without the service, the route returns 404 and the browser form is hidden.

The browser form becomes available only after a resolved environment contract supplies a serving checkpoint. It sends that displayed checkpoint and the user's policy ID, then shows the returned endpoint scope and value as text under an explicit synthetic, non-normative label. Before display, it checks the returned tenant, repository, service, revision, configuration, source digest, serving checkpoint, and endpoint membership against the loaded contract. Changing the contract or policy while a request is pending discards its result; denied, malformed, or stale responses clear the displayed example. The form does not use traffic samples, inference providers, or source execution.

## Observed field presence

Supplying `presence: {readForPrincipal}` enables **Observed field presence** and
`GET /api/field-presence`. All query fields are required: repository/service IDs,
environment, snapshot ID, revision, configuration fingerprint, serving checkpoint,
policy ID, owner-policy revision and limit (1–100). Duplicate or unknown fields,
credentials, identities, capabilities, access scopes and qualified views reject.
Existing authentication, no-store responses, output cap and fixed errors apply.

Wire `createFieldPresenceQueryStore` for this port. The transport supplies its
authenticated principal and passes `IncomingMessage` only as an opaque credential.
The store's host manager must independently authenticate that request, establish
the read capability and return the same tenant/principal before database access.
The owner/read grants, current serving/configuration pin and enabled policy are
rechecked by the store; a browser-supplied pin does not grant authority.

The form requires a current unqualified environment contract and a configured
policy/version. It validates the full returned pin and source digest, policy
generation, endpoint membership and value-free record shapes before displaying
provenance and selected present/absent states as text. Changes to the selected
service, environment or policy invalidate pending replies; malformed, denied and
stale responses clear output. Truncation and non-normative observations are
explicit. Absence in a sample does not establish that a field is optional.

Without a configured presence reader, the panel is hidden and its route returns
404. This surface does not expose owner writes, read bodies or implement a live
log provider. Browser coverage is in `tests/browser/field-presence.spec.ts`.

## Cross-service semantic comparison

Configure `corpusSemantic: {discoverAcrossServices}` from the public semantic
corpus factory to enable **Compare API candidates for a task** and
`POST /api/corpus-discover`. The exact JSON body contains `environment`,
`intentQuery` and a required `limit` of 1–16. The existing JSON body/response
bounds, strict parsing and host authentication apply. The route is unavailable
when the capability is absent; it cannot accept identity, provider or credentials.

This explicit action first builds an authorized keyword shortlist and compares
eligible context within at most four services. The browser shows each namespace
and checkpoint, inference labels, incomplete/truncated shortlist coverage and
partial analyzed context. It discards late answers after inputs change and uses
text rendering for provider prose. **Load suggested pinned contract** reauthorizes
that exact checkpoint and checks the returned source pin before displaying it.
A changed pin is withheld. Empty shortlist text does not assert enterprise-wide
API absence. This adds no embedding index or automatic provider call on page load.


## Controlled loaded-document verification HTTP port

Configure `loadedDocumentVerification: {readForPrincipal}` from the public query
factory to enable `GET /api/loaded-document-verification`. Exact query parameters
are repositoryId, serviceId, environment, snapshotId, revision, configFingerprint,
checkpointVersion, configActivationCheckpoint and loadIdentityDigest. Serving
and configuration activation checkpoints are separate versions. Unknown or
duplicate parameters and caller identity/credentials are rejected.

Host authentication supplies the principal. The reader independently
authenticates the HTTP request and anchors it to that same principal, checks
current selection and independent read grants, and returns only safe metadata.
Responses use the existing byte bound, fixed errors and no-store policy. The
route is absent without host configuration. This HTTP port adds no browser
panel, artifact fetch or writes; controlled-load observations remain
non-normative and do not establish deployment or request-handler behavior.

## Environment choices and search scope

The search and cross-service task forms use environment dropdowns. The host supplies `environments(principal)`, returning only configured names visible to that authenticated tenant and principal. `GET /api/environments` accepts no query parameters, returns at most 128 names, removes duplicates, and sorts them. Choices do not grant access: each subsequent query still authorizes its requested scope. With no provider or a failed list, service search can use All environments; forms requiring an environment remain disabled.

Find a service matches a case-insensitive substring in repository and service IDs. It is not full-text API search. Optional operation candidate search checks evidence-backed paths, summaries, descriptions and source identifiers by keyword. Semantic inference remains a separate explicit action.

## Local design demo

Run `npm run portal:demo` and open http://127.0.0.1:4317/. This loopback-only demo uses synthetic fixture data and requires no database or provider keys. `orders` is available in `uat`; `staging` has no matching sample service. Text and environment filters are applied by the demo query adapter. Never use this demo authentication or query adapter as a production host.

The portal presents service cards, operations, parameter/request/response tables, and expandable source JSON. Environment changes automatically refresh service search, clear the previous contract, and discard late search/detail replies. The layout supports desktop and mobile widths.

## Private semantic history HTTP ports

Portal 0.4.1 accepts an explicit `semanticHistory` service separately from
inference discovery. The following JSON-only POST routes share the semantic
service's current authorization and private history checks:

| Route | Additional fields |
| --- | --- |
| `/api/semantic-history` | `limit` (1–20) |
| `/api/semantic-history/reviews` | `historyId`, `limit` (1–20) |
| `/api/semantic-history/review` | `historyId`, `decision`, `expectedVersion` |

All bodies require `repositoryId`, `serviceId`, `view`, and 1–16 unique
`endpointIds`. Branch/environment views must carry the displayed expected
pointer/checkpoint version. IDs and versions use canonical decimal strings;
decisions are `acknowledged`, `follow_up`, or `dismissed`. Extra identity fields,
query parameters, duplicate JSON keys and bodies over 8 KiB are rejected. Reads
and writes derive the principal from host authentication and never call a model.
The semantic service requires an independent, transaction-held owner policy for
annotation reads/writes; private inference history reads retain their existing
source-read authority. A version conflict returns HTTP 409 `REVIEW_CONFLICT`.

Metadata writes reject cross-origin/same-site browser requests. Direct HTTP hosts
compare `Origin` to their HTTP request origin. A host behind an HTTPS proxy must
set the trusted, canonical `semanticHistoryWriteOrigin`, for example
`https://portal.example`; it is not a request field. Browser fetch metadata must
be same-origin or none. Authenticated non-browser requests may omit Origin; host
login/session integration remains required. Responses are bounded and no-store.
An uncertain write response does not prove rollback; retry the exact decision
and expected version to retrieve an idempotent receipt.

This slice adds HTTP ports; the browser review panel and production host wiring
remain separate. Decisions are metadata-only, inferred and non-normative. They
cannot approve provider prose absent from the archive, edit API contracts, or
expose another principal's private history. The loopback synthetic demo does not
enable this optional capability.

Hosts may supply only the history methods they intend to expose; omitted methods
have no registered tool/HTTP route. A read-only host need not expose annotation
writes. Supplying a method does not replace the service's independent owner policy.
