import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import type { OpenTab } from './document-state';
import { saveStatus, type SaveStatus } from './save-machine';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, SaveStateIcon } from './icons';

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
  const barRef = useRef<HTMLDivElement>(null);

  /** A vertical mouse wheel scrolls the strip sideways (a trackpad already scrolls it horizontally). */
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    if (bar.scrollWidth > bar.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      bar.scrollLeft += event.deltaY;
    }
  };

  // Overflow cues: when tabs are hidden on a side, a chevron button there says so (a shape, not a fade alone) and
  // scrolls the strip by most of its width. Mouse helpers only: the keyboard moves through the tabs with the arrows,
  // and the active tab is always scrolled into view.
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const start = bar.scrollLeft > 1;
    const end = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
    setOverflow((was) => (was.start === start && was.end === end ? was : { start, end }));
  }, []);
  useLayoutEffect(measure, [measure, tabs.length, active]);

  // When the tabs overflow the strip, the active tab is scrolled fully into view (only the strip scrolls, never the
  // workbench). The strip shows no scrollbar: a macOS overlay scrollbar covers the lower half of the tabs while it is
  // shown and swallows clicks meant for them.
  const showTab = useCallback((relPath: string | null) => {
    const bar = barRef.current;
    const tab = relPath ? refs.current.get(relPath)?.parentElement : undefined;
    if (!bar || !tab) return;
    const barRect = bar.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (tabRect.left < barRect.left) bar.scrollLeft -= barRect.left - tabRect.left;
    else if (tabRect.right > barRect.right) bar.scrollLeft += tabRect.right - barRect.right;
  }, []);
  // The chevrons are shown while the strip overflows at all, so scrolling never changes the strip's width; it changes
  // only when the overflow starts or ends, and then the active tab is shown again.
  const overflowing = overflow.start || overflow.end;
  useEffect(() => showTab(active), [showTab, active, tabs.length, overflowing]);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [measure]);
  const scrollStrip = (direction: 1 | -1) => {
    const bar = barRef.current;
    if (bar) bar.scrollBy({ left: direction * Math.max(80, bar.clientWidth * 0.8), behavior: 'smooth' });
  };

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
    <div
      className="tabs-strip"
      data-overflow-start={overflow.start ? 'true' : undefined}
      data-overflow-end={overflow.end ? 'true' : undefined}
    >
      {overflowing && (
        <button
          type="button"
          className="tabs-scroll"
          disabled={!overflow.start}
          tabIndex={-1}
          aria-hidden="true"
          title={t('tabs.scrollStart')}
          data-testid="tabs-scroll-start"
          onClick={() => scrollStrip(-1)}
        >
          <ChevronLeftIcon />
        </button>
      )}
      <div
        ref={barRef}
        className="tabs"
        role="tablist"
        aria-label={t('tabs.label')}
        data-testid="tab-bar"
        onWheel={onWheel}
        onScroll={measure}
      >
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
                onClick={() => {
                  onActivate(tab.relPath);
                  showTab(tab.relPath); // also when it is already active but scrolled partly out of view
                }}
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
      {overflowing && (
        <button
          type="button"
          className="tabs-scroll"
          disabled={!overflow.end}
          tabIndex={-1}
          aria-hidden="true"
          title={t('tabs.scrollEnd')}
          data-testid="tabs-scroll-end"
          onClick={() => scrollStrip(1)}
        >
          <ChevronRightIcon />
        </button>
      )}
    </div>
  );
}
