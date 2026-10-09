# Bounded Node.js onboarding inventory

`src/inventory.ts` provides `inventoryNodeService`, an advisory setup-time inventory for one explicitly selected service tree. The caller supplies production entrypoint paths relative to that tree and may supply authoritative API document paths relative to the same tree. It does not enumerate repositories, branches, package installations, or URLs, and it never executes service code.

The inventory follows only bounded literal relative imports and exports from the supplied entrypoints. Framework evidence must have module-scope registration syntax: Express app/router setup and routes, `swagger-express-mw` creation, or a routing-controllers server registration whose literal `controllers` array names a uniquely resolved class binding decorated by the package's actual `Controller` or `JsonController` export. Controller identity follows the selected identifier's import and re-export chain; another reachable class with the same name cannot satisfy it. Decorated but unregistered classes do not count. Non-identifier array entries, unknown identifiers, and framework-shaped calls inside functions or nested blocks stay unresolved. Dynamic imports and computed/nested `require` calls are not followed; they produce unresolved diagnostics. This conservative rule avoids treating dead code or a shadowed local identifier as production registration.

Entrypoints are explicit production selections. Paths under `test`, `tests`, `fixture`, `fixtures`, `__tests__`, or `__fixtures__`, and filenames ending in `.test.*` or `.spec.*`, are rejected as entrypoints. The inventory reads only owner-selected JSON/YAML documents. A structurally recognizable Swagger 2 document requires `info.title`, `info.version`, and an object-valued `paths`. OpenAPI 3.0.x has an available bounded document adapter and is classified supported; OpenAPI 3 versions outside 3.0.x are classified unsupported. Both require the same basic fields. Invalid or unknown dialects remain unresolved. A missing or invalid selected document keeps the overall inventory unresolved even when a source framework registration is found. The inventory does not create endpoint routes, infer a selected adapter, or apply framework priority.

## Local command

The offline command takes an explicit project root, one contained service root, and one or more entrypoints and/or selected documents. Repeat `--entrypoint` and `--document` for additional selections:

```sh
npm run inventory:nodejs -- --project-root /path/to/project --service-root services/orders --entrypoint src/main.ts --document api/openapi.json
```

It prints the inventory JSON to stdout. Failures use one sanitized message on stderr and return a non-zero status. The command does not execute service code, access the network, enumerate branches, or print source text or route contents. The analyzer is also available as the `@api-truth/analyzer-nodejs-swagger2-document/inventory` package export.

The result contains an explicit `supported`, `unsupported`, `mixed`, or `unresolved` classification, evidence paths and source spans or document pointers, content digests, safe diagnostic codes, the selected tree digest, and a deterministic fingerprint over selection, limits, signals, and content. Evidence and classifications are advisory: static reachability does not prove that a production process starts the entrypoint, that runtime configuration agrees, or that a framework version is supported. Unrecognized source forms and exhausted bounds remain unresolved.

Default bounds are 10,000 directories, 2,000 service files, 16 entrypoints, 16 selected documents, 1,000 reachable source files, 4,000 literal import edges, 100,000 AST nodes, and 2 MB per selected API document. The shared source reader also caps cumulative selected-tree input at 10 MB, rejects symlinks and invalid UTF-8, and skips dependency and VCS directories. Callers may tighten or change the inventory count bounds through the `limits` option.
