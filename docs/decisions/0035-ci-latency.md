# 0035 — CI latency and isolated E2E shards

- **Status:** accepted
- **Date:** 2026-10-16
- **Feature:** S06.5

## Context

GitHub run 38889623114 took 51m 56s. The macOS job started 28m 57s after run creation and spent
20m 42s in E2E (including packaging); Windows E2E took 15m 54s. Verify took 1–2 minutes and npm
installation about 20 seconds. The inspected checkout had 327 E2E tests in 58 files; a concurrent completion change added another test.

## Options considered

More workers on the same desktop risk focus, clipboard and native-menu interference. Dropping tests
from PR checks weakens coverage. Adding many runners can worsen queue pressure.

## Decision

Use two Playwright file-level shards per OS, each on its own runner with one worker. Preserve
fullyParallel: false and retries: 0. Both shards run verify and fault checks. Shard 1 makes installers
from its tested package using Forge's supported --from-package flag and inspects architectures.
Only macOS needs the additional next-version package used by the macOS upgrade test.

Initial local Windows shard runs passed (162 each, four platform skips total) in 3.2m and 8.5m.
The 2.8m startup-under-load test was in the longer shard alongside preview isolation/flood checks.
Rename its unchanged file to app-startup-restore.spec.ts so Playwright's file ordering puts it in
the first shard; the selection test checks these costly suites stay apart. This suggests roughly
6m and 5.7m locally, but those are estimates, not measured hosted timings.

Cancel superseded runs on the same ref, including main. Keep release workflow cancellation disabled.
Save a JSON E2E report on every shard for timing analysis. Preserve the existing windows-x64 and
macos-arm64 required status names as aggregate gates, each of which fails unless the entire matrix
succeeds. Installer artifacts alone are not evidence that CI passed.

## Consequences and rollout

The complete test set still runs on both platforms. Tests prove the two real Playwright selections
have no overlap and their union equals the unsharded suite. Workflow tests cover gating, artifact
names, cancellation and package reuse. Windows packaging and E2E can be checked locally; macOS
execution and end-to-end latency need the first hosted run. No speedup is claimed before that run.

The live Protect main ruleset requires windows-x64 and macos-arm64. Their names are preserved by
the aggregate jobs, so no ruleset change is needed. Both gate jobs use always() and explicitly fail
for any result other than success, including cancellation and skipped prerequisites.

Compare three completed runs with the baseline above: record job startup delay separately from
test execution and inspect e2e-report-<target>-<shard>/results.json for slow files. Two shards add
runner setup/build overhead and may queue if account concurrency is exhausted; if this dominates,
investigate account usage/runner availability before increasing shard count further. Cancelled runs
are expected when another push supersedes them. Public release acceptance remains unchanged.
