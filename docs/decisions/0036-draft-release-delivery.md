# 0036 — Deliver versioned drafts with GitHub Releases

- **Status:** accepted
- **Date:** 2026-10-16
- **Feature:** S28.7

## Context

The owner requested CD. Existing native release builds uploaded temporary run artifacts only.
Signing and physical-machine acceptance are still pending, so automatic public publishing would
precede the product's release criteria.

## Decision

Extend the existing tag workflow with a dependent delivery job. Use the runner's GitHub CLI and
built-in token; no new dependency or third-party publishing action. Require both platform builds,
add full E2E checks before signing, and publish assets only to a draft. Assemble uniquely named
downloads and SHA256 checksums from the current run's artifacts. Refuse existing releases rather
than replacing assets during a retry. Manual branch dispatch remains a dry run.

## Consequences

The owner can review a concrete draft before public publication. Unsigned drafts are clearly marked
for internal validation. Installer updates remain manual. Release runs retain full E2E testing on
each native runner; CI's sharding optimization is separate. Build jobs cannot write to repository
contents, and the delivery job receives no signing secrets. Tests cover assembly and workflow gates;
the first hosted run and signed downloaded-installer checks remain required rollout evidence.
