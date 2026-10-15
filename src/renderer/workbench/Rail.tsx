import { useI18n } from '../i18n/I18nProvider';
import { FileIcon, HistoryIcon, ProblemsIcon } from './icons';
import { AiIcon } from '../ai/ai-icons';

interface RailProps {
  filesVisible: boolean;
  problemsOpen: boolean;
  onToggleFiles: () => void;
  onToggleProblems: () => void;
  /** S21.3: opens the local-history window; absent while no project is open. */
  onShowHistory?: (() => void) | undefined;
  /** S33.1: the AI chat panel; absent while AI is not offered (no AI bridge, or AI switched off). */
  ai?: { readonly open: boolean; readonly onToggle: () => void } | undefined;
}

/**
 * Labelled side rail (S30.3). Only tools that work today are listed; History, lessons and the rest join as their
 * features land, so the rail never offers a control that does nothing.
 */
export function Rail({ filesVisible, problemsOpen, onToggleFiles, onToggleProblems, onShowHistory, ai }: RailProps) {
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
      {onShowHistory && (
        <button
          type="button"
          className="rail-button"
          aria-haspopup="dialog"
          data-testid="rail-history"
          onClick={onShowHistory}
        >
          <HistoryIcon />
          {t('rail.history')}
        </button>
      )}
      {ai && (
        <button
          type="button"
          className="rail-button"
          aria-pressed={ai.open}
          // Only while the panel exists (axe: aria-controls must name an element on the page).
          aria-controls={ai.open ? 'region-ai' : undefined}
          data-testid="rail-ai"
          onClick={ai.onToggle}
        >
          <AiIcon />
          {t('rail.ai')}
        </button>
      )}
    </aside>
  );
}
