# Phase 1 / proposed v0.1 release readiness

**Review date:** 2026-09-30
**Verdict:** **Open — do not publish a v0.1 release yet.** This is an evidence
inventory for the current `development` branch, not a release announcement or
an enterprise support promise. The Phase 1 [nine-step exit gate](ROADMAP.md#exit-gate-1)
and a protected shared pilot remain open.

## Gate evidence

| Gate | Current evidence | Status |
|---|---|---|
| License and distribution authority | [Apache-2.0 text](../LICENSE) is tracked. `package.json` remains `private: true`, version `0.0.0`. Copyright ownership and authority to publish under that license need owner confirmation. | **Open** |
| Contributions and governance | [CONTRIBUTING.md](../CONTRIBUTING.md) describes local setup, tests, and contribution checks. No tracked governance/maintainer-contact policy or code of conduct was found. The owner must designate maintainers and decision/response paths before public release. | **Open** |
| Vulnerability reporting | No tracked `SECURITY.md` or equivalent private-reporting route was found. Publish a reporting contact/process and response expectations before inviting security reports. | **Open** |
| Public fixtures and workflow data | [Fixture policy](../fixtures/README.md) identifies fictional orders, revisions, and environments; the [reference workflow](../.github/workflows/reference-synthetic.yml) is read-only and formats synthetic envelopes only. The bounded scan below found no matches in tracked public fixtures/workflows. It is not a full secret audit or provenance proof. | **Partial** |
| Fresh checkout | A separate clean local clone of `development` at `d6aa2f4` installed 126 locked packages with Node 24.6.0 / npm 11.5.1 using `npm ci --no-audit --no-fund`. [Local setup](LOCAL_SETUP.md) records the disposable PostgreSQL procedure and synthetic demos. | **Pass for tested machine** |
| Offline and protocol tests | `npm run check` passed strict type checking and 37 test files / 431 tests. This includes the linked read-only MCP protocol contract tests; it does not prove a deployed MCP service or identity provider. | **Pass for implemented scope** |
| PostgreSQL tests | Against the loopback-only disposable `api-truth-test` PostgreSQL service, `npm run test:integration` passed 23 files / 215 tests in the clean clone. The fixed shared service was left running for concurrent local work. | **Pass for implemented scope** |
| Browser test | `npm run test:browser` passed 1 real Chrome test in the clean clone. It exercises search, selection, details, download, and unknown state against a host-supplied query fixture; it does not cover a live provider-to-publication path. The current [check workflow](../.github/workflows/check.yml) does not run this browser gate. | **Partial** |
| Full Phase 1 lifecycle | The [backlog](BACKLOG.md#d13-slices) leaves D13-S1 open: all nine steps and same-pin portal/MCP/export reads must pass together, including denied and revoked access. D12 live provider lookup, ordered facts, artifact provenance, and publication/query agreement remain open. | **Open** |
| Public release mechanics | No release tag or artifact has been established. Branch synchronization alone does not close the lifecycle, security, governance, and owner-approval gates. | **Open** |

These commands were run against a temporary clean clone of the tracked
`development` tip; the test clone was removed afterward. The PostgreSQL test
service was already healthy and was not reset or stopped. The result does not
include untracked local work or a protected enterprise deployment.

## Reproducible public-data scan

Run from the repository root. `git grep -l` sends matching **file names only**
to `wc -l`; no candidate content or secret value is printed. The scope is
intentionally limited to tracked `fixtures/` and `.github/workflows/` files.
Review any nonzero count privately before publication. On the reviewed
`development` tip, the scope contained **23 files** and each match count below
was **0**.

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
| Source analysis | Executable `typescript-express@0.2.0` analyzer for the [documented literal Express/TypeScript subset](../analyzers/typescript/README.md#support-matrix), including exact fluent route chains, with unknown facts and diagnostics retained. | Java/Spring has design fixtures only; other Node.js frameworks and dynamic constructs are not general support. |
| Delivery and environments | Durable local ledger/workers, synthetic seven-event workflow, host-attested reference bridge, GitHub raw-body signature verification, and verified push/PR **reconciliation triggers**. | No complete live GitHub provider lookup, monotonic branch ordering, production artifact provenance, authenticated installation host, or full protected CI/deployment connector. A webhook trigger is not a branch-state fact. |
| Contracts and reads | Evidence-gated OpenAPI 3.1, atomic local publication, authorized query, host-embedded portal and read-only MCP packages. | No turnkey authenticated deployment or nine-step provider-to-same-pin cross-surface proof. Browser fixture coverage is narrower than this gate. |
| Data and examples | Public tests and demos use synthetic source, events, and temporary database schemas. | Runtime payload/log ingestion, real customer source, private documentation, LLM summaries, and an enterprise pilot are outside the demonstrated scope. |

The bounded GitHub signature verifier does not remove the larger provider and
authentication gaps. Also review
the unpinned actions in `check.yml`, browser-test CI coverage, dependency/license
inventory, and release artifact contents as explicit hygiene work.

After the separate clean-clone audit above, the `development` tip received the
endpoint-scoped response-evidence slice. At that newer tip, a clean `npm ci`
and local checks passed **432 offline tests**, **216 PostgreSQL tests**, and
**1 real-browser test**. These checks still do not close the nine-step gate.

## Owner decision needed to close D13-S2

The repository owner must confirm the right to publish under Apache-2.0, name
the maintainers and private security-reporting route, approve the public fixture
and artifact audit, define supported platforms and release/rollback ownership,
and decide whether the open D12/D13-S1 gates have actually passed. Only then
should a version/tag or public release be created. Until that decision and the
full Phase 1 evidence exist, keep v0.1 unpublished and D13-S2 open.
