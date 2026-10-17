import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { ReplaceIcon } from '../workbench/icons';
import { matchKey, replacementForMatch } from '../../shared/search';
import type { SearchFileResult } from '../../shared/ipc/search-contract';
import { applyReplace, buildPlan, hitId, type ReplaceHost, type ReplaceSummary } from './replace-apply';
import type { FlatHit } from './search-model';
import type { ProjectSearch } from './useProjectSearch';

export interface ReplaceInFiles {
  readonly expanded: boolean;
  expand(): void;
  /** The replace row, the hint and the summary, rendered under the query field. */
  readonly row: ReactNode;
  /** Per result: the include checkbox (only while the replace row is open). */
  readonly renderHitExtra?: (hit: FlatHit) => ReactNode;
  /** Per file: the include checkbox in its heading. */
  readonly renderFileExtra?: (file: SearchFileResult) => ReactNode;
  /** What a result becomes (the preview), or null when nothing is replaced. */
  readonly replacementFor?: (hit: FlatHit) => string | null;
}

const fill = (text: string, values: Readonly<Record<string, string | number>>) =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));

/**
 * S51.4: replace in files inside the find-in-files panel. The replace row shows every match's new text next to the
 * old (a per-file preview of every change), each file and each match can be unticked, and "Replace n matches" applies
 * the rest through the save pipeline (replace-apply.ts). The summary lists the applied files and, with the reason,
 * the ones left unchanged; the search then runs again, so the list shows what is left.
 */
export function useReplaceInFiles(search: ProjectSearch, host: ReplaceHost | undefined): ReplaceInFiles {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [excludedHits, setExcludedHits] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [summary, setSummary] = useState<ReplaceSummary | null>(null);
  // The listed results with the query and project they were found for: the preview and the plan use exactly these.
  const found = search.state.kind === 'done' ? search.state : null;
  const results = found?.results ?? null;
  // The field holds a newer query than the list (its search is still waiting or running): no applying meanwhile.
  const live = search.query;
  const stale =
    found !== null &&
    (found.query.text !== live.text ||
      found.query.regex !== live.regex ||
      found.query.caseSensitive !== live.caseSensitive ||
      found.query.wholeWord !== live.wholeWord);
  const summaryRef = useRef<HTMLDivElement>(null);

  // New results: every match is included again. A new query also forgets the last summary.
  useEffect(() => {
    setExcludedFiles(new Set());
    setExcludedHits(new Set());
  }, [results]);
  const queryText = search.query.text;
  useEffect(() => setSummary(null), [queryText]);

  const included = useMemo(() => {
    if (!results) return 0;
    let n = 0;
    for (const file of results.files) {
      if (excludedFiles.has(file.relPath)) continue;
      for (const m of file.matches) if (!excludedHits.has(hitId(file.relPath, matchKey(m.line, m.column)))) n += 1;
    }
    return n;
  }, [results, excludedFiles, excludedHits]);

  const searchRef = useRef(search);
  searchRef.current = search;
  const apply = useCallback(async () => {
    const current = searchRef.current;
    if (!host || !found || stale || applying) return;
    setApplying(true);
    setSummary(null);
    try {
      const plan = buildPlan(found.projectId, found.results, found.query, replacement, excludedFiles, excludedHits);
      setSummary(await applyReplace(plan, host));
    } finally {
      setApplying(false);
      current.runNow(); // what is left to find
      // The keyboard goes to the summary (the Replace button may be gone now that nothing is left to replace).
      setTimeout(() => summaryRef.current?.focus(), 0);
    }
  }, [host, found, stale, applying, replacement, excludedFiles, excludedHits]);

  const toggleIn = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const showPreview = expanded && host !== undefined;
  const row = host ? (
    <div className="replace-section">
      <div className="replace-row">
        <button
          type="button"
          className="quiet-button replace-expander"
          aria-expanded={expanded}
          aria-label={t('replace.toggleLabel')}
          data-testid="replace-expander"
          onClick={() => setExpanded((open) => !open)}
        >
          <ReplaceIcon />
          {t('replace.toggle')}
        </button>
        {expanded && (
          <div className="search-field replace-field">
            <input
              type="text"
              className="search-input"
              aria-label={t('replace.input')}
              placeholder={t('replace.placeholder')}
              autoComplete="off"
              spellCheck={false}
              value={replacement}
              data-testid="replace-input"
              onChange={(event) => setReplacement(event.target.value)}
            />
          </div>
        )}
        {showPreview && results && !stale && (included > 0 || applying) && (
          <button
            type="button"
            className="quiet-button replace-apply"
            data-testid="replace-apply"
            aria-disabled={applying}
            onClick={() => void apply()}
          >
            {applying ? t('replace.applying') : fill(t('replace.apply', included), { n: included })}
          </button>
        )}
      </div>
      {showPreview && results && results.files.length > 0 && <p className="replace-hint">{t('replace.hint')}</p>}
      <div
        ref={summaryRef}
        className="replace-summary"
        role="status"
        aria-live="polite"
        tabIndex={-1}
        data-testid="replace-summary"
      >
        {applying && <p>{t('replace.applying')}</p>}
        {summary && summary.applied.length > 0 && (
          <p data-testid="replace-applied">
            {fill(t('replace.done', summary.applied.length), { n: summary.applied.length })}
          </p>
        )}
        {summary && summary.failed.length > 0 && (
          <>
            <p>{fill(t('replace.failedTitle', summary.failed.length), { n: summary.failed.length })}</p>
            <ul className="replace-failed">
              {summary.failed.map((f) => (
                <li key={f.relPath} data-testid="replace-failed" data-path={f.relPath} data-reason={f.reason}>
                  <span className="replace-failed-path">{f.relPath}</span>
                  {t(`replace.failed.${f.reason}` as MessageKey)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  ) : null;

  const replaceText = replacement;
  const query = found?.query ?? search.query;
  return {
    expanded,
    expand: useCallback(() => setExpanded(true), []),
    row,
    ...(showPreview
      ? {
          renderFileExtra: (file: SearchFileResult) => (
            <input
              type="checkbox"
              className="replace-check"
              checked={!excludedFiles.has(file.relPath)}
              aria-label={fill(t('replace.includeFile'), { file: file.relPath })}
              data-testid="replace-include-file"
              onChange={() => setExcludedFiles((set) => toggleIn(set, file.relPath))}
            />
          ),
          renderHitExtra: (hit: FlatHit) => {
            const id = hitId(hit.file.relPath, matchKey(hit.match.line, hit.match.column));
            return (
              <input
                type="checkbox"
                className="replace-check"
                checked={!excludedFiles.has(hit.file.relPath) && !excludedHits.has(id)}
                disabled={excludedFiles.has(hit.file.relPath)}
                aria-label={fill(t('replace.includeHit'), { file: hit.file.relPath, line: hit.match.line })}
                data-testid="replace-include-hit"
                onChange={() => setExcludedHits((set) => toggleIn(set, id))}
              />
            );
          },
          replacementFor: (hit: FlatHit) => {
            const id = hitId(hit.file.relPath, matchKey(hit.match.line, hit.match.column));
            if (excludedFiles.has(hit.file.relPath) || excludedHits.has(id)) return null;
            // Re-run on the context line (the whole match is in it); a lookaround that reaches past it falls back to
            // the replacement as typed, so an included match never looks unchanged.
            return replacementForMatch(query, replaceText, hit.match.preview, hit.match.previewStart) ?? replaceText;
          },
        }
      : {}),
  };
}
