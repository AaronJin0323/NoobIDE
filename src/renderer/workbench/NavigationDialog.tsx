import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { useModalKeys } from './focus-trap';
import type { NavLocation } from '../editor/js-navigation';

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
 * or why there is nothing to show. Enter or a click opens the place; Escape closes; Tab stays inside.
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
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useModalKeys(dialog, onClose);
  useEffect(() => first.current?.focus(), [view]);
  const title =
    view.kind === 'list'
      ? fill(t(view.title), { name: view.name, count: String(view.locations.length) })
      : fill(t(view.message), { name: view.name });

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="dialog navigation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="navigation-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title" id={titleId}>
          {view.kind === 'list' ? title : t(view.heading)}
        </h2>
        <div className="dialog-body">
          {view.kind === 'notice' ? (
            <p data-testid="navigation-notice">{title}</p>
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
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet-button dialog-button"
            ref={view.kind === 'notice' ? first : undefined}
            onClick={onClose}
          >
            {t('nav.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
