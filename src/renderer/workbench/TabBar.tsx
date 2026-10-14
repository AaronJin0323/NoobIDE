import { useRef, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import type { OpenTab } from './document-state';
import { saveStatus, type SaveStatus } from './save-machine';
import { CloseIcon, SaveStateIcon } from './icons';

interface TabBarProps {
  tabs: readonly OpenTab[];
  active: string | null;
  onActivate: (relPath: string) => void;
  onClose: (relPath: string) => void;
}

/** Statuses a tab names in text next to its icon; a clean or saved tab needs no marker (S09.2, S10.3). */
export const TAB_STATE_LABEL: Partial<Record<SaveStatus, MessageKey>> = {
  dirty: 'tab.state.dirty',
  saving: 'tab.state.saving',
  failed: 'tab.state.failed',
  conflict: 'tab.state.conflict',
  deleted: 'tab.state.deleted', // S11.3
};

/** File name shown on a tab; the full relative path is in the tooltip and the accessible name. */
export function tabTitle(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

/**
 * Open files as an ARIA tablist (S09.2): one tab stop (roving tabindex), 鈫?鈫?Home/End move and show a tab, Delete
 * closes it; middle-click and the 脳 button close too. Unsaved, saving, failed and conflict states are written out
 * next to a distinct icon 鈥?never colour alone.
 */
export function TabBar({ tabs, active, onActivate, onClose }: TabBarProps) {
  const { t } = useI18n();
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const focusAndShow = (relPath: string | undefined) => {
    if (!relPath) return;
    onActivate(relPath);
    refs.current.get(relPath)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      focusAndShow(tabs[(move + tabs.length) % tabs.length]?.relPath);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const tab = tabs[index];
      if (tab) onClose(tab.relPath);
    }
  };

  return (
    <div className="tabs" role="tablist" aria-label={t('tabs.label')} data-testid="tab-bar">
      {tabs.map((tab, index) => {
        const status = saveStatus(tab.save);
        const label = TAB_STATE_LABEL[status];
        const selected = tab.relPath === active;
        const closeLabel = `${t('tabs.close')} ${tab.relPath}`;
        return (
          <div
            key={tab.relPath}
            role="presentation"
            className={`tab-item${selected ? ' selected' : ''} tab-${status}`}
            data-testid="tab"
            data-path={tab.relPath}
            data-state={status}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.relPath);
              }
            }}
            onMouseDown={(event) => {
              // Middle button must not start autoscroll; the close happens on auxclick.
              if (event.button === 1) event.preventDefault();
            }}
          >
            <button
              ref={(node) => {
                if (node) refs.current.set(tab.relPath, node);
                else refs.current.delete(tab.relPath);
              }}
              type="button"
              role="tab"
              className="tab"
              id={`tab-${index}`}
              aria-selected={selected}
              aria-controls="editor-surface"
              // S24.3: Delete closes the tab; the mouse-only × next to it is hidden from the tablist's children.
              aria-keyshortcuts="Delete"
              tabIndex={selected || (active === null && index === 0) ? 0 : -1}
              title={tab.relPath}
              onClick={() => onActivate(tab.relPath)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="tab-name">{tabTitle(tab.relPath)}</span>
              {label && (
                <span className="tab-state" data-testid="tab-state">
                  <SaveStateIcon state={status} />
                  {t(label)}
                </span>
              )}
            </button>
            <button
              type="button"
              className="tab-close"
              tabIndex={-1}
              aria-hidden="true"
              aria-label={closeLabel}
              title={closeLabel}
              data-testid="tab-close"
              onClick={() => onClose(tab.relPath)}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
