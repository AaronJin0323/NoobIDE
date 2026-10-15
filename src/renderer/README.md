# src/renderer — React workbench

File tree, Monaco editor, tabs, preview pane placeholder (the actual preview is a WebContentsView owned by main),
problems/console, history UI, onboarding. No Node APIs. All UI strings come from i18n dictionaries (zh-CN default).

`theme/` holds the colour tokens (dark/light, contrast-checked in `tokens.test.ts`) and the Monaco themes built from
them; `styles.css` only reads the tokens as CSS custom properties. Layout rules (which regions show, narrow window)
are pure functions in `workbench/layout.ts`.

Folders: `workbench/` (shell, file tree, tabs, editor and preview panes, problems, console), `editor/` (Monaco setup,
model registry, language configuration), `problems/` (problem views and cards, static problems, one-click fix),
`history/` (local history window), `recovery/` (journal scheduler, restore dialog), `welcome/` (welcome screen and
create-project wizard), `walkthrough/` (onboarding and glossary), `commands/` (command hooks and F6 region focus; the registry itself is `src/shared/commands.ts`), `i18n/`
(zh-CN / en dictionaries), `theme/`, `ai/` (AI features over `window.noobide.ai`, decision 0025; S32 ghost-text
suggestions in `inline-*.ts`).
