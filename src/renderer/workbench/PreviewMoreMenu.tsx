import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AnnotateWay } from '../annotations/AnnotationsStrip';
import { useI18n } from '../i18n/I18nProvider';

export interface PreviewMoreMenuProps {
  readonly openExternal: { readonly enabled: boolean; readonly onSelect: () => void };
  readonly entry: {
    readonly pages: readonly string[];
    /** The page the preview opens (shown with a check mark). */
    readonly value: string;
    readonly truncated: boolean;
    /** Read the pages again (the entry may have changed elsewhere). */
    readonly onOpen: () => void;
    readonly onChoose: (page: string) => void;
  };
  readonly autoRefresh: {
    readonly checked: boolean;
    readonly enabled: boolean;
    readonly title: string;
    readonly onToggle: () => void;
  };
  /** Absent: annotations are not available in this window. */
  readonly annotate?: { readonly enabled: boolean; readonly onWay: (way: AnnotateWay) => void } | undefined;
  readonly onAdvanced: () => void;
}

/** The three ways of starting an annotation (S41.5), offered from the More menu since S44.2. */
const WAYS: readonly AnnotateWay[] = ['pick', 'list', 'region'];

/**
 * S44.2: the preview toolbar's More menu (HIG Toolbars: few items in the toolbar, the rest in a More menu). An ARIA
 * menu button like the workbench's AppMenu: Enter, Space or ↓ opens it on the first item, ↑/↓/Home/End move, Escape
 * closes and returns the focus to the button, Tab or a click elsewhere closes it. "Entry page" drills into the list of
 * pages in the same menu (→ or Enter opens it, ← or Escape goes back). The menu drops down over the stage; as a
 * `role="menu"` element it is one of the PreviewPane's overlays, so the native view hides while it is open.
 */
export function PreviewMoreMenu({ openExternal, entry, autoRefresh, annotate, onAdvanced }: PreviewMoreMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'entry'>('main');
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const groupId = useId();
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  /** Which item gets the focus when the menu (or one of its views) is shown. */
  const focusOn = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const list = items();
    const wanted = focusOn.current ? list.find((el) => el.dataset.focusKey === focusOn.current) : undefined;
    (wanted ?? list[0])?.focus();
    focusOn.current = null;
  }, [open, view]);

  const show = () => {
    entry.onOpen();
    setView('main');
    setOpen(true);
  };
  const close = (focusButton: boolean) => {
    setOpen(false);
    setView('main');
    if (focusButton) button.current?.focus();
  };
  const choose = (enabled: boolean, run: () => void) => () => {
    if (!enabled) return;
    close(true);
    run();
  };
  const openEntries = () => {
    if (entry.pages.length === 0) return;
    focusOn.current = `page:${entry.value}`;
    setView('entry');
  };
  const backToMain = () => {
    focusOn.current = 'entry';
    setView('main');
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      list[(move + list.length) % list.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (view === 'entry') backToMain();
      else close(true);
    } else if (event.key === 'ArrowLeft' && view === 'entry') {
      event.preventDefault();
      backToMain();
    } else if (
      event.key === 'ArrowRight' &&
      view === 'main' &&
      document.activeElement?.closest('[data-focus-key="entry"]')
    ) {
      event.preventDefault();
      openEntries();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const item = (props: {
    key: string;
    testId: string;
    label: ReactNode;
    onSelect: () => void;
    enabled?: boolean;
    role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
    checked?: boolean;
    title?: string;
    value?: ReactNode;
    extra?: Record<string, string>;
  }) => {
    const role = props.role ?? 'menuitem';
    const enabled = props.enabled ?? true;
    return (
      <button
        key={props.key}
        type="button"
        role={role}
        aria-checked={role === 'menuitem' ? undefined : props.checked === true}
        aria-disabled={enabled ? undefined : true}
        tabIndex={-1}
        className="app-menu-item preview-menu-item"
        data-testid={props.testId}
        data-focus-key={props.key}
        title={props.title}
        onClick={props.onSelect}
        {...props.extra}
      >
        <span className="preview-menu-label">
          {/* The current choice carries a check mark, not only a colour; every item keeps the column (aligned). */}
          <span className="app-menu-check" aria-hidden="true">
            {role !== 'menuitem' && props.checked ? '✓' : ''}
          </span>
          {props.label}
        </span>
        {props.value !== undefined && <span className="menu-shortcut preview-menu-value">{props.value}</span>}
      </button>
    );
  };

  const pageLabel = (page: string) =>
    page.toLowerCase() === 'index.html' ? `${page} ${t('preview.entry.default')}` : page;

  return (
    <div className="preview-more">
      <button
        ref={button}
        type="button"
        className="icon-button preview-more-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('preview.more')}
        title={t('preview.more.title')}
        data-testid="preview-more"
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            show();
          }
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="app-menu-list preview-more-list"
          role="menu"
          aria-label={view === 'entry' ? t('preview.entry.listLabel') : t('preview.more')}
          data-testid="preview-more-menu"
          onKeyDown={onMenuKey}
        >
          {view === 'entry' ? (
            <>
              {item({
                key: 'back',
                testId: 'preview-entry-back',
                label: (
                  <>
                    <span className="preview-menu-chevron back" aria-hidden="true">
                      ‹
                    </span>
                    {t('preview.entry.back')}
                  </>
                ),
                onSelect: backToMain,
              })}
              <div role="separator" className="app-menu-separator" />
              <div className="preview-menu-heading" aria-hidden="true">
                {t('preview.entry')}
              </div>
              {entry.pages.map((page) =>
                item({
                  key: `page:${page}`,
                  testId: 'preview-entry-option',
                  role: 'menuitemradio',
                  checked: page === entry.value,
                  label: <span className="preview-menu-page">{pageLabel(page)}</span>,
                  onSelect: choose(true, () => entry.onChoose(page)),
                  extra: { 'data-page': page },
                }),
              )}
              {entry.truncated && <div className="preview-menu-note">{t('preview.entry.truncated')}</div>}
            </>
          ) : (
            <>
              {item({
                key: 'external',
                testId: 'preview-open-external',
                label: t('preview.openExternal'),
                title: t('preview.openExternal.title'),
                enabled: openExternal.enabled,
                onSelect: choose(openExternal.enabled, openExternal.onSelect),
              })}
              {item({
                key: 'entry',
                testId: 'preview-entry',
                label: t('preview.entry'),
                value: (
                  <>
                    <span className="preview-menu-page">{entry.value || t('preview.entry.none')}</span>
                    <span className="preview-menu-chevron" aria-hidden="true">
                      ›
                    </span>
                  </>
                ),
                enabled: entry.pages.length > 0,
                onSelect: openEntries,
                extra: { 'aria-haspopup': 'menu' },
              })}
              {item({
                key: 'refresh',
                testId: 'preview-auto-refresh',
                role: 'menuitemcheckbox',
                checked: autoRefresh.checked,
                label: t('preview.refreshMode'),
                title: autoRefresh.title,
                enabled: autoRefresh.enabled,
                onSelect: choose(autoRefresh.enabled, autoRefresh.onToggle),
              })}
              {annotate && (
                <>
                  <div role="separator" className="app-menu-separator" />
                  <div role="group" aria-labelledby={groupId}>
                    <div className="preview-menu-heading" id={groupId}>
                      {t('annotations.annotate')}
                      {!annotate.enabled && (
                        <span className="preview-menu-note-inline">{` · ${t('preview.annotate.needsRunning')}`}</span>
                      )}
                    </div>
                    {WAYS.map((way) =>
                      item({
                        key: `annotate:${way}`,
                        testId: `preview-annotate-${way}`,
                        label: t(`annotations.annotate.${way}`),
                        enabled: annotate.enabled,
                        onSelect: choose(annotate.enabled, () => annotate.onWay(way)),
                      }),
                    )}
                  </div>
                </>
              )}
              <div role="separator" className="app-menu-separator" />
              {item({
                key: 'advanced',
                testId: 'preview-advanced',
                label: t('preview.advanced.item'),
                title: t('preview.advanced.title'),
                onSelect: choose(true, onAdvanced),
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
