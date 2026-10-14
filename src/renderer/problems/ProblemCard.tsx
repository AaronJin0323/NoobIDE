import { useState } from 'react';
import type { ProblemAction, ProblemExplanation, ProblemRecord } from '../../shared/problem';
import { formatMessage } from '../../diagnostics/messages';
import { useI18n } from '../i18n/I18nProvider';

export interface ProblemCardProps {
  record: ProblemRecord;
  explanation: ProblemExplanation;
  /** Opens the file and puts the cursor on the reported line and column (S17.2). */
  onGoTo: (target: { file: string; line: number; column?: number }) => void;
}

/**
 * The details of one problem (S17.2): Go to code and the original error, exactly as reported. The actions come from
 * the explanation (rules engine), which always offers "Show original error" and offers "Go to code" only when the
 * file and line are known.
 */
export function ProblemCard({ record, explanation, onGoTo }: ProblemCardProps) {
  const { t, locale } = useI18n();
  const [originalOpen, setOriginalOpen] = useState(false);
  const label = (action: ProblemAction) => formatMessage(locale, action.label);
  const originalId = `problem-original-${record.id}`;

  return (
    <div className="problem-card" data-testid="problem-card" data-rule={explanation.ruleId}>
      <div className="problem-actions">
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
                {label(action)}
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
                onClick={() => setOriginalOpen((open) => !open)}
              >
                {label(action)}
              </button>
            );
          }
          return null;
        })}
      </div>
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
  t: ReturnType<typeof useI18n>['t'];
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
