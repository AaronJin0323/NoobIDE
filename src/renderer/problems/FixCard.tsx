import { useEffect, useRef, useState } from 'react';
import { formatMessage, msg } from '../../diagnostics/messages';
import { shortcutLabel, type PlatformId } from '../../platform/labels';
import { useI18n } from '../i18n/I18nProvider';
import type { Locale, MessageKey } from '../i18n/index';
import { saveErrorKey } from '../workbench/EditorPane';
import { rendererPlatform } from '../workbench/file-op-messages';
import { canRecheck, canUndo, type FixState } from './fix-model';
import { OriginalError, SOURCE_TAG } from './ProblemCard';
import type { ProblemFix } from './useProblemFix';

type Translate = (key: MessageKey) => string;

const fill = (text: string, params: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));

/** The result of the fix in words (announced politely; never colour alone). */
export function fixStatusText(fix: FixState, t: Translate, platform: PlatformId): string {
  const { span, from, to } = fix.action;
  const params = {
    file: span.file,
    line: span.line,
    from,
    to,
    shortcut: shortcutLabel(platform, 'Z'),
    reason: fix.saveError ? t(saveErrorKey(fix.saveError, platform)) : '',
  };
  const key: MessageKey = (() => {
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
  actions: Pick<ProblemFix, 'undo' | 'retrySave' | 'recheck' | 'clear'>;
  onGoTo: (target: { file: string; line: number; column?: number }) => void;
}

/**
 * S22.5: what happened to the latest one-click fix — kept at the top of the Problems panel (the fixed problem may
 * leave the list) until cleared, with its original error. The status is a polite live region in plain words.
 */
export function FixCard({ fix, serial, actions, onGoTo }: FixCardProps) {
  const { t, locale } = useI18n();
  const [originalOpen, setOriginalOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
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
}: Omit<FixCardProps, 'serial'> & {
  t: Translate;
  locale: Locale;
  platform: PlatformId;
  originalOpen: boolean;
  onToggleOriginal: () => void;
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  const { record, action, phase } = fix;
  const f = (ref: Parameters<typeof formatMessage>[1]) => formatMessage(locale, ref);
  const location = f(msg('location.fileLine', { file: action.span.file, line: action.span.line }));
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
        <span>{f(msg('undefinedName.title', { name: action.from }))}</span>
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
        <button
          type="button"
          className="secondary-button"
          data-testid="problem-fix-go-to"
          onClick={() => onGoTo({ file: action.span.file, line: action.span.line, column: action.span.column })}
        >
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
