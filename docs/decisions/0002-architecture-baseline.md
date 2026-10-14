# 0002 — Architecture baseline from PLAN.md

- **Status:** accepted
- **Date:** 2026-10-14
- **Feature:** S00.1

## Context

PLAN.md §5–§8 compares Electron + Monaco, Eclipse Theia and a Code-OSS fork for a solo developer shipping a
static-web beginner IDE on macOS arm64 and Windows x64.

## Decision

- **Electron + React + TypeScript + Monaco**, one repository, one codebase for both platforms.
- Modules as in PLAN §6: `main`, `platform`, `preload`, `renderer`, `workspace`, `preview`, `diagnostics`,
  `recovery`, `shared`, connected through interfaces; no microservices, backend or extension SDK in v1.
- Preview = `WebContentsView` + loopback static server; user pages get no IDE privileges.
- Local history = file snapshots + JSON index in app data; no database.
- Packaging with an established tool (Electron Forge expected), confirmed in S02 (decision 0004).
- Toolchain pinned in session 0: TypeScript 6.0.3, Vitest 5.0.4, ESLint 10.12 + typescript-eslint 8.71.2,
  Prettier 3.9.10, `@types/node` 24.

## Consequences

- Workspace management, saving, recovery, preview and diagnostics are ours to build and test (the bulk of the
  roadmap).
- Reassess Theia / Code-OSS only if broad language support, remote development and a full extension ecosystem become
  requirements (PLAN §12) — that would be a new decision, not an incremental change.
