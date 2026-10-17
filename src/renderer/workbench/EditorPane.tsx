import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { SAMPLE_HTML } from '../editor/sample';
import { languageForPath } from '../editor/language';
import { activeTab, type DocumentState } from './document-state';
import { isUnsaved } from './save-machine';
import { TabBar } from './TabBar';
import { isSameOrBelow } from './file-tree-model';
import { HistoryIcon, MinusIcon, PlusIcon, WarningIcon } from './icons';
import { EditorTools } from './EditorTools';
import { FileRoleHint } from './FileRole';
// S11: external changes
import { DiskStateBanner, type DiskActions } from './DiskStateBanner';
import { fill } from '../recovery/format';
// S18.3: format command (button + Monaco's Shift+Alt+F / ⇧⌥F) on the editor handle, without importing Monaco here.
import { activeEditor } from '../editor/editor-handle';
import { withShortcut } from '../commands/useCommands'; // S24.1
import { formatShortcutLabel } from '../../platform/labels';
import { saveErrorKey } from './file-op-messages';
import { publishCursor } from './editor-status-state'; // S47.5: the caret shows in the global status strip

const FORMATTABLE = new Set(['html', 'css', 'javascript']);

// Monaco is large; load it as its own chunk so the shell paints first.
const CodeEditor = lazy(() => import('../editor/CodeEditor').then((m) => ({ default: m.CodeEditor })));
const ConflictDiff = lazy(() => import('../editor/ConflictDiff').then((m) => ({ default: m.ConflictDiff })));

export interface SaveCopyNotice {
  readonly relPath: string;
  /** Where the copy went, or `null` while the last attempt failed. */
  readonly path: string | null;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

interface EditorPaneProps {
  hidden: boolean;
  state: DocumentState;
  fontSize: number;
  onZoom: (step: 1 | -1 | 0) => void;
  onActivate: (relPath: string) => void;
  onClose: (relPath: string) => void;
  onChange: (uri: string, text: string) => void;
  onSave: () => void;
  onBlur: (uri: string) => void;
  onComposition: (uri: string, composing: boolean) => void;
  onRetry: () => void;
  /** Absent when the bridge offers no save dialog. */
  onSaveCopy: (() => void) | undefined;
  copyNotice: SaveCopyNotice | null;
  /** Present after a window close was refused because of this failure (S10.6). */
  onCloseDiscarding: (() => void) | undefined;
  /** Paths being renamed, moved or trashed: their tabs are read-only meanwhile, so no edit can get lost. */
  lockedPaths: readonly string[];
  /** S11: choices for files changed or deleted outside NoobIDE. */
  diskActions?: DiskActions | undefined;
  /** S11.3: relPath of a deleted file whose tab waits for "close without keeping" to be confirmed. */
  confirmCloseDeleted?: string | null | undefined;
  /** S20.2: the welcome screen, shown above the sample while no project is open. */
  welcome?: ReactNode;
  /** S21.3: opens the local history of the active file. */
  onShowHistory?: ((relPath: string) => void) | undefined;
}

function openErrorKey(code: string): MessageKey {
  switch (code) {
    case 'unsupported-encoding':
      return 'editor.error.unsupported';
    case 'too-large':
      return 'editor.error.tooLarge';
    case 'not-found':
      return 'editor.error.notFound';
    default:
      return 'editor.error.generic';
  }
}

export function EditorPane(props: EditorPaneProps) {
  const { hidden, state, fontSize, onZoom, copyNotice } = props;
  const { t } = useI18n();
  const { project, docError, tabs } = state;
  const tab = activeTab(state);
  // S11: a conflict or a deleted file explains itself in the disk banner instead of the generic save error.
  const diskState = tab !== null && (tab.save.conflict || tab.save.deleted);
  const saveError = tab && tab.save.error && isUnsaved(tab.save) && !diskState ? tab.save.error : null;
  // S11.2: the comparison is shown for one file at a time and closes when its conflict ends.
  const [comparingPath, setComparingPath] = useState<string | null>(null);
  useEffect(() => {
    if (comparingPath !== null && !tabs.some((open) => open.relPath === comparingPath && open.save.conflict)) {
      setComparingPath(null);
    }
  }, [comparingPath, tabs]);
  const comparing = tab !== null && comparingPath === tab.relPath && tab.save.conflict && !!tab.conflictDisk;
  const notice = copyNotice && tab && copyNotice.relPath === tab.relPath ? copyNotice : null;
  const editorFile = tab
    ? {
        uri: tab.uri,
        language: languageForPath(tab.relPath),
        initialValue: tab.content.text,
        eol: tab.content.eol,
        readOnly: (tab.content.readOnly ?? false) || props.lockedPaths.some((path) => isSameOrBelow(tab.relPath, path)),
        // S32.1: AI suggestions need to know which project file this is.
        projectId: project?.projectId,
        relPath: tab.relPath,
        encoding: tab.content.encoding,
      }
    : !project
      ? { uri: 'inmemory://noobide/welcome.html', language: 'html', initialValue: SAMPLE_HTML }
      : null;
  // S47.5: no code on screen, no caret in the status strip (the editor publishes the next position when it mounts).
  const hasEditor = editorFile !== null;
  useEffect(() => {
    if (!hasEditor) publishCursor(null);
  }, [hasEditor]);

  return (
    // Hidden, not unmounted, in the narrow Preview view: the buffer and cursor survive switching back.
    <main className="region panel editor" aria-label={t('region.editor')} data-testid="region-editor" hidden={hidden}>
      {!project && props.welcome /* S20.2: welcome screen above the sample */}
      <div className="panel-header tabs-header">
        {project ? (
          <TabBar tabs={tabs} active={state.active} onActivate={props.onActivate} onClose={props.onClose} />
        ) : (
          <div className="tabs" role="tablist" aria-label={t('tabs.label')}>
            <span role="tab" aria-selected="true" className="tab" data-testid="editor-tab">
              {t('editor.welcomeTab')}
            </span>
          </div>
        )}
        {!project && (
          <span className="badge" data-testid="sample-badge">
            {t('editor.sampleBadge')}
          </span>
        )}
        {tab && props.onShowHistory && (
          <button
            type="button"
            className="quiet-button history-button"
            title={t('history.openFor')}
            aria-haspopup="dialog"
            data-testid="show-history"
            onClick={() => props.onShowHistory?.(tab.relPath)}
          >
            <HistoryIcon size={16} />
            {/* In a narrow editor only the icon shows (styles.css); the name stays the same. */}
            <span className="history-label">{t('history.open')}</span>
          </button>
        )}
        {/* Format and the code font size sit behind "Editor options", so the tabs keep the header's width. */}
        <EditorTools>
          {(close) => (
            <>
              {/* S18.3: format the file on screen (hidden for read-only files and other languages) */}
              {editorFile && tab && !editorFile.readOnly && FORMATTABLE.has(editorFile.language) && (
                <button
                  type="button"
                  className="quiet-button"
                  title={t('format.title').replace(
                    '{shortcut}',
                    formatShortcutLabel(window.noobide?.platform ?? 'other'),
                  )}
                  data-testid="format-document"
                  onClick={() => {
                    close();
                    void activeEditor()?.formatDocument();
                  }}
                >
                  {t('format.button')}
                </button>
              )}
              <ZoomGroup fontSize={fontSize} onZoom={onZoom} />
            </>
          )}
        </EditorTools>
      </div>
      {/* S47.5: the only persistent band above the code, and only on a file's first showing; the encoding and
          line-ending notes live in the status strip (EditorStatusStrip). The alerts below are states, not bands. */}
      {tab && <FileRoleHint relPath={tab.relPath} projectId={project?.projectId ?? null} />}
      {docError && (
        <p className="inline-alert" role="alert" data-testid="open-error">
          <WarningIcon />
          {docError.relPath}: {t(openErrorKey(docError.code))}
        </p>
      )}
      {saveError && tab && (
        <div className="inline-alert save-alert" role="alert" data-testid="save-error">
          <WarningIcon size={16} />
          <div className="save-alert-body">
            <strong>
              {tab.relPath}: {t(saveErrorKey(saveError.code))}
            </strong>{' '}
            {t('save.kept')}
            <span className="alert-detail">
              {t('error.detail')}: {saveError.message}
            </span>
            <span className="alert-actions">
              <button type="button" className="secondary-button" data-testid="save-retry" onClick={props.onRetry}>
                {t('save.retry')}
              </button>
              {props.onSaveCopy && (
                <button type="button" className="secondary-button" data-testid="save-copy" onClick={props.onSaveCopy}>
                  {t('save.elsewhere')}
                </button>
              )}
              {props.onCloseDiscarding && (
                <button
                  type="button"
                  className="secondary-button"
                  data-testid="close-discarding"
                  onClick={props.onCloseDiscarding}
                >
                  {t('save.closeDiscarding')}
                </button>
              )}
            </span>
            {notice && (
              <span className="alert-detail" data-testid="save-copy-notice" role="status">
                {notice.path !== null ? (
                  `${t('save.copySaved')} ${notice.path}`
                ) : (
                  // The explanation first; the system's own message only as secondary detail.
                  <>
                    {`${t('save.copyFailed')} ${t(saveErrorKey(notice.code ?? ''))}`}
                    {notice.message && <small>{` ${t('error.detail')}: ${notice.message}`}</small>}
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      )}
      {tab && props.diskActions && (
        <DiskStateBanner
          tab={tab}
          actions={props.diskActions}
          confirmClose={props.confirmCloseDeleted === tab.relPath}
          comparing={comparing}
          onToggleCompare={() => setComparingPath(comparing ? null : tab.relPath)}
          onSaveCopy={props.onSaveCopy}
          onCloseDiscarding={props.onCloseDiscarding}
        />
      )}
      {comparing && tab?.conflictDisk ? (
        <div className="editor-surface" id="editor-surface" role="tabpanel">
          <Suspense fallback={<p className="placeholder">{t('editor.loading')}</p>}>
            <ConflictDiff
              uri={tab.uri}
              language={languageForPath(tab.relPath)}
              diskText={tab.conflictDisk.text}
              ariaLabel={`${t('conflict.diffLabel')}: ${tab.relPath}`}
              summary={(d) =>
                d.identical
                  ? t('conflict.identical')
                  : fill(t('conflict.summary'), { added: d.added, removed: d.removed })
              }
            />
          </Suspense>
        </div>
      ) : editorFile ? (
        <div className="editor-surface" id="editor-surface" role="tabpanel">
          <Suspense fallback={<p className="placeholder">{t('editor.loading')}</p>}>
            <CodeEditor
              file={editorFile}
              ariaLabel={tab ? `${t('region.editor')}: ${tab.relPath}` : t('region.editor')}
              fontSize={fontSize}
              onChange={tab ? props.onChange : undefined}
              onSave={tab ? props.onSave : undefined}
              onBlur={tab ? props.onBlur : undefined}
              onComposition={tab ? props.onComposition : undefined}
              onCursor={(line, column) => publishCursor({ line, column })}
            />
          </Suspense>
        </div>
      ) : (
        <div className="empty-state" data-testid="editor-empty">
          <p className="empty-detail">{t('editor.pickFile')}</p>
        </div>
      )}
    </main>
  );
}

/** The code font size: smaller, back to the default (shows the size), larger (S13.1 / S24.1 shortcuts in the titles). */
function ZoomGroup({ fontSize, onZoom }: { fontSize: number; onZoom: (step: 1 | -1 | 0) => void }) {
  const { t } = useI18n();
  return (
    <div className="zoom" role="group" aria-label={t('zoom.label')} data-testid="zoom">
      <button
        type="button"
        className="icon-button"
        aria-label={t('zoom.out')}
        title={withShortcut(t('zoom.out'), 'zoom-out', window.noobide?.platform ?? 'other')}
        data-testid="zoom-out"
        onClick={() => onZoom(-1)}
      >
        <MinusIcon />
      </button>
      <button
        type="button"
        className="quiet-button zoom-reset"
        aria-label={`${t('zoom.reset')} (${fontSize})`}
        title={withShortcut(t('zoom.reset'), 'zoom-reset', window.noobide?.platform ?? 'other')}
        data-testid="zoom-reset"
        onClick={() => onZoom(0)}
      >
        {fontSize}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t('zoom.in')}
        title={withShortcut(t('zoom.in'), 'zoom-in', window.noobide?.platform ?? 'other')}
        data-testid="zoom-in"
        onClick={() => onZoom(1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
