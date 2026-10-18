# Project history and retired documents

The pre-beta cleanup (2026-10-18) removed finished one-off documents: completed plans, studies and assessments, and
the archived S44/S45 code. This page keeps what is still binding from them. Each full text is still in git at commit
`674a1d4`; read one with `git show 674a1d4:<path>`. The session log is `harness/PROGRESS.md`. Decisions live in
`docs/decisions/`, and gate reviews in `docs/reviews/G*.md`.

## Standing design rules (from the retired UI documents)

From `docs/reviews/ui-ux-assessment-2026-10-16.md`, "Design direction for the refinement". These rules decide UI
changes, in this order:

1. **One job per region, one primary per state.** The welcome owns the window until a project exists. The preview
   column has one filled button that matches its state (Start / Refresh / Stop-when-hung). The problem card has one
   primary (the fix, else Go to code). A dialog has one primary at the bottom right.
2. **Stable chrome.** Nothing in the top bar, the tab strip or the preview header changes size or position because
   the user typed, saved or refreshed. Transient states are shown in a fixed slot (text and icon), and buttons appear
   only when the user must act.
3. **One name per feature, everywhere.** One term per feature in zh-CN and en, enforced on the catalogues by
   `src/renderer/i18n/terms.test.ts`:

| Feature                     | zh-CN                | en                      | Entry points kept                           |
| --------------------------- | -------------------- | ----------------------- | ------------------------------------------- |
| Local history               | 历史版本             | History                 | rail · editor header · palette              |
| Beginner lessons            | 课程                 | Lessons                 | rail · palette                              |
| Problems                    | 问题                 | Problems                | status strip toggle · rail · palette        |
| Ask AI (chat, no code edit) | 问 AI                | Ask AI                  | rail · problem card · annotations · palette |
| AI edit (changes code)      | AI 修改              | Edit with AI            | editor status row · context menu · palette  |
| AI fix (problem)            | AI 修复              | Fix with AI             | problem row and card                        |
| AI suggestions (ghost text) | AI 建议              | AI suggestions          | status row toggle · settings                |
| AI project changes (agent)  | 修改项目             | Change project          | chat mode                                   |
| Crash recovery              | 恢复上次未保存的修改 | Recover unsaved edits   | dialog on start only                        |
| External change             | 文件在外部被改动     | Changed outside NoobIDE | banner only                                 |

Non-goals, so later work does not reopen them:

- **No key feature moves into a menu** (owner rule 2026-10-16). Annotate and the AI chat's three Add-context buttons
  always stay visible.
- AI off removes every AI surface (decision 0025).
- Nothing floats over the native preview (decisions 0009/0019). CSS can imitate the glass _material_ but not its
  optics, and no CSS layer can cover or blur the preview's `WebContentsView` (from the Liquid Glass study,
  `docs/product/liquid-glass-study.md`; the current design contract is `docs/product/calm-design-spec.md`, ADR 0034).
- Screenshots prove layout only. Check UI at 1280×800 and 640×480, in both languages and both themes (from
  `docs/reviews/interface-assessment-2026-10-14.md`).

**AI proposal tones** (S48.8, item B8 of `docs/product/ui-ux-improvement-plan.md`): each proposal state has one tone.
Pending gets the only prominent border and the single primary action. Running is neutral with the status dot.
Applied, failed and rejected use the `--ok` / `--danger` / `--muted` soft fills with an icon and a word. The input
(file, range) and the result (lines changed, save state) are disclosures, closed by default.

**Motion** (S47, Track A, §5 of the same plan): compositor-only motion. These were deliberately not copied from the
Claude Desktop study (§6):

- no pressed-state scaling or overshoot springs;
- no rAF ambient glow, shimmer or halo;
- no Framer Motion, Tailwind or lucide;
- no token gauges or model switchers;
- no voice or sound;
- no iframe sandbox shield (the preview is a native view);
- no CDN Storybook (offline rule).

**Open owner questions from that plan** (§8; defaults still in force unless decided):

- Canvas temperature: warm neutrals stay.
- Auto-dismiss of confirmations: no timers (PLAN §3).
- Density default: comfortable.
- `/` commands versus `@file` mentions.

**Ideas noted, not planned:**

- tab drag-to-reorder (needs the 4 px dead-zone drag model);
- a floating selection pill for Explain / Edit with AI;
- a bottom-sheet chat in narrow windows;
- native Mica/vibrancy behind `--bg`;
- a `nativeTheme.prefersReducedTransparency` bridge, if Windows does not report `prefers-reduced-transparency`
  (MANUAL-CHECKS S40.8 step 2);
- icons in menus, and context menus without shortcuts.

## Product direction (from the M19 gap review)

From `docs/reviews/mainstream-ide-gap-2026-10-17.md`. Its §4 plan became S51–S57, all done; see the backlog and ADRs
0039–0041. §5 "Not recommended", which still holds:

- **Copying VS Code's settings and keybinding surfaces.** PLAN §3 forbids moving controls by inferred skill level,
  and §1 names configuration load as a beginner failure mode. Add settings one at a time, with evidence.
- **An extension marketplace or VS Code extension compatibility.** Monaco cannot host extensions, and the
  Marketplace terms exclude other products (PLAN §5).
- **A full DAP debugger before run management is stable** (PLAN §12 v0.5 entry criteria).
- **Replacing the custom workbench with Theia/Code-OSS.** The differentiators are the custom parts: the isolated
  preview, explained problems, never-overwrite and the recovery UX.

## Archived S44/S45 HIG code (removed)

`docs/archive/s44-s45-hig/` held the files of commit `a110002`, whose edits to existing files were never committed. It
was kept as reference for S45.9, which S50.1 superseded. All of it is accounted for:

- `Sheet` was rebuilt as `src/renderer/workbench/Sheet.tsx` (S49.1 / S50.1, with the shared `SheetFrame`, the height
  cap and the covered-sheet blur).
- `Notice` was rebuilt by S50.2.
- `PreviewMoreMenu` and `AddContextMenu` were dropped by owner rule (key features stay visible).
- `header-fit.ts`, the per-area CSS and the archived e2e specs were replaced by the S49.6 container-query ladder and
  the calm stylesheet.

Left open in the HIG notes: with no AI key, the composer stays visible with Send disabled; a disabled switch or
checkbox uses opacity 0.6.

## Beta-readiness session (2026-10-18): S59, PRs #46, #48, #49

### Outcome

| PR  | What                                                                                   | Result                                           |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| #46 | S59: owner decisions, OS-language UI, unsigned install steps, 0.1.0-beta.1, memory     | merged 674a1d4; hosted matrix green on 5be80d5   |
| #49 | S58.10 Windows CI timing flakes                                                        | closed: superseded by #48 (same S58.10, broader) |
| #48 | (other session) S58.10 REAL_IO helper, deterministic search test, preview hold in main | merged d211796                                   |

Owner answers recorded in docs/release/owner-decisions.md: H.1 macOS 13+ arm64 / Windows 10 22H2+ x64, test Mac
MacBook Pro M3 Pro (macOS 27.2); H.2 unsigned on both platforms for the beta; H.4 UI follows the OS language, ~30 h/week,
no Windows arm64 in v1; invite-only beta first; AI assistant in the beta; version 0.1.0-beta.1; Windows memory miss not
accepted (S59.5); S58.5 undecided.

### Root causes found (keep these)

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

### Working in the Linux cloud container (for the next agent)

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

### Rebasing a PR whose backlog conflicts

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

### Still open before the invite-only beta

Owner: tick H.1 and H.4 (then S01.4 closes); run `npm run verify` and e2e on the Windows dev machine; S59.5 memory run
(harness/MANUAL-CHECKS.md#S59.5, pass ≤ 700 MB typical median); S36.1 live AI test; S29.1 / S29.2 acceptance runs with the
unsigned 0.1.0-beta.1 installers; S28.5 macOS upgrade; check the first Windows `npm run make` (Squirrel names the
package 0.1.0-beta1; Explorer shows FileVersion 0.1.0.1). Agent, after those runs: S29.3 fixes and the G7 review.
