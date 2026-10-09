# Phase 1 / proposed v0.1 release readiness

**Review date:** 2026-10-09
**Verdict:** **Open — do not publish a v0.1 release yet.** This is an evidence
inventory for the current `development` branch, not a release announcement or
an enterprise support promise. The Phase 1 [nine-step exit gate](ROADMAP.md#exit-gate-1)
and a protected shared pilot remain open. This refresh updates the capability
inventory and records a clean source export at `2ac62e4`. This is not a full
security/release audit. The September clone audit remains historical.

## Gate evidence

| Gate | Current evidence | Status |
|---|---|---|
| License and distribution authority | [Apache-2.0 text](../LICENSE) is tracked. `package.json` remains `private: true`, version `0.0.0`. Copyright ownership and authority to publish under that license need owner confirmation. | **Open** |
| Contributions and governance | [CONTRIBUTING.md](../CONTRIBUTING.md) describes local setup, tests, and contribution checks. No tracked governance/maintainer-contact policy or code of conduct was found. The owner must designate maintainers and decision/response paths before public release. | **Open** |
| Vulnerability reporting | [SECURITY.md](../SECURITY.md) defines the private GitHub route; the repository setting was enabled and verified on 2026-10-09. No response-time or supported-release commitment is published. Operational ownership and disclosure handling remain release gates. | **Partial** |
| Public fixtures and workflow data | [Fixture policy](../fixtures/README.md) identifies fictional orders, revisions, and environments; the [reference workflow](../.github/workflows/reference-synthetic.yml) is read-only and formats synthetic envelopes only. The scan below is historical; repeat a full fixture/artifact and provenance review before publication. | **Partial** |
| Fresh checkout | A separate clean local clone was checked on the September tip with Node 24.6.0 / npm 11.5.1. At `2ac62e4`, an isolated tracked-tree export passed clean `npm ci` with zero audited vulnerabilities; a separate Git-clone release audit remains open. [Local setup](LOCAL_SETUP.md) records the disposable PostgreSQL procedure and synthetic demos. | **Open for current tip** |
| Offline and protocol tests | At `2ac62e4`, the isolated tracked-tree export passed typecheck and 92 files / 1,345 offline tests. | **Pass for the recorded implemented scope** |
| PostgreSQL tests | At `2ac62e4`, the isolated export passed 32 files / 280 PostgreSQL tests against the loopback-only disposable service. | **Pass for the recorded implemented scope** |
| Browser test | At `2ac62e4`, six Chrome tests passed, including selected-service and cross-service keyword search, exact pinned contract loading, separate inference selection and delayed-response rejection. The [check workflow](../.github/workflows/check.yml) now includes an isolated Playwright Chromium job; its first CI execution must pass before closing this hygiene slice. | **Partial** |
| Full Phase 1 lifecycle | The [backlog](BACKLOG.md#d13-slices) leaves D13-S1 open: all nine steps and same-pin portal/MCP/export reads must pass together, including denied and revoked access. D12 live provider lookup, ordered facts, artifact provenance, and publication/query agreement remain open. | **Open** |
| Public release mechanics | No release tag or artifact has been established. Branch synchronization alone does not close the lifecycle, security, governance, and owner-approval gates. | **Open** |

The September results came from a separate clean clone. The October
`2ac62e4` results came from an isolated export of the exact tracked source tree
with a clean dependency installation. The PostgreSQL test
service was already healthy and was not reset or stopped. The result does not
include untracked local work or a protected enterprise deployment.

## Reproducible public-data scan

Run from the repository root. `git grep -l` sends matching **file names only**
to `wc -l`; no candidate content or secret value is printed. The scope is
intentionally limited to tracked `fixtures/` and `.github/workflows/` files.
Review any nonzero count privately before publication. On the reviewed
`development` tip, the scope contained **23 files** and each match count was
**0**. That result is historical rather than current evidence; rerun the scan
against the release candidate.

```sh
git ls-files -- fixtures .github/workflows | wc -l
git grep -I -l -E -e '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk_(live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{32,}' -- fixtures .github/workflows | wc -l
git grep -I -l -E -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?://[^ /]+:[^ @/]+@' -- fixtures .github/workflows | wc -l
git grep -I -l -E -e '(corp|internal|private)\.[A-Za-z0-9.-]+|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}' -- fixtures .github/workflows | wc -l
```

The scan checks common key/token shapes, email or URL credentials, and some
private-host/IP patterns. It cannot prove the absence of every credential,
private hostname, licensed third-party content, or personal datum. The owner
must review the complete public distribution and generated release artifacts
before publication. Do not paste suspicious matches into issues or logs.

## Support statement for a future release

| Area | Current bounded state | Excluded or still open |
|---|---|---|
| Source analysis | Versioned bounded profiles include `typescript-express@0.6.0`, `nodejs-routing-controllers@0.9.0`, standalone Swagger 2 `0.15.0`, Swagger middleware `0.33.0`, and OpenAPI 3.0 `0.2.0`. The offline [inventory CLI](../analyzers/nodejs/INVENTORY.md) classifies explicitly selected service trees; unsupported and unresolved constructs remain diagnostic. | These profiles are not general framework support. OpenAPI 3.1, broader decorator/schema conformance, unconfigured framework wrappers, and deployed startup proof remain open. Java/Spring remains planned. |
| Delivery and environments | The local Git connector materializes immutable configured service roots, and selected source/document profiles reach D08 baseline and branch-update persistence in local PostgreSQL tests. Synthetic event, serving-state, and reconciliation workflows remain available. | No live Git provider lookup/webhook host, production artifact provenance service, authenticated installation host, or protected CI/deployment connector. A webhook trigger is not a branch-state fact. |
| Contracts and reads | Evidence-gated OpenAPI 3.1 publication, authorized query, read-only portal/MCP, current-pin metadata observations, and cross-service keyword candidates in one explicit environment. Selected-operation semantic suggestions use declared document text and eligible source identifiers only after explicit user action. | No turnkey deployment or complete nine-step provider-to-same-pin proof. Semantic suggestions are inferred, unreviewed, non-normative, and depend on a configured external provider; keyword search itself makes no model call. |
| Data and examples | Public tests and demos use synthetic source, events, and temporary database schemas. Sanitized metadata observations are available through explicit signed-file import and current authorized environment pins. | No real customer source or logs, private documentation, live provider-backed operation, durable semantic review/index, or enterprise pilot is demonstrated. |

The bounded GitHub signature verifier does not remove the larger provider and
authentication gaps. Also review
the pinned-action and browser CI results, dependency/license inventory, and release artifact contents as explicit hygiene work.

The recorded counts apply only to `2ac62e4`. Rerun checks against the eventual
release candidate. These passes do not close the nine-step gate or protected
pilot requirements.

## Owner decision needed to close D13-S2

The repository owner must confirm the right to publish under Apache-2.0, name
the maintainers and private security-reporting route, approve the public fixture
and artifact audit, define supported platforms and release/rollback ownership,
and decide whether the open D12/D13-S1 gates have actually passed. Only then
should a version/tag or public release be created. Until that decision and the
full Phase 1 evidence exist, keep v0.1 unpublished and D13-S2 open.
