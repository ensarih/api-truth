# Analyzer process protocol

**Protocol status:** experimental until the Java analyzer passes the shared conformance suite.

Analyzer plugins are isolated, read-only processes. The host sends one UTF-8 JSON
`AnalyzerRequest` document on standard input and then closes the input stream. The
plugin writes exactly one UTF-8 JSON `AnalyzerResult` document to standard output.
Human-readable diagnostics may use standard error; they must not be mixed into the
JSON output.

Both documents use `exchange_version: "1.0.0"`. Their executable schemas and
semantic validators are exported by `@api-truth/ir` as `AnalyzerRequestSchema`,
`AnalyzerResultSchema`, `parseAnalyzerRequest`, and `parseAnalyzerResult`. A host
must validate the request before launch and validate the result before accepting
any extracted facts.

## Process contract

1. The host chooses the executable and starts it with the service source root as a
   controlled, read-only working tree. The process receives no command arguments
   containing repository or database targets.
2. The plugin reads one request from standard input. It must honor `limits`,
   `extraction_mode`, `changed_paths`, and the supplied resolution inputs.
3. The plugin emits one result whose request, analyzer, source, IR, identity, and
   exchange identities match the request and configured plugin.
4. A valid `success`, `partial`, or `failed` result is a completed protocol exchange
   and exits with status 0. Startup faults, malformed input, crashes, timeouts, or
   inability to serialize a schema-valid result exit nonzero and may write a terse
   diagnostic to standard error.
5. The host enforces the request timeout and output byte limit. It discards output
   that is oversized, malformed, version-incompatible, or semantically invalid.

The result carries structured diagnostics and coverage. A plugin must use
`partial` or `failed` with incomplete coverage when it cannot analyze the entire
requested scope; it must not invent an endpoint or silently present partial work
as complete.

## Execution boundary

- `execution_policy.network_access` is always `false` and `side_effects` is always
  `none`. Plugins must not access the network, mutate the source tree, start
  services, query databases, or call language models.
- Every source path is relative to the controlled service tree and must satisfy the
  normalized path contract. `..`, absolute paths, and undeclared roots are invalid.
- A classpath resolution input identifies an already supplied Maven artifact by
  coordinate and digest. The plugin must not download it.
- Plugins may create bounded temporary data only in a host-provided scratch area;
  that area is outside the source tree and is removed after the process exits.
- Standard error must exclude source bodies, credentials, environment values, and
  other secrets. Structured diagnostics belong in the result.

## Compatibility

The host selects a plugin only when it supports the exact `exchange_version` and
`ir_version` in the request. Additive implementation changes that do not change
JSON behavior keep the same version. A schema or semantic contract change requires
a new version and parallel host support during migration. Unknown fields remain
invalid because the D03 schemas use closed objects.

The first Java implementation belongs to Phase 2. It will ship with a pinned JDK
and build wrapper and must pass the same request/result conformance suite before
this protocol is declared stable. Phase 1 checks therefore document Java runtime
availability but do not invoke or require the machine's system JDK.
