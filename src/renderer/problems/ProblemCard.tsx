import { useState } from 'react';
import type { ProblemExplanation, ProblemRecord } from '../../shared/problem';
import { renderExplanation } from '../../diagnostics/rules/engine';
import { useI18n } from '../i18n/I18nProvider';
import type { Locale, MessageKey } from '../i18n/index';
import { fixActionOf, type ReplaceTextAction } from './fix-model';
import { AiIcon } from '../ai/ai-icons';

export interface ProblemCardProps {
  record: ProblemRecord;
  explanation: ProblemExplanation;
  /** Opens the file and puts the cursor on the reported line and column (S17.2). */
  onGoTo: (target: { file: string; line: number; column?: number }) => void;
  /** S22.5: applies the one-click fix. Absent: no fix is offered. */
  onFix?: ((record: ProblemRecord, action: ReplaceTextAction) => void) | undefined;
  /** S22.5: a fix is being applied; the fix button waits. */
  fixBusy?: boolean | undefined;
  /** S33.2: opens the AI chat about this problem (with the card's title); absent while AI is not offered. */
  onAskAi?: ((record: ProblemRecord, title: string) => void) | undefined;
  /** S35.2: asks the AI for a fix of the reported file around the reported line; absent while AI is not offered. */
  onFixWithAi?: ((record: ProblemRecord, title: string) => void) | undefined;
}

type Translate = (key: MessageKey) => string;

export const SOURCE_TAG: Record<ProblemRecord['source'], MessageKey> = {
  static: 'problems.card.source.static',
  runtime: 'problems.card.source.runtime',
  resource: 'problems.card.source.resource',
  console: 'problems.card.source.console',
};

/**
 * The problem card (S22.4, PLAN §9 example, wireframe 3): where (file, line) and what was reported, then the
 * actions (right under the head, so they are in view in a short panel), then the plain-language explanation — worded
 * as a possibility unless the rule is certain — the possible causes and the checks. The actions: the one-click fix
 * when the did-you-mean rule found exactly one name (S22.5), Fix with AI, Go to code, Show original error, Ask AI.
 * The original error is always one click away and is shown verbatim.
 */
export function ProblemCard(props: ProblemCardProps) {
  const { t, locale } = useI18n();
  const [originalOpen, setOriginalOpen] = useState(false);
  return (
    <ProblemCardBody
      {...props}
      t={t}
      locale={locale}
      originalOpen={originalOpen}
      onToggleOriginal={() => setOriginalOpen((open) => !open)}
    />
  );
}

export function ProblemCardBody({
  record,
  explanation,
  onGoTo,
  onFix,
  fixBusy,
  onAskAi,
  onFixWithAi,
  t,
  locale,
  originalOpen,
  onToggleOriginal,
}: ProblemCardProps & { t: Translate; locale: Locale; originalOpen: boolean; onToggleOriginal: () => void }) {
  const text = renderExplanation(locale, record, explanation);
  const labelOf = new Map(text.actions.map((a, i) => [explanation.actions[i], a.label]));
  const fix = onFix ? fixActionOf(explanation) : null;
  const originalId = `problem-original-${record.id}`;
  const headId = `problem-card-head-${record.id}`;

  return (
    <div
      className="problem-card"
      role="group"
      aria-labelledby={headId}
      data-testid="problem-card"
      data-rule={explanation.ruleId}
      data-certainty={explanation.certainty}
    >
      <p className="problem-card-head" id={headId} data-testid="problem-card-head">
        <span className="problem-card-tag">{t(SOURCE_TAG[record.source])}</span>{' '}
        {text.location && (
          <span className="problem-card-location" data-testid="problem-card-location">
            {text.location}
          </span>
        )}
        <span data-testid="problem-card-title">{text.title}</span>
        {record.count > 1 && (
          <span className="problem-count">{` ${t('problems.card.count').replace('{n}', String(record.count))}`}</span>
        )}
      </p>
      {/* The actions come right after the head, so they are in view in a short panel without scrolling. */}
      <div className="problem-actions">
        {fix && (
          <button
            type="button"
            className="primary-button"
            data-testid="problem-fix"
            disabled={fixBusy}
            onClick={() => onFix?.(record, fix)}
          >
            {labelOf.get(fix)}
          </button>
        )}
        {onFixWithAi && record.file && record.line !== undefined && (
          <button
            type="button"
            className="ai-entry"
            data-testid="problem-fix-ai"
            title={t('problems.card.fixWithAiHint')}
            onClick={() => onFixWithAi(record, text.title)}
          >
            <AiIcon />
            {t('problems.card.fixWithAi')}
          </button>
        )}
        {explanation.actions.map((action) => {
          if (action.kind === 'go-to-code') {
            return (
              <button
                key="go-to-code"
                type="button"
                className="secondary-button"
                data-testid="problem-go-to"
                onClick={() =>
                  onGoTo({
                    file: action.file,
                    line: action.line,
                    ...(action.column !== undefined ? { column: action.column } : {}),
                  })
                }
              >
                {labelOf.get(action)}
              </button>
            );
          }
          if (action.kind === 'show-original') {
            return (
              <button
                key="show-original"
                type="button"
                className="quiet-button"
                aria-expanded={originalOpen}
                aria-controls={originalId}
                data-testid="problem-show-original"
                onClick={onToggleOriginal}
              >
                {labelOf.get(action)}
              </button>
            );
          }
          return null;
        })}
        {onAskAi && (
          <button
            type="button"
            className="quiet-button problem-ask-ai"
            data-testid="problem-ask-ai"
            title={t('problems.card.askAiHint')}
            onClick={() => onAskAi(record, text.title)}
          >
            <AiIcon />
            {t('problems.card.askAi')}
          </button>
        )}
      </div>
      <p className="problem-card-text" data-testid="problem-explanation">
        {text.explanation}
      </p>
      {text.causesHeading && (
        <div className="problem-card-list">
          <p className="problem-card-heading">{text.causesHeading}</p>
          <ul data-testid="problem-causes">
            {text.causes.map((cause, i) => (
              <li key={i}>{cause}</li>
            ))}
          </ul>
        </div>
      )}
      {text.checksHeading && (
        <div className="problem-card-list">
          <p className="problem-card-heading">{text.checksHeading}</p>
          <ul data-testid="problem-checks">
            {text.checks.map((check, i) => (
              <li key={i}>{check}</li>
            ))}
          </ul>
        </div>
      )}
      {originalOpen && <OriginalError id={originalId} record={record} locale={locale} t={t} />}
    </div>
  );
}

export function OriginalError({
  id,
  record,
  locale,
  t,
}: {
  id: string;
  record: ProblemRecord;
  locale: string;
  t: Translate;
}) {
  const time = (at: number) => new Date(at).toLocaleTimeString(locale, { hour12: false });
  const owner = typeof record.data?.owner === 'string' ? record.data.owner : '';
  const source =
    record.source === 'static'
      ? t('problems.original.sourceStatic').replace('{owner}', owner)
      : record.preview
        ? t('problems.original.sourcePreview')
            .replace('{session}', record.preview.sessionId)
            .replace('{generation}', String((record.last?.preview ?? record.preview).generation))
        : t('problems.original.sourcePage');
  const latestDiffers = record.last && record.last.message !== record.originalMessage;
  return (
    <div className="problem-original" id={id} data-testid="problem-original">
      <pre className="problem-original-text" data-testid="problem-original-message">
        {record.originalMessage}
      </pre>
      {record.originalStack && (
        <pre className="problem-original-text" data-testid="problem-original-stack">
          {record.originalStack}
        </pre>
      )}
      {latestDiffers && record.last && (
        <>
          <p className="problem-original-label">{t('problems.original.latest')}</p>
          <pre className="problem-original-text">{record.last.message}</pre>
        </>
      )}
      {record.truncated && <p className="problem-original-meta">{t('problems.original.truncated')}</p>}
      <p className="problem-original-meta" data-testid="problem-original-meta">
        {[
          `${t('problems.original.code')} ${record.code}`,
          source,
          `${t('problems.original.firstSeen')} ${time(record.firstSeen)}`,
          ...(record.count > 1 ? [`${t('problems.original.lastSeen')} ${time(record.lastSeen)}`] : []),
        ].join(' · ')}
      </p>
    </div>
  );
}
