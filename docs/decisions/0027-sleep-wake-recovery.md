# 0027 — Sleep/wake recovery

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S25.1 (Windows x64), S25.2 (macOS arm64)

## Context

PLAN §3/§8 require watchers, the preview's loopback server and the preview to survive sleep and wake on both
platforms, without ever losing an edit. What a sleep breaks is up to the OS: a recursive `fs.watch`
(ReadDirectoryChangesW / FSEvents) can stop delivering or miss events without an `error`; a listening socket can be
torn down (network stack reset, VPN/firewall software); the preview's renderer can come back hung or crashed; and
timers resume with a stale view of time — the preview watchdog's ping sent before the sleep looks minutes old.
Windows Modern Standby (S0ix) often wakes a frozen desktop app without a `suspend`/`resume` pair.

## Options considered

1. **Do nothing, rely on the existing self-healing** (the watcher restarts after `error`, the user can Stop/Start).
   Silent watch death is not covered, and a stale ping marks a healthy page "Not responding".
2. **Restart everything on every wake** (new watcher, new server, reload the page). Simple, but reloads a working
   page (loses its state), and a page that was already in an endless loop would be restarted into the same loop.
3. **Probe, then repair only what is broken** (chosen).

## Decision

`src/main/wake-recovery.ts` (`WakeRecovery`, Electron-free) listens to `powerMonitor` in main. The signals per platform
come from `src/platform/power-events.ts`:

| Platform | Events                    | Drift check (wake without an event)             |
| -------- | ------------------------- | ----------------------------------------------- |
| Windows  | `resume`, `unlock-screen` | tick every 10 s, wake if ≥ 60 s late            |
| macOS    | `resume`, `unlock-screen` | tick every 30 s, wake if ≥ 120 s late (App Nap) |

`suspend` records the preview state. On a wake signal (after a 1.5 s settle pause), once per wake — an unlock or clock
jump within 10 s of a recovery is the same wake, overlapping signals join the recovery in flight:

1. **Watcher:** `ProjectWatcher.resync()` closes the OS watch, takes a fresh snapshot, attaches a new watch and emits
   `rescan`. The renderer reloads the tree and checks open files against the disk with its usual external-change rules
   (a dirty buffer is never replaced).
2. **Watchdog:** the preview's outstanding ping is forgotten, so the sleep is not counted as the page's answer time.
3. **Server:** `PreviewServer.answers()` sends `HEAD /.noobide-health` without the ownership secret: the request checks
   answer 403 before any file is touched, and the secret never leaves the process. The session's network proxy
   (decision 0015) gets a TCP connect check, since all page traffic goes through it. No answer within 3 s → the preview
   restarts (`PreviewManager.restartAfterWake('server')`: Stop + Start in the same window). The registry tries the
   previous port first, so the page normally keeps its origin and storage; otherwise the new URL is loaded.
4. **Page:** a trivial `executeJavaScript('0')` with a 3 s timeout. Not answering, and the page was starting, running or
   refreshing before the sleep → restart (`'page'`): a hung page cannot reload itself. A page that was already
   unresponsive before the sleep is left alone (Stop/Start stays available). A healthy page is never reloaded.
5. A restart adds one localised console notice (`restarted-after-sleep`, zh-CN and en, as text). One content-free log
   line `wake-recovery {trigger, watcher, server, page}` goes to the app log.

A Stop, project switch or Start by the user while the restart is stopping wins: the restart then does not start
again. The restart goes through the ordinary Stop/Start path: the new view gets the same isolation (no preload, sandbox,
context isolation, per-project partition, the proxy and request policy). Editor buffers, autosave and the recovery
journal are in the renderer and app data; recovery never calls them, never reads project file contents and never
writes into a project.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- A clock set forward by more than the gap (or a long debugger pause) also triggers a recovery; it is harmless (a
  rescan and two probes). A clock set back is ignored.
- `unlock-screen` without a sleep (macOS screen lock) runs the same cheap probes; a healthy preview is untouched.
- Tests: `src/main/wake-recovery.test.ts` (simulated powerMonitor and clock: every decision, coalescing, clock jumps
  forward/back, App Nap lateness, dispose), `src/platform/power-events.test.ts`, `tests/integration/wake-recovery.test.ts`
  (real watcher whose OS watch silently died, real server whose socket died or hangs, same-port restart and fallback,
  drift-only wake), `tests/e2e/sleep-wake.spec.ts` (real `powerMonitor` events in the packaged app: tree rescan, no
  reload of a healthy page, server-socket kill → restart on the same origin with the zh-CN notice, page hung after wake
  → new renderer, a page hung before the sleep left alone, unsaved edit kept and saved afterwards).
- A real sleep cannot be automated: S25.1/S25.2 stay `needs_manual_check` with owner steps in
  `harness/MANUAL-CHECKS.md` (≥ 5 min sleep with a project and a running preview, then tree, preview and save).
