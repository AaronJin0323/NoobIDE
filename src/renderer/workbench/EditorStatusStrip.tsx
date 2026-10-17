import { useSyncExternalStore } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { EditorAiActions } from '../ai/EditorAiActions';
import { toggleInlineAi, useInlineAiState } from '../ai/useInlineAiState'; // S32.1
import { IndentStatus } from './IndentStatus'; // S43.2
import { EmmetHint } from '../editor/EmmetHint'; // S53.1
import { ColorStatus } from '../editor/ColorPicker'; // S53.3
import { FormatSaveNotice } from './FormatSaveNotice'; // S53.4
import { WarningIcon } from './icons';
import type { OpenTab } from './document-state';
import { cursorPosition, subscribeCursor } from './editor-status-state';
import { navigationWait, subscribeNavigationWait } from './navigation-wait-state'; // S57

const INLINE_WORD = {
  on: 'ai.inline.state.on',
  off: 'ai.inline.state.off',
  paused: 'ai.inline.state.paused',
} as const satisfies Record<string, MessageKey>;
const INLINE_SENTENCE = {
  on: 'ai.inline.status.on',
  off: 'ai.inline.status.off',
  paused: 'ai.inline.status.paused',
} as const satisfies Record<string, MessageKey>;

interface EditorStatusStripProps {
  /** The active tab, or null (the welcome sample, or a project without an open file). */
  tab: OpenTab | null;
  /** A code editor is on screen (an open file, or the welcome sample while no project is open). */
  hasEditor: boolean;
  projectId: string | null;
}

/**
 * S47.5: the editor's part of the global status strip — one status row for the whole window. The editor pane used to
 * carry its own bottom row (AI edit, explain, indent, caret, AI suggestions) above this strip; those now sit at the
 * end of the strip, next to the Problems toggle at its start. The encoding and line-ending notes that were bands above
 * the code are short items here with the full sentence as their tooltip, so at most one persistent band (the role
 * hint, first showing only) stays above the code.
 *
 * The strip's markup belongs to ProblemsPanel (the toggle and the live count); this region is a sibling laid over the
 * strip's free end (styles.css `.status-editor`), its own F6 stop after Problems.
 */
export function EditorStatusStrip({ tab, hasEditor, projectId }: EditorStatusStripProps) {
  const { t } = useI18n();
  const cursor = useSyncExternalStore(subscribeCursor, cursorPosition);
  const navWait = useSyncExternalStore(subscribeNavigationWait, navigationWait); // S57
  const inlineAi = useInlineAiState(projectId); // S32.1
  if (!hasEditor || !cursor) return null;
  const readOnlyEncoding = tab?.content.readOnly ? tab.content : null;
  return (
    <div className="region status-editor" role="region" aria-label={t('region.status')} data-testid="region-status">
      {/* Edit with AI / Explain: always in view while AI is offered (the same actions as the editor's context menu),
          without taking room from the open-file tabs. */}
      {tab && <EditorAiActions />}
      <IndentStatus />
      <EmmetHint />
      <ColorStatus />
      <FormatSaveNotice />
      {readOnlyEncoding && (
        // S07.4: another encoding — shown read-only so a save can never re-encode (and damage) the file.
        <span
          className="status-note"
          role="status"
          data-testid="read-only-notice"
          title={`${t('editor.readOnlyEncoding')} ${readOnlyEncoding.encoding}${
            readOnlyEncoding.encodingGuessed ? ` ${t('editor.encodingGuessed')}` : ''
          }`}
        >
          <WarningIcon size={14} />
          {`${readOnlyEncoding.encoding} · ${t('editor.status.readOnly')}`}
        </span>
      )}
      {tab?.content.mixedEol && (
        <span
          className="status-note"
          role="note"
          data-testid="mixed-eol"
          title={t(tab.content.eol === '\r\n' ? 'editor.mixedEol.crlf' : 'editor.mixedEol.lf')}
        >
          <WarningIcon size={14} />
          {fill(t('editor.status.mixedEol'), { eol: tab.content.eol === '\r\n' ? 'CRLF' : 'LF' })}
        </span>
      )}
      {navWait && (
        // S57: F12 / Shift+F12 / F2 pressed while the project's scripts are still being read: the command waits for
        // the index (bounded) and says so here, as text, instead of answering "not found" from a half-read project.
        <span className="status-note" role="status" data-testid="navigation-indexing">
          {fill(t('nav.indexing.status'), { command: t(navWait) })}
        </span>
      )}
      <span
        className="status-cursor"
        data-testid="cursor-position"
      >{`${t('editor.line')} ${cursor.line}, ${t('editor.column')} ${cursor.column}`}</span>
      {inlineAi && (
        // The suggestions toggle: the same command as the palette's, its state as a short word (the full sentence and
        // the command's name are the tooltip).
        <button
          type="button"
          className="status-button status-ai-toggle"
          aria-pressed={inlineAi !== 'off'}
          title={`${t(INLINE_SENTENCE[inlineAi])} · ${t('command.toggleInlineAi')}`}
          data-testid="inline-ai-state"
          data-state={inlineAi}
          onClick={() => toggleInlineAi(projectId)}
        >
          {t(INLINE_WORD[inlineAi])}
        </button>
      )}
    </div>
  );
}
