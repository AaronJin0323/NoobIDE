# src/recovery — journal and local history

Crash-recovery journal for unsaved buffers and per-file local history (content-addressed snapshots + JSON index)
stored in app data, never in the project. Undo, autosave, recovery and history stay independent (PLAN §7).
