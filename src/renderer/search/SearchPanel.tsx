import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { isImeKey } from '../workbench/ime';
import { CaseIcon, ChevronDownIcon, RefreshIcon, RegexIcon, SearchIcon, WholeWordIcon } from '../workbench/icons';
import {
  SEARCH_TOGGLES,
  flattenHits,
  moveHit,
  panelMessage,
  previewParts,
  splitPath,
  type FlatHit,
  type SearchOption,
} from './search-model';
import type { ProjectSearch } from './useProjectSearch';

const TOGGLE_ICON: Record<SearchOption, () => ReactNode> = {
  caseSensitive: CaseIcon,
  wholeWord: WholeWordIcon,
  regex: RegexIcon,
};

export interface SearchPanelProps {
  readonly open: boolean;
  readonly projectOpen: boolean;
  readonly search: ProjectSearch;
  /** Bumped by Ctrl/Cmd+Shift+F: the query field takes the focus with its text selected. */
  readonly focusRequest: number;
  readonly onClose: () => void;
  /** Opens the file at the match (and moves the keyboard into the editor). */
  readonly onOpenHit: (target: { file: string; line: number; column: number }) => void;
  /** S51.4: the replace row and the per-file preview, under the query. */
  readonly replace?: ReactNode;
  /** S51.4: extra content per result (the include checkbox of replace), keyed by the hit. */
  readonly renderHitExtra?: (hit: FlatHit) => ReactNode;
}

const fill = (text: string, n: number) => text.replace('{n}', String(n));

/**
 * The find-in-files panel (S51.3) in the bottom region beside Problems. One query field with three option toggles
 * (each a button with an icon, its accessible name and aria-pressed: never colour alone), a polite status line that
 * says what happened in words (results, nothing found, invalid regular expression, no project), and the results
 * grouped by file. Keyboard: ↓ from the field into the results, ↑/↓/Home/End between them, Enter opens one, Escape
 * collapses the panel.
 */
export function SearchPanel({
  open,
  projectOpen,
  search,
  focusRequest,
  onClose,
  onOpenHit,
  replace,
  renderHitExtra,
}: SearchPanelProps) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ids = useId();
  const results = search.state.kind === 'done' ? search.state.results : null;
  const hits = useMemo(() => flattenHits(results), [results]);
  const [current, setCurrent] = useState(0);
  const active = hits.length === 0 ? -1 : Math.min(current, hits.length - 1);
  const message = panelMessage(t, search.state, search.query, projectOpen);

  useEffect(() => setCurrent(0), [results]);

  useEffect(() => {
    if (focusRequest === 0 || !open) return;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest, open]);

  const focusHit = (index: number) => {
    setCurrent(index);
    list.current?.querySelector<HTMLElement>(`[data-hit-index="${index}"]`)?.focus();
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(event.nativeEvent)) return; // the input method owns Enter and the arrows while composing
    if (event.key === 'Enter') {
      event.preventDefault();
      search.runNow();
    } else if (event.key === 'ArrowDown' && hits.length > 0) {
      event.preventDefault();
      focusHit(Math.max(active, 0));
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = Number((event.target as HTMLElement).dataset.hitIndex ?? NaN);
    if (Number.isNaN(index)) return;
    if (event.key === 'ArrowUp' && index === 0) {
      event.preventDefault();
      input.current?.focus();
      return;
    }
    const next = moveHit(index, hits.length, event.key);
    if (next !== null) {
      event.preventDefault();
      focusHit(next);
    }
  };

  let flatIndex = 0;
  // Closed: an empty, hidden region (nothing to tab to, nothing rendered for nothing).
  if (!open)
    return <div id="search-panel" className="panel problems-panel search-panel" hidden data-testid="search-panel" />;
  return (
    <div
      id="search-panel"
      className="panel problems-panel search-panel"
      data-testid="search-panel"
      role="region"
      aria-labelledby={`${ids}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-header">
        <h2 className="region-title" id={`${ids}-title`}>
          {t('search.title')}
        </h2>
        <span className="search-header-actions">
          {/* Only when there is something to search again: no disabled decoration (S30.3). */}
          {projectOpen && search.query.text !== '' && (
            <button
              type="button"
              className="icon-button"
              aria-label={t('search.refresh')}
              title={t('search.refresh')}
              data-testid="search-refresh"
              onClick={search.runNow}
            >
              <RefreshIcon />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={t('search.close')}
            title={t('search.close')}
            onClick={onClose}
          >
            <ChevronDownIcon />
          </button>
        </span>
      </div>
      <div className="search-body">
        {/* Without a project there is nothing to search: only the explanation below shows. */}
        {projectOpen && (
          <div className="search-form">
            <div className="search-field">
              <SearchIcon size={14} />
              <input
                ref={input}
                type="text"
                className="search-input"
                aria-label={t('search.query')}
                placeholder={t('search.placeholder')}
                autoComplete="off"
                spellCheck={false}
                value={search.query.text}
                data-testid="search-input"
                onChange={(event) => search.setText(event.target.value)}
                onKeyDown={onInputKey}
              />
              {SEARCH_TOGGLES.map(({ option, label }) => {
                const Icon = TOGGLE_ICON[option];
                const on = search.query[option];
                return (
                  <button
                    key={option}
                    type="button"
                    className="search-toggle"
                    aria-pressed={on}
                    aria-label={t(label)}
                    title={t(label)}
                    data-testid={`search-toggle-${option}`}
                    onClick={() => search.toggle(option)}
                  >
                    <Icon />
                  </button>
                );
              })}
            </div>
            {replace}
          </div>
        )}
        <p
          className="search-status"
          role="status"
          aria-live="polite"
          data-testid="search-status"
          data-kind={message.kind}
        >
          {message.text}
        </p>
        {results && results.files.length > 0 && (
          // Focusable as a whole only through its results (roving tabindex): Tab reaches the current result.
          <div
            ref={list}
            className="search-results"
            role="region"
            aria-label={t('search.results')}
            data-testid="search-results"
            onKeyDown={onListKey}
          >
            {results.files.map((file) => {
              const { folder, name } = splitPath(file.relPath);
              const headingId = `${ids}-file-${file.relPath}`;
              return (
                <section
                  key={file.relPath}
                  className="search-file"
                  aria-labelledby={headingId}
                  data-path={file.relPath}
                >
                  <h3 className="search-file-head" id={headingId}>
                    <span className="search-file-name">{name}</span>
                    {folder && <span className="search-file-folder">{folder}</span>}
                    <span className="problems-badge" data-testid="search-file-count">
                      {fill(t('search.fileMatches'), file.matches.length)}
                    </span>
                  </h3>
                  <ul className="search-hits">
                    {file.matches.map((match) => {
                      const index = flatIndex;
                      flatIndex += 1;
                      const hit = hits[index] as FlatHit;
                      const parts = previewParts(match);
                      return (
                        <li key={hit.key} className="search-hit-row">
                          {renderHitExtra?.(hit)}
                          <button
                            type="button"
                            className="search-hit"
                            tabIndex={index === active ? 0 : -1}
                            data-hit-index={index}
                            data-testid="search-hit"
                            data-path={file.relPath}
                            data-line={match.line}
                            data-column={match.column}
                            onFocus={() => setCurrent(index)}
                            onClick={() => onOpenHit({ file: file.relPath, line: match.line, column: match.column })}
                          >
                            <span className="search-hit-line">{fill(t('search.line'), match.line)}</span>
                            <span className="search-hit-text">
                              {parts.before}
                              <mark className="search-hit-mark">{parts.hit}</mark>
                              {parts.after}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {message.truncated && (
              <p className="search-truncated" data-testid="search-truncated">
                {message.truncated}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The status strip's "Find in files" button beside the Problems toggle (S51.3). */
export function SearchStripButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="status-button"
      aria-expanded={open}
      aria-controls="search-panel"
      title={t('search.toggle')}
      data-testid="search-toggle"
      onClick={onToggle}
    >
      <SearchIcon size={14} />
      {t('search.title')}
    </button>
  );
}
