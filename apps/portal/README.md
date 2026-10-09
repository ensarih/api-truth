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

A host may pass `semantic: { discover }` to enable the **Find an API for this task** form and `POST /api/discover`. The browser starts from the resolved contract currently on screen. It asks the user to check 1–16 endpoint boxes (contracts with 16 or fewer operations start fully selected), then submits the task text and explicit revision, branch, or environment view. Branch and environment requests carry the displayed pointer/checkpoint version; the service rechecks authorization and the exact pin before and after provider inference.

The form tells users that selected endpoint documentation, eligible source route/handler identifiers, and task text may be sent to the host-configured inference provider. The route accepts only `application/json`, at most 8 KiB, with duplicate-key/depth/field checks. Identity always comes from `authenticate`; the request cannot supply a tenant or principal. It does not use a snapshot identifier from the browser to authorize access. Responses label suggestions as inferred, unreviewed and non-normative, include evidence IDs, and report requested/analyzed/omitted endpoint IDs in `contextCoverage`. A no-match result with partial coverage applies only to analyzed operations. This read-only feature does not choose an analyzer profile, change a contract, or establish a deployment fact. The host must configure the semantic service and its provider separately.
