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

`prepareOpenApiPublication` checks an
explicit revision, branch-pointer, or environment-checkpoint assertion against
the exact snapshot; a resolved environment assertion must name one snapshot.
It adds snapshot/source/config provenance inside the OpenAPI document, returns
canonical UTF-8 bytes and their SHA-256 digest, and marks only diagnostic-free
strict results publishable. Branch and environment pins are assertions: a
database publisher must recheck current authoritative state inside the
transaction that switches a publication pointer.

`applyOpenApiMigrations(pool, { schema })` creates tenant-scoped immutable
artifact and publication tables plus versioned current pointers in the same
PostgreSQL schema as the catalog. `createOpenApiPublicationStore(pool,
{ schema })` prepares revision, branch, and environment selectors through
`prepareRevision`, `prepareBranch`, or `prepareEnvironment`; all use `publish`,
`readCurrent`, and `readPublication`. Publication rechecks the authoritative
branch pointer or resolved serving checkpoint, snapshot, access grants,
canonical bytes, and expected publication-pointer version inside one
transaction. A replay of the current publication is idempotent. Current reads
withhold stale branch/environment selections; all reads recheck grants and
content integrity. Environment publications retain their source and deployment
access scopes so historical reads also respect revocation. Before pointer
promotion, the publisher validates the document against the pinned official
OpenAPI 3.1 document schema, checks local references and JSON Schemas, and
rejects external references or examples whose schema fit cannot be verified.
The official document schema does not validate Schema Objects itself; the
separate JSON Schema check closes that gap for this supported profile. The
[pinned source and license](schema/SOURCE.md) are included offline.

For the local synthetic revision-publication walkthrough, start the isolated
PostgreSQL environment with `npm run test:env:up` and run
`npm run openapi:roundtrip`. It publishes a strict document, confirms replay,
rejects stale promotion, recovers with the correct pointer version, reads the
previous publication, prints a small JSON result, and removes its temporary
test schema. Use `npm run test:env:down` when finished.

Run `npx vitest run tests/unit/openapi-projection.test.ts
tests/unit/openapi-compiler.test.ts tests/unit/openapi-preparation.test.ts` from
the repository root for focused tests.
See the [backlog](../../docs/BACKLOG.md) for the remaining gates.


## Form encoding

IR 1.1 request bodies can retain per-property form encodings. Matched
`urlencoded` and `multipart` serialization formats export into their exact
media entries. Field encoding is sorted and emits `style`, `explode`, or
`contentType`; evidence IDs never enter the OpenAPI document. Weak, limited or
non-endpoint encoding evidence emits `UNVERIFIED_FORM_ENCODING` and omits the
operation, including when merging consumes variants. Each direct form property
must have an encoding record; missing records emit `UNKNOWN_FORM_ENCODING`
and omit the operation. Required fields and format
constraints still need their independent eligibility; declaring form encoding
does not qualify other schema constraints.
