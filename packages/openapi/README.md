# `@api-truth/openapi`

D10 starts with a deterministic projection planner. `planOpenApiProjection`
validates a D03 contract snapshot, groups endpoints by the method and path
shape that would share one OpenAPI operation, and retains every endpoint ID.
Placeholder spelling does not create a second operation. Distinct handlers
selected by headers or media types produce a `variant_set` diagnostic rather
than overwriting one another. Constrained or otherwise unsupported route
syntax and unsupported HTTP methods remain explicitly unprojectable.

This planner does **not** produce an OpenAPI document or declare any group
exportable. Subsequent D10 slices must prove faithful representation of
selectors and request/response relationships, handle schema/requiredness
gaps, validate draft and strict documents, and publish immutable artifacts
atomically. In particular, a `selected_single` group still needs selector
compilation before export.

Run `npx vitest run tests/unit/openapi-projection.test.ts` from the repository
root for focused tests. See the [backlog](../../docs/BACKLOG.md) for the
remaining D10 gates.
