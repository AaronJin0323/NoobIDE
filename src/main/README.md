# src/main — Electron main process

Windows, application lifecycle, IPC handlers, wiring of services. Thin: business logic lives in workspace/, preview/,
diagnostics/, recovery/. Every IPC handler validates its payload and sender (see src/shared/ipc, feature S03.1).

- `main.ts` — startup and wiring; `window-options.ts`, `harden.ts`, `csp.ts`, `app-protocol.ts` / `app-asset.ts`
  (workbench served from `noobide://app`, decision 0005); `close-guard.ts` (S10.6),
  `window-lifecycle.ts` and `app-menu.ts` (S24.2); `self-test.ts` (packaged Monaco worker self-test);
  `wake-recovery.ts` (S25.1/S25.2 sleep/wake recovery: watcher rescan, server and page probes, decision 0028).
- IPC: `ipc.ts` (files, projects; registers `recovery-ipc.ts` and `history-ipc.ts`), `app-data-ipc.ts` (settings,
  recent projects, session, logs), `preview-ipc.ts`, `create-project-ipc.ts`, `walkthrough-ipc.ts`,
  `commands-ipc.ts`, `checkpoints-ipc.ts` (S56 project checkpoints; restores write through
  `ProjectService.restoreBytes`); `problems-bridge.ts` connects the preview to the runtime capture adapter (S16.2).
- App-data stores, all under `app.getPath('userData')` and never inside a project: `settings-store.ts`
  (`settings.json`), `recent-projects.ts` (`recent-projects.json`), `session-store.ts` (`session.json`),
  `preview-store.ts` (`preview.json`, start-preview trust), `walkthrough-store.ts` (`walkthrough.json`),
  `app-log.ts` (`logs/`); the names are listed once in `app-data-layout.ts`. `json-file.ts` backs up unreadable files
  instead of overwriting them, and `schemaVersionOf` gives the S28.4 rule: older files are upgraded, files from a
  newer NoobIDE are read but never written (ADR 0023). The recovery journal
  (`recovery/`), history (`history/`) and checkpoint (`checkpoints/`, blobs shared with history, decision 0041) stores
  come from src/recovery. User-facing description:
  `docs/release/install.en.md` §5.
