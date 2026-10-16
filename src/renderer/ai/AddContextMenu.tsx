import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageKey } from '../i18n/index';
import { DocumentIcon, PlusIcon, PreviewIcon, SelectionIcon } from './ai-icons';

type Translate = (key: MessageKey) => string;

export interface AddContextActions {
  addCurrentFile(): boolean;
  addSelection(): boolean;
  addPreview(): Promise<boolean>;
}

const ITEMS: readonly {
  readonly testId: string;
  readonly label: MessageKey;
  readonly icon: ReactNode;
  readonly run: (actions: AddContextActions) => unknown;
}[] = [
  { testId: 'ai-add-file', label: 'ai.chat.context.addFile', icon: <DocumentIcon />, run: (a) => a.addCurrentFile() },
  {
    testId: 'ai-add-selection',
    label: 'ai.chat.context.addSelection',
    icon: <SelectionIcon />,
    run: (a) => a.addSelection(),
  },
  { testId: 'ai-add-preview', label: 'ai.chat.context.addPreview', icon: <PreviewIcon />, run: (a) => a.addPreview() },
];

/**
 * S45.5 (HIG Menus / pull-down buttons): the composer's one "Add" (+) button replaces the three add-context buttons.
 * An ARIA menu button like the preview's More menu: Enter, Space or ↓ opens it on the first item, ↑/↓/Home/End move,
 * Escape closes it and returns the focus to the button, Tab or a click elsewhere closes it. It opens upwards because
 * the composer sits at the bottom of the panel.
 */
export function AddContextMenu({
  actions,
  t,
  defaultOpen = false,
}: {
  readonly actions: AddContextActions;
  readonly t: Translate;
  /** Rendered open (unit tests of the static markup). */
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return undefined;
    items()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
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
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const label = t('ai.chat.context.addGroup');
  return (
    <div className="ai-add">
      <button
        ref={button}
        type="button"
        className="icon-button ai-add-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        data-testid="ai-add-menu"
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <PlusIcon size={14} />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="app-menu-list ai-add-list"
          role="menu"
          aria-label={label}
          data-testid="ai-add-list"
          onKeyDown={onMenuKey}
        >
          {ITEMS.map((item) => (
            <button
              key={item.testId}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="app-menu-item ai-add-item"
              data-testid={item.testId}
              onClick={() => {
                close(true);
                void item.run(actions);
              }}
            >
              <span className="ai-add-item-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="ai-add-item-label">{t(item.label)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
