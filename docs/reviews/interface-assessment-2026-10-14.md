# Interface assessment — 2026-10-14

S01.5 · Owner-requested assessment and design direction.

## Assessment and evidence boundary

The current interface feels unfinished because it gives empty regions and unavailable controls substantial space,
with little hierarchy or guidance. Improving its appearance requires clearer composition, consistent visual
rules, and useful states. Changing the palette alone would leave those problems intact.

This reviews source against [PLAN](../../PLAN.md) §§2, 3, 9 and 11 and the existing
[wireframes](../wireframes/index.html). Windows headless Edge inspection rendered the actual React/Monaco
renderer through Vite. It does not validate Electron's native frame or macOS. Ignored screenshots are in
`test-results/interface-audit/current-{light,dark,narrow}.png`. Baseline `npm run verify` passed, including
42 tests; those gates do not establish beginner usability.

The [workbench](../../src/renderer/workbench/Workbench.tsx), lines 7–9, explicitly describes a scaffold.
Monaco edits an in-memory sample; Files, Preview and Problems remain placeholders. Every design below is a
proposal, not an implemented or usability-proven capability. This assessment changes no runtime behavior.

## Prioritized findings

1. **P1 — No obvious starting point.** [TopBar](../../src/renderer/workbench/TopBar.tsx), lines 14–22, presents
   three disabled actions. [FilesPanel](../../src/renderer/workbench/FilesPanel.tsx), lines 6–8, only explains
   that no folder is open. There is no actionable first-use flow in the renderer. A newcomer needs a clear
   entry action before seeing the full workbench.
2. **P1 — Empty content dominates.** [styles.css](../../src/renderer/styles.css), lines 45–58, reserves 22% of
   the height for Problems. Inspection at 1280×800 measured Problems at 176px, Files at 220px, and editor and
   preview at 530px each. Collapse unused tools and allocate space to the current task.
3. **P1 — States lack credibility.** [EditorPane](../../src/renderer/workbench/EditorPane.tsx), lines 18–22,
   opens an editable sample while the toolbar says no file is open. [ProblemsPanel](../../src/renderer/workbench/ProblemsPanel.tsx),
   line 11, always says no problems were found. Distinguish a demo buffer from a disk file, and unchecked
   content from checked content with no detected problems.
4. **P2 — Hierarchy is weak.** [styles.css](../../src/renderer/styles.css), lines 60–104, gives controls the same
   outlined treatment, emphasizes the application name, and mutes the project identity. Panel headings and
   placeholder messages compete at similar emphasis. Establish primary, secondary and quiet treatments.
5. **P2 — Theme treatment is incomplete.** Shell colors respond to dark mode in
   [styles.css](../../src/renderer/styles.css), lines 11–19; [CodeEditor](../../src/renderer/editor/CodeEditor.tsx),
   lines 20–28, supplies no Monaco theme. Inspection confirmed Monaco remained `rgb(255,255,254)` in both
   themes against dark shell `rgb(37,37,38)`. Theme the shell, editor, selection and native window background
   together. System fonts are acceptable.
6. **P2 — Layout and semantics need completion.** The window permits 640px width
   ([window-options.ts](../../src/main/window-options.ts), lines 48–51), but the three-column grid has no narrow
   alternative. At 640×480, inspection measured editor/preview at 210/209px and showed severely clipped code.
   Editor and Problems tabs are spans, with no tab interaction. Retain 16px code and visible focus while
   adding keyboard-operable controls and responsive layouts.

## Proposed visual foundation

Aim for a calm learning workspace: neutral surrounding surfaces, a clear project identity, readable code and
an obvious result. Use restrained separators instead of boxing every group. Adopt a 4px spacing base and
adapt hierarchy with available width, consistent with [Fluent 2 layout guidance](https://fluent2.microsoft.design/layout).
The following dimensions and colors are design hypotheses for NoobIDE, requiring validation.

| Element                | Proposed starting specification                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Spacing                | 4, 8, 12, 16, 24 and 32px; related controls use smaller gaps                                         |
| Typography             | 13–14px interface text, 16px editor, 24–28px welcome heading; preserve Chinese fallbacks             |
| Toolbar / pane headers | 48px project toolbar; aligned 36px pane headers; controls at least 32px high                         |
| Main layout            | 220px collapsible Files; adjustable remaining space initially split equally between code and preview |
| Bottom region          | 28px collapsed status strip; Problems expands on request without stealing typing focus               |
| Narrow layout          | Below an initial 960px threshold, collapse Files and offer Code / Preview switching                  |
| Surfaces               | Light: `#F5F7FA` chrome, `#FFFFFF` editor; dark: `#181B22` chrome, `#20242D` editor                  |
| Emphasis               | Blue `#2563EB` light / `#7AA2FF` dark accent; 1px separators, 6px control radii, 2px visible focus   |

Check contrast before adopting tokens. Pair status colors with text and symbols. Use one coherent icon family,
with labels on common actions. Keep large reading surfaces uninterrupted and bundle all assets locally.

## Three proposed screen designs

**Welcome:** Replace the empty workbench with a concise introduction, one prominent “Create my first webpage”
action, “Open folder,” and recent projects showing real locations. Three locally bundled template thumbnails
support selection without overwhelming the page. Creation shows the exact destination and rejects collisions.
Until creation exists, label any demonstration honestly and do not expose working-looking placeholder actions.

**Workbench:** Put project name and location access first, followed by confirmed save status. Keep Help and
More tools stable; place language and appearance choices in settings. Files retain actual names with optional
short role descriptions: structure, appearance, interaction. Align editor tabs with the preview header. Preview
shows its entry page, running/stopped state, refresh and viewport controls; explain auto-refresh and possible
page-state loss. Retain the isolated WebContentsView architecture. Opening a folder must not silently run it.

**Error state:** Show a nonintrusive count and file marker, then an expandable problem card with source type,
file/line, plain-language explanation and concrete checks. Make “Go to code” the primary action and keep the
original error expandable. Preserve static/runtime/resource distinctions and repeated-event counts. A save
failure must preserve edits and explain the cause; never display “Saved” or an updated preview prematurely.
Keep undo, crash recovery and local history as distinct actions and states.

## Implementation order and observable acceptance

1. **Visual foundation:** Prepare welcome, workbench and error compositions in both languages and themes;
   then implement shared tokens and synchronized Monaco theming. Record screenshots at 1280×800 and 640×480,
   checking clipping, alignment and text expansion. Screenshots prove layout only.
2. **Files and truthful state:** Connect the design to S07–S10, with real models and confirmed save state;
   then conflicts/recovery and session restore in S11–S13. Demonstrate successful and failed writes, preserved
   buffers, reopen behavior and Chinese paths. Locale/theme changes must retain edits and cursor position.
3. **Preview and layout:** Integrate S14–S15. Test splitter persistence, narrow switching, keyboard access,
   zoom/DPI placement and explicit start for external projects. Confirm preview refresh follows successful
   saving and the editor remains usable when a page fails.
4. **Problems and beginner flow:** Connect S16–S19 diagnostics, S20 welcome/templates, S21 history, S22 cards
   and S23 walkthroughs. Demonstrate a real typo, missing resource, navigation to code, original evidence,
   and diff-before-restore. Distinguish unchecked, checking and checked-empty states.
5. **Accessibility and user evidence:** Apply S24 keyboard, focus, themes and zoom requirements throughout
   implementation, then complete its formal pass. Test without a mouse and at enlarged text sizes in both
   locales. Run PLAN §11's first-page, error-fixing, folder-location and recovery tasks with beginners;
   record observed outcomes and failures separately from visual preference.

These priorities propose sequencing within existing work. They do not mark future features complete or change
their acceptance criteria. Next investment: establish the visual foundation and screen states before more
scaffold styling becomes embedded in subsequent features.
