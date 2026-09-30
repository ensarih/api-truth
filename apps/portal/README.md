# API Truth portal (first slice)

`createPortalServer({ authenticate, query })` serves a small service browser
and a read-only `/api/services` route. It uses the shared query layer and
requires the host to supply an authentication callback; there is no default
principal or request header that grants access. The tenant ID comes from that
callback, never from a query parameter. The browser can select an environment
to see a resolved, unknown, transitional, unavailable, or ambiguous state.
The page displays returned names as text rather than HTML.

This slice does not start a standalone deployment or provide a login system.
Endpoint detail, contract differences, OpenAPI download, publication pinning,
and the cross-surface portal/MCP gate remain D11-S3/S4 work.

Run `npx vitest run tests/unit/portal-server.test.ts` to check the host
authentication boundary, tenant isolation, and service browsing route.
