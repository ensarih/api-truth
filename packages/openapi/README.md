# `@api-truth/openapi`

`planOpenApiProjection` validates a D03 snapshot and groups endpoints by the
method and path shape they would occupy in OpenAPI. It keeps all endpoint IDs;
different handlers are never silently overwritten.

`compileOpenApiSnapshot(snapshot, mode)` builds an OpenAPI 3.1 document in
`draft` or `strict` mode. It emits only operations whose route, known response,
parameter presence, body presence, and security can be represented. Draft mode
returns explicit diagnostics for omitted operations or constraints. Strict mode
returns no document when any diagnostic remains. Neither mode invents a server,
response status, security rule, or required input.

The compiler rewrites local schema references into OpenAPI components, keeps
exact status codes, ranges, media types, and supported parameter serialization,
and uses evidence-backed API-key and HTTP security definitions. Source-only or
unqualified constraints stay out of normative schemas. An exact eligible,
unconditional field-presence claim can promote a matching `required` property;
otherwise the omission is diagnosed.

The compiler represents a `consumes` selector only when its concrete media
types exactly match required request-body media. It can combine handlers that
use disjoint concrete media types when their path, parameters, responses, and
security agree. Each media type keeps its own request schema. Header, query,
and `produces` selectors, overlapping media, and variants with different
responses or other contracts are diagnosed and omitted rather than flattened
into a broader operation. Explicit variant-scoped exports are not yet
supported.

`prepareOpenApiPublication` is the pure first step of D10-S3. It checks an
explicit revision, branch-pointer, or environment-checkpoint assertion against
the exact snapshot; a resolved environment assertion must name one snapshot.
It adds snapshot/source/config provenance inside the OpenAPI document, returns
canonical UTF-8 bytes and their SHA-256 digest, and marks only diagnostic-free
strict results publishable. Branch and environment pins are assertions: a
database publisher must recheck current authoritative state inside the
transaction that switches a publication pointer. Durable storage, atomic
promotion, and external OpenAPI validation remain D10-S3/S4 work.

Run `npx vitest run tests/unit/openapi-projection.test.ts
tests/unit/openapi-compiler.test.ts tests/unit/openapi-preparation.test.ts` from
the repository root for focused tests.
See the [backlog](../../docs/BACKLOG.md) for the remaining gates.
