import { lazy, Suspense, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { SAMPLE_HTML } from '../editor/sample';
import { languageForPath } from '../editor/language';
import { activeTab, type DocumentState } from './document-state';
import { isUnsaved } from './save-machine';
import { TabBar } from './TabBar';
import { MinusIcon, PlusIcon, WarningIcon } from './icons';

// Monaco is large; load it as its own chunk so the shell paints first.
const CodeEditor = lazy(() => import('../editor/CodeEditor').then((m) => ({ default: m.CodeEditor })));

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

export function saveErrorKey(code: string): MessageKey {
  switch (code) {
    case 'permission-denied':
      return 'save.error.permission';
    case 'busy':
      return 'save.error.busy';
    case 'disk-full':
      return 'save.error.diskFull';
    case 'not-found':
      return 'save.error.notFound';
    default:
      return 'save.error.generic';
  }
}

export function EditorPane(props: EditorPaneProps) {
  const { hidden, state, fontSize, onZoom, copyNotice } = props;
  const { t } = useI18n();
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  const { project, docError, tabs } = state;
  const tab = activeTab(state);
  const saveError = tab && tab.save.error && isUnsaved(tab.save) ? tab.save.error : null;
  const notice = copyNotice && tab && copyNotice.relPath === tab.relPath ? copyNotice : null;
  const editorFile = tab
    ? { uri: tab.uri, language: languageForPath(tab.relPath), initialValue: tab.content.text, eol: tab.content.eol }
    : !project
      ? { uri: 'inmemory://noobide/welcome.html', language: 'html', initialValue: SAMPLE_HTML }
      : null;

  return (
    // Hidden, not unmounted, in the narrow Preview view: the buffer and cursor survive switching back.
    <main className="region panel editor" aria-label={t('region.editor')} data-testid="region-editor" hidden={hidden}>
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
        <div className="zoom" role="group" aria-label={t('zoom.label')} data-testid="zoom">
          <button
            type="button"
            className="icon-button"
            aria-label={t('zoom.out')}
            title={t('zoom.out')}
            data-testid="zoom-out"
            onClick={() => onZoom(-1)}
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            className="quiet-button zoom-reset"
            aria-label={`${t('zoom.reset')} (${fontSize})`}
            title={t('zoom.reset')}
            data-testid="zoom-reset"
            onClick={() => onZoom(0)}
          >
            {fontSize}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('zoom.in')}
            title={t('zoom.in')}
            data-testid="zoom-in"
            onClick={() => onZoom(1)}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      {docError && (
        <p className="inline-alert" role="alert" data-testid="open-error">
          <WarningIcon />
          {docError.relPath}: {t(openErrorKey(docError.code))}
        </p>
      )}
      {saveError && tab && (
        <div className="inline-alert save-alert" role="alert" data-testid="save-error">
          <WarningIcon size={15} />
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
                {notice.path !== null
                  ? `${t('save.copySaved')} ${notice.path}`
                  : `${t('save.copyFailed')} ${notice.code ?? ''} ${notice.message ?? ''}`}
              </span>
            )}
          </div>
        </div>
      )}
      {tab?.content.mixedEol && (
        <p className="inline-alert" role="note" data-testid="mixed-eol">
          <WarningIcon />
          {t(tab.content.eol === '\r\n' ? 'editor.mixedEol.crlf' : 'editor.mixedEol.lf')}
        </p>
      )}
      {editorFile ? (
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
              onCursor={(line, column) => setCursor({ line, column })}
            />
          </Suspense>
        </div>
      ) : (
        <div className="empty-state" data-testid="editor-empty">
          <p className="empty-detail">{t('editor.pickFile')}</p>
        </div>
      )}
      {editorFile && cursor && (
        <div className="editor-status" data-testid="cursor-position">
          {`${t('editor.line')} ${cursor.line}, ${t('editor.column')} ${cursor.column}`}
        </div>
      )}
    </main>
  );
}
