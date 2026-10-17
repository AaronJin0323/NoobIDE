import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { CommandId } from '../../shared/commands';
import { paletteEntriesOf, type PaletteCommand } from '../commands/CommandPalette';
import { moveSelection, searchPalette, type MatchEntry } from '../commands/palette-model';
import type { Locale, MessageKey } from '../i18n/index';
import { isImeKey } from '../workbench/ime';
import { acceptablePath, findTrigger, replaceTrigger, type Trigger } from './composer-triggers';

/** S48.4: where the composer's `/` and `@` lists come from (the workbench supplies them). */
export interface ComposerSources {
  /** The registry's commands that can run right now (the palette's list). */
  commands(): readonly PaletteCommand[];
  runCommand(id: CommandId): void;
  /** Project-relative paths of the open project's files (project-files.ts). */
  projectFiles(): Promise<readonly string[]>;
}

/** How many suggestions are shown at once; typing narrows the rest. */
const MAX_SHOWN = 50;

type Suggestion =
  | {
      readonly kind: 'command';
      readonly key: string;
      readonly id: CommandId;
      readonly label: string;
      readonly detail: string | null;
      readonly shortcut: string | null;
    }
  | {
      readonly kind: 'file';
      readonly key: string;
      readonly relPath: string;
      readonly label: string;
      readonly detail: string;
    };

interface FileEntry extends MatchEntry {
  readonly relPath: string;
}

function fileEntry(relPath: string): FileEntry {
  const slash = relPath.lastIndexOf('/');
  return { relPath, label: relPath.slice(slash + 1), otherLabel: relPath };
}

/**
 * S48.4: slash commands and @file mentions in the chat composer. The textarea stays a textbox: while a list is open
 * it points at the list (aria-controls) and its active option (aria-activedescendant), ↑/↓ wrap, Enter or Tab
 * accept and Escape closes only the list (the panel stays). Keys an input method is composing never reach the list.
 */
export function useComposerSuggestions(options: {
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly input: RefObject<HTMLTextAreaElement | null>;
  readonly sources: ComposerSources | undefined;
  /** An accepted @file becomes a file context chip. */
  readonly addFile: (relPath: string) => void;
  /** Files can be mentioned only with an open project. */
  readonly projectId: string | null;
  readonly t: (key: MessageKey) => string;
  readonly locale: Locale;
}) {
  const { prompt, setPrompt, input, sources, addFile, projectId, t, locale } = options;
  const [caret, setCaret] = useState(prompt.length);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(0);
  const [commands, setCommands] = useState<readonly PaletteCommand[]>([]);
  const [files, setFiles] = useState<{ readonly projectId: string; readonly paths: readonly string[] } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const found = findTrigger(prompt, caret);
  const trigger: Trigger | null =
    found &&
    focused &&
    found.start !== dismissed &&
    sources !== undefined &&
    (found.kind === 'command' || projectId !== null)
      ? found
      : null;
  const kind = trigger?.kind ?? null;
  const start = trigger?.start ?? -1;
  const query = trigger?.query ?? '';

  // A list opens with what applies at that moment (like the palette): the runnable commands, the project's files.
  useEffect(() => {
    setSelected(0);
    if (!sources || kind === null) return undefined;
    if (kind === 'command') {
      setCommands(sources.commands());
      return undefined;
    }
    if (projectId === null) return undefined;
    let live = true;
    void sources.projectFiles().then(
      (paths) => live && setFiles({ projectId, paths }),
      () => live && setFiles({ projectId, paths: [] }),
    );
    return () => {
      live = false;
    };
  }, [kind, start, sources, projectId]);

  // Another word (or none) under the caret: an Escape-closed list may open again.
  useEffect(() => {
    if (found?.start !== dismissed) setDismissed(null);
  }, [found?.start, dismissed]);

  // After an accept, the caret goes right after what was inserted (the controlled value moved it to the end).
  useEffect(() => {
    const at = pendingCaret.current;
    const area = input.current;
    if (at === null || !area) return;
    pendingCaret.current = null;
    area.setSelectionRange(at, at);
  }, [prompt, input]);

  const commandEntries = useMemo(() => paletteEntriesOf(commands, t, locale), [commands, t, locale]);
  const fileEntries = useMemo(
    () => (files && files.projectId === projectId ? files.paths.filter(acceptablePath).map(fileEntry) : null),
    [files, projectId],
  );

  const suggestions: Suggestion[] = useMemo(() => {
    if (kind === null) return [];
    if (kind === 'command') {
      return searchPalette(commandEntries, query)
        .slice(0, MAX_SHOWN)
        .map(({ entry, viaOther }) => ({
          kind: 'command',
          key: entry.id,
          id: entry.id,
          label: entry.label,
          detail: viaOther ? entry.otherLabel : null,
          shortcut: entry.shortcut,
        }));
    }
    return searchPalette(fileEntries ?? [], query)
      .slice(0, MAX_SHOWN)
      .map(({ entry }) => {
        const folder = entry.relPath.slice(0, Math.max(0, entry.relPath.length - entry.label.length - 1));
        return {
          kind: 'file',
          key: entry.relPath,
          relPath: entry.relPath,
          label: entry.label,
          detail: folder || t('ai.composer.folderRoot'),
        };
      });
  }, [kind, query, commandEntries, fileEntries, t]);

  const active = suggestions.length === 0 ? -1 : Math.min(selected, suggestions.length - 1);
  const loading = trigger?.kind === 'file' && fileEntries === null;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const accept = (suggestion: Suggestion) => {
    if (!trigger) return;
    if (suggestion.kind === 'command') {
      const next = replaceTrigger(prompt, trigger, '');
      pendingCaret.current = next.caret;
      setCaret(next.caret);
      setPrompt(next.text);
      sources?.runCommand(suggestion.id);
    } else {
      const next = replaceTrigger(prompt, trigger, suggestion.relPath);
      pendingCaret.current = next.caret;
      setCaret(next.caret);
      setPrompt(next.text);
      addFile(suggestion.relPath);
    }
  };

  /** True when the key belonged to the open list (the caller then does nothing else with it). */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!trigger || isImeKey(event.nativeEvent)) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation(); // closes the list, never the panel or a dialog around it
      setDismissed(trigger.start);
      return true;
    }
    if (suggestions.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(moveSelection(active, suggestions.length, event.key));
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault();
      const suggestion = suggestions[active];
      if (suggestion) accept(suggestion);
      return true;
    }
    return false;
  };

  const trackCaret = (area: HTMLTextAreaElement) => {
    if (area.selectionStart === area.selectionEnd) setCaret(area.selectionStart);
    else setCaret(-1); // a selection: no trigger
  };

  const open = trigger !== null;
  const inputProps = open
    ? {
        'aria-autocomplete': 'list' as const,
        'aria-controls': listId,
        ...(active >= 0 ? { 'aria-activedescendant': optionId(active) } : {}),
      }
    : {};

  const list = open ? (
    <div className="ai-suggest" data-testid="ai-suggest" data-kind={trigger.kind}>
      {suggestions.length > 0 ? (
        <ul
          id={listId}
          className="ai-suggest-list"
          role="listbox"
          aria-label={t(trigger.kind === 'command' ? 'ai.composer.commands' : 'ai.composer.files')}
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.key}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className="ai-suggest-option"
              data-testid="ai-suggest-option"
              data-value={suggestion.kind === 'command' ? suggestion.id : suggestion.relPath}
              // Keeps the keyboard in the composer.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== active && setSelected(index)}
              onClick={() => accept(suggestion)}
            >
              <span className="ai-suggest-sigil" aria-hidden="true">
                {suggestion.kind === 'command' ? '/' : '@'}
              </span>
              <span className="ai-suggest-text">
                <span className="ai-suggest-label">{suggestion.label}</span>
                {suggestion.detail && <span className="ai-suggest-detail">{suggestion.detail}</span>}
              </span>
              {suggestion.kind === 'command' && suggestion.shortcut && <kbd className="kbd">{suggestion.shortcut}</kbd>}
            </li>
          ))}
        </ul>
      ) : (
        <p id={listId} className="ai-suggest-empty" role="status" data-testid="ai-suggest-empty">
          {t(
            loading
              ? 'ai.composer.loadingFiles'
              : trigger.kind === 'command'
                ? 'ai.composer.noCommands'
                : 'ai.composer.noFiles',
          )}
        </p>
      )}
      <p className="ai-suggest-hint">{t('ai.composer.listHint')}</p>
    </div>
  ) : null;

  const focusProps = {
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };

  return { open, list, inputProps, focusProps, onKeyDown, trackCaret };
}
