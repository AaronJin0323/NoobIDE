import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { MoreIcon } from './icons';

export interface AppMenuItem {
  readonly id: string;
  readonly label: MessageKey;
  /** S24.1: the shortcut hint from the command registry (`⌘S` / `Ctrl+S`), if the command has one. */
  readonly shortcut?: string | null;
  /** S24.1: a separator line goes above this item (a new group). */
  readonly separatorBefore?: boolean;
  /** S24.4: a choice among several (menuitemradio): whether it is the current one; null/absent for actions. */
  readonly checked?: boolean | null;
  readonly onSelect: () => void;
}

const isChoice = (item: AppMenuItem) => item.checked !== undefined && item.checked !== null;

interface AppMenuProps {
  readonly items: readonly AppMenuItem[];
  /** Name of the menu (button label, tooltip and the list's accessible name). Default: the help/more menu. */
  readonly menuLabel?: MessageKey;
  /** Test id of the button; the list's element id is `${testId}-list`. Default: `app-menu`. */
  readonly testId?: string;
  /** The button's icon. Default: ⋯. */
  readonly icon?: ReactNode;
  /** S47.4: the list opens flush with the button's right edge (a menu at the end of the top bar). */
  readonly alignEnd?: boolean;
  /** S47.4: a line of plain text above the items (the project menu shows the project folder). */
  readonly detail?: { readonly label: MessageKey; readonly text: string; readonly testId: string } | undefined;
}

/**
 * The workbench's small command menus (S13.3 close project, S13.6 open logs folder; S47.4: a project menu next to
 * the project name and a help/more menu at the end of the top bar). An ARIA menu button: Enter, Space or ↓ opens it
 * on the first item, ↑/↓/Home/End move, Escape closes and returns focus to the button, Tab or a click elsewhere
 * closes it. A native preview view never covers an open menu: the preview hides under any `[role="menu"]`
 * (preview-viewport.ts OVERLAY_SELECTOR).
 */
export function AppMenu({
  items,
  menuLabel = 'appMenu.label',
  testId = 'app-menu',
  icon,
  alignEnd,
  detail,
}: AppMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listId = `${testId}-list`;
  const entries = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return undefined;
    entries()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  if (items.length === 0) return null;

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = entries();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      list[(move + list.length) % list.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className="app-menu">
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={t(menuLabel)}
        title={t(menuLabel)}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon ?? <MoreIcon />}
      </button>
      {open && (
        <div
          ref={menu}
          id={listId}
          className={alignEnd ? 'app-menu-list app-menu-list-end' : 'app-menu-list'}
          role="menu"
          aria-label={t(menuLabel)}
          onKeyDown={onMenuKey}
        >
          {detail && (
            <div className="app-menu-detail" title={detail.text}>
              <span className="app-menu-detail-label">{t(detail.label)}</span>
              <span className="app-menu-detail-text" data-testid={detail.testId}>
                {detail.text}
              </span>
            </div>
          )}
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.separatorBefore && <div role="separator" className="app-menu-separator" />}
              <button
                type="button"
                role={isChoice(item) ? 'menuitemradio' : 'menuitem'}
                aria-checked={isChoice(item) ? item.checked === true : undefined}
                tabIndex={-1}
                className="app-menu-item"
                data-testid={`menu-${item.id}`}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                <span>
                  {/* S24.4: the current choice carries a check mark, not only a colour */}
                  {isChoice(item) && (
                    <span className="app-menu-check" aria-hidden="true">
                      {item.checked ? '✓' : ''}
                    </span>
                  )}
                  {t(item.label)}
                </span>
                {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
