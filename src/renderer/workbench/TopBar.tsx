import { useI18n } from '../i18n/I18nProvider';
import { otherLocale } from '../i18n/index';

export function TopBar() {
  const { t, locale, setLocale } = useI18n();
  return (
    <header className="region topbar" role="banner" aria-label={t('region.topbar')} data-testid="region-topbar">
      <span className="app-name">{t('app.name')}</span>
      <span className="project-name">{t('topbar.noProject')}</span>
      <span className="spacer" />
      <span className="save-status" role="status" aria-label={t('topbar.saveStatus')} data-testid="save-status">
        {t('topbar.saveStatus.noFile')}
      </span>
      <button type="button" className="tb-button" disabled>
        {t('topbar.preview')}
      </button>
      <button type="button" className="tb-button" disabled>
        {t('topbar.help')}
      </button>
      <button type="button" className="tb-button" disabled>
        {t('topbar.moreTools')}
      </button>
      <button
        type="button"
        className="tb-button"
        title={t('topbar.language')}
        data-testid="switch-language"
        onClick={() => setLocale(otherLocale(locale))}
      >
        {t('topbar.switchLanguage')}
      </button>
    </header>
  );
}
