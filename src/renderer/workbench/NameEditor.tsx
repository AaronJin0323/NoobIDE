import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { nameProblemMessage } from './file-op-messages';
import { WarningIcon } from './icons';

interface NameEditorProps {
  label: string;
  initialName: string;
  /** Explanation from the last attempt (main refused it); shown until the name changes. */
  error: string | null;
  onCommit: (name: string) => void;
  /** `blur`: focus already moved elsewhere and stays there; `escape`: focus returns to the tree. */
  onCancel: (reason: 'escape' | 'blur') => void;
}

/**
 * Inline name field for create and rename (S08.2). Problems with the name are explained while typing (the Windows
 * and macOS rules apply on every platform); Enter commits, Escape or leaving the field cancels — nothing is changed
 * on disk until Enter.
 */
export function NameEditor({ label, initialName, error, onCommit, onCancel }: NameEditorProps) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);
  const [shownError, setShownError] = useState(error);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const hintId = useId();

  useEffect(() => setShownError(error), [error]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, so typing replaces "page" in "page.html".
    const dot = initialName.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initialName.length);
  }, [initialName]);

  const problem = touched ? nameProblemMessage(t, name) : null;
  const message = problem ?? shownError;
  return (
    <span className="name-editor">
      <input
        ref={input}
        className="name-input"
        aria-label={label}
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? errorId : hintId}
        data-testid="name-input"
        value={name}
        spellCheck={false}
        onChange={(event) => {
          setName(event.target.value);
          setTouched(true);
          setShownError(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation(); // the tree's arrow, F2 and Delete keys do not apply while typing a name
          if (event.key === 'Enter') {
            event.preventDefault();
            setTouched(true);
            if (nameProblemMessage(t, name) === null) onCommit(name);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel('escape');
          }
        }}
        onBlur={(event) => {
          // Clicking the explanation keeps the field; leaving the editor cancels.
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) onCancel('blur');
        }}
        onClick={(event) => event.stopPropagation()}
      />
      {message ? (
        <span className="name-error" id={errorId} role="alert" data-testid="name-error">
          <WarningIcon />
          {message}
        </span>
      ) : (
        <span className="name-hint" id={hintId}>
          {t('files.nameHint')}
        </span>
      )}
    </span>
  );
}
