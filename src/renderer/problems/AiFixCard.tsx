import { useEffect, useRef, useState } from 'react';
import { formatMessage, msg } from '../../diagnostics/messages';
import { shortcutLabel, type PlatformId } from '../../platform/labels';
import { useI18n } from '../i18n/I18nProvider';
import type { Locale, MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { saveErrorKey } from '../workbench/EditorPane';
import { rendererPlatform } from '../workbench/file-op-messages';
import { canRecheckAiFix, type AiFixState } from './ai-fix';
import { OriginalError, SOURCE_TAG } from './ProblemCard';
import type { AiFix } from './useAiFix';

type Translate = (key: MessageKey) => string;

/** The AI fix's state in words (a polite live region; never colour alone). */
export function aiFixStatusText(fix: AiFixState, t: Translate, platform: PlatformId): string {
  const params = {
    file: fix.record.file ?? '',
    line: fix.record.line ?? '',
    reason: fix.saveError ? t(saveErrorKey(fix.saveError, platform)) : '',
  };
  const key: MessageKey = (() => {
    switch (fix.phase) {
      case 'save-failed':
        return 'ai.fix.saveFailed';
      case 'checking':
        return 'ai.fix.checking';
      case 'unchecked':
        return 'ai.fix.unchecked';
      case 'awaiting-refresh':
        return 'ai.fix.awaitingRefresh';
      case 'still-reported':
        return 'ai.fix.stillReported';
      case 'resolved':
        return fix.record.source === 'static' ? 'problems.fix.resolved.static' : 'problems.fix.resolved.runtime';
    }
  })();
  return fill(t(key), params);
}

export interface AiFixCardProps {
  readonly fix: AiFixState;
  readonly serial: number;
  readonly actions: Pick<AiFix, 'recheck' | 'clear'>;
  readonly onGoTo: (target: { file: string; line: number; column?: number }) => void;
}

/**
 * S35.2: the latest accepted AI fix, at the top of the Problems panel until cleared (the fixed problem may leave the
 * list), with its original error and the verdict in words. The change itself is an ordinary editor edit: Ctrl/Cmd+Z
 * in the editor undoes it, and the save that follows re-checks.
 */
export function AiFixCard({ fix, serial, actions, onGoTo }: AiFixCardProps) {
  const { t, locale } = useI18n();
  const [originalOpen, setOriginalOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
    setOriginalOpen(false);
  }, [serial]);
  return (
    <AiFixCardBody
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

export function AiFixCardBody({
  fix,
  t,
  locale,
  platform,
  actions,
  onGoTo,
  originalOpen,
  onToggleOriginal,
  cardRef,
}: Omit<AiFixCardProps, 'serial'> & {
  t: Translate;
  locale: Locale;
  platform: PlatformId;
  originalOpen: boolean;
  onToggleOriginal: () => void;
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  const { record, phase } = fix;
  const f = (ref: Parameters<typeof formatMessage>[1]) => formatMessage(locale, ref);
  const headId = `ai-fix-head-${record.id}`;
  const originalId = `ai-fix-original-${record.id}`;
  return (
    <div
      className={`problem-card problem-fix-card phase-${phase}`}
      role="group"
      aria-labelledby={headId}
      tabIndex={-1}
      ref={cardRef}
      data-testid="ai-fix-card"
      data-phase={phase}
    >
      <p className="problem-card-heading" id={headId}>
        {t('ai.fix.heading')}
      </p>
      <p className="problem-card-head">
        <span className="problem-card-tag">{t(SOURCE_TAG[record.source])}</span>{' '}
        {record.file && (
          <span className="problem-card-location">
            {f(msg('location.fileLine', { file: record.file, line: record.line ?? 1 }))}
          </span>
        )}
      </p>
      <p className="problem-fix-status" role="status" aria-live="polite" data-testid="ai-fix-status">
        {aiFixStatusText(fix, t, platform)}
      </p>
      <p className="problem-original-meta">{fill(t('ai.fix.undoHint'), { shortcut: shortcutLabel(platform, 'Z') })}</p>
      <div className="problem-actions">
        {canRecheckAiFix(fix) && (
          <button type="button" className="secondary-button" data-testid="ai-fix-recheck" onClick={actions.recheck}>
            {t('problems.fix.recheck')}
          </button>
        )}
        {record.file && (
          <button
            type="button"
            className="secondary-button"
            data-testid="ai-fix-go-to"
            onClick={() => onGoTo({ file: record.file ?? '', line: record.line ?? 1 })}
          >
            {f(msg('action.goToCode'))}
          </button>
        )}
        <button
          type="button"
          className="quiet-button"
          aria-expanded={originalOpen}
          aria-controls={originalId}
          data-testid="ai-fix-show-original"
          onClick={onToggleOriginal}
        >
          {f(msg('action.showOriginal'))}
        </button>
        <button type="button" className="quiet-button" data-testid="ai-fix-clear" onClick={actions.clear}>
          {t('problems.fix.clear')}
        </button>
      </div>
      {originalOpen && <OriginalError id={originalId} record={record} locale={locale} t={t} />}
    </div>
  );
}
