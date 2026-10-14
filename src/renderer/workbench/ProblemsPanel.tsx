import { useI18n } from '../i18n/I18nProvider';
import { ChevronDownIcon, UncheckedIcon } from './icons';

interface ProblemsPanelProps {
  open: boolean;
  onToggle: () => void;
}

/**
 * Problems lives in the status strip and expands on request (S30.3). Opening it never moves keyboard focus into the
 * panel, so new problems cannot pull the cursor out of the editor (PLAN §3). Until diagnostics exist (S16) the honest
 * state is "not checked yet" — never "no problems found".
 */
export function ProblemsPanel({ open, onToggle }: ProblemsPanelProps) {
  const { t } = useI18n();
  return (
    <section className="region problems" aria-label={t('region.problems')} data-testid="region-problems">
      <div id="problems-panel" className="panel problems-panel" hidden={!open} data-testid="problems-panel">
        <div className="panel-header">
          <h2 className="region-title">{t('problems.tab')}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t('problems.collapse')}
            title={t('problems.collapse')}
            onClick={onToggle}
          >
            <ChevronDownIcon />
          </button>
        </div>
        <p className="problems-message">
          <UncheckedIcon />
          {t('problems.uncheckedDetail')}
        </p>
      </div>
      <div className="status-strip">
        <button
          type="button"
          className="status-button"
          aria-expanded={open}
          aria-controls="problems-panel"
          title={t('problems.toggle')}
          data-testid="problems-toggle"
          onClick={onToggle}
        >
          <UncheckedIcon />
          {t('problems.tab')} · {t('problems.unchecked')}
        </button>
      </div>
    </section>
  );
}
