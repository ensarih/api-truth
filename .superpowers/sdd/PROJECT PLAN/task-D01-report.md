# D01 completion report — pilot constraints and architecture decisions

**Task:** D01  
**Status:** complete  
**Worktree / branch:** `.worktrees/api-truth-development` / `development`

## Delivered

- Added [D01 pilot constraints and evidence boundaries](../../../docs/decisions/D01-pilot-constraints.md), indexed from `docs/decisions/README.md`.
- Recorded a provisional TypeScript/Node.js and Java support matrix: Express and Spring MVC/Spring Boot are explicitly provisional, GitHub Actions is the public reference CI, and enterprise CI/CD remains provider-neutral.
- Added synthetic, internally consistent branch/environment cases for PR preview, merge without deployment, UAT-only deployment, promotion, failed-before-rollout, failed partial rollout with a mixed active revision set, unknown serving state, rollback request, and confirmed rollback.
- Added a 83-row provisional event/log inventory. Each row identifies its source/owner, sensitivity classification, and intended consumer. It covers common envelopes, PR/merge events, deployment/reconciliation, URL mapping/traffic observations, and sanitized examples.
- Recorded the required distinctions: source intent versus deployment attempt versus authoritative serving state; mixed/unknown active revisions; exposure versus traffic observations; and rollback request versus confirmed rollback.

## Verification

| Command | Result |
|---|---|
| `git diff --check` | Passed with no output. |
| Local Markdown link check over `docs/decisions/README.md` and `docs/decisions/D01-pilot-constraints.md` | `Checked 2 documentation files; all local Markdown links resolve.` |
| Inventory structure check | `Validated 83 inventory rows; each has field, scope, source/owner, sensitivity, and consumer columns.` |
| Required-content scan | Found the provisional Express/Spring choices, GitHub Actions reference CI, UAT/staging/production mapping, failed partial rollout, separate rollback states, and active revision inventory fields. |

## Concerns / follow-up inputs

- The framework choices and pilot support boundaries remain provisional pending the real pilot service inventory.
- The enterprise CI/CD provider, authoritative serving-state source, log backend/field availability, and data/retention policy remain installation decisions.
- D03 owns executable schema shapes, cardinality, validation, versioning, and migration rules; this document intentionally preserves only the field inventory and semantic boundaries.

