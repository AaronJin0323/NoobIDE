import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';

export interface AppMenuItem {
  readonly id: string;
  readonly label: MessageKey;
  readonly onSelect: () => void;
}

/**
 * The workbench's small command menu (S13.3 close project, S13.6 open logs folder). An ARIA menu button: Enter,
 * Space or ↓ opens it on the first item, ↑/↓/Home/End move, Escape closes and returns focus to the button, Tab or a
 * click elsewhere closes it. It opens to the left half of the window, where no native preview view can cover it.
 */
export function AppMenu({ items }: { items: readonly AppMenuItem[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const entries = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

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
        aria-controls="app-menu-list"
        aria-label={t('appMenu.label')}
        title={t('appMenu.label')}
        data-testid="app-menu"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
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
          id="app-menu-list"
          className="app-menu-list"
          role="menu"
          aria-label={t('appMenu.label')}
          onKeyDown={onMenuKey}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="app-menu-item"
              data-testid={`menu-${item.id}`}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
