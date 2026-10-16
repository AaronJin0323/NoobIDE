import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { aboutVersions, OPEN_ABOUT_EVENT } from './about';
import { Sheet, sheetButtonClass } from './Sheet';

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
 * S28.1 About dialog on the shared Sheet (S49.1): name, version and runtime versions. It says only what the app is
 * proven to do (PLAN §4, §9): editing and previewing plain HTML / CSS / JavaScript webpages. Escape, Close or a click
 * outside dismisses it (nothing to lose); Tab stays inside.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const versions = aboutVersions(__NOOBIDE_VERSION__, navigator.userAgent);
  // Third-party license notices (<resources>/THIRD_PARTY_NOTICES.txt), opened by main in the OS text viewer.
  const notices = window.noobide?.notices;
  const [noticesFailed, setNoticesFailed] = useState(false);
  const openNotices = useCallback(() => {
    if (!notices) return;
    void notices.open().then(
      (result) => setNoticesFailed(!result.ok),
      () => setNoticesFailed(true),
    );
  }, [notices]);

  return (
    <Sheet
      title={t('about.title')}
      width={480}
      className="about-dialog"
      onClose={onClose}
      closeLabel={t('about.close')}
      dismissOnBackdrop
      testId="about-dialog"
      closeTestId="about-close"
      actions={
        notices && (
          <button
            type="button"
            className={sheetButtonClass('cancel')}
            data-testid="about-notices"
            onClick={openNotices}
          >
            {t('about.notices')}
          </button>
        )
      }
    >
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
        {noticesFailed && (
          <p className="dialog-hint" role="alert" data-testid="about-notices-error">
            {t('about.noticesFailed')}
          </p>
        )}
      </div>
    </Sheet>
  );
}
