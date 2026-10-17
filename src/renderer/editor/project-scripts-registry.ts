/**
 * S57: where the open project's ProjectScripts instance is found by JavaScript navigation, and whether it is still
 * indexing. Monaco-free so the workbench (useProjectScripts, useJsNavigation) can use it from the first render; the
 * Monaco binding (project-scripts-monaco.ts) registers the instance once its chunk has loaded.
 *
 * Opening a project has two gaps a keypress can fall into: the Monaco chunk is still loading (no instance yet), and
 * the instance is still reading the project's scripts. Both count as "indexing" here, so F12 pressed a second after
 * opening a project waits for the real answer instead of a false "not found".
 */
import { timedOut, type ProjectScripts } from './project-scripts';

/** How long navigation waits for the index before it says it is still indexing. */
export const INDEX_WAIT_MS = 10_000;

let current: ProjectScripts | null = null;
/** A project is open but its ProjectScripts has not been created yet (the Monaco chunk is loading). */
let expected = false;
let waiters: (() => void)[] = [];

export const currentProjectScripts = (): ProjectScripts | null => current;

/** The workbench opened a project: an instance is on its way (useProjectScripts). */
export function expectProjectScripts(): void {
  expected = true;
}

/** The workbench closed the project (or its effect was torn down) before an instance existed. */
export function cancelExpectedProjectScripts(): void {
  expected = false;
  wake();
}

export function registerProjectScripts(scripts: ProjectScripts): void {
  current = scripts;
  expected = false;
  wake();
}

export function unregisterProjectScripts(scripts: ProjectScripts): void {
  if (current === scripts) current = null;
  wake();
}

function wake(): void {
  const list = waiters;
  waiters = [];
  for (const w of list) w();
}

/** True while an answer about the project's scripts could still be missing a file. */
export function projectIndexing(): boolean {
  return expected || (current?.indexing() ?? false);
}

/**
 * Resolves `true` once the open project's scripts are indexed (at once when no project is open), `false` when they
 * are not after `timeoutMs`.
 */
export async function whenProjectIndexed(timeoutMs = INDEX_WAIT_MS, now: () => number = Date.now): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (expected && current === null) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    const woken = new Promise<void>((resolve) => waiters.push(resolve));
    if (await timedOut(woken, remaining)) return false;
  }
  const scripts = current;
  if (!scripts) return true;
  return scripts.whenIndexed(Math.max(0, deadline - now()), now);
}

/** Tests: forget everything. */
export function resetProjectScriptsRegistry(): void {
  current = null;
  expected = false;
  wake();
  releaseProjectScriptReads();
}

// ── e2e hook: a slow disk on demand ──────────────────────────────────────────────────────────────────────────────
// The race this module closes (a keypress while the project's scripts are still being read) is a matter of
// milliseconds on a developer machine and of seconds on a starved hosted runner. The e2e suite holds the reads here,
// presses the key, checks what the user sees, then releases them — the same way the worker kill switch simulates a
// crash (monaco-setup.ts). The hold only delays reads; nothing is read or written differently.

let hold: { readonly gate: Promise<void>; release(): void } | null = null;

/** e2e: every project-script read waits until `releaseProjectScriptReads()`. */
export function holdProjectScriptReads(): void {
  if (hold) return;
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  hold = { gate, release };
}

export function releaseProjectScriptReads(): void {
  hold?.release();
  hold = null;
}

/** The binding's reads pass through here (resolved at once unless a hold is on). */
export const projectScriptReadGate = (): Promise<void> => hold?.gate ?? Promise.resolve();
