import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { aboutVersions, OPEN_ABOUT_EVENT } from './about';
import { useModalKeys } from './focus-trap';

/** Open state of the About dialog: opened by `openAbout()` from anywhere, closed by the dialog. */
export function useAboutRequests(): { open: boolean; close: () => void } {
  const [open, setOpen] = useState(false);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const onOpen = () => {
      opener.current = document.activeElement;
      setOpen(true);
    };
    window.addEventListener(OPEN_ABOUT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ABOUT_EVENT, onOpen);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    // Focus returns to where it was (the menu entry or the editor).
    if (opener.current instanceof HTMLElement) opener.current.focus();
  }, []);
  return { open, close };
}

/**
 * S28.1 About dialog: name, version and runtime versions. It says only what the app is proven to do (PLAN §4, §9):
 * editing and previewing plain HTML / CSS / JavaScript webpages. Escape or Close dismisses it; Tab stays inside.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const versions = aboutVersions(__NOOBIDE_VERSION__, navigator.userAgent);
  useModalKeys(dialog, onClose);
  useEffect(() => close.current?.focus(), []);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="dialog about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="about-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title" id={titleId}>
          {t('about.title')}
        </h2>
        <div className="dialog-body">
          <p>{t('about.description')}</p>
          <p data-testid="about-version" data-version={versions.app}>
            {fill(t('about.version'), { version: versions.app })}
          </p>
          {versions.electron && versions.chromium && (
            <p className="dialog-hint" data-testid="about-runtime">
              {fill(t('about.runtime'), { electron: versions.electron, chromium: versions.chromium })}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button dialog-button"
            ref={close}
            data-testid="about-close"
            onClick={onClose}
          >
            {t('about.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
