import { useI18n } from '../i18n/I18nProvider';

/**
 * Placeholder only. The real preview is an isolated WebContentsView owned by main and positioned over this area
 * (S04, S15) — user HTML is never rendered into this React DOM (AGENTS.md invariant).
 */
export function PreviewPane() {
  const { t } = useI18n();
  return (
    <section className="region preview" aria-label={t('region.preview')} data-testid="region-preview">
      <h2 className="region-title">{t('region.preview')}</h2>
      <p className="placeholder">{t('preview.placeholder')}</p>
    </section>
  );
}
