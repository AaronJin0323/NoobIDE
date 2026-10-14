# 0010 — Capturing preview diagnostics: webContents events, not CDP

- **Status:** accepted (spike; revisit in S05.7 / S16.2)
- **Date:** 2026-10-14
- **Feature:** S05.3, S05.4

## Context

The IDE needs raw records for uncaught exceptions, console errors, failed resources (404s) and module load failures
from the sandboxed preview, with URL and line (PLAN §9), without a preload in the page (decision 0009) and without
breaking the user's own DevTools.

## Options considered

1. **`webContents.debugger` (Chrome DevTools Protocol):** `Runtime.exceptionThrown` (with stack and column),
   `Log.entryAdded`, `Network.loadingFailed` / `responseReceived` with initiator. Richest data, but a debugger session
   must stay attached for the page's whole life; every message still crosses the main process; attach/detach must be
   managed around navigations and crashes; and in the spike `Debugger.sendCommand('Page.enable')` on a fresh view
   hung, which needs more investigation.
2. **webContents / session events (chosen):** `console-message` (Chromium reports uncaught exceptions and unhandled
   rejections as "Uncaught …" console errors with source URL and line), `webRequest.onCompleted` (status ≥ 400) and
   `onErrorOccurred` (network errors, blocked requests), `did-fail-load` for the page itself.

## Decision

Use events (option 2) in `src/preview/preview-manager.ts`. Records are `PreviewLogEntry` (source `console |
exception | network | page-load`, level, message, URL, line, status, resourceType) and are mapped onto the shared
diagnostics model by `src/preview/to-problem.ts` (`normalizePageError`, `projectPathFromUrl`, `ProblemStore`), so the
runtime capture adapter (S16.2) builds on it instead of a parallel model.

Measured in `tests/e2e/preview-isolation.spec.ts` (S05.4): the console error (errors.js:1), the uncaught
ReferenceError (errors.js:3), the image 404 and the 404 of a missing ES module import (resourceType `script`) each
produce a record; records keep arriving while DevTools is open on the preview (nothing else is attached, so there is
no conflict).

Limits of this choice: no column and no stack for exceptions (Electron's `console-message` has neither); a module
load failure is visible as the failed request, not as a separate "module" error; no initiator line for failed
resources (S16.4 will derive the initiator file).

Console volume (S05.3): main pushes records into a bounded `LogBuffer` (200 per 250 ms batch, the rest counted as
dropped) and the workbench shows at most 200 lines plus "N messages dropped". Because Electron builds a
main-process event per console message, a guard detaches the listener for 1 s when more than 500 messages arrive
within 100 ms; skipped messages are then reported as "at least N dropped".

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Measured on Windows: a page logging ~650,000 messages in 6 s still stalls the main (browser UI) thread for
  3.2–4.7 s (≈8 s without the guard; the remainder is Chromium/Electron per-message work that happens even with no
  listener). Keystrokes are delayed, not lost, and the workbench renderer stays at ≤ 15 ms timer lag. S05.3 stays
  blocked; S05.7 tracks an in-page rate limiter installed before page scripts (CDP
  `Page.addScriptToEvaluateOnNewDocument` with getter-based console methods keeps the user's call site as the
  message location).
- Verified on Windows x64 by the e2e suite; macOS arm64 runs the same suite on the CI runner (S06).
