import { useI18n } from '../i18n/I18nProvider';

export function FilesPanel() {
  const { t } = useI18n();
  return (
    <nav className="region files" aria-label={t('region.files')} data-testid="region-files">
      <h2 className="region-title">{t('region.files')}</h2>
      <p className="placeholder">{t('files.empty')}</p>
    </nav>
  );
}
