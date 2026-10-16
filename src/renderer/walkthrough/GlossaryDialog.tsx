import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { useModalKeys, useReturnFocus } from '../workbench/focus-trap';
import { filterGlossary, glossaryId } from './lessons';
import './walkthrough.css';

export interface GlossaryDialogProps {
  /** The standard term to show first (from a walkthrough link), or null for the whole list. */
  readonly initialTerm: string | null;
  onClose(): void;
}

/**
 * The terminology glossary (S23.4, resources/lessons/glossary.json). Every entry shows the standard term verbatim —
 * the word tutorials and error messages use — with the localized name and a short explanation. A modal dialog: focus
 * stays inside, Escape closes it, and the term it was opened for is scrolled to, focused and marked as current.
 */
export function GlossaryDialog({ initialTerm, onClose }: GlossaryDialogProps) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useModalKeys(dialogRef, onClose);
  useReturnFocus();
  const entries = filterGlossary(query);

  useEffect(() => {
    const target = initialTerm ? document.getElementById(glossaryId(initialTerm)) : null;
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
      target.focus();
    } else searchRef.current?.focus();
  }, [initialTerm]);

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog glossary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="glossary"
      >
        <h2 className="dialog-title" id={titleId}>
          {t('glossary.title')}
        </h2>
        <p className="dialog-hint">{t('glossary.intro')}</p>
        <input
          ref={searchRef}
          type="search"
          className="text-field glossary-search"
          aria-label={t('glossary.search')}
          placeholder={t('glossary.search')}
          data-testid="glossary-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {entries.length === 0 && (
          <p className="dialog-hint" data-testid="glossary-empty">
            {t('glossary.empty')}
          </p>
        )}
        <ul className="glossary-list" data-testid="glossary-list">
          {entries.map((entry) => (
            <li
              key={entry.term}
              id={glossaryId(entry.term)}
              className="glossary-entry"
              tabIndex={-1}
              aria-current={entry.term === initialTerm ? 'true' : undefined}
              data-testid="glossary-entry"
              data-term={entry.term}
            >
              <h3 className="glossary-term">
                <code data-testid="glossary-term">{entry.term}</code>
                {entry[locale].name !== entry.term && <span className="glossary-name">{entry[locale].name}</span>}
              </h3>
              <p className="glossary-text">{entry[locale].text}</p>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" data-testid="glossary-close" onClick={onClose}>
            {t('glossary.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
