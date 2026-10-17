import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { NoobideApi, TreeEntry } from '../../shared/ipc/contract';
import { fill } from './file-op-messages';
import { trapTab } from './focus-trap';
import { isImeKey } from './ime';
import { filterFolders, moveRefusal, type MoveSource } from './move-model';
import { TreeFolderIcon } from './icons';

/** Folders the dialog lists at most (breadth first), and how deep it looks. */
export const MOVE_DIALOG_LIMITS = { maxFolders: 1000, maxDepth: 12 } as const;

interface MoveDialogProps {
  projectId: string;
  projectName: string;
  sources: readonly MoveSource[];
  /** The single entry's name for the title; null for a selection of several. */
  name: string | null;
  listDir: NoobideApi['workspace']['listDir'];
  onMove(folder: string): void;
  onCancel(): void;
}

/**
 * "Move to…" (S52.1): a modal list of the project's folders with a filter field (combobox + listbox pattern).
 * Up/Down/Home/End choose, Enter moves, Escape cancels, Tab stays inside. Folders the selection cannot go into
 * (itself, a folder below it, the folder it is already in) stay listed but are disabled, with the reason as text.
 */
export function MoveDialog({ projectId, projectName, sources, name, listDir, onMove, onCancel }: MoveDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const listId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [folders, setFolders] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  useEffect(() => input.current?.focus(), []);

  // Lists the folders breadth first with the tree's own listing (same filters: no dotfolders, links not followed).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: string[] = [''];
      let level = [''];
      for (let depth = 0; depth < MOVE_DIALOG_LIMITS.maxDepth && level.length > 0; depth += 1) {
        const next: string[] = [];
        for (const folder of level) {
          const result = await listDir({ projectId, relPath: folder }).catch(() => null);
          if (cancelled) return;
          if (!result?.ok) continue;
          for (const entry of result.value.entries as readonly TreeEntry[]) {
            if (entry.kind !== 'directory' || entry.unportable || entry.isLink) continue;
            if (found.length >= MOVE_DIALOG_LIMITS.maxFolders) {
              setTruncated(true);
              break;
            }
            found.push(entry.relPath);
            next.push(entry.relPath);
          }
        }
        level = next;
      }
      if (!cancelled) setFolders(found.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))));
    })();
    return () => {
      cancelled = true;
    };
  }, [listDir, projectId]);

  const shown = useMemo(() => filterFolders(folders ?? [], query), [folders, query]);
  const refusals = useMemo(() => shown.map((folder) => moveRefusal(sources, folder)), [shown, sources]);
  const active = Math.min(selected, shown.length - 1);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const label = (folder: string) => (folder === '' ? fill(t('move.root'), { name: projectName }) : folder);

  const choose = (index: number) => {
    const folder = shown[index];
    if (folder !== undefined && refusals[index] === null) onMove(folder);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (isImeKey(event.nativeEvent)) return;
    const move = (to: number) => setSelected(Math.max(0, Math.min(shown.length - 1, to)));
    switch (event.key) {
      case 'ArrowDown':
        move(active + 1);
        break;
      case 'ArrowUp':
        move(active - 1);
        break;
      case 'Home':
        if (event.target !== input.current) move(0);
        else return;
        break;
      case 'End':
        if (event.target !== input.current) move(shown.length - 1);
        else return;
        break;
      case 'Enter':
        choose(active);
        break;
      case 'Escape':
        onCancel();
        break;
      case 'Tab':
        trapTab(event, dialog.current);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  });

  const activeRefusal = refusals[active] ?? 'same-folder';
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        ref={dialog}
        className="dialog move-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="move-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 className="dialog-title" id={titleId}>
          {name === null ? fill(t('move.titleMany'), { n: String(sources.length) }) : fill(t('move.title'), { name })}
        </h2>
        <label className="sr-only" htmlFor={`${listId}-input`}>
          {t('move.filter')}
        </label>
        <input
          ref={input}
          id={`${listId}-input`}
          className="palette-input move-filter"
          type="text"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown.length > 0 ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('move.filterPlaceholder')}
          value={query}
          data-testid="move-filter"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
        />
        {folders === null ? (
          <p className="dialog-hint" role="status">
            {t('move.loading')}
          </p>
        ) : shown.length === 0 ? (
          <p className="dialog-hint" role="status">
            {t('move.none')}
          </p>
        ) : (
          <ul id={listId} className="palette-list move-list" role="listbox" aria-label={t('move.folders')}>
            {shown.map((folder, index) => {
              const refusal = refusals[index];
              const reason = refusal === 'into-itself' ? t('op.intoItself') : refusal ? t('move.sameFolder') : '';
              return (
                <li
                  key={folder}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={refusal !== null || undefined}
                  className="palette-option move-option"
                  data-testid="move-option"
                  data-folder={folder}
                  onMouseMove={() => index !== active && setSelected(index)}
                  onClick={() => choose(index)}
                >
                  <TreeFolderIcon open={false} />
                  <span className="palette-text">
                    <span className="palette-label">{label(folder)}</span>
                    {reason && <span className="palette-other">{reason}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {truncated && <p className="dialog-hint">{t('move.truncated')}</p>}
        <p className="dialog-hint" aria-hidden="true">
          {t('move.keys')}
        </p>
        <div className="dialog-actions">
          <button type="button" className="quiet-button dialog-button" onClick={onCancel}>
            {t('move.cancel')}
          </button>
          <button
            type="button"
            className="primary-button dialog-button"
            data-testid="move-confirm"
            disabled={shown.length === 0 || activeRefusal !== null}
            onClick={() => choose(active)}
          >
            {t('move.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
