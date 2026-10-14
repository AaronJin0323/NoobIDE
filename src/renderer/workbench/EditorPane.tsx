import { lazy, Suspense } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { SAMPLE_HTML } from '../editor/sample';

// Monaco is large; load it as its own chunk so the shell paints first.
const CodeEditor = lazy(() => import('../editor/CodeEditor').then((m) => ({ default: m.CodeEditor })));

export function EditorPane({ hidden }: { hidden: boolean }) {
  const { t } = useI18n();
  return (
    // Hidden, not unmounted, in the narrow Preview view: the buffer and cursor survive switching back.
    <main className="region panel editor" aria-label={t('region.editor')} data-testid="region-editor" hidden={hidden}>
      <div className="panel-header tabs-header">
        <div className="tabs" role="tablist" aria-label={t('region.editor')}>
          <span role="tab" aria-selected="true" className="tab">
            {t('editor.welcomeTab')}
          </span>
        </div>
        <span className="badge" data-testid="sample-badge">
          {t('editor.sampleBadge')}
        </span>
      </div>
      <Suspense fallback={<p className="placeholder">{t('editor.loading')}</p>}>
        <CodeEditor
          uri="inmemory://noobide/welcome.html"
          language="html"
          initialValue={SAMPLE_HTML}
          ariaLabel={t('region.editor')}
        />
      </Suspense>
    </main>
  );
}
