import { useEffect, useId, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { focusableIn, useModalKeys, useReturnFocus } from './focus-trap';
import { CloseIcon } from './icons';
import { useSheetLayer } from './sheet-stack';

/**
 * S49.1 — the one shell every modal dialog uses (assessment 2026-10-16, P1 item 6 and P2 item 12; the Sheet part of
 * the archived S44 anatomy, docs/archive/s44-s45-hig). What every sheet gets, by construction:
 *
 *   - a title (an h2 that names the dialog, optionally with a small icon) and a Close control top-right, whose
 *     accessible name is the caller's own word for leaving (Close, Cancel, Decide later);
 *   - Escape, which does what Close does (`onEscape` may step in first: History cancels an open confirmation);
 *     neither works while `closeDisabled` (a restore or a create still running);
 *   - a focus trap (Tab / Shift+Tab stay inside, also when focus fell to the page) and the focus returned to the
 *     opener when the sheet closes (focus-trap.ts). Focus moves in when the sheet opens: a child that took it in its
 *     own effect keeps it; else `[data-autofocus]`, else the first control of the content, else Close;
 *   - a content area that scrolls on its own, so the title and the action row stay in view in a 1024×660 window;
 *   - one action row in reading order Cancel → Primary (`actions`, last button is the default), with optional
 *     `leading` text or controls set apart on the left (a usage line, a disclosure);
 *   - a width from the scale 480 / 720 / 960 and (S50.1) a height of at most
 *     calc(100dvh - 2 × max(32px, titlebar inset)), so it never runs under the window controls;
 *   - (S50.1) while another sheet or the palette is open over it, a 2px blur and a dim (sheet-stack.ts);
 *   - the overlay material: frosted over the scrim, solid under reduced transparency, increased contrast and forced
 *     colours (glass.css, decision 0034); the native preview hides under it (preview-viewport.ts OVERLAY_SELECTOR
 *     matches `.dialog-backdrop` and `[role=dialog]`, decision 0019).
 *
 * A click on the backdrop closes the sheet only when `dismissOnBackdrop` is set — never for a sheet with a field,
 * so a half-typed value is never lost by a stray click.
 *
 * Buttons inside use {@link sheetButtonClass}: `cancel` (quiet), `primary` (the one filled button) and `danger`
 * (filled, drawn in the danger colour, for a destructive verb such as Move to trash or Clear all).
 */
export type SheetWidth = 480 | 720 | 960;

export interface SheetProps {
  /** Names the dialog (the h2). */
  readonly title: ReactNode;
  /** A small icon before the title (Recovery's warning mark). */
  readonly titleIcon?: ReactNode;
  /** At most one short sentence under the title; it describes the dialog to assistive technology too. */
  readonly description?: ReactNode;
  /** The content. It scrolls when the window is short; the title and the actions stay in view. */
  readonly children: ReactNode;
  /** Trailing actions in reading order: Cancel first, the primary last. Omit when Close is the only way out. */
  readonly actions?: ReactNode;
  /** Set apart at the left of the action row: a status line or a disclosure. */
  readonly leading?: ReactNode;
  /** Close top-right, Escape, and the backdrop when `dismissOnBackdrop`. */
  onClose(): void;
  /** Escape only, when it should do something before closing (cancel an inline confirmation). */
  readonly onEscape?: (() => void) | undefined;
  /** Accessible name of the Close control: the caller's own word (Close, Cancel, Decide later). */
  readonly closeLabel: string;
  /** While a change is running: Close and Escape do nothing, so its result stays visible. */
  readonly closeDisabled?: boolean;
  /** Only for sheets without a field (a confirmation): a click outside closes. */
  readonly dismissOnBackdrop?: boolean;
  /** `alertdialog` for a question that interrupts; its content then describes it. */
  readonly role?: 'dialog' | 'alertdialog';
  readonly width?: SheetWidth;
  readonly className?: string;
  /** Extra class on the backdrop (a feature's z-index). */
  readonly backdropClassName?: string;
  readonly testId: string;
  readonly closeTestId?: string;
  /** The sheet element, for callers that move focus inside it themselves. */
  readonly sheetRef?: RefObject<HTMLDivElement | null>;
}

/** The class of a sheet button by its job: Cancel (quiet), the primary, or a destructive primary. */
export function sheetButtonClass(kind: 'cancel' | 'primary' | 'danger'): string {
  switch (kind) {
    case 'cancel':
      return 'quiet-button dialog-button';
    case 'primary':
      return 'primary-button dialog-button';
    case 'danger':
      return 'primary-button danger-button dialog-button';
  }
}

/**
 * What Escape does in a sheet (pure, so it is tested without a DOM): nothing while closing is disabled, else the
 * caller's `onEscape` when it has one, else the same as Close. Returns which ran.
 */
export function escapeAction(options: {
  readonly closeDisabled: boolean;
  readonly onEscape?: (() => void) | undefined;
  onClose(): void;
}): 'none' | 'escape' | 'close' {
  if (options.closeDisabled) return 'none';
  if (options.onEscape) {
    options.onEscape();
    return 'escape';
  }
  options.onClose();
  return 'close';
}

export interface SheetFrameProps {
  readonly children: ReactNode;
  /** Classes of the dialog element (`dialog sheet …` for a Sheet, `palette` for the command palette). */
  readonly className: string;
  /** Classes of the backdrop (`dialog-backdrop …`, `palette-backdrop`). */
  readonly backdropClassName: string;
  /** Escape (after the frame's own checks). */
  onEscape(): void;
  /** A click on the backdrop, or null when the backdrop does not close. */
  readonly onBackdrop: (() => void) | null;
  readonly role?: 'dialog' | 'alertdialog';
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  readonly testId: string;
  readonly backdropTestId?: string | undefined;
  /** S51.5: a mode the dialog element carries as data-mode (the palette: files / commands) for styling and tests. */
  readonly dataMode?: string | undefined;
  readonly sheetRef?: RefObject<HTMLDivElement | null>;
  /** After the frame stopped a mouse-down inside the dialog from reaching the backdrop. */
  readonly onSheetMouseDown?: ((event: MouseEvent<HTMLDivElement>) => void) | undefined;
}

/**
 * S50.1 — the modal frame every sheet and the command palette share: the backdrop, the dialog element (modal, named,
 * described), Escape and the Tab trap, focus returned to the opener, and the blur and dim while another sheet is
 * open over it. {@link Sheet} adds the title / content / actions anatomy on top; the palette puts its search field
 * and list straight into the frame.
 */
export function SheetFrame({
  children,
  className,
  backdropClassName,
  onEscape,
  onBackdrop,
  role = 'dialog',
  labelledBy,
  describedBy,
  testId,
  backdropTestId,
  dataMode,
  sheetRef,
  onSheetMouseDown,
}: SheetFrameProps) {
  const own = useRef<HTMLDivElement>(null);
  const ref = sheetRef ?? own;
  const layer = useSheetLayer();
  useReturnFocus();
  useModalKeys(ref, onEscape, layer.isFront);
  return (
    <div className={backdropClassName} data-testid={backdropTestId} onMouseDown={onBackdrop ?? undefined}>
      <div
        ref={ref}
        className={className}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        data-testid={testId}
        data-mode={dataMode}
        data-sheet=""
        data-covered={layer.covered ? '' : undefined}
        onMouseDown={(event) => {
          event.stopPropagation();
          onSheetMouseDown?.(event);
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Sheet({
  title,
  titleIcon,
  description,
  children,
  actions,
  leading,
  onClose,
  onEscape,
  closeLabel,
  closeDisabled = false,
  dismissOnBackdrop = false,
  role = 'dialog',
  width = 480,
  className,
  backdropClassName,
  testId,
  closeTestId,
  sheetRef,
}: SheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const contentId = useId();
  const own = useRef<HTMLDivElement>(null);
  const ref = sheetRef ?? own;
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const sheet = ref.current;
    // Children's effects ran first: a field or row that took focus keeps it.
    if (!sheet || sheet.contains(document.activeElement)) return;
    const content = sheet.querySelector<HTMLElement>('.sheet-content');
    const target =
      sheet.querySelector<HTMLElement>('[data-autofocus]') ??
      (content ? focusableIn(content)[0] : undefined) ??
      closeButton.current;
    target?.focus();
    // Once, when the sheet opens.
  }, []);

  const describedBy = role === 'alertdialog' ? contentId : description ? descriptionId : undefined;
  const classes = ['dialog', 'sheet', `sheet-${width}`, className].filter(Boolean).join(' ');
  return (
    <SheetFrame
      className={classes}
      backdropClassName={['dialog-backdrop', backdropClassName].filter(Boolean).join(' ')}
      onEscape={() => {
        escapeAction({ closeDisabled, onEscape, onClose });
      }}
      onBackdrop={dismissOnBackdrop && !closeDisabled ? () => onClose() : null}
      role={role}
      labelledBy={titleId}
      describedBy={describedBy}
      testId={testId}
      sheetRef={ref}
    >
      <header className="sheet-header">
        <h2 className="dialog-title sheet-title" id={titleId}>
          {titleIcon && <span className="sheet-title-icon">{titleIcon}</span>}
          {title}
        </h2>
        <button
          type="button"
          className="icon-button sheet-close"
          ref={closeButton}
          aria-label={closeLabel}
          title={closeLabel}
          disabled={closeDisabled}
          data-testid={closeTestId}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      {description && (
        <p className="dialog-hint sheet-description" id={descriptionId}>
          {description}
        </p>
      )}
      <div className="sheet-content" id={contentId}>
        {children}
      </div>
      {(actions || leading) && (
        <div className="dialog-actions sheet-actions">
          {leading && <div className="sheet-actions-leading">{leading}</div>}
          {actions}
        </div>
      )}
    </SheetFrame>
  );
}
