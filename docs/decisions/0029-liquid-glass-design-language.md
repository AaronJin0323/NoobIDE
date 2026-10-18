# 0029 — Liquid Glass design language

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S40.1 (direction for S40.2–S40.8)

## Context

On 2026-10-15 the owner asked for the interface to follow Apple's Liquid Glass design language. The S30 visual
foundation (semantic tokens, synchronised Monaco theme, light and dark) fixed hierarchy and credibility issues from the
interface assessment (retired; [history](../history.md)), but the chrome still looks flat and boxed. The
study docs/product/liquid-glass-study.md (retired; [history](../history.md)) reads Apple's guidance area by area.

Constraints that any direction must respect:

- **The preview is a native `WebContentsView`** above the renderer (decisions 0009, 0019). No CSS can sit over it or
  blur it; overlays that would cover it must hide it (PreviewPane `covered`).
- **Typing and preview latency budgets (S27)** must not regress; continuous `backdrop-filter` over Monaco or large
  areas is expensive on integrated Windows GPUs.
- **CSS has no lensing or refraction**, only alpha, blur, saturate, gradients and shadows.
- AGENTS.md invariants: i18n (zh-CN default, en), not colour alone, keyboard reachable, offline (no CDN assets or
  fonts), restricted IPC, platform code in `src/platform`.
- Windows x64 and Apple Silicon both ship; accessibility settings map to CSS media features differently on each.

## Options considered

1. **Native window material now** (Windows 11 Mica through `BrowserWindow` `backgroundMaterial`, macOS `vibrancy`) —
   rejected for this session: it changes window transparency and frame on both platforms, is absent on Windows 10,
   interacts with the native preview's background, and needs real-hardware proof before it can be trusted. Kept as a
   later candidate.
2. **Blur everywhere** (every panel and bar as `backdrop-filter` glass) — rejected: it puts glass over content against
   Apple's own guidance, costs GPU time on every frame the editor repaints, and cannot reach the preview anyway, so the
   look would be inconsistent exactly where users look most.
3. **A CSS/component framework** with a glass theme — rejected: new dependencies, generic styling that ignores our
   tokens and contrast tests, and no knowledge of the native-preview constraint.
4. **Leave the S30 look** — rejected: the owner asked for the change, and the study found real gains (grouped toolbar,
   command search, clearer primary action, concentric shapes) beyond appearance.
5. **A small, rule-based glass layer in our own CSS on top of S30 tokens** — chosen.

## Decision

1. **Glass only on the floating control layer.** The rail, top-bar groups, status strip, menus, the command palette
   and sheets are glass. Content — code, the preview, file names, problem cards, chat text — stays on solid panels.
   No glass on glass; one material variant.
2. **No backdrop blur on persistent chrome.** Persistent chrome floats over the static window background (tinted by
   two ambient colour fields), so an alpha fill (`--glass-chrome`) reads as glass at no runtime cost. Only transient
   overlays (`--glass-overlay` with `backdrop-filter`) blur, only while open, and never over the native preview: an
   overlay that covers the preview column sets `covered` and the view is hidden.
3. **A solid twin for every translucent token.** `GLASS` in `src/renderer/theme/tokens.ts` sits beside `THEMES`, is
   written by ThemeProvider, and every fill has a `…Solid` twin. `prefers-reduced-transparency: reduce`,
   `html[data-transparency=reduce]`, `prefers-contrast: more` and `forced-colors: active` switch to the solid twins
   (contrast also drops the ambient background; forced colours use system colours and borders). `prefers-reduced-motion`
   replaces every scale or slide with a short dissolve and stops press scaling. Text, muted and accent text must reach
   4.5:1 on each fill composited over every surface listed in `GLASS_BACKDROPS`, and on the solid twins.
4. **Concentric shapes and spring motion tokens.** Radii are tokens with the rule inner = outer − padding written next
   to them (rail 22/16, panel 14/8, menu 14/8, sheet 22/14; capsules for groups and pills). Motion uses CSS `linear()`
   spring curves (`--ease-snappy`, `--ease-smooth`) and durations from 120 ms to at most 340 ms; nothing animates on
   typing, tab switching or preview refresh.
5. **The command palette is the searchable command surface**, derived from the command registry (decision 0014): a new
   `command-palette` command (Ctrl+Shift+P / ⌘⇧P, View menu, top-bar search button) lists only commands whose `when`
   allows them now, with shortcuts and check state, searchable in both interface languages, keyboard-operable as a
   modal combobox, IME-safe. It runs the chosen command through the same registry path as menus and shortcuts — no
   second command list.

All of it is plain CSS in `src/renderer/glass.css` (loaded after `styles.css`) plus the palette component; no new
dependency, asset, IPC channel or main-process change.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- The look is an imitation of Apple's material, not its optics: no refraction, no motion-following highlights. This is
  stated in the study so we do not claim more.
- The visual distance between Windows and macOS stays small, because the material is ours rather than the OS's. The
  cost is that NoobIDE does not pick up the desktop wallpaper tint (Mica/vibrancy) until option 1 is revisited.
- Whether Windows "Transparency effects: off" reaches `prefers-reduced-transparency` in our Electron version is
  unproven; Windows High Contrast does reach `forced-colors`. If S40.8 shows no mapping, bridge
  `nativeTheme.prefersReducedTransparency` to `html[data-transparency]` (the CSS hook already exists).
- New overlays must set PreviewPane `covered` if they can overlap the preview column; this is part of review.
- **Verification:**
  - `src/renderer/theme/tokens.test.ts` (S40.2): glass token shape, `composite()`, 4.5:1 for every fill over every
    backdrop in both themes and on the solid twins.
  - `src/renderer/commands/palette-model.test.ts` (S40.5): bilingual ranked search, normalisation, selection movement.
  - `tests/e2e/glass.spec.ts` (S40.7, Windows x64 locally, macOS arm64 in the CI matrix): no element with a backdrop
    filter intersects the editor or preview while no overlay is open; solid twins under reduced transparency, contrast
    and forced colours; dissolve-only motion under reduced motion; palette keyboard flow, menu entry, preview hidden,
    axe in light and dark. Existing a11y, theme, shell, menu and command specs stay green.
  - `tests/e2e/glass-visual.spec.ts` writes light and dark screenshots to `test-results/glass/` for review (layout
    only, not evidence of behaviour).
  - S40.8 manual checks on real Windows 11 and Apple Silicon hardware (steps in `harness/MANUAL-CHECKS.md`):
    Transparency effects off, High Contrast, Reduce Transparency, Increase Contrast, Reduce Motion, and that typing
    and the preview feel unchanged.
