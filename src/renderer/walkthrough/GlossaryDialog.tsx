import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { Sheet } from '../workbench/Sheet';
import { filterGlossary, glossaryId } from './lessons';
import './walkthrough.css';

export interface GlossaryDialogProps {
  /** The standard term to show first (from a walkthrough link), or null for the whole list. */
  readonly initialTerm: string | null;
  onClose(): void;
}

/**
 * The terminology glossary (S23.4, resources/lessons/glossary.json) on the shared Sheet (S49.1). Every entry shows
 * the standard term verbatim — the word tutorials and error messages use — with the localized name and a short
 * explanation. Focus stays inside, Escape or Close dismisses it, and the term it was opened for is scrolled to,
 * focused and marked as current; otherwise the search field takes focus.
 */
export function GlossaryDialog({ initialTerm, onClose }: GlossaryDialogProps) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const entries = filterGlossary(query);

  useEffect(() => {
    const target = initialTerm ? document.getElementById(glossaryId(initialTerm)) : null;
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
      target.focus();
    } else searchRef.current?.focus();
  }, [initialTerm]);

  return (
    <Sheet
      title={t('glossary.title')}
      description={t('glossary.intro')}
      width={720}
      className="glossary-dialog"
      onClose={onClose}
      closeLabel={t('glossary.close')}
      testId="glossary"
      closeTestId="glossary-close"
    >
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
    </Sheet>
  );
}
