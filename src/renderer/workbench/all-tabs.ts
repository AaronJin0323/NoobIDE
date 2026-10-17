import type { MessageKey } from '../i18n/index';
import type { OpenTab } from './document-state';
import { saveStatus, type SaveStatus } from './save-machine';

/**
 * S49.5: the tab bar's "All tabs" list. Pure: every open file in tab order with its name, its folder (to tell two
 * `index.html` apart), whether it is the shown tab, and its state in a word — "Saved" included, so every row says
 * where it stands, never by colour alone.
 */
export interface AllTabsRow {
  readonly relPath: string;
  readonly name: string;
  /** The folder path, or '' at the project root. */
  readonly folder: string;
  readonly current: boolean;
  readonly status: SaveStatus;
  readonly stateKey: MessageKey;
}

export const ALL_TABS_STATE: Record<SaveStatus, MessageKey> = {
  clean: 'tabs.all.saved',
  saved: 'tabs.all.saved',
  dirty: 'tab.state.dirty',
  saving: 'tab.state.saving',
  failed: 'tab.state.failed',
  conflict: 'tab.state.conflict',
  deleted: 'tab.state.deleted',
};

export function allTabsRows(tabs: readonly OpenTab[], active: string | null): AllTabsRow[] {
  return tabs.map((tab) => {
    const slash = tab.relPath.lastIndexOf('/');
    const status = saveStatus(tab.save);
    return {
      relPath: tab.relPath,
      name: tab.relPath.slice(slash + 1),
      folder: slash === -1 ? '' : tab.relPath.slice(0, slash),
      current: tab.relPath === active,
      status,
      stateKey: ALL_TABS_STATE[status],
    };
  });
}

/**
 * Where the keyboard goes after the row at `index` was closed from the list: the row that took its place, else the
 * one before it; null when the list is empty (the list closes and the focus returns to the All-tabs button).
 */
export function focusAfterClose(index: number, remaining: number): number | null {
  if (remaining <= 0) return null;
  return Math.min(index, remaining - 1);
}
