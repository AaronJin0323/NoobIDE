import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import {
  convertIndentation,
  setIndentOverride,
  shownIndent,
  subscribeIndent,
  type ShownIndent,
} from '../editor/indent-state';
import type { IndentSource } from '../editor/indent-detect';
import { TreeContextMenu, type MenuItem } from './TreeContextMenu';

const SOURCE_KEY: Record<IndentSource, MessageKey> = {
  detected: 'smartEdit.indent.source.detected',
  project: 'smartEdit.indent.source.project',
  default: 'smartEdit.indent.source.default',
  override: 'smartEdit.indent.source.override',
};

/** Height of one menu row plus padding (TreeContextMenu's own estimate), to open the menu above the status bar. */
const ROW = 34;

/**
 * The status button's accessible name: everything the button shows, including the mixed tabs/spaces warning, so a
 * screen reader user hears it too (the visible text alone is overridden by aria-label).
 */
export function indentButtonLabel(
  t: (key: MessageKey) => string,
  indent: Pick<ShownIndent['indent'], 'insertSpaces' | 'tabSize' | 'source' | 'mixed'>,
): string {
  const style = fill(t(indent.insertSpaces ? 'smartEdit.indent.spaces' : 'smartEdit.indent.tabs'), {
    size: indent.tabSize,
  });
  const source = t(SOURCE_KEY[indent.source]);
  return indent.mixed
    ? fill(t('smartEdit.indent.buttonMixed'), { style, source, mixed: t('smartEdit.indent.mixed') })
    : fill(t('smartEdit.indent.button'), { style, source });
}

/**
 * S43.2: the indentation of the file on screen in the status bar — style, width and where it came from, as text — and
 * a keyboard-operable menu to override it, detect it again or convert the file (decision 0032).
 */
export function IndentStatus() {
  const { t } = useI18n();
  const shown: ShownIndent | null = useSyncExternalStore(subscribeIndent, shownIndent);
  const button = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setMenuAt(null);
    if (restoreFocus) button.current?.focus();
  }, []);
  if (!shown) return null;
  const { uri, indent } = shown;
  const style = fill(t(indent.insertSpaces ? 'smartEdit.indent.spaces' : 'smartEdit.indent.tabs'), {
    size: indent.tabSize,
  });
  const source = t(SOURCE_KEY[indent.source]);
  const items: MenuItem[] = [
    {
      id: 'spaces-2',
      label: t('smartEdit.indent.useSpaces2'),
      run: () => setIndentOverride(uri, { insertSpaces: true, tabSize: 2 }),
    },
    {
      id: 'spaces-4',
      label: t('smartEdit.indent.useSpaces4'),
      run: () => setIndentOverride(uri, { insertSpaces: true, tabSize: 4 }),
    },
    {
      id: 'tabs-2',
      label: t('smartEdit.indent.useTabs2'),
      run: () => setIndentOverride(uri, { insertSpaces: false, tabSize: 2 }),
    },
    {
      id: 'tabs-4',
      label: t('smartEdit.indent.useTabs4'),
      run: () => setIndentOverride(uri, { insertSpaces: false, tabSize: 4 }),
    },
    { id: 'detect', label: t('smartEdit.indent.detect'), run: () => setIndentOverride(uri, null) },
    { id: 'convert', label: t('smartEdit.indent.convert'), run: () => convertIndentation(uri) },
  ];
  return (
    <>
      <button
        ref={button}
        type="button"
        className="editor-status-indent"
        data-testid="indent-status"
        data-insert-spaces={indent.insertSpaces}
        data-tab-size={indent.tabSize}
        data-source={indent.source}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        aria-label={indentButtonLabel(t, indent)}
        title={indent.mixed ? `${source} · ${t('smartEdit.indent.mixed')}` : source}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          setMenuAt(rect ? { x: rect.left, y: rect.top - (items.length * ROW + 16) } : { x: 0, y: 0 });
        }}
      >
        {style}
        <span className="editor-status-indent-source">{` · ${source}`}</span>
        {indent.mixed && <span className="editor-status-indent-mixed">{` · ${t('smartEdit.indent.mixed')}`}</span>}
      </button>
      {menuAt && (
        <TreeContextMenu label={t('smartEdit.indent.menu')} items={items} x={menuAt.x} y={menuAt.y} onClose={close} />
      )}
    </>
  );
}
