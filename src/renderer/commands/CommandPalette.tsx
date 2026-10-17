import { isImeKey } from '../workbench/ime';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { otherLocale, translate, type MessageKey } from '../i18n/index';
import type { CommandId } from '../../shared/commands';
import { SearchIcon } from '../workbench/icons';
import { SheetFrame } from '../workbench/Sheet';
import {
  PALETTE_KEYWORDS,
  keywordList,
  moveSelection,
  recentLead,
  searchPalette,
  type PaletteEntry,
  type PaletteMatch,
} from './palette-model';
import { rankFiles } from './quick-open-model';

export interface PaletteCommand {
  readonly id: CommandId;
  readonly label: MessageKey;
  readonly shortcut: string | null;
  /** A choice among several (theme): whether it is the current one; null for actions. */
  readonly checked: boolean | null;
}

interface CommandPaletteProps {
  /** The commands that apply right now, captured when the palette opened. */
  commands: readonly PaletteCommand[];
  /** `null`: closed without running anything. */
  onClose: (run: CommandId | null) => void;
  /**
   * S51.5: opened as quick open (Ctrl/Cmd+P): the project's files (the S43.4 index) and the recently opened ones.
   * The palette searches files until the query starts with `>`, which switches to the commands.
   */
  files?: { readonly paths: readonly string[]; readonly recent: readonly string[] } | undefined;
  /** S51.5: a file was chosen; the palette closes and the file opens in a tab. */
  onOpenFile?: ((relPath: string) => void) | undefined;
  /** S49.5: command ids last run from the palette, newest first (app data). */
  recents?: readonly string[];
}

/**
 * The command palette (S40.5): a glass sheet with one search field over the list of commands that apply now. It is
 * a modal dialog on the shared sheet frame (S50.1: focus stays in the field, Escape or a click outside closes it and
 * focus goes back to where it was; a sheet under it blurs and dims); the field is a combobox whose active option
 * follows ↑/↓, and Enter runs it. Typing in Chinese through an
 * input method never runs anything mid-composition. Only commands that can run are listed — nothing pretends.
 */
export function CommandPalette({ commands, onClose, files, onOpenFile, recents = [] }: CommandPaletteProps) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const titleId = useId();
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const entries: PaletteEntry[] = useMemo(
    () =>
      commands.map((command) => {
        const keywords = PALETTE_KEYWORDS[command.id];
        return {
          id: command.id,
          label: t(command.label),
          otherLabel: translate(otherLocale(locale), command.label),
          shortcut: command.shortcut,
          ...(keywords
            ? { keywords: [...keywordList(t(keywords)), ...keywordList(translate(otherLocale(locale), keywords))] }
            : {}),
        };
      }),
    [commands, t, locale],
  );
  // S51.5: quick open searches files until the query starts with ">" (then the rest of it searches commands).
  const filesMode = files !== undefined && !query.startsWith('>');
  const commandQuery = files !== undefined ? query.replace(/^>\s*/, '') : query;
  const fileMatches = useMemo(
    () => (filesMode && files ? rankFiles(files.paths, query, files.recent) : []),
    [filesMode, files, query],
  );
  const commandMatches = useMemo(
    () => (filesMode ? [] : searchPalette(entries, commandQuery, recents)),
    [filesMode, entries, commandQuery, recents],
  );
  // S49.5: with an empty command query the recently run commands come first, under a "Recent" group.
  const lead = filesMode ? 0 : recentLead(commandMatches, recents, commandQuery);
  const count = filesMode ? fileMatches.length : commandMatches.length;
  const checkedOf = useMemo(() => new Map(commands.map((c) => [c.id, c.checked])), [commands]);
  const active = count === 0 ? -1 : Math.min(selected, count - 1);

  // Focus goes into the field on open; the shared frame gives it back to where it was on close.
  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    list.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(event.nativeEvent)) return; // the input method owns Enter and the arrows while composing
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(moveSelection(active, count, event.key));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (filesMode) {
        const file = fileMatches[active];
        if (file) onOpenFile?.(file.relPath);
        return;
      }
      const match = commandMatches[active];
      if (match) onClose(match.entry.id);
    } else if (event.key === 'Tab') {
      event.preventDefault(); // the field is the only stop in the sheet
    }
  };

  // S51.5: the texts of the mode in use (files or commands).
  const text = filesMode
    ? {
        title: t('palette.files.title'),
        label: t('palette.files.label'),
        placeholder: t('palette.files.placeholder'),
        results: t('palette.files.results'),
        empty: t('palette.files.empty'),
        count: t('palette.files.count'),
        keys: t('palette.files.keys'),
      }
    : {
        title: t('palette.title'),
        label: t('palette.label'),
        placeholder: t('palette.placeholder'),
        results: t('palette.results'),
        empty: t('palette.empty'),
        count: t('palette.count'),
        keys: t('palette.keys'),
      };

  const renderOption = (match: PaletteMatch, index: number) => {
    const checked = checkedOf.get(match.entry.id) ?? null;
    return (
      <li
        key={match.entry.id}
        id={optionId(index)}
        role="option"
        aria-selected={index === active}
        aria-checked={checked === null ? undefined : checked}
        className="palette-option"
        data-testid={`palette-${match.entry.id}`}
        onMouseMove={() => index !== active && setSelected(index)}
        onClick={() => onClose(match.entry.id)}
      >
        {/* The current choice carries a check mark, not only a colour */}
        <span className="palette-check" aria-hidden="true">
          {checked ? '✓' : ''}
        </span>
        <span className="palette-text">
          <span className="palette-label">{match.entry.label}</span>
          {match.viaOther && (
            <span className="palette-other">{t('palette.other').replace('{label}', match.entry.otherLabel)}</span>
          )}
        </span>
        {match.entry.shortcut && <kbd className="kbd">{match.entry.shortcut}</kbd>}
      </li>
    );
  };

  return (
    <SheetFrame
      className="palette"
      backdropClassName="palette-backdrop"
      backdropTestId="palette-backdrop"
      onBackdrop={() => onClose(null)}
      onEscape={() => onClose(null)}
      labelledBy={titleId}
      testId="command-palette"
      dataMode={filesMode ? 'files' : 'commands'}
      onSheetMouseDown={(event) => {
        // Clicking the sheet's padding or footer keeps the keyboard in the search field.
        if (event.target !== input.current) event.preventDefault();
      }}
    >
      <h2 className="sr-only" id={titleId}>
        {text.title}
      </h2>
      <div className="palette-search">
        <SearchIcon size={16} />
        <label className="sr-only" htmlFor={`${listId}-input`}>
          {text.label}
        </label>
        <input
          ref={input}
          id={`${listId}-input`}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded={count > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={text.placeholder}
          value={query}
          data-testid="palette-input"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {filesMode && count > 0 ? (
        <ul ref={list} id={listId} className="palette-list" role="listbox" aria-label={text.results}>
          {fileMatches.map((file, index) => (
            <li
              key={file.relPath}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className="palette-option"
              data-testid="palette-file"
              data-path={file.relPath}
              onMouseMove={() => index !== active && setSelected(index)}
              onClick={() => onOpenFile?.(file.relPath)}
            >
              <span className="palette-check" aria-hidden="true" />
              <span className="palette-text">
                <span className="palette-label">{file.name}</span>
                {file.folder && <span className="palette-other">{file.folder}</span>}
              </span>
              {file.recent && query === '' && <span className="palette-recent">{t('palette.files.recent')}</span>}
            </li>
          ))}
        </ul>
      ) : count > 0 ? (
        <ul ref={list} id={listId} className="palette-list" role="listbox" aria-label={text.results}>
          {lead > 0 && (
            <li
              role="group"
              className="palette-recent-group"
              aria-label={t('palette.recent')}
              data-testid="palette-recent"
            >
              <div className="palette-group" aria-hidden="true">
                {t('palette.recent')}
              </div>
              <ul role="none" className="palette-group-list">
                {commandMatches.slice(0, lead).map((match, index) => renderOption(match, index))}
              </ul>
            </li>
          )}
          {commandMatches.slice(lead).map((match, index) => renderOption(match, index + lead))}
        </ul>
      ) : (
        <p className="palette-empty" data-testid="palette-empty">
          {text.empty}
        </p>
      )}
      <p className="palette-footer">
        <span role="status" aria-live="polite" data-testid="palette-count">
          {text.count.replace('{n}', String(count))}
        </span>
        <span aria-hidden="true">{text.keys}</span>
      </p>
    </SheetFrame>
  );
}
