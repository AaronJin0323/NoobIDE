# NoobIDE v1 — one-page scope

- **Status:** draft for owner review (S01.1) · **Date:** 2026-10-14 · **Source of truth:** [PLAN.md](../../PLAN.md)
- If this page and PLAN.md disagree, PLAN.md wins; fix this page.

## Who it is for

People with **≤ 3 months of web-development experience** who build personal homepages and simple interactive pages
([PLAN §1](../../PLAN.md)). They can type and use a file manager but have never configured a toolchain. Chinese-first
UI with English available (assumption, owner to confirm — H.4).

**The promise:** in ten minutes a beginner can _create a page → edit → see the result → understand an error → fix
it → recover a change → continue next time_, without help ([PLAN §2](../../PLAN.md)). v1 competes on how many
beginners finish that loop, not on matching VS Code or IntelliJ.

## Supported projects

Ordinary static websites: multiple HTML/CSS/JS files, images, fonts, local JSON, browser JavaScript and ES Modules
with relative paths ([PLAN §1](../../PLAN.md), [§4 “Running webpages”](../../PLAN.md)). No build step, no Node.js
install required.

## In scope for v1 ([PLAN §4](../../PLAN.md))

| Area            | v1 includes                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Projects        | Create from 3 templates, open any folder, recent projects, reveal in Finder / File Explorer      |
| Files           | Tree, create file/folder, rename, delete to OS trash; never silently overwrite                   |
| Editing         | Tabs, highlighting, indent, comment, find/replace, undo/redo, IME, ~16px start size, light/dark  |
| Code assistance | Monaco's built-in HTML/CSS/JS completion, hover, formatting, static diagnostics (validated only) |
| Saving          | Autosave by default + manual save, explicit status, external-change conflicts with diff + choice |
| Running pages   | Loopback static server inside the project, entry page choice, relative paths, ES Modules, JSON   |
| Preview         | Isolated embedded preview, auto/manual refresh, stop, desktop/mobile width, open in browser      |
| Errors          | Console, JS exceptions, resource failures, go to line, 10–15 explained problem types (PLAN §9)   |
| Recovery        | Undo · crash-recovery journal (≤ 2 s) · per-file local history with diff before restore          |
| Beginner help   | 3 templates, skippable walkthrough in a real project, file-role hints, one unguided task         |
| Distribution    | macOS arm64 DMG, Windows x64 installer, local logs, version info, manual upgrade instructions    |

Every capability above is claimed only after a test or validation scenario proves it ([PLAN §4](../../PLAN.md)).

## Explicitly out of scope for v1

| Excluded                                   | Defined in                                     | Earliest planned                            |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------- |
| React / Vue / framework projects, SSR      | [PLAN §1](../../PLAN.md), [§4](../../PLAN.md)  | v0.4 ([PLAN §12](../../PLAN.md))            |
| Node.js backends, npm management, scripts  | [PLAN §1](../../PLAN.md), [§4](../../PLAN.md)  | v0.4                                        |
| Integrated terminal                        | [PLAN §4](../../PLAN.md)                       | v0.4                                        |
| Git interface                              | [PLAN §4](../../PLAN.md)                       | v0.3                                        |
| Open extension marketplace / VS Code exts. | [PLAN §4](../../PLAN.md), [§5](../../PLAN.md)  | “Later expansion”, curated only             |
| AI chat (and AI explanations)              | [PLAN §4](../../PLAN.md), [§9](../../PLAN.md)  | Later, opt-in, offline core stays intact    |
| Cloud accounts, sync, collaboration        | [PLAN §4](../../PLAN.md), [§13](../../PLAN.md) | Not planned                                 |
| One-click publishing                       | [PLAN §4](../../PLAN.md)                       | Not planned                                 |
| Custom breakpoint debugger                 | [PLAN §4](../../PLAN.md)                       | v0.5 (Chromium DevTools via explicit entry) |
| Workspace search, semantic rename, JS nav  | [PLAN §4](../../PLAN.md)                       | v0.2                                        |
| Live CSS injection without reload          | [PLAN §3](../../PLAN.md)                       | After v1                                    |
| Real mobile OS / touch emulation           | [PLAN §3](../../PLAN.md)                       | Not planned (width switch only)             |
| Multi-file / whole-project snapshots       | [PLAN §7](../../PLAN.md)                       | After v1                                    |
| Disabling browser security to bypass CORS  | [PLAN §8](../../PLAN.md)                       | Never                                       |
| Automatic updates                          | [PLAN §11](../../PLAN.md)                      | After v1 (manual upgrades first)            |
| Intel Mac, Windows arm64, Linux            | [PLAN §1](../../PLAN.md), [§12](../../PLAN.md) | Assess after v1                             |

## Support matrix

| Platform          | Architecture | Package               | Minimum OS    | Current stable at release | Test hardware                           |
| ----------------- | ------------ | --------------------- | ------------- | ------------------------- | --------------------------------------- |
| macOS             | arm64 native | Signed, notarised DMG | **TBD → H.1** | Test required             | Physical Apple Silicon, 8 GB, SSD (H.1) |
| Windows           | x64          | Signed installer      | **TBD → H.1** | Test required             | Fixed x64 reference, 8 GB, SSD (H.1)    |
| Windows arm64     | —            | Not shipped in v1     | —             | —                         | Assess later (H.4)                      |
| Intel Mac / Linux | —            | Not shipped in v1     | —             | —                         | —                                       |

Minimums are chosen together with the pinned Electron version (44.x, decision 0004) and may not be lower than what that
Electron release supports. They are still open (owner task H.1); once chosen they will be recorded in
`docs/decisions/0003-platform-support.md` (S01.4, not written yet) and in the release notes
([template](../release/release-notes-template.md)).
Rosetta does not count as Mac support ([PLAN §11](../../PLAN.md)).

## How we know v1 is done

PLAN §11 acceptance targets on both platforms (beginner metrics measured with
[the task script](task-script.md)), all §11 failure cases passing (S26), and a clean-machine install on each
platform (S29). Finished UI screenshots are not evidence ([PLAN §10](../../PLAN.md)).
