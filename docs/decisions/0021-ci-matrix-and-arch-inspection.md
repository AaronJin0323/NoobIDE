# 0021 — CI build matrix and binary architecture inspection

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S06.1, S06.2

## Context

PLAN §5 requires each installer to be built and checked on its own OS and architecture: Windows x64 and Apple
Silicon (arm64) macOS. Cross-packaging does not count as delivery validation. S06.1 asks for a GitHub Actions
matrix that runs verify, the Electron e2e suite and `make` on both platforms and keeps the installers; S06.2 asks
for a script that fails when a native binary in a build has the wrong architecture. The repository has no YAML or
binary-parsing dependency, and AGENTS.md prefers not adding one.

## Options considered

**Runners**

| Option                                        | For                                                                     | Against                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `windows-latest` + `macos-14` (chosen)        | Native x64 and native arm64 (M1) hosted runners; free for private repos | `windows-latest` moves forward over time                |
| `macos-13` / `macos-latest-large` (Intel)     | —                                                                       | x86_64: builds the wrong architecture for this product  |
| `ubuntu-latest` + cross-packaging for Win/Mac | Cheaper and faster                                                      | Not native (PLAN §5); cannot run the e2e suite natively |

**Pinning actions:** tags (`@v7`) are mutable; a full commit SHA is immutable. Chosen: full SHA plus a `# vX.Y.Z`
comment so updates stay readable. Pins used: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0,
`actions/upload-artifact` v7.0.2 (resolved from the release tags on 2026-10-15).

**Workflow test:** add a YAML parser dev-dependency, or check the file structurally. Chosen: a structural,
line-based check (`tests/integration/ci-workflow.test.ts`) — the workflow uses a plain block-style YAML subset, and
the assertions (matrix, step order, SHA pins, permissions) do not need a full parser.

**Architecture inspection:** shell out to `file`/`lipo` (macOS only) or `dumpbin` (Windows SDK), add a binary-format
package, or parse the headers in Node. Chosen: pure Node (`scripts/inspect-arch.mjs`), reading only header bytes:

- Mach-O thin (`MH_MAGIC`/`MH_MAGIC_64`, both byte orders) → `cputype` must be `CPU_TYPE_ARM64`.
- Mach-O universal (`FAT_MAGIC` / `FAT_MAGIC_64`) → slice table. Java class files share `0xCAFEBABE`; they are
  recognised by the slice count word (a class file's version makes it ≥ 45) and ignored.
- Windows PE (`MZ`, `e_lfanew`, `PE\0\0`) → COFF `Machine` must be `IMAGE_FILE_MACHINE_AMD64` (0x8664).

Files are classified by content, not by name or extension. Symbolic links are not followed (macOS frameworks use
them; their targets are inspected once anyway).

**Universal (fat) binary policy.** Options: (a) fail any universal binary, (b) accept one that contains an arm64
slice, (c) accept and warn. A universal binary with an arm64 slice runs natively on Apple Silicon (Activity Monitor
shows "Apple"), so it does not break the product requirement, but its x86_64 slice is dead weight and a sign that a
dependency was not built for the target. Chosen: **(c)** — a universal binary passes only if it contains an `arm64`
slice and is reported as a warning naming the extra slices; `--strict` turns the warning into a failure. A universal
binary without an arm64 slice fails. Today the Electron 44 arm64 build contains no universal binaries (13 thin arm64
Mach-O files), so the default and strict modes give the same result.

**What is inspected.** By default every packaged app directory in `out/` (`out/NoobIDE-darwin-arm64`,
`out/NoobIDE-win32-x64`), not `out/make`: the DMG is compressed, and the Squirrel `Setup.exe`/`Update.exe`
bootstrapper is a 32-bit x86 Squirrel component that Squirrel adds at install time, not part of the app. The script
exits 2 if no native binary is found, so a wrong path cannot pass silently. The contents of `app.asar` are not
unpacked; the app has no native Node modules (pure JS dependencies, AGENTS.md).

## Decision

- `.github/workflows/ci.yml`: one `build` job with a matrix `windows-x64` (`windows-latest`, x64) and `macos-arm64`
  (`macos-14`, arm64), `fail-fast: false`. Steps: checkout (no persisted credentials) → setup-node from `.nvmrc`
  with the npm cache → assert `process.arch` equals the matrix arch → `npm ci` → `npm run verify` →
  `npm run test:e2e` → `npm run make` → `node scripts/inspect-arch.mjs` → upload `out/make/` as
  `noobide-<target>` (error if empty, 14 days). On failure the Playwright output in `test-results/` is uploaded.
  No xvfb: Windows and macOS runners have a desktop session, and Playwright drives the Electron binary from
  `node_modules` (no browser download).
- Triggers: push to `main`, pull requests, manual dispatch. Never `pull_request_target`. Top-level
  `permissions: contents: read` only; no secrets are used (signing comes with S28.2/S28.3).
- `scripts/inspect-arch.mjs` as above; exit 0 pass, 1 wrong architecture, 2 usage / nothing found.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- `tests/integration/ci-workflow.test.ts` fails if the matrix, step order, SHA pinning, permissions or artifact
  upload regress. `tests/integration/inspect-arch.test.ts` covers thin/fat/fat64 Mach-O, Java-class false
  positives, x86/arm64/x64 PE, symlinks, Chinese paths and the exit codes with generated header fixtures.
- macOS arm64: the job's commands were run on a physical Apple Silicon Mac (see PROGRESS / S06.1 evidence), and
  `inspect-arch` passes on `out/NoobIDE-darwin-arm64` (cross-checked with `file`: 13 Mach-O, all arm64).
- Windows x64 and the real Actions run cannot be exercised by an agent: the owner pushes and checks the run
  (`harness/MANUAL-CHECKS.md#S06.1`).
- Updating an action: resolve the new tag to its commit SHA (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`)
  and replace SHA and comment together.
- CI relies on the npm bundled with Node 22 (npm 10), which runs dependency install scripts by default. Newer npm
  (11.x) asks for an `allowScripts` approval for `electron-winstaller`, `fs-xattr`, `macos-alias` and `fsevents`;
  if `.nvmrc` moves to a Node with such an npm, approve these in the repo's npm config, or `make` loses its
  7-Zip selection (Squirrel) and DMG helpers.
