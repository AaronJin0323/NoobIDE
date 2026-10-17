import { isImeKey } from '../workbench/ime';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { otherLocale, translate, type Locale, type MessageKey } from '../i18n/index';
import type { CommandId } from '../../shared/commands';
import { SearchIcon } from '../workbench/icons';
import { SheetFrame } from '../workbench/Sheet';
import { PALETTE_KEYWORDS, keywordList, moveSelection, searchPalette, type PaletteEntry } from './palette-model';

export interface PaletteCommand {
  readonly id: CommandId;
  readonly label: MessageKey;
  readonly shortcut: string | null;
  /** A choice among several (theme): whether it is the current one; null for actions. */
  readonly checked: boolean | null;
}

/**
 * The commands as the matcher reads them: labels in the interface language and the other one, plus keywords. Shared
 * with the chat composer's `/` list (S48.4), so both find a command by the same words.
 */
export function paletteEntriesOf(
  commands: readonly PaletteCommand[],
  t: (key: MessageKey) => string,
  locale: Locale,
): PaletteEntry[] {
  const other = otherLocale(locale);
  return commands.map((command) => {
    const keywords = PALETTE_KEYWORDS[command.id];
    return {
      id: command.id,
      label: t(command.label),
      otherLabel: translate(other, command.label),
      shortcut: command.shortcut,
      ...(keywords ? { keywords: [...keywordList(t(keywords)), ...keywordList(translate(other, keywords))] } : {}),
    };
  });
}

interface CommandPaletteProps {
  /** The commands that apply right now, captured when the palette opened. */
  commands: readonly PaletteCommand[];
  /** `null`: closed without running anything. */
  onClose: (run: CommandId | null) => void;
}

/**
 * The command palette (S40.5): a glass sheet with one search field over the list of commands that apply now. It is
 * a modal dialog on the shared sheet frame (S50.1: focus stays in the field, Escape or a click outside closes it and
 * focus goes back to where it was; a sheet under it blurs and dims); the field is a combobox whose active option follows ↑/↓, and Enter runs it. Typing in Chinese through an
 * input method never runs anything mid-composition. Only commands that can run are listed — nothing pretends.
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const titleId = useId();
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const entries: PaletteEntry[] = useMemo(() => paletteEntriesOf(commands, t, locale), [commands, t, locale]);
  const matches = useMemo(() => searchPalette(entries, query), [entries, query]);
  const checkedOf = useMemo(() => new Map(commands.map((c) => [c.id, c.checked])), [commands]);
  const active = matches.length === 0 ? -1 : Math.min(selected, matches.length - 1);

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
      setSelected(moveSelection(active, matches.length, event.key));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const match = matches[active];
      if (match) onClose(match.entry.id);
    } else if (event.key === 'Tab') {
      event.preventDefault(); // the field is the only stop in the sheet
    }
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
      onSheetMouseDown={(event) => {
        // Clicking the sheet's padding or footer keeps the keyboard in the search field.
        if (event.target !== input.current) event.preventDefault();
      }}
    >
      <h2 className="sr-only" id={titleId}>
        {t('palette.title')}
      </h2>
      <div className="palette-search">
        <SearchIcon size={16} />
        <label className="sr-only" htmlFor={`${listId}-input`}>
          {t('palette.label')}
        </label>
        <input
          ref={input}
          id={`${listId}-input`}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('palette.placeholder')}
          value={query}
          data-testid="palette-input"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {matches.length > 0 ? (
        <ul ref={list} id={listId} className="palette-list" role="listbox" aria-label={t('palette.results')}>
          {matches.map((match, index) => {
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
                    <span className="palette-other">
                      {t('palette.other').replace('{label}', match.entry.otherLabel)}
                    </span>
                  )}
                </span>
                {match.entry.shortcut && <kbd className="kbd">{match.entry.shortcut}</kbd>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="palette-empty" data-testid="palette-empty">
          {t('palette.empty')}
        </p>
      )}
      <p className="palette-footer">
        <span role="status" aria-live="polite" data-testid="palette-count">
          {t('palette.count').replace('{n}', String(matches.length))}
        </span>
        <span aria-hidden="true">{t('palette.keys')}</span>
      </p>
    </SheetFrame>
  );
}
