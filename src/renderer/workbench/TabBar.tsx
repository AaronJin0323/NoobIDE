import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import type { OpenTab } from './document-state';
import { saveStatus, type SaveStatus } from './save-machine';
import { scrollBehavior, useReducedMotion } from '../theme/motion';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, ListIcon, SaveStateIcon } from './icons';
import { allTabsRows, focusAfterClose } from './all-tabs'; // S49.5
import { useRovingFocus } from './useRovingFocus'; // S49.5
import { fileRoleDetailKey, fileRoleFor, fileRoleLabelKey } from './file-role';
import { fill } from './file-op-messages';

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
 * S47.3: the tab's tooltip — the relative path, plus the state word while the tab is not clean. S47.5: the file's role
 * ("页面结构：写网页上有什么内容…") on a second line, where it stays after the hint above the code has collapsed.
 */
export function tabTooltip(relPath: string, state: string | null, role: string | null = null): string {
  const first = state ? `${relPath} · ${state}` : relPath;
  return role ? `${first}\n${role}` : first;
}

/**
 * Open files as an ARIA tablist (S09.2): one tab stop (roving tabindex), 鈫?鈫?Home/End move and show a tab, Delete
 * closes it; middle-click and the × button close too. Unsaved, saving, failed and conflict states show a distinct
 * next to a distinct icon 鈥?never colour alone.
 */
export function TabBar({ tabs, active, onActivate, onClose }: TabBarProps) {
  const { t } = useI18n();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const barRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

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
  useEffect(() => {
    showTab(active);
    // A new tab can still change size after this commit (its state label, the strip's chevrons): check again once
    // the layout has settled.
    const frame = requestAnimationFrame(() => {
      measure();
      showTab(active);
    });
    return () => cancelAnimationFrame(frame);
  }, [showTab, measure, active, tabs.length, overflowing]);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [measure]);
  const scrollStrip = (direction: 1 | -1) => {
    const bar = barRef.current;
    // S47.1: the strip glides unless the system asks for reduced motion.
    if (bar)
      bar.scrollBy({ left: direction * Math.max(80, bar.clientWidth * 0.8), behavior: scrollBehavior(reducedMotion) });
  };

  // Delete on the focused tab: its button leaves the DOM once the tab is closed (after its save), which would drop the
  // keyboard focus on the page body. The tab shown next takes the focus instead, so the arrows keep working.
  const refocusAfterClose = useRef<string | null>(null);
  useEffect(() => {
    const closing = refocusAfterClose.current;
    if (closing === null || tabs.some((tab) => tab.relPath === closing)) return; // not closed (yet)
    refocusAfterClose.current = null;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return; // the focus went somewhere on purpose
    const next = active ?? tabs[0]?.relPath;
    if (next !== undefined) refs.current.get(next)?.focus();
  }, [tabs, active]);

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
      if (tab) {
        refocusAfterClose.current = tab.relPath;
        onClose(tab.relPath);
      }
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
          const role = fileRoleFor(tab.relPath);
          const roleText = role
            ? fill(t('fileRole.tooltip'), { role: t(fileRoleLabelKey(role)), detail: t(fileRoleDetailKey(role)) })
            : null;
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
                title={tabTooltip(tab.relPath, label ? t(label) : null, roleText)}
                onClick={() => {
                  onActivate(tab.relPath);
                  showTab(tab.relPath); // also when it is already active but scrolled partly out of view
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                <span className="tab-name">{tabTitle(tab.relPath)}</span>
                <span className="tab-state-slot" aria-hidden={label ? undefined : 'true'}>
                  {label && (
                    <span className="tab-state" data-testid="tab-state" title={t(label)}>
                      <SaveStateIcon state={status} />
                      <span className="sr-only">{t(label)}</span>
                    </span>
                  )}
                </span>
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
      {/* S49.5: every open file in one list, with its state word, closable from there. */}
      <AllTabs
        tabs={tabs}
        active={active}
        shown={overflowing}
        onActivate={(relPath) => focusAndShow(relPath)}
        onClose={onClose}
      />
    </div>
  );
}

/**
 * S49.5: the "All tabs" button (offered while the strip overflows) and its list: one row per open file in tab
 * order — name, folder, state word (Saved included), a check on the shown tab — and a close button per row. The list
 * is one tab stop (the arrows move, Delete closes the focused row's file); Escape or a click outside closes it and
 * the focus goes back to the button. Closing a file with unsaved edits goes through the usual close path.
 */
function AllTabs({
  tabs,
  active,
  shown,
  onActivate,
  onClose,
}: {
  tabs: readonly OpenTab[];
  active: string | null;
  shown: boolean;
  onActivate: (relPath: string) => void;
  onClose: (relPath: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const listId = 'all-tabs-list';
  const roving = useRovingFocus<HTMLUListElement>({ orientation: 'both', items: ':scope > li > button' });
  const rows = allTabsRows(tabs, active);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // On open the shown file's row takes the focus; after a close from the list, the row that took its place.
  useLayoutEffect(() => {
    if (!open) return;
    const openers = [...(panel.current?.querySelectorAll<HTMLButtonElement>('.all-tabs-open') ?? [])];
    if (openers.length === 0) {
      setOpen(false);
      button.current?.focus();
      return;
    }
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    openers[Math.min(index, openers.length - 1)]?.focus({ preventScroll: true });
  }, [open, tabs.length]);

  if (!shown && !open) return null;

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const closeRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    pendingFocus.current = focusAfterClose(index, rows.length - 1);
    onClose(row.relPath);
  };

  return (
    <div className="all-tabs">
      <button
        ref={button}
        type="button"
        className="tabs-all"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={fill(t('tabs.all.title'), { n: String(tabs.length) })}
        title={fill(t('tabs.all.title'), { n: String(tabs.length) })}
        data-testid="tabs-all"
        onClick={() => {
          if (!open)
            pendingFocus.current = Math.max(
              0,
              rows.findIndex((row) => row.current),
            );
          setOpen((value) => !value);
        }}
      >
        <ListIcon />
      </button>
      {open && (
        <div
          ref={panel}
          id={listId}
          className="app-menu-list app-menu-list-end all-tabs-list"
          role="dialog"
          aria-label={t('tabs.all.menu')}
          data-testid="all-tabs-list"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }
          }}
        >
          <ul className="all-tabs-rows" {...roving}>
            {rows.map((row, index) => {
              const state = t(row.stateKey);
              return (
                <li key={row.relPath} className="all-tabs-row" data-path={row.relPath} data-state={row.status}>
                  <button
                    type="button"
                    className="app-menu-item all-tabs-open"
                    aria-current={row.current ? 'true' : undefined}
                    aria-keyshortcuts="Delete"
                    title={row.relPath}
                    data-testid="all-tabs-open"
                    onClick={() => {
                      close(false);
                      onActivate(row.relPath);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Delete') {
                        event.preventDefault();
                        closeRow(index);
                      }
                    }}
                  >
                    <span className="all-tabs-check" aria-hidden="true">
                      {row.current && <CheckIcon />}
                    </span>
                    <span className="all-tabs-name">
                      {row.name}
                      {row.current && <span className="sr-only">{` (${t('tabs.all.current')})`}</span>}
                    </span>
                    {row.folder && <span className="all-tabs-folder">{row.folder}</span>}
                    <span className="all-tabs-state" data-testid="all-tabs-state">
                      {row.status !== 'clean' && row.status !== 'saved' && <SaveStateIcon state={row.status} />}
                      {state}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button all-tabs-close"
                    aria-label={fill(t('tabs.all.close'), { name: row.relPath })}
                    title={fill(t('tabs.all.close'), { name: row.relPath })}
                    data-testid="all-tabs-close"
                    onClick={() => closeRow(index)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
