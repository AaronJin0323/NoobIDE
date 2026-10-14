# src/renderer — React workbench

File tree, Monaco editor, tabs, preview pane placeholder (the actual preview is a WebContentsView owned by main),
problems/console, history UI, onboarding. No Node APIs. All UI strings come from i18n dictionaries (zh-CN default).

`theme/` holds the colour tokens (dark/light, contrast-checked in `tokens.test.ts`) and the Monaco themes built from
them; `styles.css` only reads the tokens as CSS custom properties. Layout rules (which regions show, narrow window)
are pure functions in `workbench/layout.ts`.
