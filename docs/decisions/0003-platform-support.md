# 0003 — Platform support matrix and minimum OS versions

- **Status:** Accepted (2026-10-18). The owner accepted option 1 in chat (H.1) and confirmed Windows arm64 out of
  v1 (H.4). Recorded in [owner-decisions.md](../release/owner-decisions.md).
- **Date:** 2026-10-15 (proposed), 2026-10-18 (accepted)
- **Feature:** S01.4 (depends on H.1; H.4 covers Windows arm64)

## Context

PLAN §1 and §5 commit v1 to **Apple Silicon macOS (arm64)** and **Windows x64**. Both the minimum supported version
and the current stable version must be in the test matrix, on real devices, and stated in the release notes. The
install guides (`docs/release/install.*.md`) still say "to be decided (H.1)".

The floor is set by the pinned Electron, **44.7.0** (package.json, ADR 0004). Its platform-support section
(`node_modules/electron/README.md`) says **"macOS (Ventura and up)"** and **"Windows (Windows 10 and up)"**, with
x64 and arm64 binaries for Windows. Electron follows Chromium's support policy, so every Electron upgrade can raise
the floor. An upgrade must re-check this ADR.

Facts relevant to the choice, as of October 2026:

- Every Apple Silicon Mac ships with macOS 11 or later. Macs that shipped with macOS 14 or 15 (M3 and M4) cannot be
  downgraded below their shipping version. They can run macOS 13 in a virtual machine (Virtualization.framework,
  for example UTM).
- Windows 10 reached end of support on 2025-10-14, and consumer Extended Security Updates end 2026-10-13. Windows
  10 is still a large share of desktops in China, especially on school and older home PCs, which is the beginner
  audience.
- The owner's dev machine is Windows 11 Home 25H2 (build 26200) x64. CI uses `windows-latest` (Windows Server 2025)
  and `macos-14` (Sonoma, arm64).

## Options considered

| Option                                          | macOS minimum | Windows minimum     | For                                                              | Against                                                                       |
| ----------------------------------------------- | ------------- | ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **1. Follow Electron's floor**                  | 13 Ventura    | 10 22H2 (19045) x64 | Widest reach for beginners on older or family PCs; no extra code | Ventura is out of Apple security support; it needs a VM to test               |
| 2. Only OS versions their vendor still supports | 14 Sonoma     | 11 23H2 x64         | Smaller test matrix; every user gets OS security fixes           | Excludes many Windows 10 users in the target audience for no technical reason |
| 3. Mixed                                        | 14 Sonoma     | 10 22H2 x64         | Physical-device testing of the macOS minimum is easier           | Arbitrary on macOS: Electron runs on 13                                       |

## Decision (accepted 2026-10-18)

**Option 1:**

- **macOS 13 Ventura or later, Apple Silicon (arm64) only.** Intel Macs are not supported in v1 (PLAN §1).
- **Windows 10 22H2 (build 19045) or later, x64.** Windows 11 x64 is fully supported.
- **Windows arm64 is out of v1.**
  - Do not build arm64 installers and do not claim support.
  - The x64 build may happen to run under Windows 11 Prism emulation, but it is untested and unsupported.
  - Revisit after v1 on user demand (PLAN §12 "later expansion"; confirmed by the owner in H.4).
- **Review trigger:** re-check on every Electron major upgrade and when Electron or Chromium drops macOS 13 or
  Windows 10. When the floor rises, the minimum rises with it, and the release notes say so one release ahead.

### Test devices (release validation, PLAN §11)

| Platform    | Minimum version  | Current stable                             | Device                                                                                                                                                                                                                             |
| ----------- | ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64 | macOS 13 Ventura | macOS 27.2 (or the newest at release time) | **The owner's MacBook Pro M3 Pro** (physical, macOS 27.2) on current stable, for first launch after download, Gatekeeper, Retina, IME, and sleep and wake. A macOS 13 **VM on that Mac** (UTM) for the minimum. `macos-14` in CI   |
| Windows x64 | Windows 10 22H2  | Windows 11 25H2                            | The **dev PC** (Windows 11 25H2) for current stable. A **clean Windows 10 22H2 x64** for the minimum, with no developer tools: a spare PC or a VM in VirtualBox or VMware (Windows 11 Home has no Hyper-V). `windows-latest` in CI |

The owner confirmed the physical Apple Silicon Mac on 2026-10-18: a **MacBook Pro M3 Pro on macOS 27.2**. An M3
Mac shipped with macOS 14, so it cannot boot macOS 13; the minimum runs in a macOS 13 VM on it (UTM). The
`manual-mac` checks (S28.5 and the M8 validation) run on this Mac.

Summary of the accepted matrix:

- **macOS:** minimum 13 Ventura, Apple Silicon only. Test devices: MacBook Pro M3 Pro (macOS 27.2) and a macOS 13
  VM on it. CI `macos-14`.
- **Windows:** minimum 10 22H2 (19045) x64, plus Windows 11 x64. Test devices: the dev PC (Windows 11 25H2) and a
  clean Windows 10 22H2 x64 PC or VM. CI `windows-latest`.
- **Windows arm64:** out of v1. No build, no support claim; revisit after v1.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Now that it is accepted:
  - The install guides and release-notes template replace "to be decided (H.1)" with these minimums.
  - `forge.config.ts` sets `LSMinimumSystemVersion` to `13.0` (`packagerConfig.extendInfo`), so macOS refuses to
    start NoobIDE on older systems with a clear system message. An integration test reads the packaged
    Info.plist.
  - The Squirrel installer has no version gate. Windows 7, 8 and 8.1 are excluded because Electron 44 does not
    start there, and the install guide states this.
- Verification:
  - The validation runs (M8) install, open, edit, preview and recover a template on each of the four rows above.
  - They are recorded in `harness/MANUAL-CHECKS.md` with the exact OS build numbers.
- Unsupported (stated, not tested): Intel Macs, macOS 12 and older, Windows on arm64, Windows 32-bit, Linux.
