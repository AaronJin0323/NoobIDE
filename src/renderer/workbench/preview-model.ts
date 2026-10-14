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
// --- end S17.3 ---
