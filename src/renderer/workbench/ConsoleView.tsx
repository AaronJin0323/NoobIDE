import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import type { PreviewNotice } from '../../shared/ipc/preview-contract';
import {
  CONSOLE_LEVEL_FILTERS,
  MAX_VISIBLE_LOG_ENTRIES,
  olderCount,
  visibleLog,
  type ConsoleEntry,
  type ConsoleLevelFilter,
  type LogView,
} from './preview-model';

const FILTER_LABEL: Record<ConsoleLevelFilter, MessageKey> = {
  all: 'preview.console.level.all',
  error: 'preview.console.level.error',
  warning: 'preview.console.level.warning',
  info: 'preview.console.level.info',
};

/**
 * The page's console output (S05.3 list, S17.3 view): level filter, Clear, bounded to the newest
 * MAX_VISIBLE_LOG_ENTRIES lines, and attributed to page loads: output from before the last refresh is labelled
 * "before refresh" and can be hidden to see only the current load. Levels are spelled out, never colour alone.
 */
export function ConsoleView({ log, onClear }: { log: LogView; onClear: () => void }) {
  const { t } = useI18n();
  const [level, setLevel] = useState<ConsoleLevelFilter>('all');
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const lines = visibleLog(log, level, !onlyCurrent);
  const older = olderCount(log);
  // The tools appear with the first output (no controls that do nothing); an emptied console starts unfiltered again.
  const hasOutput = log.entries.length > 0 || log.dropped > 0 || log.throttled;
  useEffect(() => {
    if (hasOutput) return;
    setLevel('all');
    setOnlyCurrent(false);
  }, [hasOutput]);
  return (
    <div className="preview-console" role="region" aria-label={t('preview.console')} data-testid="preview-console">
      {hasOutput && (
        <div className="preview-console-toolbar">
          <label className="preview-console-filter">
            {t('preview.console.filter')}
            <select
              value={level}
              data-testid="console-level"
              onChange={(event) => setLevel(event.target.value as ConsoleLevelFilter)}
            >
              {CONSOLE_LEVEL_FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {t(FILTER_LABEL[filter])}
                </option>
              ))}
            </select>
          </label>
          {older > 0 && (
            <label className="preview-console-filter">
              <input
                type="checkbox"
                checked={onlyCurrent}
                data-testid="console-only-current"
                onChange={(event) => setOnlyCurrent(event.target.checked)}
              />
              {t('preview.console.onlyCurrent').replace('{count}', String(older))}
            </label>
          )}
          <button
            type="button"
            className="quiet-button"
            data-testid="console-clear"
            title={t('preview.console.cap').replace('{count}', String(MAX_VISIBLE_LOG_ENTRIES))}
            onClick={onClear}
          >
            {t('preview.console.clear')}
          </button>
        </div>
      )}
      {(log.dropped > 0 || log.throttled) && (
        <p className="preview-console-dropped" data-testid="preview-console-dropped">
          {t(log.throttled ? 'preview.console.droppedAtLeast' : 'preview.console.dropped').replace(
            '{count}',
            String(log.dropped),
          )}
        </p>
      )}
      {lines.length === 0 ? (
        <p className="preview-console-empty">
          {log.entries.length === 0 ? t('preview.console.empty') : t('preview.console.emptyFiltered')}
        </p>
      ) : (
        <ol className="preview-console-list">
          {lines.map((entry, index) => (
            <LogLine key={index} entry={entry} older={entry.generation !== log.generation} />
          ))}
        </ol>
      )}
    </div>
  );
}

function LogLine({ entry, older }: { entry: ConsoleEntry; older: boolean }) {
  const { t } = useI18n();
  const where = entry.url ? `${fileName(entry.url)}${entry.line ? `:${entry.line}` : ''}` : '';
  return (
    <li
      className={`preview-console-line level-${entry.level}${older ? ' older' : ''}`}
      data-source={entry.source}
      data-level={entry.level}
      data-generation={entry.generation}
      {...(entry.notice ? { 'data-notice': entry.notice.kind } : {})}
    >
      <span className="preview-console-level">{t(`preview.level.${entry.level}`)}</span>
      {older && <span className="preview-console-older">{t('preview.console.olderTag')}</span>}
      <span className="preview-console-text">{entry.notice ? noticeText(entry.notice, t) : entry.message}</span>
      {where && <span className="preview-console-where">{where}</span>}
    </li>
  );
}

/** IDE notices about the page (S25.4 permissions, decision 0016 flood stop), in the user's language. */
function noticeText(notice: PreviewNotice, t: (key: MessageKey) => string): string {
  if (notice.kind === 'console-flood-stopped') return t('preview.notice.consoleFloodStopped');
  if (notice.permission === 'other') return t('preview.notice.permissionDeniedOther');
  return t('preview.notice.permissionDenied').replace('{permission}', t(`preview.permission.${notice.permission}`));
}

function fileName(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || u.host);
  } catch {
    return url;
  }
}
