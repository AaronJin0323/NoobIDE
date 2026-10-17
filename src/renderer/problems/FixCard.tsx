import { useEffect, useRef, useState } from 'react';
import { formatMessage, msg } from '../../diagnostics/messages';
import { shortcutLabel, type PlatformId } from '../../platform/labels';
import { useI18n } from '../i18n/I18nProvider';
import type { Locale, MessageKey } from '../i18n/index';
import { opErrorMessage, saveErrorKey } from '../workbench/file-op-messages';
import type { FileOpError } from '../../shared/ipc/contract';
import { rendererPlatform } from '../workbench/file-op-messages';
import { explain } from '../../diagnostics/rules';
import { canRecheck, canUndo, fixFile, problemSite, type FixState } from './fix-model';
import { OriginalError, SOURCE_TAG } from './ProblemCard';
import type { ProblemFix } from './useProblemFix';

type Translate = (key: MessageKey) => string;

const fill = (text: string, params: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));

/** The result of the fix in words (announced politely; never colour alone). */
export function fixStatusText(fix: FixState, t: Translate, platform: PlatformId): string {
  const { action } = fix;
  const site = problemSite(action);
  const create = action.kind === 'create-file';
  const params = {
    file: site.file,
    line: site.line,
    path: fixFile(action),
    from: create ? '' : action.from,
    to: create ? '' : action.to,
    shortcut: shortcutLabel(platform, 'Z'),
    reason: !fix.saveError
      ? ''
      : fix.reason === 'create-failed'
        ? opErrorMessage(t, fix.saveError as FileOpError, '', fixFile(action), platform)
        : t(saveErrorKey(fix.saveError, platform)),
  };
  const key: MessageKey = (() => {
    // S55.3: a created file has its own words (nothing was "changed from … to …").
    if (create) {
      if (fix.phase === 'applying') return 'problems.fix.create.applying';
      if (fix.phase === 'not-applied' && fix.reason === 'exists') return 'problems.fix.create.exists';
      if (fix.phase === 'not-applied' && fix.reason === 'created-empty') return 'problems.fix.create.createdEmpty';
      if (fix.phase === 'not-applied' && fix.reason === 'create-failed') return 'problems.fix.create.failed';
      if (fix.phase === 'save-failed') return 'problems.fix.create.saveFailed';
      if (fix.phase === 'checking') return 'problems.fix.create.checking';
      if (fix.phase === 'unchecked') return 'problems.fix.create.unchecked';
      if (fix.phase === 'still-reported') return 'problems.fix.create.stillReported';
      if (fix.phase === 'undone') return 'problems.fix.create.undone';
    }
    switch (fix.phase) {
      case 'applying':
        return 'problems.fix.applying';
      case 'not-applied':
        return fix.reason === 'read-only'
          ? 'problems.fix.notApplied.readOnly'
          : fix.reason === 'not-open'
            ? 'problems.fix.notApplied.notOpen'
            : 'problems.fix.notApplied.changed';
      case 'save-failed':
        return 'problems.fix.saveFailed';
      case 'checking':
        return 'problems.fix.checking';
      case 'unchecked':
        return 'problems.fix.unchecked';
      case 'awaiting-refresh':
        return 'problems.fix.awaitingRefresh';
      case 'still-reported':
        return 'problems.fix.stillReported';
      case 'resolved':
        return fix.record.source === 'static' ? 'problems.fix.resolved.static' : 'problems.fix.resolved.runtime';
      case 'undoing':
        return 'problems.fix.undoing';
      case 'undone':
        return 'problems.fix.undone';
      case 'undo-failed':
        return fix.saveError ? 'problems.fix.undoFailed.save' : 'problems.fix.undoFailed.changed';
    }
  })();
  return fill(t(key), params);
}

export interface FixCardProps {
  fix: FixState;
  /** A new fix started: the card takes keyboard focus once, so its result and Undo are next. */
  serial: number;
  /** S55.3: false for a fix chosen in the editor's lightbulb — the keyboard stays in the editor. */
  takeFocus?: boolean;
  actions: Pick<ProblemFix, 'undo' | 'retrySave' | 'recheck' | 'clear'>;
  onGoTo: (target: { file: string; line: number; column?: number }) => void;
}

/**
 * S22.5: what happened to the latest one-click fix — kept at the top of the Problems panel (the fixed problem may
 * leave the list) until cleared, with its original error. The status is a polite live region in plain words.
 */
export function FixCard({ fix, serial, takeFocus = true, actions, onGoTo }: FixCardProps) {
  const { t, locale } = useI18n();
  const [originalOpen, setOriginalOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const focus = useRef(takeFocus);
  focus.current = takeFocus;
  useEffect(() => {
    if (focus.current) ref.current?.focus();
    setOriginalOpen(false);
  }, [serial]);
  return (
    <FixCardBody
      fix={fix}
      t={t}
      locale={locale}
      platform={rendererPlatform()}
      actions={actions}
      onGoTo={onGoTo}
      originalOpen={originalOpen}
      onToggleOriginal={() => setOriginalOpen((open) => !open)}
      cardRef={ref}
    />
  );
}

export function FixCardBody({
  fix,
  t,
  locale,
  platform,
  actions,
  onGoTo,
  originalOpen,
  onToggleOriginal,
  cardRef,
}: Omit<FixCardProps, 'serial' | 'takeFocus'> & {
  t: Translate;
  locale: Locale;
  platform: PlatformId;
  originalOpen: boolean;
  onToggleOriginal: () => void;
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  const { record, action, phase } = fix;
  const f = (ref: Parameters<typeof formatMessage>[1]) => formatMessage(locale, ref);
  const site = problemSite(action);
  const location = f(msg('location.fileLine', { file: site.file, line: site.line }));
  const goTo =
    action.kind === 'create-file'
      ? { file: action.path, line: 1 }
      : { file: action.span.file, line: action.span.line, column: action.span.column };
  const headId = `problem-fix-head-${record.id}`;
  const originalId = `problem-fix-original-${record.id}`;
  const applied = phase !== 'applying' && phase !== 'not-applied' && phase !== 'undone' && phase !== 'undoing';
  return (
    <div
      className={`problem-card problem-fix-card phase-${phase}`}
      role="group"
      aria-labelledby={headId}
      tabIndex={-1}
      ref={cardRef}
      data-testid="problem-fix-card"
      data-phase={phase}
    >
      <p className="problem-card-heading" id={headId}>
        {t('problems.fix.heading')}
      </p>
      <p className="problem-card-head">
        <span className="problem-card-tag">{t(SOURCE_TAG[record.source])}</span>{' '}
        <span className="problem-card-location">{location}</span>
        <span>{f(explain(record).title)}</span>
      </p>
      <p className="problem-fix-status" role="status" aria-live="polite" data-testid="problem-fix-status">
        {fixStatusText(fix, t, platform)}
      </p>
      {applied && canUndo(fix) && phase !== 'undo-failed' && (
        <p className="problem-original-meta">
          {fill(t('problems.fix.undoHint'), { shortcut: shortcutLabel(platform, 'Z') })}
        </p>
      )}
      <div className="problem-actions">
        {canUndo(fix) && (
          <button type="button" className="secondary-button" data-testid="problem-fix-undo" onClick={actions.undo}>
            {t('problems.fix.undo')}
          </button>
        )}
        {phase === 'save-failed' && (
          <button
            type="button"
            className="secondary-button"
            data-testid="problem-fix-retry"
            onClick={actions.retrySave}
          >
            {t('problems.fix.retrySave')}
          </button>
        )}
        {canRecheck(fix) && (
          <button
            type="button"
            className="secondary-button"
            data-testid="problem-fix-recheck"
            onClick={actions.recheck}
          >
            {t('problems.fix.recheck')}
          </button>
        )}
        <button type="button" className="secondary-button" data-testid="problem-fix-go-to" onClick={() => onGoTo(goTo)}>
          {f(msg('action.goToCode'))}
        </button>
        <button
          type="button"
          className="quiet-button"
          aria-expanded={originalOpen}
          aria-controls={originalId}
          data-testid="problem-fix-show-original"
          onClick={onToggleOriginal}
        >
          {f(msg('action.showOriginal'))}
        </button>
        <button type="button" className="quiet-button" data-testid="problem-fix-clear" onClick={actions.clear}>
          {t('problems.fix.clear')}
        </button>
      </div>
      {originalOpen && <OriginalError id={originalId} record={record} locale={locale} t={t} />}
    </div>
  );
}
