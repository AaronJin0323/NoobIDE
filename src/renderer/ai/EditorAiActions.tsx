import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import type { PlatformId } from '../../platform/labels';
import { commandShortcutLabel } from '../../shared/commands';
import {
  activeEditor,
  subscribeEditorContextActions,
  type EditorContextAction,
  type EditorSelection,
} from '../editor/editor-handle';
import { AiIcon, ExplainIcon } from './ai-icons';

/** The editor context-menu actions that also get a button in the editor's status bar (ids from useAiChat / Workbench). */
export const INLINE_EDIT_ACTION = 'ai-inline-edit';
export const EXPLAIN_ACTION = 'ai-explain';

type Translate = (key: MessageKey) => string;

/**
 * The AI actions of the editor, always in view in its status bar under the code: "Edit with AI" (Ctrl/Cmd+I) and "Explain". They run
 * exactly the editor's context-menu actions, so they are offered under the same condition — only while AI is offered
 * (the features register the actions only then) — and with the selection in the editor at the moment of the click.
 */
export function EditorAiActions() {
  const { t } = useI18n();
  const [actions, setActions] = useState<readonly EditorContextAction[]>([]);
  useEffect(() => subscribeEditorContextActions(setActions), []);
  return (
    <EditorAiActionsView
      actions={actions}
      platform={window.noobide?.platform ?? 'other'}
      selection={() => activeEditor()?.selection?.() ?? null}
      t={t}
    />
  );
}

/** The buttons with their inputs passed in (unit-tested with renderToStaticMarkup). */
export function EditorAiActionsView({
  actions,
  platform,
  selection,
  t,
}: {
  readonly actions: readonly EditorContextAction[];
  readonly platform: PlatformId;
  readonly selection: () => EditorSelection | null;
  readonly t: Translate;
}) {
  const edit = actions.find((action) => action.id === INLINE_EDIT_ACTION);
  const explain = actions.find((action) => action.id === EXPLAIN_ACTION);
  if (!edit && !explain) return null;
  const shortcut = commandShortcutLabel('ai-inline-edit', platform);
  return (
    <div className="editor-ai-actions" role="group" aria-label={t('ai.editor.actions')} data-testid="editor-ai-actions">
      {edit && (
        <button
          type="button"
          className="ai-entry"
          title={shortcut ? `${edit.label} (${shortcut})` : edit.label}
          aria-keyshortcuts={shortcut ? ariaShortcut(platform) : undefined}
          data-testid="editor-ai-edit"
          onClick={() => edit.run(selection())}
        >
          <AiIcon size={14} />
          <span className="editor-ai-edit-label">{t('ai.editor.editButton')}</span>
          {shortcut && (
            <kbd className="ai-entry-kbd" aria-hidden="true">
              {shortcut}
            </kbd>
          )}
        </button>
      )}
      {explain && (
        <button
          type="button"
          className="quiet-button"
          aria-label={explain.label}
          title={explain.label}
          data-testid="editor-ai-explain"
          onClick={() => explain.run(selection())}
        >
          <ExplainIcon size={14} />
          <span className="editor-ai-explain-label">{t('ai.editor.explainButton')}</span>
        </button>
      )}
    </div>
  );
}

function ariaShortcut(platform: PlatformId): string {
  return platform === 'mac' ? 'Meta+I' : 'Control+I';
}
