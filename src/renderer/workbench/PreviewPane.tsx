import { useI18n } from '../i18n/I18nProvider';
import { MonitorIcon, StopIcon } from './icons';

/**
 * Placeholder only. The real preview is an isolated WebContentsView owned by main and positioned over this area
 * (S04, S15) — user HTML is never rendered into this React DOM (AGENTS.md invariant).
 */
export function PreviewPane({ hidden }: { hidden: boolean }) {
  const { t } = useI18n();
  return (
    <section
      className="region panel preview"
      aria-label={t('region.preview')}
      data-testid="region-preview"
      hidden={hidden}
    >
      <div className="panel-header">
        <h2 className="region-title">{t('region.preview')}</h2>
        <span className="state-pill" data-testid="preview-state">
          <StopIcon />
          {t('preview.stopped')}
        </span>
      </div>
      <div className="preview-stage">
        <div className="empty-state">
          <span className="empty-icon">
            <MonitorIcon />
          </span>
          <p className="empty-title">{t('preview.placeholder')}</p>
          <p className="empty-detail">{t('preview.hint')}</p>
        </div>
      </div>
    </section>
  );
}
