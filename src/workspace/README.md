# src/workspace — files and projects

Path utilities, directory tree, watcher, encoding/EOL detection, atomic saves, conflict detection and
`.noobide/project.json`. Never silently overwrite; always keep in-memory content on failure (PLAN §7).

- `project-service.ts` — open / read / save with realpath containment and external-change detection (S03, S10, S11).
- `atomic-write.ts` (S10.1), `text-codec.ts` (UTF-8, BOM, EOL, binary refusal — S07.4), `paths.ts` (S07.1).
- `tree.ts`, `ignore.ts`, `listing-filter.ts` (lazy tree, S07.2), `watcher.ts` (S07.3, decision 0007).
- `project-search.ts` — bounded text search over the project for find / replace in files (S51.2).
- `file-ops.ts` — create, rename, move without overwriting (S08, decision 0008).
- `project-config.ts` — `.noobide/project.json` (S13.2); `portability-scan.ts` — cross-platform transfer check
  (S13.5, decision 0022).
- `create-project.ts`, `templates.ts` — the create-project wizard's file copy (S20).

App settings are not here: the schema is `src/shared/settings.ts`, the store `src/main/settings-store.ts`.
