# 0001 — Record architecture decisions

- **Status:** accepted
- **Date:** 2026-10-14

## Context

The project is built across many agent sessions with no shared memory. Choices made in one session (a library, a
security setting, a trade-off) must be visible and justified for later sessions and for the owner.

## Decision

Significant decisions are recorded as `docs/decisions/NNNN-short-title.md`, numbered sequentially, using this
template. "Significant" means: adding a runtime dependency or native module, choosing between libraries, any
security or data-safety setting, changing an invariant in AGENTS.md, or deviating from PLAN.md.

## Consequences

Agents read relevant decisions before changing an area. A superseded decision is not deleted; its status becomes
"superseded by NNNN".

---

Template:

```markdown
# NNNN — Title

- **Status:** proposed | accepted | superseded by NNNN
- **Date:** YYYY-MM-DD
- **Feature:** S..

## Context

## Options considered

## Decision

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)
```
