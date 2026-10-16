import type { PreviewLogEntry, PreviewState, PreviewStatus } from '../../shared/ipc/preview-contract';
import type { MessageKey } from '../i18n/index';

/** Pure view model of the preview pane (S04.3, S05.2, S05.3): what to show and which actions are offered. */

export const MAX_VISIBLE_LOG_ENTRIES = 200;

/** S17.3: a console line plus the preview generation (page load) it came from. */
export type ConsoleEntry = PreviewLogEntry & { readonly generation: number };

export interface LogView {
  /** Newest last; at most MAX_VISIBLE_LOG_ENTRIES. */
  readonly entries: readonly ConsoleEntry[];
  /** Messages main dropped because the page logged faster than the cap (shown as "N messages dropped"). */
  readonly dropped: number;
  /** Some messages were skipped without being counted, so `dropped` is a lower bound ("at least N"). */
  readonly throttled: boolean;
  /** S17.3: the current page load; every start or refresh of the preview begins a new one. */
  readonly generation: number;
}

export const EMPTY_LOG: LogView = { entries: [], dropped: 0, throttled: false, generation: 0 };

export function appendLogBatch(
  view: LogView,
  entries: readonly PreviewLogEntry[],
  dropped: number,
  throttled = false,
): LogView {
  const tagged = entries.map((entry) => ({ ...entry, generation: view.generation })); // S17.3
  const merged = tagged.length === 0 ? view.entries : [...view.entries, ...tagged];
  return {
    entries: merged.length > MAX_VISIBLE_LOG_ENTRIES ? merged.slice(-MAX_VISIBLE_LOG_ENTRIES) : merged,
    dropped: view.dropped + dropped,
    throttled: view.throttled || throttled,
    generation: view.generation,
  };
}

export const STOPPED: PreviewStatus = { state: 'stopped', projectId: null };

export function stateLabelKey(state: PreviewState): MessageKey {
  switch (state) {
    case 'stopped':
      return 'preview.stopped';
    case 'starting':
      return 'preview.state.starting';
    case 'running':
      return 'preview.state.running';
    case 'refreshing':
      return 'preview.state.refreshing';
    case 'unresponsive':
      return 'preview.state.unresponsive';
    case 'failed':
      return 'preview.state.failed';
  }
}

export interface PreviewActions {
  readonly start: boolean;
  readonly stop: boolean;
  readonly reload: boolean;
}

/** Stop is offered in every live state, and above all when the page is unresponsive (PLAN §8). */
export function actionsFor(status: PreviewStatus, hasProject: boolean): PreviewActions {
  const live = status.state !== 'stopped';
  return {
    start: hasProject && (status.state === 'stopped' || status.state === 'failed'),
    stop: live,
    reload: status.state === 'running' || (status.state === 'failed' && status.failure === 'load-failed'),
  };
}

/** The message shown in the stage when no page is visible, or null when the page covers the stage. */
export function stageMessageKey(status: PreviewStatus, hasProject: boolean): MessageKey | null {
  switch (status.state) {
    case 'stopped':
      return hasProject ? 'preview.startHint' : 'preview.hint';
    case 'unresponsive':
      return 'preview.unresponsiveDetail';
    case 'failed':
      return status.failure === 'server-failed'
        ? 'preview.failed.server'
        : status.failure === 'crashed'
          ? 'preview.failed.crashed'
          : null; // A failed load still shows Chromium's error page in the view.
    default:
      return null;
  }
}

/**
 * S10.5: a save failed, so the page shows older content than the editor. The preview refreshes only after a
 * confirmed write; until the save succeeds the pill says "preview not updated" (wireframe editor-preview, pill).
 */
export function previewNotUpdated(status: PreviewStatus, saveFailed: boolean): boolean {
  return saveFailed && (status.state === 'running' || status.state === 'refreshing' || status.state === 'starting');
}

/** The native view is shown only while a page is meant to be visible; overlays and messages need the stage. */
export function viewVisible(status: PreviewStatus, paneVisible: boolean): boolean {
  return paneVisible && stageMessageKey(status, true) === null && status.state !== 'stopped';
}

// --- S17.3 console view: levels, filter, clear, attribution to the current page load ---

/** A start or refresh of the preview: later lines belong to the new page load; earlier ones stay, marked older. */
export function nextGeneration(view: LogView): LogView {
  return { ...view, generation: view.generation + 1 };
}

/** The Clear button: the list and the dropped counters are emptied; the page load stays the same. */
export function clearLog(view: LogView): LogView {
  return { ...EMPTY_LOG, generation: view.generation };
}

export type ConsoleLevelFilter = 'all' | 'error' | 'warning' | 'info';
export const CONSOLE_LEVEL_FILTERS: readonly ConsoleLevelFilter[] = ['all', 'error', 'warning', 'info'];

/** Lines to show: by level ('info' includes debug output) and, unless `older` is set, only the current page load. */
export function visibleLog(view: LogView, level: ConsoleLevelFilter, older: boolean): ConsoleEntry[] {
  return view.entries.filter(
    (entry) =>
      (older || entry.generation === view.generation) &&
      (level === 'all' ||
        entry.level === level ||
        (level === 'info' && (entry.level === 'info' || entry.level === 'debug'))),
  );
}

/** Lines from earlier page loads (hidden unless the user asks for them). */
export function olderCount(view: LogView): number {
  return view.entries.filter((entry) => entry.generation !== view.generation).length;
}
/** Errors of the current page load: the console heading shows their number (icon + number, never colour alone). */
export function errorCount(view: LogView): number {
  return view.entries.filter((entry) => entry.level === 'error' && entry.generation === view.generation).length;
}
// --- end S17.3 ---

// --- S14.2–S14.4, S15.4: preview toolbar ---

export interface ToolbarActions extends PreviewActions {
  /** A page is being served: it can be opened in the default browser. */
  readonly openExternal: boolean;
  /** There is a page (also a failed load or a hung one) whose developer tools can open. */
  readonly devTools: boolean;
  readonly clearData: boolean;
}

export function toolbarFor(status: PreviewStatus, hasProject: boolean): ToolbarActions {
  const served = status.state === 'running' || status.state === 'refreshing' || status.state === 'starting';
  const loadFailed = status.state === 'failed' && status.failure === 'load-failed';
  return {
    ...actionsFor(status, hasProject),
    openExternal: hasProject && (served || loadFailed),
    devTools: hasProject && (served || loadFailed || status.state === 'unresponsive'),
    clearData: hasProject,
  };
}

/**
 * The state pill: always text (never colour alone). A failed save (S10.5) or, in manual refresh mode, a save the
 * page does not show yet (S14.2) take precedence over the plain state while a page is shown.
 */
export function pillFor(
  status: PreviewStatus,
  saveFailed: boolean,
): { readonly label: MessageKey; readonly detail: MessageKey | null; readonly warning: boolean } {
  if (previewNotUpdated(status, saveFailed)) {
    return { label: 'preview.notUpdated', detail: 'preview.notUpdatedDetail', warning: true };
  }
  if (status.outdated === true && status.state !== 'stopped') {
    return { label: 'preview.outdated', detail: 'preview.outdatedDetail', warning: true };
  }
  return {
    label: stateLabelKey(status.state),
    detail: null,
    warning: status.state === 'unresponsive' || status.state === 'failed',
  };
}

/** S14.3: the value the entry picker shows: the configured entry, else index.html when the project has one. */
export function entryChoice(pages: readonly string[], entry: string | null): string {
  if (entry !== null && pages.includes(entry)) return entry;
  // No configured entry: index.html, else the first page — the one the preview opens (defaultEntryPath, same order).
  return pages.find((page) => page.toLowerCase() === 'index.html') ?? pages[0] ?? '';
}

/** S14.3: what to store for a picked page — null (the default) for the top-level index.html. */
export function entryToStore(page: string): string | null {
  return page.toLowerCase() === 'index.html' ? null : page;
}

/** S14.2: key presses in the code editor that count as typing (not shortcuts or bare modifiers). */
export function isTypingKey(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  if (event.ctrlKey || event.metaKey) return false; // ⌘S, Ctrl+Z… are commands, not typing
  return !['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock', 'Escape'].includes(event.key);
}
// --- end S14 / S15.4 ---

/** Where the preview is: the page showing, whether it is missing (404), and whether it is not the entry page. */
export interface PageLocation {
  /** Project-relative path of the page showing ('index.html' for the server root). */
  readonly path: string;
  readonly missing: boolean;
  /** Showing another page than the entry page (or a missing one): "Back to entry page" is offered. */
  readonly away: boolean;
}

/** The folder's index page spelled out: '' → 'index.html', 'docs/' → 'docs/index.html'. */
const pageOf = (path: string) => (path === '' || path.endsWith('/') ? `${path}index.html` : path);

/**
 * The page location the toolbar shows, from the status (`url`, `notFound`) and the entry page (`entryChoice`, '' when
 * unknown). Null while no page of a running preview is known.
 */
export function pageLocation(status: PreviewStatus, entryPage: string): PageLocation | null {
  if (status.state === 'stopped' || !status.url) return null;
  let path: string;
  try {
    path = pageOf(decodeURIComponent(new URL(status.url).pathname.replace(/^\/+/, '')));
  } catch {
    return null;
  }
  const missing = status.notFound === true;
  const entry = entryPage === '' ? null : pageOf(entryPage);
  return { path, missing, away: missing || (entry !== null && path !== entry) };
}
