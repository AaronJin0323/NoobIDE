import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { MoreIcon } from './icons';

/**
 * The editor header's overflow ("Editor options"): Format and the code font size live in a small panel behind one
 * button, so the open-file tabs keep the width of the header. The panel's controls stay in the DOM while it is closed
 * (`hidden`), so their state (e.g. the font size) is always readable by assistive technology and tests.
 *
 * Keyboard: Enter/Space opens the panel and moves focus into it; Escape closes it and returns focus to the button;
 * Tab past its last control closes it. A click outside closes it. Zoom steps keep it open (several steps in a row);
 * the caller closes it after a one-shot action through `close`.
 */
export function EditorTools({ children }: { children: (close: () => void) => ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // Focus the first control when the panel opens.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }, [open]);

  // A press outside closes the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  return (
    <div
      ref={root}
      className="editor-more"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        // Focus left the button and the panel (Tab past the last control): close.
        if (open && !(event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('editor.more')}
        title={t('editor.more.title')}
        data-testid="editor-more"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
      </button>
      <div
        ref={panel}
        id={panelId}
        className="editor-more-panel"
        role="group"
        aria-label={t('editor.more')}
        data-testid="editor-more-panel"
        hidden={!open}
      >
        {children(() => close(true))}
      </div>
    </div>
  );
}
