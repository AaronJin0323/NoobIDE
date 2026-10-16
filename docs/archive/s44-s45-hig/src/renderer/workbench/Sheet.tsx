import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { focusSnapshot, focusableIn, returnFocus, useModalKeys } from './focus-trap';

export type SheetSize = 'small' | 'medium' | 'wide' | 'large';

export interface SheetProps {
  /** The sheet's title (an h2; it names the dialog). */
  readonly title: ReactNode;
  /** Shown to screen readers only: the palette's search field is its visible title. */
  readonly titleHidden?: boolean;
  /** At most one short sentence under the title (it describes the dialog). */
  readonly description?: ReactNode;
  /** The content. It scrolls when the window is small; the title and the actions stay in view. */
  readonly children: ReactNode;
  /**
   * The trailing actions in reading order: Cancel (or Close) first, the default / primary action last. A lone Close
   * is the default button. Destructive actions are named with their verb and use `destructive-button`.
   */
  readonly actions?: ReactNode;
  /** Leading content of the action bar: a status line or an action set apart from the default (e.g. Discard). */
  readonly leading?: ReactNode;
  /** A footer in place of the action bar (the palette's result count and key hints). */
  readonly footer?: ReactNode;
  /** Escape (and a click on the backdrop when `dismissOnBackdrop`). */
  onEscape(): void;
  readonly dismissOnBackdrop?: boolean;
  /** `alertdialog` for a question that interrupts (the content then describes the dialog). */
  readonly role?: 'dialog' | 'alertdialog';
  readonly size?: SheetSize;
  readonly className?: string;
  readonly backdropClassName?: string;
  readonly testId: string;
  readonly backdropTestId?: string;
  readonly sheetRef?: RefObject<HTMLDivElement | null>;
  onMouseDown?(event: MouseEvent<HTMLDivElement>): void;
}

/**
 * S45.4: the one anatomy every modal sheet follows (HIG Sheets, Alerts, Buttons): a title, an optional one-line
 * description, the content (which scrolls), and the actions trailing in one row — Cancel before the primary action,
 * so the default button is always the last one. The sheet is modal: Escape closes it, Tab and Shift+Tab stay inside,
 * focus moves in when it opens (to `[data-autofocus]` if a child did not already take it, else the default button)
 * and goes back to the opener when it closes. It fits a 1024×660 window: only the content scrolls.
 */
export function Sheet({
  title,
  titleHidden = false,
  description,
  children,
  actions,
  leading,
  footer,
  onEscape,
  dismissOnBackdrop = false,
  role = 'dialog',
  size = 'medium',
  className,
  backdropClassName,
  testId,
  backdropTestId,
  sheetRef,
  onMouseDown,
}: SheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const contentId = useId();
  const own = useRef<HTMLDivElement>(null);
  const ref = sheetRef ?? own;
  // Taken while rendering the first time: the opener still has focus then.
  const [opener] = useState(focusSnapshot);
  useModalKeys(ref, onEscape);

  useEffect(() => {
    const sheet = ref.current;
    // Children's effects run first: a field that took focus keeps it.
    if (sheet && !sheet.contains(document.activeElement)) {
      const target =
        sheet.querySelector<HTMLElement>('[data-autofocus]') ??
        sheet.querySelector<HTMLElement>('.sheet-actions [data-default]') ??
        focusableIn(sheet)[0];
      target?.focus();
    }
    return () => {
      returnFocus(opener);
    };
  }, []);

  const describedBy = role === 'alertdialog' ? contentId : description ? descriptionId : undefined;
  const classes = ['sheet', `sheet-${size}`, className].filter(Boolean).join(' ');
  return (
    <div
      className={['sheet-backdrop', backdropClassName].filter(Boolean).join(' ')}
      data-testid={backdropTestId}
      onMouseDown={dismissOnBackdrop ? () => onEscape() : undefined}
    >
      <div
        ref={ref}
        className={classes}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        data-testid={testId}
        data-sheet=""
        onMouseDown={(event) => {
          event.stopPropagation();
          onMouseDown?.(event);
        }}
      >
        <header className={titleHidden ? 'sheet-header sr-only' : 'sheet-header'}>
          <h2 className="dialog-title sheet-title" id={titleId}>
            {title}
          </h2>
          {description && (
            <p className="sheet-description" id={descriptionId}>
              {description}
            </p>
          )}
        </header>
        <div className="sheet-content" id={contentId}>
          {children}
        </div>
        {(actions || leading) && (
          <div className="dialog-actions sheet-actions">
            {leading && <div className="sheet-actions-leading">{leading}</div>}
            {actions}
          </div>
        )}
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}
