import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { fill, nameProblemMessage } from './file-op-messages';
import { trapTab } from './focus-trap';
import { isImeKey } from './ime';
import { sameName } from '../../shared/file-names';

interface ImportNameDialogProps {
  /** The name the file would get. */
  name: string;
  /** The entry already there (`exists` / `case-conflict`), or null when the name itself is not valid. */
  existing: string | null;
  /** The folder's name as shown to the user. */
  folder: string;
  /** The name proposed in the field (e.g. "猫 咪 copy.png"). */
  suggestion: string;
  onRename(name: string): void;
  onSkip(): void;
}

/**
 * S52.4: an added file's name is taken (or not valid on Windows and macOS). NoobIDE never replaces the existing
 * entry: the user types another name or skips this file. Enter adds, Escape skips, Tab stays inside.
 */
export function ImportNameDialog({ name, existing, folder, suggestion, onRename, onSkip }: ImportNameDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const inputId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(suggestion);
  const problem = nameProblemMessage(t, value);
  const unchanged = existing !== null && sameName(value, existing, false); // still the name that is taken

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = () => {
    if (!problem && !unchanged) onRename(value);
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="import-name-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (isImeKey(event.nativeEvent)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onSkip();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Tab') trapTab(event, dialog.current);
        }}
      >
        <h2 className="dialog-title" id={titleId}>
          {t('import.conflictTitle')}
        </h2>
        <div className="dialog-body">
          <p>
            {existing === null
              ? fill(t('import.invalidBody'), { name })
              : fill(t('import.conflictBody'), { folder, existing, name })}
          </p>
          <label htmlFor={inputId}>{t('import.newName')}</label>
          <input
            ref={input}
            id={inputId}
            className="palette-input move-filter"
            type="text"
            value={value}
            spellCheck={false}
            aria-invalid={problem !== null || unchanged}
            aria-describedby={problem || unchanged ? `${inputId}-problem` : undefined}
            data-testid="import-name-input"
            onChange={(event) => setValue(event.target.value)}
          />
          {(problem || unchanged) && (
            <p className="dialog-hint" id={`${inputId}-problem`} role="alert">
              {problem ?? t('import.stillTaken')}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button dialog-button" data-testid="import-skip" onClick={onSkip}>
            {t('import.skip')}
          </button>
          <button
            type="button"
            className="primary-button dialog-button"
            data-testid="import-rename"
            disabled={problem !== null || unchanged}
            onClick={submit}
          >
            {t('import.rename')}
          </button>
        </div>
      </div>
    </div>
  );
}
