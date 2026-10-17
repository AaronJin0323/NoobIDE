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

## Commands

| Command                     | What it does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm test`                  | Unit + integration tests (Vitest)                                                                |
| `npm run test:e2e`          | `electron-forge package`, then Playwright against the production bundles (`-- --no-build` skips) |
| `npm run selftest:packaged` | Runs the packaged app in `out/` with `NOOBIDE_SELF_TEST=1`: Monaco workers must answer           |
| `npm run selftest:dev`      | Same probe through `electron-forge start` (Vite dev server)                                      |
| `npm run verify -- --e2e`   | All gates including e2e                                                                          |

E2E uses the stock Electron binary because the packaged app has the `--inspect` fuse off (decision 0005); the
self-test is how the shipped binary itself is checked. On Linux without a display both scripts wrap themselves in
`xvfb-run`; as root (containers) they add `--no-sandbox`, which normal Windows/macOS runs never need.

## Conventions

- Tests that touch the filesystem use a fresh temp directory and clean up. Paths in tests are built with `path`
  APIs; include at least one name with Chinese characters and spaces in any path-related suite.
- Fault injection goes through injectable adapters (e.g. a `FileSystem` interface) rather than mocking Node globals,
  so ENOSPC, EPERM, EBUSY and locked files can be simulated on any OS.
- Fixtures live in `tests/fixtures/<scenario>/` and are real mini websites (multi-file, modules, JSON, images,
  broken scripts, hostile pages). Files that must keep CRLF are named `crlf-*` (see `.gitattributes`).
- E2E tests must not depend on network access.
- E2E tests must not depend on the window size: Monaco renders only the visible lines, and the Windows CI runner's
  1024×768 display gives a much shorter editor than a Mac. Read editor text with `documentText()` and focus the
  editor with `focusEditor()` (tests/e2e/project.ts), not by asserting on or clicking `.view-lines`. Reproduce a
  short window locally with `NOOBIDE_E2E_WINDOW=1024x660 npm run test:e2e`.
- Platform-specific tests use `describe.runIf(...)` with the helpers from `src/platform`, and the reason is written
  in the test name.
- A flaky test is a bug: fix it or quarantine it with a linked feature, never delete it silently.
- Hosted runners (S06.5, S06.6) have few cores and deschedule any process at any time, for seconds. A test must not
  assume that a fixed delay, a page's own timer or a "load then click" sequence orders events the way it does on a
  dev machine: wait for the state you need (a log line, a DOM attribute, a snapshot that walked) and let the test
  start what it measures (the busy loop of `tests/fixtures/预览 快照/忙碌.html` is started by the test, not by the page).
  A per-call latency budget is judged on the best of several batches (`completion-latency.test.ts`): contention adds
  time to a sample and never removes any, so the quietest batch measures the code. Product thresholds are never
  raised to make a runner pass.

## CI shards and timing (S06.5)

CI runs two E2E shards on separate runners for each OS; each desktop keeps one Playwright worker.
Reproduce either selection with `npm run test:e2e -- --shard=1/2` or `--shard=2/2`.
After a successful build, `npm run test:e2e -- --no-build --shard=2/2` reuses it. Never run these
commands concurrently in the same checkout: they share build output and a desktop.

Each shard uploads `e2e-report-<target>-<shard>` containing `results.json`, including durations and
failures. Compare job queue delay separately from execution time. The required checks `windows-x64`
and `macos-arm64` now aggregate all four jobs; installers are produced once per OS from the tested
package. A missing or failed shard cannot pass either required check. See ADR 0035 for the baseline
and the first hosted-run comparison procedure.

## Required failure cases (PLAN §11) — tracked in S26

Chinese characters and spaces in paths · external file changes · read-only directories · failed saves · JavaScript
infinite loops in preview · heavy console output · resource 404s · page network failures · recovery after forced
termination · recovery after deletion · reopening after renaming · preview attempts to read files outside the project.
