import { useI18n } from '../i18n/I18nProvider';

export function ProblemsPanel() {
  const { t } = useI18n();
  return (
    <section className="region problems" aria-label={t('region.problems')} data-testid="region-problems">
      <div className="panel-tabs">
        <span className="panel-tab active">{t('problems.tab')}</span>
        <span className="panel-tab">{t('console.tab')}</span>
      </div>
      <p className="placeholder">{t('problems.none')}</p>
    </section>
  );
}
