import { useEffect } from 'react';
import { WALKTHROUGH_STEPS } from '../../shared/walkthrough';
import { useI18n } from '../i18n/I18nProvider';
import { FINAL_TASK_LESSON, STEP_LESSONS, localized } from './lessons';
import { STEP_ANCHORS, isLastStep, type PanelView } from './walkthrough-model';
import './walkthrough.css';

export interface WalkthroughPanelProps {
  readonly view: PanelView;
  onNext(): void;
  onBack(): void;
  onClose(): void;
  onStartTask(): void;
  onCloseTask(): void;
  /** Opens the glossary at a standard term (S23.4). */
  onTerm(term: string): void;
}

const ANCHOR_ATTRIBUTE = 'data-walkthrough-anchor';

/**
 * Outlines the current step's anchor element. Elements appear and re-render (the file tree loads lazily), so the
 * attribute is re-applied while the step is shown and removed when it ends.
 */
function useAnchor(selector: string | null): void {
  useEffect(() => {
    if (!selector) return undefined;
    const apply = () => {
      const target = document.querySelector(selector);
      for (const el of document.querySelectorAll(`[${ANCHOR_ATTRIBUTE}]`)) {
        if (el !== target) el.removeAttribute(ANCHOR_ATTRIBUTE);
      }
      target?.setAttribute(ANCHOR_ATTRIBUTE, 'true');
    };
    apply();
    const timer = setInterval(apply, 400);
    return () => {
      clearInterval(timer);
      for (const el of document.querySelectorAll(`[${ANCHOR_ATTRIBUTE}]`)) el.removeAttribute(ANCHOR_ATTRIBUTE);
    };
  }, [selector]);
}

/** Moves focus to the anchor (or scrolls it into view when it cannot take focus). */
function showAnchor(selector: string): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return;
  target.scrollIntoView({ block: 'nearest' });
  const focusable = target.matches('button, [tabindex], a[href], input')
    ? target
    : target.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"]), [role="treeitem"]');
  focusable?.focus();
}

/**
 * The walkthrough strip (S23.1): a non-modal region between the workbench and the status strip, so it never covers
 * the editor, the file tree or the native preview. It names the step, says what to do and where (in words — the
 * outline on the anchor is never the only cue), reports detection as text, links standard terms to the glossary,
 * and every action is a keyboard-reachable button.
 */
export function WalkthroughPanel({
  view,
  onNext,
  onBack,
  onClose,
  onStartTask,
  onCloseTask,
  onTerm,
}: WalkthroughPanelProps) {
  const { t, locale } = useI18n();
  const anchor = view.kind === 'step' ? STEP_ANCHORS[view.step] : null;
  useAnchor(anchor);
  if (view.kind === 'hidden') return null;

  if (view.kind === 'step') {
    const lesson = STEP_LESSONS[view.step];
    const last = isLastStep(view.step);
    return (
      <section
        className="walkthrough"
        aria-label={t('walkthrough.region')}
        data-testid="walkthrough"
        data-step={view.step}
        data-done={view.done}
      >
        <div className="walkthrough-main">
          <p className="walkthrough-progress" data-testid="walkthrough-progress">
            {t('walkthrough.progress')
              .replace('{n}', String(view.index + 1))
              .replace('{total}', String(WALKTHROUGH_STEPS.length))}
          </p>
          <h2 className="walkthrough-title" data-testid="walkthrough-title">
            {localized(lesson.title, locale)}
          </h2>
          <p className="walkthrough-body" data-testid="walkthrough-body">
            {localized(lesson.body, locale)}
          </p>
          <p className="walkthrough-where" data-testid="walkthrough-where">
            <span className="walkthrough-label">{t('walkthrough.where')}</span>
            {localized(lesson.where, locale)}
          </p>
          <p className="walkthrough-terms">
            <span className="walkthrough-label">{t('walkthrough.terms')}</span>
            {lesson.terms.map((term) => (
              <button
                key={term}
                type="button"
                className="walkthrough-term"
                data-testid="walkthrough-term"
                onClick={() => onTerm(term)}
              >
                {term}
              </button>
            ))}
          </p>
        </div>
        <div className="walkthrough-side">
          <p
            className={view.done ? 'walkthrough-check is-done' : 'walkthrough-check'}
            role="status"
            data-testid="walkthrough-check"
          >
            {view.done ? t('walkthrough.done') : t('walkthrough.waiting')}
          </p>
          <div className="walkthrough-actions">
            <button
              type="button"
              className="quiet-button"
              data-testid="walkthrough-back"
              disabled={view.index === 0}
              onClick={onBack}
            >
              {t('walkthrough.back')}
            </button>
            {anchor && (
              <button
                type="button"
                className="secondary-button"
                data-testid="walkthrough-show"
                onClick={() => showAnchor(anchor)}
              >
                {t('walkthrough.showMe')}
              </button>
            )}
            <button
              type="button"
              className={view.done ? 'primary-button walkthrough-next' : 'secondary-button walkthrough-next'}
              data-testid="walkthrough-next"
              onClick={onNext}
            >
              {last ? t('walkthrough.finish') : view.done ? t('walkthrough.next') : t('walkthrough.skipStep')}
            </button>
            <button
              type="button"
              className="quiet-button"
              data-testid="walkthrough-close"
              title={t('walkthrough.closeHint')}
              onClick={onClose}
            >
              {t('walkthrough.close')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (view.kind === 'task-offer') {
    return (
      <section className="walkthrough" aria-label={t('walkthrough.region')} data-testid="walkthrough" data-step="offer">
        <div className="walkthrough-main">
          <h2 className="walkthrough-title" data-testid="walkthrough-title">
            {t('walkthrough.offer.title')}
          </h2>
          <p className="walkthrough-body">{t('walkthrough.offer.text')}</p>
        </div>
        <div className="walkthrough-side">
          <div className="walkthrough-actions">
            <button type="button" className="primary-button" data-testid="task-start" onClick={onStartTask}>
              {t('walkthrough.task.start')}
            </button>
            <button type="button" className="quiet-button" data-testid="task-later" onClick={onCloseTask}>
              {t('walkthrough.task.later')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  // S23.3: the unguided task — the goal only, no anchor, no steps.
  return (
    <section
      className="walkthrough"
      aria-label={t('walkthrough.region')}
      data-testid="final-task"
      data-done={view.done}
    >
      <div className="walkthrough-main">
        <h2 className="walkthrough-title" data-testid="walkthrough-title">
          {localized(FINAL_TASK_LESSON.title, locale)}
        </h2>
        <p className="walkthrough-body" data-testid="task-goal">
          {localized(FINAL_TASK_LESSON.goal, locale)}
        </p>
      </div>
      <div className="walkthrough-side">
        <p
          className={view.done ? 'walkthrough-check is-done' : 'walkthrough-check'}
          role="status"
          data-testid="task-check"
        >
          {view.done ? localized(FINAL_TASK_LESSON.done, locale) : t('walkthrough.task.waiting')}
        </p>
        <div className="walkthrough-actions">
          <button
            type="button"
            className={view.done ? 'primary-button' : 'quiet-button'}
            data-testid="task-close"
            onClick={onCloseTask}
          >
            {view.done ? t('walkthrough.task.close') : t('walkthrough.task.stop')}
          </button>
        </div>
      </div>
    </section>
  );
}
