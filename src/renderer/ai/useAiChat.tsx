import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import { setEditorContextActions, type EditorSelection } from '../editor/editor-handle';
import { useI18n } from '../i18n/I18nProvider';
import { aiBridge, aiSettingsAvailable, AI_STATUS_CHANGED_EVENT, openAiSettings } from './ai-bridge';
import { AiChatController, type AiChatHost, type SelectionContext } from './chat-controller';
import type { AiChatExtensions, AiConsentRenderer } from './chat-extensions';
import { aiSurfacesShown } from './chat-model';
import { ChatPanel, type PastChatsSlot } from './ChatPanel';
import { aiHistoryBridge, ChatHistorySync } from './chat-history';
import { SavedChatsList } from './SavedChatsList';
import { ConsentPlaceholder } from './ConsentPlaceholder';

const noSubscribe = () => () => undefined;
const noState = () => null;

/** What the workbench tells the chat about its editor (read at the moment of use). */
export interface AiWorkbenchHost {
  activeFile(): string | null;
  fileText(relPath: string): string | undefined;
  /** Maps an editor model URI to its project-relative path. */
  relPathOf(uri: string): string | undefined;
  /** The editor's current selection (editor-handle), or null. */
  editorSelection(): EditorSelection | null;
}

export interface UseAiChatOptions {
  /** S34+: agent turns, step and proposal rendering (see chat-extensions.ts). */
  readonly extensions?: AiChatExtensions;
  /** S31's consent component; defaults to the placeholder. */
  readonly consent?: AiConsentRenderer;
}

/**
 * The AI chat for the workbench (S33): one controller per window, its state, the panel element, and the entry points
 * (rail / command toggle, "Explain this code", "Ask AI" on a problem). Every surface is absent when there is no AI
 * bridge or AI is switched off.
 */
export function useAiChat(projectId: string | null, host: AiWorkbenchHost, options: UseAiChatOptions = {}) {
  const { t, locale } = useI18n();
  const api = useMemo(() => aiBridge(), []);
  const hostRef = useRef(host);
  hostRef.current = host;
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const controllerRef = useRef<AiChatController | null>(null);
  if (!controllerRef.current) {
    const toSelection = (selection: EditorSelection | null): SelectionContext | null => {
      const relPath = selection ? hostRef.current.relPathOf(selection.uri) : undefined;
      return selection && relPath
        ? { relPath, startLine: selection.startLine, endLine: selection.endLine, text: selection.text }
        : null;
    };
    const chatHost: AiChatHost = {
      projectId: () => projectRef.current,
      locale: () => localeRef.current,
      activeFile: () => hostRef.current.activeFile(),
      fileText: (relPath) => hostRef.current.fileText(relPath),
      selection: () => toSelection(hostRef.current.editorSelection()),
    };
    controllerRef.current = new AiChatController(api, chatHost);
  }
  const controller = controllerRef.current;
  controller.setRequestBuilder(options.extensions?.requestBuilder);

  useEffect(() => controller.start(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  // S39.1: conversations of an open project are saved in app data; "Past chats" reopens or deletes them.
  const historyRef = useRef<ChatHistorySync | null | undefined>(undefined);
  if (historyRef.current === undefined) {
    const historyApi = aiHistoryBridge();
    historyRef.current = historyApi ? new ChatHistorySync(historyApi, controller, () => projectRef.current) : null;
  }
  const history = historyRef.current;
  useEffect(() => history?.start(), [history]);
  useEffect(() => history?.projectChanged(), [history, projectId]);
  const historyState = useSyncExternalStore(history?.subscribe ?? noSubscribe, history?.getState ?? noState);

  // Status (AI on/off, key, the project's consent): on start, per project, when the window regains focus, and when
  // Settings → AI says it changed.
  useEffect(() => {
    void controller.refreshStatus();
  }, [controller, projectId]);
  useEffect(() => {
    const refresh = () => void controller.refreshStatus();
    window.addEventListener('focus', refresh);
    window.addEventListener(AI_STATUS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(AI_STATUS_CHANGED_EVENT, refresh);
    };
  }, [controller]);

  const shown = aiSurfacesShown(state.availability);

  const explainSelection = useCallback(
    (selection?: EditorSelection | null) => {
      const current = selection === undefined ? hostRef.current.editorSelection() : selection;
      const relPath = current ? hostRef.current.relPathOf(current.uri) : undefined;
      controller.explainCode(
        current && relPath
          ? { relPath, startLine: current.startLine, endLine: current.endLine, text: current.text }
          : null,
        t('ai.prompt.explainCode'),
      );
    },
    [controller, t],
  );

  const askAboutProblem = useCallback(
    (record: ProblemRecord, title: string) =>
      controller.explainProblem(
        {
          relPath: record.file,
          line: record.line,
          title,
          originalMessage: record.originalMessage,
          code: record.code,
        },
        t('ai.prompt.explainProblem'),
      ),
    [controller, t],
  );

  // S33.2: "Ask AI to explain this code" in the code editor's context menu while AI is offered.
  useEffect(() => {
    if (!shown) {
      setEditorContextActions([]);
      return undefined;
    }
    setEditorContextActions([
      { id: 'ai-explain', label: t('ai.editor.explain'), needsSelection: true, run: (s) => explainSelection(s) },
    ]);
    return () => setEditorContextActions([]);
  }, [shown, t, explainSelection]);

  const consent = useMemo<AiConsentRenderer>(
    () =>
      options.consent ?? ((props) => (api ? <ConsentPlaceholder key={props.projectId} api={api} {...props} /> : null)),
    [options.consent, api],
  );

  const pastChats: PastChatsSlot | undefined =
    history && historyState && projectId !== null
      ? {
          listOpen: historyState.listOpen,
          onToggle: () => history.toggleList(),
          notice: historyState.notice,
          list: (
            <SavedChatsList
              state={historyState}
              actions={history}
              activeId={history.savedIdOf(state.active[projectId] ?? null)}
              locale={locale}
              t={t}
            />
          ),
        }
      : undefined;

  const panel =
    state.open && api && shown ? (
      <ChatPanel
        state={state}
        projectId={projectId}
        actions={controller}
        consent={consent}
        onOpenSettings={aiSettingsAvailable() ? () => openAiSettings() : undefined}
        extensions={options.extensions}
        pastChats={pastChats}
      />
    ) : null;

  return {
    controller,
    state,
    /** AI entry points (rail button, commands, Explain, Ask AI) are offered. */
    shown,
    open: state.open,
    panel,
    toggle: useCallback(() => controller.toggle(), [controller]),
    explainSelection,
    askAboutProblem,
  };
}
