import type { PreviewLogEntry, PreviewState, PreviewStatus } from '../../shared/ipc/preview-contract';
import type { MessageKey } from '../i18n/index';

/** Pure view model of the preview pane (S04.3, S05.2, S05.3): what to show and which actions are offered. */

export const MAX_VISIBLE_LOG_ENTRIES = 200;

export interface LogView {
  /** Newest last; at most MAX_VISIBLE_LOG_ENTRIES. */
  readonly entries: readonly PreviewLogEntry[];
  /** Messages main dropped because the page logged faster than the cap (shown as "N messages dropped"). */
  readonly dropped: number;
}

export const EMPTY_LOG: LogView = { entries: [], dropped: 0 };

export function appendLogBatch(view: LogView, entries: readonly PreviewLogEntry[], dropped: number): LogView {
  const merged = entries.length === 0 ? view.entries : [...view.entries, ...entries];
  return {
    entries: merged.length > MAX_VISIBLE_LOG_ENTRIES ? merged.slice(-MAX_VISIBLE_LOG_ENTRIES) : merged,
    dropped: view.dropped + dropped,
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

/** The native view is shown only while a page is meant to be visible; overlays and messages need the stage. */
export function viewVisible(status: PreviewStatus, paneVisible: boolean): boolean {
  return paneVisible && stageMessageKey(status, true) === null && status.state !== 'stopped';
}
