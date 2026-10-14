import { lazy, Suspense } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { SAMPLE_HTML } from '../editor/sample';
import { languageForPath } from '../editor/language';
import type { DocumentState } from './document-state';
import { WarningIcon } from './icons';
import { FileRoleHint } from './FileRole';

// Monaco is large; load it as its own chunk so the shell paints first.
const CodeEditor = lazy(() => import('../editor/CodeEditor').then((m) => ({ default: m.CodeEditor })));

interface EditorPaneProps {
  hidden: boolean;
  state: DocumentState;
  onChange: (text: string) => void;
  onSave: () => void;
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

export function EditorPane({ hidden, state, onChange, onSave }: EditorPaneProps) {
  const { t } = useI18n();
  const { project, doc, docError, saveError } = state;
  const showSaveError = saveError !== null && state.revision !== state.savedRevision;
  return (
    // Hidden, not unmounted, in the narrow Preview view: the buffer and cursor survive switching back.
    <main className="region panel editor" aria-label={t('region.editor')} data-testid="region-editor" hidden={hidden}>
      <div className="panel-header tabs-header">
        <div className="tabs" role="tablist" aria-label={t('region.editor')}>
          {(doc || !project) && (
            <span role="tab" aria-selected="true" className="tab" data-testid="editor-tab">
              {doc ? doc.relPath : t('editor.welcomeTab')}
            </span>
          )}
        </div>
        {!project && (
          <span className="badge" data-testid="sample-badge">
            {t('editor.sampleBadge')}
          </span>
        )}
      </div>
      {doc && <FileRoleHint relPath={doc.relPath} />}
      {showSaveError && (
        <div className="inline-alert save-alert" role="alert" data-testid="save-error">
          <WarningIcon size={15} />
          <div>
            <strong>{t(saveErrorKey(saveError.code))}</strong> {t('save.kept')}
            <span className="alert-detail">
              {t('error.detail')}: {saveError.message}
            </span>
          </div>
        </div>
      )}
      {doc?.content.readOnly && (
        // S07.4: another encoding — shown read-only so a save can never re-encode (and damage) the file.
        <p className="inline-alert" role="status" data-testid="read-only-notice">
          <WarningIcon />
          <span>
            {t('editor.readOnlyEncoding')} <strong>{doc.content.encoding}</strong>
          </span>
        </p>
      )}
      {doc ? (
        <Suspense fallback={<p className="placeholder">{t('editor.loading')}</p>}>
          <CodeEditor
            uri={doc.content.uri}
            language={languageForPath(doc.relPath)}
            initialValue={doc.content.text}
            eol={doc.content.eol}
            ariaLabel={`${t('region.editor')}: ${doc.relPath}`}
            onChange={onChange}
            onSave={onSave}
            readOnly={doc.content.readOnly ?? false}
          />
        </Suspense>
      ) : project ? (
        <div className="empty-state" data-testid="editor-empty">
          {docError ? (
            <p className="inline-alert" role="alert" data-testid="open-error">
              <WarningIcon />
              {docError.relPath}: {t(openErrorKey(docError.code))}
            </p>
          ) : (
            <p className="empty-detail">{t('editor.pickFile')}</p>
          )}
        </div>
      ) : (
        <Suspense fallback={<p className="placeholder">{t('editor.loading')}</p>}>
          <CodeEditor
            uri="inmemory://noobide/welcome.html"
            language="html"
            initialValue={SAMPLE_HTML}
            ariaLabel={t('region.editor')}
          />
        </Suspense>
      )}
    </main>
  );
}
