# Testing strategy

PLAN §5 and §11: test saving, isolation, recovery and real tasks separately on each platform; do not chase
coverage percentages. Every feature's acceptance criteria say how it is proven.

## Layers

| Layer        | Where                                | Runner                       | Typical subjects                                          |
| ------------ | ------------------------------------ | ---------------------------- | --------------------------------------------------------- |
| Unit         | `src/**/*.test.ts` (beside the code) | Vitest (`npm test`)          | Pure logic: path utils, state machines, rules, schemas    |
| Integration  | `tests/integration/**/*.test.ts`     | Vitest                       | Real filesystem in temp dirs, static server over loopback |
| End-to-end   | `tests/e2e/`                         | Playwright `_electron` (S02) | Launch the app, drive the UI, kill/relaunch, preview      |
| Packaged     | CI artefacts (S06)                   | Scripts + e2e on the build   | Workers load, arch inspection, offline, installers        |
| Manual       | `harness/MANUAL-CHECKS.md`           | Owner                        | IME, Retina/DPI, sleep/wake, signing, clean-machine runs  |
| User studies | `docs/research/`                     | Owner                        | PLAN §11 beginner metrics                                 |

## Conventions

- Tests that touch the filesystem use a fresh temp directory and clean up. Paths in tests are built with `path`
  APIs; include at least one name with Chinese characters and spaces in any path-related suite.
- Fault injection goes through injectable adapters (e.g. a `FileSystem` interface) rather than mocking Node globals,
  so ENOSPC, EPERM, EBUSY and locked files can be simulated on any OS.
- Fixtures live in `tests/fixtures/<scenario>/` and are real mini websites (multi-file, modules, JSON, images,
  broken scripts, hostile pages). Files that must keep CRLF are named `crlf-*` (see `.gitattributes`).
- E2E tests must not depend on network access.
- Platform-specific tests use `describe.runIf(...)` with the helpers from `src/platform`, and the reason is written
  in the test name.
- A flaky test is a bug: fix it or quarantine it with a linked feature, never delete it silently.

## Required failure cases (PLAN §11) — tracked in S26

Chinese characters and spaces in paths · external file changes · read-only directories · failed saves · JavaScript
infinite loops in preview · heavy console output · resource 404s · page network failures · recovery after forced
termination · recovery after deletion · reopening after renaming · preview attempts to read files outside the project.
