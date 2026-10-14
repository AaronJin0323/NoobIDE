import { useEffect, useRef, type KeyboardEvent } from 'react';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly run: () => void;
}

interface TreeContextMenuProps {
  label: string;
  items: readonly MenuItem[];
  x: number;
  y: number;
  /** `restoreFocus`: put focus back on the tree row (Escape); not when an item runs or the user clicked away. */
  onClose: (restoreFocus: boolean) => void;
}

/**
 * Context menu for a file tree row (S08.5): WAI-ARIA menu pattern. Opens with the first item focused; Up/Down/Home/
 * End move, Enter/Space run, Escape and Tab close. Rendered in the page (not a native menu) so it follows the
 * interface language.
 */
export function TreeContextMenu({ label, items, x, y, onClose }: TreeContextMenuProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refs.current[0]?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose(false);
    };
    const onBlur = () => onClose(false);
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent) => {
    const index = refs.current.findIndex((el) => el === document.activeElement);
    const move = (to: number) => refs.current[(to + items.length) % items.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(items.length - 1);
        break;
      case 'Escape':
      case 'Tab':
        onClose(true);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Keep the menu inside the window.
  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.min(y, window.innerHeight - (items.length * 34 + 16));
  return (
    <div
      ref={menu}
      className="context-menu"
      role="menu"
      aria-label={label}
      data-testid="tree-menu"
      style={{ left: Math.max(4, left), top: Math.max(4, top) }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="menu-item"
          data-command={item.id}
          onClick={() => {
            onClose(false);
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span className="menu-shortcut" aria-hidden="true">
              {item.shortcut}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
