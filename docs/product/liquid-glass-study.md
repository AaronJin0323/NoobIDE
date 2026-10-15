# Liquid Glass design study

S40.1 · Owner request 2026-10-15 · Decision: [0029](../decisions/0029-liquid-glass-design-language.md) · Builds on
the [interface assessment](../reviews/interface-assessment-2026-10-14.md) and the S30 token system.

## Purpose and boundary

Apple's 2025 design language ("Liquid Glass") is a coherent, well-documented answer to a question NoobIDE also has:
how to make controls feel light and modern without ever competing with the user's content. This study reads Apple's
guidance area by area and decides, for each, what NoobIDE **adopts**, **adapts** or **rejects** on Electron for
Windows x64 and Apple Silicon macOS. It is not an attempt to clone macOS: NoobIDE runs on Windows first, and its users
are beginners, so clarity wins over spectacle every time.

Everything Apple describes below is paraphrased from the linked pages; short quoted fragments are marked. Two hard
constraints shape every answer:

1. **CSS cannot do real lensing.** Apple's glass bends and refracts what is behind it, with specular highlights that
   follow motion. In a browser we have `backdrop-filter` (blur, saturate), alpha fills, gradients and shadows. We
   imitate the _material_ (translucency, rim, highlight, depth), never the optics.
2. **Nothing can float over the preview.** The preview is a native `WebContentsView` composited above the renderer
   (decision [0009](../decisions/0009-preview-isolation-and-static-server.md), [0019](../decisions/0019-preview-view-sync.md)).
   No CSS layer can sit on top of it or blur it. Any overlay that would cover the preview column hides the native view
   (PreviewPane `covered`), exactly as dialogs already do.

Sources, abbreviated in the tables: HIG = Human Interface Guidelines, SUI = SwiftUI documentation, plus the Liquid
Glass technology overviews ([overview](https://developer.apple.com/documentation/technologyoverviews/liquid-glass),
[adopting](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)) and two WWDC25
sessions ([219 Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/),
[356 Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/)).

## Principles, one area at a time

### 1. Materials and layering

**Apple:** Liquid Glass is a functional layer reserved for navigation and controls that float above content; ordinary
materials give structure inside content. Glass should not be stacked on glass. It has no colour of its own: tint is
kept for the one primary action and applied to the background, not the glyph. There are two variants, regular
(adaptive, the default) and clear (over media, which needs dimming beneath it), and they are not mixed. Thicker
material means more contrast; thinner means more context shows through. Sources:
[HIG materials](https://developer.apple.com/design/human-interface-guidelines/materials),
[HIG color](https://developer.apple.com/design/human-interface-guidelines/color),
[SUI glass](https://developer.apple.com/documentation/swiftui/glass),
[overview](https://developer.apple.com/documentation/technologyoverviews/liquid-glass), WWDC 219.

**NoobIDE:**

| Adopt                                                                                                                   | Adapt                                                                                                                                                                                                                                                                                                                                                                                     | Reject                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two layers: solid content panels (editor, preview, file names, chat text) and a glass control layer. No glass on glass. | Only the "regular" variant, as two tokens: `glassChrome` (persistent, thinner) and `glassOverlay` (transient, thicker for legibility over any surface). Persistent chrome floats over the static window background tinted by two soft ambient colour fields, so an alpha fill reads as glass **without** `backdrop-filter`. Only menus, sheets and the palette blur, and only while open. | Lensing, refraction, motion-following highlights, the "clear" variant and light/dark flipping of small elements — not achievable credibly in CSS, and costly on low-end Windows GPUs. |

### 2. Glass for controls, not content

**Apple:** hierarchy comes from layout and grouping, not from custom backgrounds; content is never put in glass.
Sources: [HIG materials](https://developer.apple.com/design/human-interface-guidelines/materials),
[HIG layout](https://developer.apple.com/design/human-interface-guidelines/layout), WWDC 219.

**NoobIDE:** adopted as rule 1 of decision 0029. Code, the page result, the file tree's rows, problem cards and chat
messages stay on `--panel` / `--raised`. Panels lose their hard borders and get a hairline plus a soft shadow instead,
which also answers the assessment's "boxing every group" finding.

### 3. Concentricity

**Apple:** shapes are fixed, capsule or concentric; a concentric inner radius equals the outer radius minus the
padding, with a minimum for standalone items. Corners that pinch or flare are a sign the nesting is wrong. Toolbar items
are concentric with their bar; sheets use a larger radius. Sources: WWDC 356,
[SUI ConcentricRectangle](https://developer.apple.com/documentation/swiftui/concentricrectangle),
[HIG toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars),
[adopting](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).

**NoobIDE:** adopted as explicit radius tokens with the subtraction written down, because CSS has no concentric shape:
rail 22 → items 16 (6 padding); panel 14 → header controls 8; menu 14 → items 8; sheet 22 → palette field 14 (8
padding); toolbar groups and pills are capsules. Apple gives no numeric radii, so these values are ours.

### 4. Scroll edge effects

**Apple:** where floating UI overlaps scrolling content, a soft fade or blur replaces a hard divider; one effect per
view, none where nothing floats. Sources:
[SUI ScrollEdgeEffectStyle](https://developer.apple.com/documentation/swiftui/scrolledgeeffectstyle), WWDC 356.

**NoobIDE:** adapted. Our headers do not overlap content, so a blur would hide nothing; instead the file tree,
problems list and AI chat fade their first 20 px under the header **only once scrolled**, through a mask driven by a
CSS scroll-driven animation (`animation-timeline: scroll(self)`, no JavaScript, no work while idle). Rejected for the
editor (Monaco owns its scrolling and the 16 px code must never be obscured) and for the preview (native view).

### 5. Toolbars and grouping

**Apple:** leading, centre and trailing zones; at most about three groups; symbols over text, never mixing both in one
group background; a single prominent tinted action at the trailing end; every toolbar item also exists as a menu
command; overflow goes into a menu. Sources:
[HIG toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars),
[adopting](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).

**NoobIDE:** adopted with a beginner adaptation. The top bar has identity on the leading side (mark, project name and
location) and two capsule groups: _project_ (reveal in Explorer/Finder, project menu) and _find & language_ (command
search, language switch); the save status sits between them as a pill. We keep **text labels** on the language switch
and the command search, because beginners do not yet know our symbols; icon-only buttons always carry an accessible
name and tooltip. Every toolbar action already is a registry command with a native menu entry (decision
[0014](../decisions/0014-command-registry-and-native-menus.md)).

### 6. Sidebars and the rail

**Apple:** the sidebar floats inset in the glass layer, has at most two levels, a show/hide control plus a View menu
item that reflects state, and may collapse in narrow windows. Source:
[HIG sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars).

**NoobIDE:** the tool rail becomes a floating glass capsule inset 8 px from the window edge; its open tool is marked
by a soft accent fill **plus** an inner ring and bold label (not colour alone). Files and Problems already have View
menu toggles with checkmarks and collapse below 960 px (S24/S30). The file tree itself stays solid content — it holds
the user's file names.

### 7. Sheets, popovers and alerts

**Apple:** a sheet is one scoped task at a time, Cancel leading and Done trailing, over a dimmed parent, with a larger
radius. Popovers are for small tasks and never for warnings. Alerts are rare, have at most three verb buttons, Cancel is
never the default, Return confirms and Escape cancels. Sources:
[HIG sheets](https://developer.apple.com/design/human-interface-guidelines/sheets),
[HIG popovers](https://developer.apple.com/design/human-interface-guidelines/popovers),
[HIG alerts](https://developer.apple.com/design/human-interface-guidelines/alerts).

**NoobIDE:** dialogs become glass sheets (radius 22, blur, scrim) that rise in; the preview is hidden while any sheet is
open. Button order is left as it is: Windows and macOS conventions differ (Windows usually puts the primary action first), so we
do not impose Apple's order; platform-specific ordering, if ever needed, belongs in `src/platform`. Destructive confirmations keep their existing wording and the OS-trash rule.

### 8. Menus, commands and shortcuts

**Apple:** menu items are verbs, end in an ellipsis when more input follows, are dimmed rather than hidden when
unavailable in the menu bar, use separators for groups, one submenu level and checkmarks for state; every custom
command belongs in the menu bar. Context menus are short, show no shortcuts, put destructive items last, and every item
also exists elsewhere. Shortcuts use the standard modifier order, never override system ones and support full keyboard
access. Menus adopt glass. Sources:
[HIG menus](https://developer.apple.com/design/human-interface-guidelines/menus),
[HIG the menu bar](https://developer.apple.com/design/human-interface-guidelines/the-menu-bar),
[HIG context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus),
[HIG keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards),
[SUI menus and commands](https://developer.apple.com/documentation/swiftui/menus-and-commands).

**NoobIDE:** in-window menus become glass with concentric items and an accent highlight; native menus stay native. We
add a **command palette** (Ctrl+Shift+P / ⌘⇧P, the "Search commands" field in the top bar, View → Search Commands…)
derived from the command registry: it lists only commands whose `when` allows them now (nothing pretends), with their
shortcut and checkmark state. It searches in the interface language **and** the other one, because tutorials name
commands in English while the UI defaults to Chinese ("save" finds 保存), and it never runs anything during IME
composition. Apple does not prescribe a palette; it is the keyboard-first answer to "every command is reachable" that
beginners meet in other editors. Later: drop shortcuts from context menus per HIG; icons in menus.

### 9. Control styles and sizes

**Apple:** named button styles (automatic, bordered, borderedProminent, borderless, plain, link, plus glass and
glassProminent); one or two prominent buttons per view, distinguished by style rather than size; roles for normal,
primary, cancel and destructive; always a pressed state; progress inside the button for slow actions. macOS hit targets
are 28 × 28 pt by default (20 minimum). Toggles must not rely on colour alone. Sources:
[SUI PrimitiveButtonStyle](https://developer.apple.com/documentation/swiftui/primitivebuttonstyle),
[SUI ControlSize](https://developer.apple.com/documentation/swiftui/controlsize),
[HIG buttons](https://developer.apple.com/design/human-interface-guidelines/buttons),
[HIG toggles](https://developer.apple.com/design/human-interface-guidelines/toggles).

**NoobIDE:** mapped onto the existing classes:

| Apple style      | NoobIDE class                   | Use                                                 |
| ---------------- | ------------------------------- | --------------------------------------------------- |
| glassProminent   | `.primary-button`               | The one primary action of a place (accent capsule)  |
| glass / bordered | `.secondary-button`             | Secondary actions (glass capsule with rim)          |
| plain            | `.quiet-button`, `.icon-button` | Toolbar and list actions (fill only on hover)       |
| segmented        | `.segmented`                    | Code / Preview switch, raised knob in a glass track |

Pressed controls give a quick spring squeeze (scale 0.96). Controls on glass are 30 px inside a 36 px group, above
the macOS default target and the S24 keyboard/focus rules stay unchanged. An empty state's single action is styled as
the place's primary action.

### 10. Text input and search

**Apple:** placeholders disappear, so a visible or accessible label stays; there is a clear focus state and Return
submits; validation happens at sensible moments; a search field has a magnifier, a clear affordance, a placeholder that
states the scope, and live results. Sources:
[SUI TextField](https://developer.apple.com/documentation/swiftui/textfield),
[HIG text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields),
[HIG searching](https://developer.apple.com/design/human-interface-guidelines/searching),
[HIG search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields).

**NoobIDE:** one filled field style (hairline border, radius 10, a 3 px focus glow in `--focus`), errors shown in words
and a red border (not colour alone). The palette field is a combobox with a magnifier, an example-giving placeholder
("e.g. save, preview, theme, 保存"), live results and a polite live count. Existing roles and accessible names are
unchanged so the S24 axe checks keep holding.

### 11. Animation and springs

**Apple:** SwiftUI animates with springs (default: half a second, no bounce; presets smooth, snappy, bouncy) and glass
shapes can morph into each other. Motion should be purposeful and brief, never make people wait, be avoided on very
frequent interactions, and never be the only signal. Sources:
[SUI animations](https://developer.apple.com/documentation/swiftui/animations),
[SUI Spring](https://developer.apple.com/documentation/swiftui/spring),
[SUI GlassEffectContainer](https://developer.apple.com/documentation/swiftui/glasseffectcontainer),
[HIG motion](https://developer.apple.com/design/human-interface-guidelines/motion).

**NoobIDE:** springs as CSS `linear()` easing tokens — `--ease-snappy` (about 4 % overshoot) and `--ease-smooth`
(critically damped) — with durations of 120 ms (press), 160 ms (fades), 260 ms (menus, palette) and 340 ms (sheets),
the longest. Menus and the palette pop from their origin, sheets rise. Apple publishes no numeric presets, so curves are
our own. Rejected for now: morphing between toolbar groups (needs layout measurement in JS) and any animation on
typing, tab switching or preview refresh.

### 12. Accessibility

**Apple:** Reduce Motion swaps movement for fades and avoids animating into or out of blur; Reduce Transparency makes
materials frostier or opaque; Increase Contrast makes them mostly solid with a contrasting border. Text contrast 4.5:1
(3:1 for large or bold), no information by colour alone, labels on icon-only items. Sources:
[HIG accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility),
[SUI accessibilityReduceTransparency](https://developer.apple.com/documentation/swiftui/environmentvalues/accessibilityreducetransparency),
WWDC 219.

**NoobIDE:** every translucent token has a solid twin (`glassChromeSolid`, `glassOverlaySolid`), switched in by
`prefers-reduced-transparency: reduce`, `html[data-transparency=reduce]`, `prefers-contrast: more` (which also removes
the ambient background and strengthens hairlines) and `forced-colors: active` (system colours, `CanvasText` borders, no
blur). `prefers-reduced-motion` turns every pop and rise into a 160 ms dissolve and stops the press squeeze. A unit
test composites each glass fill over every surface it can float over (window background with and without the ambient
tint for chrome; every workbench surface for overlays) and requires 4.5:1 for text, muted and accent text in both
themes, and on the solid twins.

**Platform caveat.** Chromium maps `prefers-reduced-transparency` to macOS Reduce Transparency, but whether Windows
"Transparency effects: off" reaches it in our Electron version is not guaranteed. Windows High Contrast does map to
`forced-colors`. Both are therefore S40.8 real-hardware checks, and bridging Electron's
`nativeTheme.prefersReducedTransparency` to `data-transparency` is a later candidate if Windows does not map.

### 13. Colour and typography

**Apple:** semantic colours with light and dark variants, colour used sparingly on glass, vibrant label tiers on
materials; on macOS body text is 13 pt with titles at 15/17/22/26; the new design favours bolder, left-aligned type.
Sources: [HIG color](https://developer.apple.com/design/human-interface-guidelines/color),
[HIG typography](https://developer.apple.com/design/human-interface-guidelines/typography), WWDC 356.

**NoobIDE:** colour stays in S30's semantic tokens; glass tokens are added beside them in `tokens.ts` and written by
the same ThemeProvider, so light and dark always ship together. Accent is used for the primary action, the selected
menu or palette row, and the open tool — nothing else. Type keeps the S30 scale (13–14 px UI, 16 px editor, Chinese
font fallbacks); sheet titles go to 17 px with slight negative tracking. No new or downloaded fonts (offline rule).

## Architecture and performance

| Concern              | Rule                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview isolation    | No CSS over the native view; overlays that cover the preview column set `covered` (the palette included). Nothing about the view, its session or its IPC changes. |
| Typing latency (S27) | No `backdrop-filter` on persistent chrome; nothing blurred intersects the editor or preview while no overlay is open (e2e assertion in S40.7).                    |
| i18n                 | Palette strings in zh-CN and en (`src/renderer/i18n/palette.ts`), the View menu entry through `menu-template.ts`.                                                 |
| Offline              | Pure CSS; no assets, no fonts, no network.                                                                                                                        |
| Keyboard             | Palette is a modal combobox: ↑/↓ move (Home/End stay in the text), Enter runs, Escape or outside click closes and returns focus.                                  |

## Concrete plan

| Phase | Feature | Verify                  | Content                                                                                                                                                                                                               |
| ----- | ------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | S40.1   | agent-check             | This study, decision 0029 and the plan.                                                                                                                                                                               |
| 1     | S40.2   | auto                    | `GLASS` tokens + solid twins in `tokens.ts`, `composite()` and the `GLASS_BACKDROPS` contrast test; `glass.css` materials, ambient background, solid switching for reduced transparency, contrast and forced colours. |
| 2     | S40.3   | auto                    | Button styles mapped from SwiftUI, toolbar groups in `TopBar.tsx`, floating rail capsule, segmented control, filled text fields with focus glow and worded errors, concentric radius tokens.                          |
| 2     | S40.4   | auto                    | `--ease-snappy` / `--ease-smooth` springs, duration tokens ≤ 340 ms, `glass-pop` / `glass-rise` / `glass-fade`, reduce-motion dissolve and no press scaling.                                                          |
| 3     | S40.5   | auto                    | `command-palette` in `src/shared/commands.ts`, View menu entry, `CommandPalette.tsx` + pure `palette-model.ts` (bilingual ranked search, wrap-around selection), top-bar search button, preview hidden while open.    |
| 3     | S40.6   | auto                    | Scroll-edge mask on the file tree, problems list and AI chat; AI messages, composer, chips and consent in the same radii and materials; no AI behaviour change.                                                       |
| 4     | S40.7   | auto                    | `tests/e2e/glass-visual.spec.ts` captures welcome, workbench, menu, problems, palette, AI and a sheet in light and dark; `tests/e2e/glass.spec.ts` asserts material, motion, palette and accessibility rules.         |
| 5     | S40.8   | manual-win / manual-mac | Windows 11: Transparency effects off, a High Contrast theme, typing and preview feel. Apple Silicon: Reduce Transparency, Increase Contrast, Reduce Motion, light and dark. Steps in `harness/MANUAL-CHECKS.md`.      |

**Visual review.** Run the S40.7 spec and open `test-results/glass/` (ignored by git): `<state>-light.png` and
`<state>-dark.png` for `welcome`, `workbench`, `menu`, `problems`, `palette`, `ai` and `sheet`. Screenshots prove layout
only; the rules above are proved by the unit and e2e assertions.

## Later / not now

| Candidate                                                                                          | Why not now                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native window material: Windows 11 Mica via `BrowserWindow` `backgroundMaterial`, macOS `vibrancy` | Changes the window frame and transparency on both platforms (Windows 10 has no Mica, Mica breaks with some GPU drivers), interacts with the native preview's background and needs real-hardware proof first. |
| Bridge `nativeTheme.prefersReducedTransparency` to `html[data-transparency]`                       | Only needed if S40.8 shows Windows does not reach the media query; the hook already exists in CSS.                                                                                                           |
| Morphing toolbar groups (glass shapes merging and splitting)                                       | Needs JS layout measurement and FLIP animation; little value for beginners.                                                                                                                                  |
| AI as a sidebar inspector rather than a rail tool                                                  | A layout change across the workbench and preview sizing; revisit after beginner testing.                                                                                                                     |
| Icons in menus                                                                                     | Requires a complete, consistent icon family first.                                                                                                                                                           |
| Context menus without shortcuts (HIG)                                                              | Small change, but touches existing menu e2e specs; schedule with the next menu work.                                                                                                                         |
| Thumbnail-blur "clear" glass over media                                                            | Nothing in NoobIDE floats over media.                                                                                                                                                                        |
