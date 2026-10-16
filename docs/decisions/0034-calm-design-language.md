# 0034 — Calm design language (supersedes parts of 0029)

- **Status:** accepted
- **Date:** 2026-10-16
- **Feature:** S46.1

## Context

The owner compared the workbench with Claude Desktop and found it looks cheap. An audit of the shell and feature
stylesheets (summarised in [calm-design-spec.md](../product/calm-design-spec.md)) traced this to effects stacked by
the S40 Liquid Glass layer and to the lack of a shape, type and colour system. The worst offender is
translucent chrome without blur: on Windows, Electron cannot show real glass, so it renders as grey plastic. Gloss, rims,
highlights and drop shadows on black buttons make it worse. Other causes: 16 radii, bold everywhere, cool
blue-grey neutrals with neon states, nested bordered boxes, and inconsistent icon strokes.

## Options considered

1. **Tune the glass layer.** Lower the alphas, drop a few shadows and keep the concentric/capsule rules. This
   leaves the root cause in place: without a real backdrop, translucent chrome has nothing to show.
2. **Native materials** (Mica, vibrancy). These need main-process and platform work, behave differently on Windows
   10/11 and macOS, and still do not fix type, shape or colour. The idea is kept as a later candidate.
3. **Calm, flat language (chosen).** Chrome sits on the window background with no material. Content sits on solid
   surfaces. The overlay is the only translucent, frosted layer. A four-step radius scale, a token type scale with
   weight 400 by default, warm neutrals and quiet status colours complete the language. It is plain CSS plus token
   values, with no dependency.

## Decision

Adopt option 3 as specified in [calm-design-spec.md](../product/calm-design-spec.md).

From 0029:

- **Kept:**
  - overlays (menus, palette, dialogs, sheets) are frosted with `backdrop-filter`;
  - nothing blurred intersects the editor, and an overlay over the native preview hides it (`covered`);
  - every overlay fill has a solid twin used under reduced transparency, increased contrast and forced colours;
  - spring and duration tokens and the reduced-motion dissolve (`glass-pop` / `glass-fade`);
  - the command palette and scroll-edge masks.
- **Superseded:**
  - persistent chrome as translucent glass over ambient colour fields. Chrome is now solid `--bg` with no material,
    and the ambient fields are removed.
  - capsule toolbar groups and the floating rail capsule. These become plain groups and a flush rail.
  - the concentric radius table. It is replaced by `--radius-sm/control/panel/sheet` plus a pill for counters.
  - glass and prominent button styles with gloss and drop shadows. Buttons are now flat primary, secondary, quiet
    and icon.
  - pressed-state scaling. Pressed controls now change background only, with `--ease-smooth`.

The owner's monochrome brand (black filled controls in both schemes, with a grey rim in dark) is unchanged.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Features S40.2 and S40.3 are superseded by S46.3 and S46.4. S40.4, S40.5 and S40.6 remain satisfied.
- `src/renderer/design-rules.test.ts` mechanically enforces the shape, type, elevation and colour rules on every
  stylesheet, so later sessions cannot drift back.
- `tokens.test.ts` keeps the 4.5:1 and 3:1 rules for the new palette and for the overlay fill over every surface it
  can cover. `glass.spec.ts` asserts that chrome is solid and has no blur, and that overlays stay frosted.
- Every platform gets less GPU work, because the chrome no longer composites alpha fills. S40.8 manual checks
  become simpler, since the chrome is already solid and only the overlays switch.
- The layout `FRAME` (top bar 52, strip 32, gap 8) is unchanged, so the S45 visibility guarantees still hold.
- The owner judges the visual result from the before/after screenshots and a real run on Windows x64 and Apple
  Silicon (S46.8, `harness/MANUAL-CHECKS.md`).
