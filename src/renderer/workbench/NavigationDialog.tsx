import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { Sheet } from './Sheet';
import type { NavLocation } from '../editor/js-navigation';
import { INDEX_WAIT_MS } from '../editor/project-scripts-registry';

export type NavigationView =
  | {
      readonly kind: 'list';
      readonly title: MessageKey;
      readonly name: string;
      readonly locations: readonly NavLocation[];
    }
  | { readonly kind: 'notice'; readonly heading: MessageKey; readonly message: MessageKey; readonly name: string };

/**
 * S57.1: the places Go to definition or Find all references found (one button each: file, line and the line's code),
 * or why there is nothing to show, on the shared {@link Sheet} (S49.1): Enter or a click opens the place; Escape and
 * Close dismiss it; Tab stays inside. Close is the only way out, so there is no action row.
 */
export function NavigationDialog({
  view,
  onOpen,
  onClose,
}: {
  view: NavigationView;
  onOpen: (location: NavLocation) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const first = useRef<HTMLButtonElement>(null);
  // The first place takes focus (a notice has nothing to focus: the sheet moves focus to Close).
  useEffect(() => first.current?.focus(), [view]);
  const title =
    view.kind === 'list'
      ? fill(t(view.title), { name: view.name, count: String(view.locations.length) })
      : fill(t(view.message), { name: view.name, seconds: String(INDEX_WAIT_MS / 1000) });

  return (
    <Sheet
      title={view.kind === 'list' ? title : t(view.heading)}
      width={720}
      className="navigation-dialog"
      onClose={onClose}
      closeLabel={t('nav.close')}
      dismissOnBackdrop
      testId="navigation-dialog"
      closeTestId="navigation-close"
    >
      {view.kind === 'notice' ? (
        <div className="dialog-body">
          <p data-testid="navigation-notice">{title}</p>
        </div>
      ) : (
        <ul className="navigation-list">
          {view.locations.map((location, i) => (
            <li key={`${location.relPath}:${location.line}:${location.column}`}>
              <button
                type="button"
                ref={i === 0 ? first : undefined}
                className="navigation-item"
                data-testid="navigation-item"
                data-location={`${location.relPath}:${location.line}:${location.column}`}
                onClick={() => onOpen(location)}
              >
                <span className="navigation-file">
                  {fill(t('nav.location'), { file: location.relPath, line: String(location.line) })}
                </span>
                <code className="navigation-code">{location.lineText.trim()}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
