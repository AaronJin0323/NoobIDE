# 0019 — Keeping the preview WebContentsView in step with the workbench

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S15.1, S15.2, S15.3, S15.5, S15.6

## Context

The preview page is a native `WebContentsView` that main positions over a placeholder element (the stage) in the
workbench (decision 0009). It is not part of the React DOM, so PLAN §8 asks for explicit synchronisation of pane
resizing, window resizing, DPI, bounds, overlays and keyboard focus. Measured problems before S15 (macOS arm64):

- A mouse drag of a divider stopped short of where the button was released (dropped 20–50 px of an 80 px drag): the
  last pointer moves were coalesced or still queued at `pointerup`, and the persisted size was then off. An earlier
  Windows branch saw a splitter persist 12 px off, probably the same cause.
- Main rounded `x` and `width` separately; at fractional scale factors (Windows 125 / 150 %) that puts the view's
  right edge one pixel past or short of the stage.
- Only some overlays hid the view (an explicit list in `Workbench.tsx`); a confirmation dialog, the recovery dialog
  or the "more actions" menu could be drawn under the page.
- Starting or refreshing the preview moved the keyboard focus into the page (`webContents.isFocused()` of the page
  became true, the workbench's false). After a save refreshed the preview, the next key presses would have gone to
  the page instead of the editor. There was also no keyboard way into or out of the page.

## Options considered

1. Hide the native view and show a screenshot while the workbench needs the area (VS Code's webview approach for
   drags). Costly (capturePage per change), and a stale image on a learning tool is misleading.
2. Off-screen rendering of the page into the DOM. Breaks isolation guarantees and performance; rejected.
3. Keep the native view and synchronise it explicitly with small, tested rules — chosen.

## Decision

- **Bounds** (`src/preview/view-sync.ts`, `toViewBounds`): CSS px → window DIPs by the workbench zoom factor, and
  the four **edges** are rounded, so the view's right and bottom edges always land on the stage's edges.
  `PreviewPane` re-sends on ResizeObserver, window resize, every render, and a `devicePixelRatio` change (moving to
  a monitor with another scale factor).
- **Dividers** (`Splitter.tsx`): the `pointerup` position is applied as the final value, so the persisted size is
  where the user let go. Sizes stay integers (files panel px) and 0.001 fractions (editor share), as in S13.4.
- **Narrow layout** (S15.2): the narrow Code / Preview switch only changes which region is rendered; the pane's
  `hidden` state already drives the view's visibility, and the files drawer counts as an overlay.
- **Viewport width** (S15.3, `preview-viewport.ts`): "mobile" places the view 375 CSS px wide, centred on the stage.
  Nothing else changes (user agent, touch points, device pixel ratio are proven unchanged in e2e), and the labels say
  "width" plus a note that it is not phone emulation (PLAN §3).
- **Overlays**: `PreviewPane` watches the DOM (child-list mutations, coalesced per animation frame) for modal
  backdrops, dialogs and DOM menus (`OVERLAY_SELECTOR`) and hides the view while any of them **overlaps** the stage.
  New dialogs are covered without editing a list; a menu elsewhere does not blank the preview. The explicit
  `covered` prop stays for the narrow files drawer.
- **Focus**: Enter on the focusable stage (`role="group"`, label explains Enter / F6) asks main to focus the page
  (`preview:focus`, sender-checked, no payload). F6 / Shift+F6 inside the page are caught in main
  (`before-input-event`, also suppressing the macOS menu accelerator) and give the focus back to the workbench,
  which continues the S24.3 region order from the preview. `FocusGuard` returns focus that a start or refresh takes
  from the workbench (only when the workbench had it when the load began, until 500 ms after loading stops);
  Enter on the stage always wins.

## Consequences

- A DOM overlay that overlaps the stage blanks the page while it is open. That is the honest choice: the native
  view cannot be drawn under the DOM.
- A click into the page during a refresh that began while the editor had the focus is returned to the editor;
  clicking again works. Accepted for the editor-first workflow.
- The rules are unit-tested; the platform behaviour is proven by `tests/e2e/preview-layout.spec.ts` on macOS
  (including `--force-device-scale-factor` 1.5 and 2 and fullscreen). Real monitor moves, Windows scaling and
  physical mouse drags across the native view are manual checks (harness/MANUAL-CHECKS.md, S15.5 / S15.6).
