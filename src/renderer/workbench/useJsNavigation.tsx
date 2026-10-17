import { useCallback, useEffect, useState } from 'react';
import { activeEditor, setEditorContextActionGroup } from '../editor/editor-handle';
import type { NavLocation } from '../editor/js-navigation';
import { useI18n } from '../i18n/I18nProvider';
import { NavigationDialog, type NavigationView } from './NavigationDialog';
import { RenameDialog } from './RenameDialog';
import { applyRename, type RenameHost } from './rename-apply';
import '../editor/authoring.css';

export interface RenameDeps {
  /** How the rename reaches the files: their tabs and savers (rename-apply.ts). */
  readonly host: RenameHost;
  /** The project's HTML pages (open tabs: their live text), searched for the old name, or why not all are known. */
  htmlPages(): Promise<
    | { readonly ok: true; readonly pages: { relPath: string; text: string }[] }
    | { readonly ok: false; readonly reason: 'incomplete-project' | 'pages-unknown' }
  >;
}

/**
 * S57.1: Go to definition (F12) and Find all references (Shift+F12) for the project's scripts. One definition opens
 * its file at the place; several, or the references, are listed; nothing found or an unsupported place (an HTML
 * page's inline `<script>`) is explained. S57.2: Rename (F2) with a per-file preview, applied through the save
 * pipeline. The editor's context menu offers the same commands.
 */
export function useJsNavigation(
  goTo: (target: { file: string; line: number; column?: number }) => void,
  rename: RenameDeps | null,
) {
  const { t } = useI18n();
  const [view, setView] = useState<NavigationView | null>(null);
  const [renaming, setRenaming] = useState<{ name: string } | null>(null);

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
  const renameSymbol = useCallback(() => {
    const name = activeEditor()?.nameAtCursor?.() ?? null;
    if (name) setRenaming({ name });
    else
      setView({ kind: 'notice', heading: 'command.renameSymbol', message: 'rename.refused.not-renamable', name: '' });
  }, []);

  // The editor's context menu (right click) offers the same commands.
  useEffect(() => {
    setEditorContextActionGroup('js-navigation', [
      { id: 'goToDefinition', label: t('command.goToDefinition'), needsSelection: false, run: goToDefinition },
      { id: 'findReferences', label: t('command.findReferences'), needsSelection: false, run: findReferences },
      ...(rename
        ? [{ id: 'renameSymbol', label: t('command.renameSymbol'), needsSelection: false, run: renameSymbol }]
        : []),
    ]);
    return () => setEditorContextActionGroup('js-navigation', []);
  }, [t, goToDefinition, findReferences, renameSymbol, rename]);

  const close = useCallback(() => {
    setView(null);
    activeEditor()?.focus?.();
  }, []);

  const closeRename = useCallback(() => {
    setRenaming(null);
    activeEditor()?.focus?.();
  }, []);

  const dialog =
    renaming && rename ? (
      <RenameDialog
        name={renaming.name}
        onClose={closeRename}
        // The plan is computed for the editor and cursor the rename started from (the dialog keeps the focus).
        plan={async (newName) => {
          const pages = await rename.htmlPages();
          if (!pages.ok) return { ok: false, reason: pages.reason };
          return (await activeEditor()?.renamePlan?.(newName, pages.pages)) ?? null;
        }}
        apply={(plan) => applyRename(plan.files, rename.host)}
      />
    ) : view ? (
      <NavigationDialog
        view={view}
        onClose={close}
        onOpen={(location) => {
          setView(null);
          goTo({ file: location.relPath, line: location.line, column: location.column });
        }}
      />
    ) : null;

  return {
    goToDefinition,
    findReferences,
    renameSymbol: rename ? renameSymbol : undefined,
    dialog,
    open: view !== null || renaming !== null,
  };
}
