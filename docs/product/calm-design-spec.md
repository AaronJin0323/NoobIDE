# Calm design spec (S46)

Owner request 2026-10-16: the workbench looks cheap next to Claude Desktop, which is calm, flat, warm and quiet.
This spec is the contract for the S46 refinement. Decision: [0034](../decisions/0034-calm-design-language.md).
Before screenshots: `glass-visual.spec.ts` at `9c66b07` (test-results/glass/, not committed).

## Diagnosis (from the S46 audit)

1. **Stacked effects.** Two ambient colour fields behind the window; translucent chrome with no blur (reads as grey
   plastic); a 4-layer shadow on every chrome control; gloss gradients, rims, inset highlights and coloured drop
   shadows on black buttons; `brightness()` hovers and `scale(.96)` presses with spring overshoot.
2. **No shape system.** 16 distinct radii (1 to 999 px), `--radius-panel` defined twice (12 vs 14), capsules mixed
   with rounded rectangles in one row; feature files and glass overrides re-radius the same element.
3. **Flat type, heavy weight.** About 75% of declarations are 12 px, 60+ are weight 600. Hierarchy is carried by
   bold alone, so on Windows (Microsoft YaHei has only regular and bold) every label renders bold.
4. **Cool palette, loud states.** Blue-grey neutrals (`#0B0D12`, `#ECEEF3`), neon status colours, a green pill for
   the _normal_ "no changes" state, native blue checkboxes and radios in a monochrome UI.
5. **Box in box.** Every region is a floating card with border plus shadow; inside, dashed preview stage, tiles,
   nested cards (chat composer > input > chips > preview text); five different "selected" treatments; 3 px left
   bars and dashed outlines that read as prototype styling.
6. **Inconsistent icons.** 8 stroke widths (1.4 to 2.4) and 9 sizes on one 16-unit grid.
7. **Window.** `backgroundColor: '#ffffff'` in both themes.

## Principles

1. **Quiet by default.** Chrome sits directly on the window background with no fill, border or shadow. Only content
   (editor, preview, dialogs) gets a surface. One divider where two areas meet, never two.
2. **One material per layer.** Window `--bg` → content `--panel` → overlay (frosted, the only translucent layer).
   No gradient anywhere except scroll-edge masks.
3. **Hierarchy by size and colour, not weight.** Default weight is 400; 500 for buttons, tabs and titles; 600 only
   for dialog and welcome headings. Secondary information is `--muted`, not smaller-and-bolder.
4. **Colour means something.** Neutrals are warm. Status colours appear only for actual problems and successes,
   always with an icon or word. The normal state is neutral.
5. **One shape scale.** Four radii plus a pill reserved for counters and status pills.

## Tokens

### Colour (tokens.ts THEMES — all pairs pass tokens.test.ts)

| Token                             | Light                             | Dark                              |
| --------------------------------- | --------------------------------- | --------------------------------- |
| bg                                | `#F4F3EF`                         | `#1B1A18`                         |
| panel                             | `#FFFFFF`                         | `#232220`                         |
| raised                            | `#F1F0EC`                         | `#2B2A27`                         |
| hover                             | `#E9E7E2`                         | `#33312E`                         |
| line                              | `#E3E1DB`                         | `#363431`                         |
| text                              | `#1F1E1C`                         | `#ECEAE4`                         |
| muted                             | `#5F5C56`                         | `#A9A59D`                         |
| faint                             | `#6E6B64`                         | `#959189`                         |
| accent                            | `#1F1E1C`                         | `#ECEAE4`                         |
| accentFill                        | `#1F1E1C`                         | `#0F0E0D`                         |
| accentRim                         | `#1F1E1C`                         | `#8F8B83`                         |
| onAccent                          | `#FFFFFF`                         | `#FFFFFF`                         |
| accentText                        | `#1F1E1C`                         | `#ECEAE4`                         |
| accentSoft                        | `#ECEAE5`                         | `#34322F`                         |
| ok / okSoft                       | `#2E6B47` / `#EAF2EC`             | `#86C29C` / `#22302A`             |
| warn / warnSoft                   | `#7F5300` / `#F8F0DF`             | `#E2B467` / `#342C1F`             |
| danger / dangerSoft               | `#A8352C` / `#F9ECEA`             | `#EC8F84` / `#3A2624`             |
| focus                             | `#1F1E1C`                         | `#ECEAE4`                         |
| lineHighlight                     | `#F7F6F3`                         | `#282725`                         |
| selection                         | `#E2DFD8`                         | `#3E3B37`                         |
| syntax tag / attr / string        | `#2F5BB5` / `#93531A` / `#2E6B47` | `#8DB4F0` / `#E3AE78` / `#9BCF9F` |
| syntax comment / keyword / number | `#6E6B64` / `#7346B8` / `#A23C6B` | `#99958D` / `#C4A9F0` / `#EAA3C2` |

The owner's monochrome brand stays: filled controls are black in both schemes, with the grey rim in dark.

### Glass (tokens.ts GLASS) — overlays only

Kept: `glassOverlay`, `glassOverlaySolid`, `glassHover`, `glassStroke`, `glassShadow`, `scrim` (values retuned
warm). Removed: `glassChrome`, `glassChromeSolid`, `glassHighlight`, `ambientA`, `ambientB` (persistent chrome has
no material any more). `GLASS_BACKDROPS` keeps only `glassOverlay`.

### CSS custom properties (defined once, in styles.css `:root`)

| Group     | Names and values                                                                                                                                                                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Radius    | `--radius-sm: 6px` (chips, kbd, badges, tree rows, small icon buttons) · `--radius-control: 8px` (buttons, inputs, tabs, list rows, menu items, callouts) · `--radius-panel: 12px` (panels, menus, popovers, cards, composer) · `--radius-sheet: 14px` (dialogs, palette) · `--radius-capsule: 999px` (counters and status pills only) |
| Type size | `--text-xs: 11px` (kbd, rail labels, counters) · `--text-sm: 12px` (meta, status strip, hints, file roles) · `--text-md: 13px` (UI default: buttons, tree, tabs, menus) · `--text-lg: 14px` (panel titles, prose: chat, lessons, dialog body) · `--text-xl: 16px` (dialog titles) · `--text-2xl: 22px` (welcome heading)               |
| Weight    | `--weight-regular: 400` · `--weight-medium: 500` · `--weight-strong: 600`                                                                                                                                                                                                                                                              |
| Elevation | `--shadow-overlay: 0 0 0 1px var(--line), 0 12px 32px -12px var(--glass-shadow)` (menus, palette, dialogs, popovers — the only shadow) · `--ring-accent: inset 0 0 0 1px var(--accent-rim)` (filled controls)                                                                                                                          |
| Motion    | `--dur-fast: 120ms`, `--dur-base: 200ms`, `--ease-out`, `--ease-smooth` (kept), `--ease-snappy` (overlays only). Keyframes `glass-pop` / `glass-fade` keep their names.                                                                                                                                                                |

Removed names (must not be referenced after S46): `--material-chrome`, `--material-hairline`, `--shadow-chrome`,
`--shadow-panel`, `--shadow-prominent`, `--radius-rail`, `--radius-rail-item`, `--radius-menu`,
`--radius-menu-item`, `--radius-field`, `--ambient-a`, `--ambient-b`, `--glass-chrome`, `--glass-chrome-solid`,
`--glass-highlight`, `--border`.

Spacing values: 2, 4, 8, 12, 16, 20, 24, 32 px. Body stays `13px/1.5`; `FRAME` (top bar 52, strip 32, gap 8) is
unchanged so the S45 visibility guarantees hold.

## Components (shared classes in styles.css; feature files use these, never re-implement)

| Component                                   | Spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.primary-button`                           | 32 px high, padding 0 14, `--radius-control`, `--accent-fill` + `--on-accent`, `--ring-accent`, `--text-md`/500. No gradient, no drop shadow, no filter. Hover: `color-mix(in srgb, var(--accent-fill) 86%, var(--muted))`. One per place.                                                                                                                                                                                                                                                                                                                                                    |
| `.secondary-button`                         | 32 px, `--panel` fill, 1 px `--line` border, `--text`. Hover `--hover`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `.quiet-button`                             | 28–32 px, transparent, `--text` (or `--muted` for tertiary), hover `--hover`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `.icon-button`                              | 28 × 28, `--radius-control`, quiet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Pressed                                     | background change only, `--dur-fast` `--ease-smooth`. No scale, no brightness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Text field (all inputs, selects, textareas) | 32 px (textarea auto), `--radius-control`, `--panel` fill, 1 px `--line` border; hover border `--muted` at 40%; focus: border `--focus` + the global `:focus-visible` outline. Error: `--danger` border + message text.                                                                                                                                                                                                                                                                                                                                                                       |
| Checkbox / radio                            | native, `accent-color: var(--accent)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Chip / tag / badge                          | 22–24 px, `--radius-sm`, `--raised` fill, no border, `--text-sm`. Counters may use `--radius-capsule`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Card                                        | `--panel` (or `--raised` on panel), 1 px `--line`, `--radius-panel`, padding 16, no shadow. Never a card in a card: nest with spacing and one divider.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| List row                                    | 30–32 px, `--radius-control` (tree rows `--radius-sm`), hover `--hover-soft`, selected/current per the row below, plus the existing aria state. No left bars.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Callout (error / warning / info / success)  | `--*-soft` fill, `--radius-control`, padding 10 12, icon + text in the status colour. No left bar, no border.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Selected / current / pressed                | `--hover` fill **and** a non-colour cue: the label at `--weight-strong` (600 — Microsoft YaHei has no 500 face, so 500 is not a cue on zh-CN Windows); icon-only controls use `--ring-selected` (`inset 0 0 0 1px var(--muted)`). Hover is always lighter: `--hover-soft` (`color-mix(in srgb, var(--hover) 55%, transparent)`) and never adds the cue. Disabled: `--muted` text plus `inset 0 0 0 1px var(--line)` (a shape change, not colour alone). Focus is the only 2 px outline; walkthrough anchors use a 3 px solid `--accent` outline at offset 4 px so they never look like focus. |
| Empty state                                 | icon 32 in `--faint` without a tile, `--text-lg`/500 title, `--muted` body, one button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Regions

| Region                                                   | Spec                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window                                                   | `--bg`, flat. Native `backgroundColor` follows the theme (no white flash in dark).                                                                                                                                                                                                                                      |
| Top bar                                                  | On `--bg`, no capsule groups: controls sit in plain flex groups with 4 px gaps. App name 14/500. Project name 14/500, path `--text-sm` `--muted`, one line with ellipsis. Save state: `--muted` text + icon when clean; Save button is a `.primary-button` only while dirty/failed; failures in `--danger` text + icon. |
| Rail                                                     | Full-height column on `--bg`, no fill, border or shadow. Buttons 52 × 52, icon 18, label `--text-xs` `--muted`; current: `--hover` fill + `--text` + `aria-current`/`aria-pressed`.                                                                                                                                     |
| Files panel                                              | Sits on `--bg` like a sidebar: no panel fill, border or shadow; header row without a divider.                                                                                                                                                                                                                           |
| Editor and preview                                       | `--panel` surfaces, 1 px `--line` border, `--radius-panel`, no shadow. Header 40 px with one bottom divider. Tabs: selected tab `--raised` fill, `--radius-control`, 500 weight; others `--muted`.                                                                                                                      |
| Preview stage                                            | `--raised` fill, `--radius-control`, no dashed border.                                                                                                                                                                                                                                                                  |
| Problems / console / status strip                        | On `--bg`, `--text-sm` `--muted`; counts as text + icon.                                                                                                                                                                                                                                                                |
| Overlays (menus, context menu, palette, dialogs, sheets) | `--glass-overlay` + `backdrop-filter` (kept, frosted), `--shadow-overlay`, `--radius-panel` (menus) or `--radius-sheet` (dialogs, palette). Menu items `--radius-control`, selected row `--accent-fill` (kept).                                                                                                         |
| Welcome                                                  | No card, no gradient: content on `--bg`, heading `--text-2xl`/600, body `--text-lg` `--muted`, primary + secondary button.                                                                                                                                                                                              |
| AI chat                                                  | Assistant messages are plain text (no bubble) at `--text-lg`/1.6; user messages a `--raised` bubble with `--radius-panel`. Composer: one bordered field (`--radius-panel`) holding the textarea and the send row; context chips inside it without their own borders.                                                    |

## Icons

One stroke width (1.5 on the 16-unit grid) for every outline icon; sizes 14 (inline), 16 (default), 18 (rail), 32
(empty states). `stroke-width` is scaled so the rendered stroke stays about 1.5 px at every size
(`vector-effect: non-scaling-stroke` or per-size width).

## Amendments after review (S46)

- Selected, current, pressed, hover and disabled states as in the table above (review: fill-only states broke "state never by colour alone").
- Never `outline: none` / `outline: 0`: hide an outline with `outline-color: transparent` so forced colours still draws focus.
- Inline `<svg>` glyphs in components come from `workbench/icons.tsx` (or `ai/ai-icons.tsx`), and CSS never resizes an icon away from the size its stroke was computed for.
- The shared `.text-field` class is the one text-field style; feature inputs add it instead of re-implementing it.
- The native window background follows the saved theme choice (`system` follows the OS).

## Enforcement

`src/renderer/design-rules.test.ts` scans every stylesheet under `src/renderer` and fails on: radii that are not
the radius tokens (or 0 / 50%); gradients outside mask properties; font sizes not from the type tokens (`em` and
`inherit` allowed); weights other than 400/500/600; box shadows that are not `none`, a shadow/ring token, or a
plain `0 0 0 Npx` / `inset 0 0 0 Npx` ring; literal colours outside custom-property definitions, masks and
forced-colours system colours, and named colours; `dashed` lines (borders, outlines, text decoration, column rules); `filter: brightness`, `drop-shadow` and `text-shadow`; `scale(` in transforms; weights in the `font` shorthand other than 400/500/600; `outline: none` / `outline: 0`; and any reference to a removed custom property.
