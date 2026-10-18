# Beta-readiness session notes (2026-10-18)

Findings from the cloud session that delivered S59 (PR #46, merged as 674a1d4). The session's scratch logs, backups
and probes were deleted after this file was written; everything worth keeping from them is below. The narrative entry
is harness/PROGRESS.md → Session 53.

## Outcome

| PR  | What                                                                                   | Result                                           |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| #46 | S59: owner decisions, OS-language UI, unsigned install steps, 0.1.0-beta.1, memory     | merged 674a1d4; hosted matrix green on 5be80d5   |
| #49 | S58.10 Windows CI timing flakes                                                        | closed: superseded by #48 (same S58.10, broader) |
| #48 | (other session) S58.10 REAL_IO helper, deterministic search test, preview hold in main | merged d211796                                   |

Owner answers recorded in docs/release/owner-decisions.md: H.1 macOS 13+ arm64 / Windows 10 22H2+ x64, test Mac
MacBook Pro M3 Pro (macOS 27.2); H.2 unsigned on both platforms for the beta; H.4 UI follows the OS language, ~30 h/week,
no Windows arm64 in v1; invite-only beta first; AI assistant in the beta; version 0.1.0-beta.1; Windows memory miss not
accepted (S59.5); S58.5 undecided.

## Root causes found (keep these)

1. **TypeScript worker idle stop broke Format Document (S59.5, removed).** A static
   `import { WorkerManager } from 'monaco-editor/languages/features/typescript/workerManager'` in
   `src/renderer/editor/monaco-setup.ts` stopped Shift+Alt+F from formatting CSS (history.spec "Format Document keeps
   the text…", hosted Windows + macOS, run 39094652477). Bisect in the Linux container with the Linux shortcut:
   b461a84 passes 9/9, 9f94c29 fails; removing only that import passes 9/9. Formatting via the Format button still
   worked, so the import changes how Monaco's language modules load, not the formatter. Do not import Monaco's
   private language-feature modules statically; an idle stop needs its own worker manager or an upstream API, behind
   an e2e of Format Document (docs/perf/memory.md → Remaining gap).
2. **Packaged launches outside `launchApp` follow the runner's OS language (S59.2).** authoring-offline and upgrade
   spawn the packaged binary themselves, so after the OS-language change they came up in English ("Colour: #c0392b"
   instead of "颜色：#c0392b"; upgrade expects "版本"). Fixed with `packagedLanguageArgs()` + `seedZhCnSettings()` in
   tests/e2e/launch.ts. Any new spec that spawns the app itself must use them. Hosted macOS passed with the pin
   (`-AppleLanguages (zh-CN)` after the app path, plus the seeded settings.json); which of the two layers did the work
   there is not proven.
3. **Windows runner timing flakes (S58.10, fixed by #48).** Real-I/O integration tests (ai-service, checkpoint-restore,
   checkpoint-store, release-workflow bash parse) hit Vitest's 5 s default; the S51.6 project-search yield test raced a
   free-running tick loop (measured slow − normal = −87); find-replace-in-files saw 2 preview loads instead of 1 because
   the renderer's 150 ms typing pings could arrive late (now held in main).

## Working in the Linux cloud container (for the next agent)

- Runs as **root**: 5 tests always fail here and pass on Windows/macOS — file-ops "moved into itself … junction",
  protected-folder "read-only attribute", save-pipeline ×2 and faults/save-faults "read-only file". The
  watcher mass-delete perf budget also misses here (1263 ms vs 500 ms). Compare against main before treating any of
  these as a regression; `npm run verify` cannot be green in this container.
- **e2e works under xvfb**: `xvfb-run -a npm run test:e2e -- tests/e2e/<spec>.ts` (`-- --no-build` reuses the build).
  `launchApp` adds `--no-sandbox` for root; specs that spawn the packaged binary themselves need `--no-sandbox` added
  locally (not committed) or they never open their DevTools port.
- **Shortcuts differ on Linux**: Monaco's Format Document is Ctrl+Shift+I there, not Shift+Alt+F. A spoofed
  `--user-agent` does not switch Monaco's keybindings. Reproduce Windows/macOS shortcut failures by swapping the key
  locally, and always run the base commit the same way to calibrate.
- CI artifact downloads (blob.core.windows.net) are blocked by the network policy; use job logs.

## Rebasing a PR whose backlog conflicts

Every feature commit touches harness/features.json, so a rebase onto a main that added features at the same place
conflicts on each of them. Resolve by keeping the upstream file and re-applying only this PR's session and features
(run at each conflict, then `git add harness/features.json && git rebase --continue`):

```js
// node resolve-features.mjs — base = upstream side (:2), plus the PR's S59 session/features from the commit (:3)
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const show = (rev) =>
  JSON.parse(execSync(`git show ${rev}:harness/features.json`, { encoding: 'utf8', maxBuffer: 1 << 26 }));
const ours = show(':2');
const theirs = show(':3');
for (const s of theirs.sessions)
  if (s.id === 'S59' && !ours.sessions.some((x) => x.id === 'S59')) ours.sessions.push(s);
for (const f of theirs.features) {
  if (!f.id.startsWith('S59.')) continue; // change the prefix to the PR's session
  const i = ours.features.findIndex((x) => x.id === f.id);
  if (i >= 0) ours.features[i] = f;
  else ours.features.push(f);
}
writeFileSync('harness/features.json', JSON.stringify(ours, null, 2) + '\n');
```

PROGRESS.md conflicts: keep both entries, newest on top, and renumber this PR's session entry after main's latest.
Check afterwards that every non-harness file main changed is identical to main and the PR's file set is unchanged.

## Still open before the invite-only beta

Owner: tick H.1 and H.4 (then S01.4 closes); run `npm run verify` and e2e on the Windows dev machine; S59.5 memory run
(harness/MANUAL-CHECKS.md#S59.5, pass ≤ 700 MB typical median); S36.1 live AI test; S29.1 / S29.2 acceptance runs with the
unsigned 0.1.0-beta.1 installers; S28.5 macOS upgrade; check the first Windows `npm run make` (Squirrel names the
package 0.1.0-beta1; Explorer shows FileVersion 0.1.0.1). Agent, after those runs: S29.3 fixes and the G7 review.
