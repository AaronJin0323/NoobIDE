import { useI18n } from '../i18n/I18nProvider';
import { otherLocale } from '../i18n/index';
import { CodeIcon, DotIcon } from './icons';
import type { NarrowView } from './layout';

interface TopBarProps {
  /** Present only in a narrow window (S30.4). */
  narrow?: { view: NarrowView; onShow: (view: NarrowView) => void } | undefined;
}

export function TopBar({ narrow }: TopBarProps) {
  const { t, locale, setLocale } = useI18n();
  return (
    <header className="region topbar" role="banner" aria-label={t('region.topbar')} data-testid="region-topbar">
      <span className="app-mark" aria-hidden="true">
        <CodeIcon />
      </span>
      <span className="app-name">{t('app.name')}</span>
      <div className="project">
        <span className="project-name">{t('topbar.noProject')}</span>
        <span className="project-detail">{t('topbar.sampleNotice')}</span>
      </div>
      {narrow && (
        <div className="segmented" role="group" aria-label={t('narrow.switch')} data-testid="narrow-switch">
          {(['code', 'preview'] as const).map((view) => (
            <button
              key={view}
              type="button"
              className="segment"
              aria-pressed={narrow.view === view}
              onClick={() => narrow.onShow(view)}
            >
              {t(view === 'code' ? 'narrow.code' : 'narrow.preview')}
            </button>
          ))}
        </div>
      )}
      <span className="spacer" />
      <span className="save-status" role="status" aria-label={t('topbar.saveStatus')} data-testid="save-status">
        <DotIcon />
        {t('topbar.saveStatus.noFile')}
      </span>
      <button
        type="button"
        className="quiet-button"
        title={t('topbar.language')}
        data-testid="switch-language"
        onClick={() => setLocale(otherLocale(locale))}
      >
        {t('topbar.switchLanguage')}
      </button>
    </header>
  );
}
