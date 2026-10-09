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
