# OpenAPI 3.0 document adapter

`openapi3-document` version `0.2.0` accepts one explicitly selected, contained JSON or YAML document and produces IR `1.1.0`. It supports OpenAPI `3.0.x` only. OpenAPI 3.1 fails explicitly; a separate 3.1 profile remains backlog work.

The adapter extracts path operations, path and operation parameter overrides, request bodies, media-specific responses, response headers, reusable components, supported schema fields, local component references, security scheme declarations, and server declarations. Server URLs are exposure claims; they never become application route prefixes. No source code runs, no network is accessed, and external references fail.

Facts from the document have source-pointer evidence and are declared. Specification defaults, such as omitted parameter serialization settings, are inferred. Missing or unsupported schema references leave media declarations visible but do not create an empty schema claim. Conflicting parameters and schema/content declarations are withheld with diagnostics. Unsupported security, serialization, encoding, and server forms make coverage incomplete. Application runtime binding remains unverified in this document-only profile.
