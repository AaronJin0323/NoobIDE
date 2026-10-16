import { useI18n } from '../i18n/I18nProvider';
import { FileIcon, HistoryIcon, LessonsIcon, ProblemsIcon } from './icons';
import { AiIcon } from '../ai/ai-icons';

interface RailProps {
  filesVisible: boolean;
  problemsOpen: boolean;
  onToggleFiles: () => void;
  onToggleProblems: () => void;
  /** S21.3: opens the local-history window; absent while no project is open. */
  onShowHistory?: (() => void) | undefined;
  /** Opens (or reopens) the beginner walkthrough: the same command as Help → walkthrough. */
  onShowLessons?: (() => void) | undefined;
  /** S33.1: the AI chat panel; absent while AI is not offered (no AI bridge, or AI switched off). */
  ai?: { readonly open: boolean; readonly onToggle: () => void } | undefined;
}

/**
 * Labelled side rail (S30.3). Only tools that work today are listed, so the rail never offers a control that does
 * nothing. The key features of the app (files, problems, history, lessons, AI) each keep a labelled button here, so
 * none of them is reachable only through a menu.
 */
export function Rail({
  filesVisible,
  problemsOpen,
  onToggleFiles,
  onToggleProblems,
  onShowHistory,
  onShowLessons,
  ai,
}: RailProps) {
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
      {onShowLessons && (
        <button
          type="button"
          className="rail-button"
          title={t('rail.lessons.title')}
          data-testid="rail-lessons"
          onClick={onShowLessons}
        >
          <LessonsIcon />
          {t('rail.lessons')}
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
