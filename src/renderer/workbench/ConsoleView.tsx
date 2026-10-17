import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { copyText } from '../ai/clipboard';
import { JumpLatestIcon } from '../ai/ai-icons';
import { useScrollLatch } from '../ai/useScrollLatch';
import { noticeText } from './console-notice';
import { linesToText, searchLines, type ConsoleLineWords } from './console-model';
import { CopyIcon, WarningIcon } from './icons';
import { useRovingFocus } from './useRovingFocus';
import {
  CONSOLE_LEVEL_FILTERS,
  MAX_VISIBLE_LOG_ENTRIES,
  errorCount,
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

/** How long "Copied N lines" stays in the toolbar. */
const COPIED_NOTE_MS = 4000;

/** S49.4: a stable key per console line (entries are new objects when they arrive), for the latch's pending count. */
const lineKeys = new WeakMap<ConsoleEntry, number>();
let nextLineKey = 0;
function keyOf(entry: ConsoleEntry): number {
  let key = lineKeys.get(entry);
  if (key === undefined) {
    nextLineKey += 1;
    key = nextLineKey;
    lineKeys.set(entry, key);
  }
  return key;
}

interface Row {
  readonly entry: ConsoleEntry;
  readonly key: number;
  readonly older: boolean;
  readonly words: ConsoleLineWords;
}

type CopyNote =
  | { readonly kind: 'copied'; readonly n: number; readonly seq: number }
  | { readonly kind: 'failed'; readonly seq: number };

/**
 * The page's console output (S05.3 list, S17.3 view): level filter, Clear, bounded to the newest
 * MAX_VISIBLE_LOG_ENTRIES lines, and attributed to page loads: output from before the last refresh is labelled
 * "before refresh" and can be hidden to see only the current load. Levels are spelled out, never colour alone.
 * S49.4: the list follows new output only while the reader has not scrolled it (the S48.1 scroll latch, with Jump to
 * latest and the number of new lines); a search field filters the shown lines ignoring case; every line has Copy line
 * (one tab stop for the list, the arrows move between lines) and the toolbar has Copy all visible.
 */
export function ConsoleView({ log, onClear }: { log: LogView; onClear: () => void }) {
  const { t } = useI18n();
  const [level, setLevel] = useState<ConsoleLevelFilter>('all');
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const [query, setQuery] = useState('');
  const [copyNote, setCopyNote] = useState<CopyNote | null>(null);
  const rows: Row[] = visibleLog(log, level, !onlyCurrent).map((entry) => {
    const older = entry.generation !== log.generation;
    return { entry, key: keyOf(entry), older, words: wordsOf(entry, older, t) };
  });
  const lines = searchLines(rows, query, (row) => row.words);
  const older = olderCount(log);
  const errors = errorCount(log);
  // The tools appear with the first output (no controls that do nothing); an emptied console starts unfiltered again.
  const hasOutput = log.entries.length > 0 || log.dropped > 0 || log.throttled;
  useEffect(() => {
    if (hasOutput) return;
    setLevel('all');
    setOnlyCurrent(false);
    setQuery('');
  }, [hasOutput]);

  // S49.4: the scroll latch over the list. The toolbar sits outside the scroller, so typing a search is not "the
  // reader moved the log". Lines newer than the last render are the change's entries (the pending count).
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  const newKeys = lines.filter((row) => row.key > seen.current).map((row) => String(row.key));
  const latch = useScrollLatch(scroller, `${lines.length}:${lines.at(-1)?.key ?? 0}`, newKeys, '');
  const lastKey = rows.at(-1)?.key ?? 0;
  useEffect(() => {
    seen.current = Math.max(seen.current, lastKey);
  }, [lastKey]);

  useEffect(() => {
    if (!copyNote) return undefined;
    const timer = setTimeout(() => setCopyNote(null), COPIED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [copyNote]);
  const copy = (words: readonly ConsoleLineWords[]) => {
    void copyText(linesToText(words)).then((ok) =>
      setCopyNote((prev) => {
        const seq = (prev?.seq ?? 0) + 1;
        return ok ? { kind: 'copied', n: words.length, seq } : { kind: 'failed', seq };
      }),
    );
  };
  const roving = useRovingFocus<HTMLOListElement>({
    orientation: 'vertical',
    items: ':scope > li > button.preview-console-copy',
  });

  return (
    <div className="preview-console" role="region" aria-label={t('preview.console')} data-testid="preview-console">
      {/* The heading row is always shown (a visible name and the number of errors, icon + number, never colour
          alone); the tools appear with the first output. */}
      <div className="preview-console-toolbar" data-testid="console-head">
        <h3 className="preview-console-title">{t('preview.console')}</h3>
        {errors > 0 && (
          <span
            className="preview-console-errors"
            data-testid="console-error-count"
            title={t('preview.console.errors.label').replace('{count}', String(errors))}
          >
            <WarningIcon size={14} />
            {t('preview.console.errors').replace('{count}', String(errors))}
          </span>
        )}
        {hasOutput && (
          <>
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
            <input
              type="search"
              className="preview-console-search"
              data-testid="console-search"
              value={query}
              placeholder={t('preview.console.search.placeholder')}
              aria-label={t('preview.console.search.label')}
              title={t('preview.console.search.label')}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className="quiet-button"
              data-testid="console-copy-all"
              disabled={lines.length === 0}
              aria-label={t('preview.console.copyAll')}
              title={fill(t('preview.console.copyAll.title', lines.length), { n: lines.length })}
              onClick={() => copy(lines.map((row) => row.words))}
            >
              <CopyIcon />
              <span className="cq-label">{t('preview.console.copyAll')}</span>
            </button>
            <button
              type="button"
              className="quiet-button"
              data-testid="console-clear"
              title={t('preview.console.cap').replace('{count}', String(MAX_VISIBLE_LOG_ENTRIES))}
              onClick={onClear}
            >
              {t('preview.console.clear')}
            </button>
          </>
        )}
        {copyNote && (
          <span
            key={copyNote.seq}
            className="preview-console-copied"
            role="status"
            data-testid="console-copy-status"
            data-kind={copyNote.kind}
          >
            {copyNote.kind === 'failed' && <WarningIcon size={14} />}
            {copyNote.kind === 'copied'
              ? fill(t('preview.console.copied', copyNote.n), { n: copyNote.n })
              : t('preview.console.copyFailed')}
          </span>
        )}
      </div>
      {(log.dropped > 0 || log.throttled) && (
        <p className="preview-console-dropped" data-testid="preview-console-dropped">
          {t(log.throttled ? 'preview.console.droppedAtLeast' : 'preview.console.dropped').replace(
            '{count}',
            String(log.dropped),
          )}
        </p>
      )}
      <div className="preview-console-body" ref={scroller} data-testid="console-scroller">
        {lines.length === 0 ? (
          <p className="preview-console-empty">
            {log.entries.length === 0
              ? t('preview.console.empty')
              : rows.length > 0
                ? fill(t('preview.console.emptySearch'), { query: query.trim() })
                : t('preview.console.emptyFiltered')}
          </p>
        ) : (
          <ol className="preview-console-list" {...roving}>
            {lines.map((row, index) => (
              <LogLine key={row.key} row={row} n={index + 1} onCopy={() => copy([row.words])} />
            ))}
          </ol>
        )}
        {latch.show && (
          <button type="button" className="preview-console-jump" data-testid="console-jump" onClick={latch.jump}>
            <JumpLatestIcon />
            {t('preview.console.jumpLatest')}
            {latch.pending > 0 && (
              <span className="preview-console-jump-count" data-testid="console-jump-count">
                {fill(t('preview.console.jumpPending', latch.pending), { n: latch.pending })}
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/** The words a row shows (and copies). */
function wordsOf(entry: ConsoleEntry, older: boolean, t: (key: MessageKey) => string): ConsoleLineWords {
  const notice = entry.notice ? noticeText(entry.notice, entry.message, t) : null;
  const where = entry.url ? `${fileName(entry.url)}${entry.line ? `:${entry.line}` : ''}` : '';
  return {
    level: t(`preview.level.${entry.level}`),
    older: older ? t('preview.console.olderTag') : undefined,
    text: notice ? notice.text : entry.message,
    detail: notice?.detail || undefined,
    where: where || undefined,
  };
}

function LogLine({ row, n, onCopy }: { row: Row; n: number; onCopy: () => void }) {
  const { t } = useI18n();
  const { entry, words } = row;
  return (
    <li
      className={`preview-console-line level-${entry.level}${row.older ? ' older' : ''}`}
      data-source={entry.source}
      data-level={entry.level}
      data-generation={entry.generation}
      {...(entry.notice ? { 'data-notice': entry.notice.kind } : {})}
    >
      <span className="preview-console-level">{words.level}</span>
      {words.older && <span className="preview-console-older">{words.older}</span>}
      <span className="preview-console-text">{words.text}</span>
      {words.detail && <span className="preview-console-detail">{words.detail}</span>}
      {words.where && <span className="preview-console-where">{words.where}</span>}
      <button
        type="button"
        className="icon-button preview-console-copy"
        data-testid="console-copy-line"
        aria-label={fill(t('preview.console.copyLine.label'), { n })}
        title={t('preview.console.copyLine')}
        onClick={onCopy}
      >
        <CopyIcon />
      </button>
    </li>
  );
}

function fileName(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || u.host);
  } catch {
    return url;
  }
}
