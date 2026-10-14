import { useI18n } from '../i18n/I18nProvider';
import { FileIcon, ProblemsIcon } from './icons';

interface RailProps {
  filesVisible: boolean;
  problemsOpen: boolean;
  onToggleFiles: () => void;
  onToggleProblems: () => void;
}

/**
 * Labelled side rail (S30.3). Only tools that work today are listed; History, lessons and the rest join as their
 * features land, so the rail never offers a control that does nothing.
 */
export function Rail({ filesVisible, problemsOpen, onToggleFiles, onToggleProblems }: RailProps) {
  const { t } = useI18n();
  return (
    <aside className="rail" aria-label={t('region.rail')} data-testid="rail">
      <button
        type="button"
        className="rail-button"
        aria-pressed={filesVisible}
        aria-controls="region-files"
        data-testid="rail-files"
        onClick={onToggleFiles}
      >
        <FileIcon />
        {t('rail.files')}
      </button>
      <button
        type="button"
        className="rail-button"
        aria-expanded={problemsOpen}
        aria-controls="problems-panel"
        data-testid="rail-problems"
        onClick={onToggleProblems}
      >
        <ProblemsIcon />
        {t('rail.problems')}
      </button>
    </aside>
  );
}
