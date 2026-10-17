import { useCallback, useEffect, useState } from 'react';
import { activeEditor, setEditorContextActionGroup } from '../editor/editor-handle';
import type { NavLocation } from '../editor/js-navigation';
import { useI18n } from '../i18n/I18nProvider';
import { NavigationDialog, type NavigationView } from './NavigationDialog';
import '../editor/authoring.css';

/**
 * S57.1: Go to definition (F12) and Find all references (Shift+F12) for the project's scripts. One definition opens
 * its file at the place; several, or the references, are listed; nothing found or an unsupported place (an HTML
 * page's inline `<script>`) is explained. The editor's context menu offers the same commands.
 */
export function useJsNavigation(goTo: (target: { file: string; line: number; column?: number }) => void) {
  const { t } = useI18n();
  const [view, setView] = useState<NavigationView | null>(null);

  const run = useCallback(
    async (query: 'definition' | 'references') => {
      const editor = activeEditor();
      const result = await editor?.navigate?.(query);
      if (!result) return;
      const name = editor?.nameAtCursor?.() ?? '';
      const heading = query === 'definition' ? 'command.goToDefinition' : 'command.findReferences';
      if (result.kind === 'unsupported') {
        setView({
          kind: 'notice',
          heading,
          name,
          message: result.reason === 'inline-script' ? 'nav.unsupported.inline-script' : 'nav.unsupported.not-a-script',
        });
        return;
      }
      const { locations } = result;
      if (locations.length === 0) {
        setView({
          kind: 'notice',
          heading,
          name,
          message: query === 'definition' ? 'nav.none.definition' : 'nav.none.references',
        });
      } else if (query === 'definition' && locations.length === 1) {
        const [only] = locations as [NavLocation];
        goTo({ file: only.relPath, line: only.line, column: only.column });
      } else {
        setView({
          kind: 'list',
          name,
          locations,
          title: query === 'definition' ? 'nav.definitions.title' : 'nav.references.title',
        });
      }
    },
    [goTo],
  );

  const goToDefinition = useCallback(() => void run('definition'), [run]);
  const findReferences = useCallback(() => void run('references'), [run]);

  // The editor's context menu (right click) offers the same commands.
  useEffect(() => {
    setEditorContextActionGroup('js-navigation', [
      { id: 'goToDefinition', label: t('command.goToDefinition'), needsSelection: false, run: goToDefinition },
      { id: 'findReferences', label: t('command.findReferences'), needsSelection: false, run: findReferences },
    ]);
    return () => setEditorContextActionGroup('js-navigation', []);
  }, [t, goToDefinition, findReferences]);

  const close = useCallback(() => {
    setView(null);
    activeEditor()?.focus?.();
  }, []);

  const dialog = view ? (
    <NavigationDialog
      view={view}
      onClose={close}
      onOpen={(location) => {
        setView(null);
        goTo({ file: location.relPath, line: location.line, column: location.column });
      }}
    />
  ) : null;

  return { goToDefinition, findReferences, dialog, open: view !== null };
}
