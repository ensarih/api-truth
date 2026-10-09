# Configured analyzer host

`@api-truth/analyzer-host` dispatches one explicit, exact compiled-in profile.
It is an execution boundary for existing offline analyzers, not framework
detection and not a source-selected plugin loader. No project build, startup,
network request or branch enumeration is performed.

## Profiles

| Adapter | Version | IR |
|---|---|---|
| typescript-express | 0.4.0 | 1.0.0 |
| nodejs-routing-controllers | 0.7.0 | 1.0.0 |
| nodejs-swagger2-document | 0.13.0 | 1.1.0 |
| nodejs-swagger-express-mw | 0.32.0 | 1.1.0 |

These are bounded profiles; listing one does not certify the whole framework.
The optional configuration IR field defaults to legacy 1.0.0, so Swagger
selections require explicit 1.1.0. Unknown versions, unknown selection fields
and unsupported wire combinations fail before source access.

```ts
const analyzer = createConfiguredAnalyzer({
  projectRoot: immutableCheckout,
  selection: service.analyzer,
});
const result = await analyzer.analyze(digestBoundRequest);
```

The host freezes copies of registry identities and detaches the selection,
request, adapter input and result. An adapter cannot redirect the request's
service/revision or replace its protocol identity and pass result validation.
Errors use fixed codes without source or credential values. Existing adapter
containment, resource limits, declaration authority and diagnostic behavior
remain in force.

## Orchestration boundary

The host can fill D08's analyzer port. The resolver remains host-supplied and
must produce the selected profile's exact digest-bound resolution inputs.
Swagger middleware IR 1.1 baseline analysis is tested through D08 and D06.
Complete multi-input incremental updates and configuration-bound profile
options remain separate backlog gates.

Signed runtime captures may be used by the standalone middleware analyzer with
an external trusted public key. D08 currently rejects runtime observations:
receipts can change output independently of immutable source bytes and need a
separately pinned job input before they can participate in durable reuse.
This prevents an unpinned receipt from silently changing a cached contract.
