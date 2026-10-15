/**
 * Saved chats of the AI chat panel (S39.1): conversion between the panel's conversations (chat-model.ts) and the
 * saved form (ai-history-contract.ts), and `ChatHistorySync`, which saves each conversation of an open project when a
 * turn ends and runs the "Past chats" list (reopen, delete with confirmation). No React and no DOM, so it is
 * unit-tested against a fake bridge.
 *
 * What is saved: questions, answers, steps, what a turn was sent with (names and lines, not the code it carried) and
 * what an agent proposed (kind and path of each change, not the contents). Chats without an open project are not
 * saved. Main keeps the files in app data (never in the project folder) and caps them.
 */
import type { AiContextItem } from '../../shared/ipc/ai-contract';
import type {
  AiChatToSave,
  AiHistoryApi,
  AiSavedChat,
  AiSavedChatSummary,
  AiSavedContextItem,
  AiSavedPart,
  AiSavedTurn,
} from '../../shared/ipc/ai-history-contract';
import type { MessageKey } from '../i18n/index';
import type { AiChatController } from './chat-controller';
import type { ChatState, ChatTurn, Conversation, TurnPart } from './chat-model';

export function aiHistoryBridge(): AiHistoryApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window.noobide as { readonly aiHistory?: AiHistoryApi } | undefined)?.aiHistory;
}

const ended = (turn: ChatTurn) => turn.status === 'done' || turn.status === 'error' || turn.status === 'cancelled';

function savedContext(item: AiContextItem): AiSavedContextItem {
  return {
    kind: item.kind,
    ...(item.relPath !== undefined ? { relPath: item.relPath } : {}),
    ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
    ...(item.endLine !== undefined ? { endLine: item.endLine } : {}),
    ...(item.label !== undefined ? { label: item.label.slice(0, 500) } : {}),
  };
}

function savedPart(part: TurnPart): AiSavedPart {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text };
    case 'step':
      return { kind: 'step', tool: part.tool, summary: part.summary.slice(0, 2000) };
    case 'proposal':
      return {
        kind: 'proposal',
        reason: part.reason.slice(0, 2000),
        changes: part.changes.map((c) =>
          c.kind === 'rename' ? { kind: c.kind, relPath: c.relPath, to: c.to } : { kind: c.kind, relPath: c.relPath },
        ),
      };
    case 'saved-proposal':
      return { kind: 'proposal', reason: part.reason, changes: part.changes };
  }
}

/** An ended turn in the saved form; null while it is still running. */
export function toSavedTurn(turn: ChatTurn): AiSavedTurn | null {
  if (!ended(turn)) return null;
  return {
    kind: turn.kind,
    mode: turn.mode,
    prompt: turn.prompt,
    context: turn.context.map(savedContext),
    status: turn.status as AiSavedTurn['status'],
    parts: turn.parts.map(savedPart),
    ...(turn.usage ? { usage: { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens } } : {}),
    ...(turn.error && /^[\w-]{1,64}$/.test(String(turn.error.code)) ? { errorCode: String(turn.error.code) } : {}),
  };
}

/** The conversation to save, or null when it has nothing ended to save yet. */
export function toChatToSave(conversation: Conversation, savedId: string): AiChatToSave | null {
  const turns = conversation.turns.map(toSavedTurn).filter((t): t is AiSavedTurn => t !== null);
  if (turns.length === 0) return null;
  return { id: savedId, title: conversation.title.slice(0, 200), turns: turns.slice(-200) };
}

/** A saved chat as a panel conversation (its id is the saved id; turns are ended and have no request). */
export function fromSavedChat(chat: AiSavedChat, projectKey: string): Conversation {
  return {
    id: chat.id,
    projectKey,
    title: chat.title,
    turns: chat.turns.map((turn, i) => ({
      id: `saved-${chat.id}-${i}`,
      kind: turn.kind,
      mode: turn.mode,
      prompt: turn.prompt,
      context: turn.context,
      requestId: null,
      status: turn.status,
      stopping: false,
      parts: turn.parts.map((part): TurnPart =>
        part.kind === 'proposal' ? { ...part, kind: 'saved-proposal' } : part,
      ),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.errorCode ? { error: { code: turn.errorCode, message: '' } } : {}),
    })),
  };
}

export interface ChatHistoryState {
  /** The "Past chats" list is shown instead of the conversation. */
  readonly listOpen: boolean;
  /** The project the list belongs to. */
  readonly projectId: string | null;
  /** null while loading (or before the first load). */
  readonly chats: readonly AiSavedChatSummary[] | null;
  readonly skipped: number;
  /** The chat waiting for "Delete?" to be confirmed. */
  readonly confirmDelete: string | null;
  /** A short message about the history (save failed, deleted…), by message key. */
  readonly notice: MessageKey | null;
}

const INITIAL: ChatHistoryState = {
  listOpen: false,
  projectId: null,
  chats: null,
  skipped: 0,
  confirmDelete: null,
  notice: null,
};

type Uuid = () => string;
const defaultUuid: Uuid = () => crypto.randomUUID();

/**
 * Keeps an open project's conversations saved and runs the "Past chats" list. A conversation is saved after each of
 * its turns ends (one save at a time per conversation; the latest state wins).
 */
export class ChatHistorySync {
  private state: ChatHistoryState = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** Panel conversation id → saved chat id (a reopened chat keeps its own id). */
  private readonly savedIds = new Map<string, string>();
  /** The turns last sent for saving, per conversation (unchanged turns are not saved again). */
  private readonly lastSaved = new Map<string, readonly ChatTurn[]>();
  private readonly saving = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private listSeq = 0;

  constructor(
    private readonly api: AiHistoryApi,
    private readonly controller: Pick<
      AiChatController,
      'getState' | 'subscribe' | 'restoreConversation' | 'removeConversation'
    >,
    private readonly projectId: () => string | null,
    private readonly uuid: Uuid = defaultUuid,
  ) {}

  getState = (): ChatHistoryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<ChatHistoryState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Starts saving conversations as their turns end. Returns the stop function; idempotent. */
  start(): () => void {
    if (!this.unsubscribe) this.unsubscribe = this.controller.subscribe(() => this.onChatState());
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  /** The open project changed: the list is for the new one. */
  projectChanged(): void {
    const projectId = this.projectId();
    if (projectId === this.state.projectId) return;
    this.set({ projectId, chats: null, skipped: 0, confirmDelete: null, notice: null, listOpen: false });
  }

  // ── list ──
  async openList(): Promise<void> {
    this.set({ listOpen: true, confirmDelete: null, notice: null, projectId: this.projectId() });
    await this.refresh();
  }
  closeList(): void {
    this.set({ listOpen: false, confirmDelete: null });
  }
  toggleList(): void {
    if (this.state.listOpen) this.closeList();
    else void this.openList();
  }

  async refresh(): Promise<void> {
    const projectId = this.projectId();
    if (!projectId) return;
    const seq = ++this.listSeq;
    try {
      const result = await this.api.listChats({ projectId });
      if (seq !== this.listSeq) return;
      if (result.ok) this.set({ projectId, chats: result.value.chats, skipped: result.value.skipped });
      else this.set({ projectId, chats: [], skipped: 0, notice: 'ai.history.listFailed' });
    } catch {
      if (seq === this.listSeq) this.set({ projectId, chats: [], notice: 'ai.history.listFailed' });
    }
  }

  /** Reopens a saved chat (an already open copy is just shown) and returns to the conversation. */
  async reopen(chatId: string): Promise<void> {
    const projectId = this.projectId();
    if (!projectId) return;
    const open = [...this.savedIds].find(([, saved]) => saved === chatId)?.[0];
    const inMemory = this.controller.getState().conversations.find((c) => c.id === (open ?? chatId));
    if (inMemory) {
      this.controller.restoreConversation(inMemory);
      this.set({ listOpen: false, notice: null });
      return;
    }
    try {
      const result = await this.api.getChat({ projectId, chatId });
      if (!result.ok) {
        this.set({ notice: 'ai.history.loadFailed' });
        void this.refresh();
        return;
      }
      const conversation = fromSavedChat(result.value, projectId);
      this.savedIds.set(conversation.id, chatId);
      this.lastSaved.set(conversation.id, conversation.turns);
      this.controller.restoreConversation(conversation);
      this.set({ listOpen: false, notice: null });
    } catch {
      this.set({ notice: 'ai.history.loadFailed' });
    }
  }

  askDelete(chatId: string): void {
    this.set({ confirmDelete: chatId, notice: null });
  }
  cancelDelete(): void {
    this.set({ confirmDelete: null });
  }
  async confirmDelete(): Promise<void> {
    const chatId = this.state.confirmDelete;
    const projectId = this.projectId();
    if (!chatId || !projectId) return;
    this.set({ confirmDelete: null });
    let deleted: boolean;
    try {
      deleted = (await this.api.deleteChat({ projectId, chatId })).ok;
    } catch {
      deleted = false;
    }
    if (deleted) {
      const conversationId = [...this.savedIds].find(([, saved]) => saved === chatId)?.[0] ?? chatId;
      this.controller.removeConversation(conversationId);
      // A conversation still answering stays in the panel; it is no longer linked to the deleted file.
      this.savedIds.delete(conversationId);
      this.lastSaved.delete(conversationId);
    }
    this.set({ notice: deleted ? 'ai.history.deleted' : 'ai.history.deleteFailed' });
    await this.refresh();
  }

  /** The saved chat id of a panel conversation (null: not saved yet, or none). */
  savedIdOf(conversationId: string | null): string | null {
    return conversationId ? (this.savedIds.get(conversationId) ?? null) : null;
  }

  /** Waits for the saves in flight (tests, and before the window closes). */
  async flush(): Promise<void> {
    await Promise.all([...this.saving.values()]);
  }

  // ── saving ──
  private onChatState(): void {
    const projectId = this.projectId();
    if (!projectId) return;
    const state: ChatState = this.controller.getState();
    for (const conversation of state.conversations) {
      if (conversation.projectKey !== projectId) continue;
      const last = conversation.turns.at(-1);
      // A question sent while the list is shown: show the conversation it went to.
      if (last && !ended(last) && this.state.listOpen && state.active[projectId] === conversation.id) {
        this.set({ listOpen: false, confirmDelete: null });
      }
      if (!last || !ended(last)) continue;
      if (this.lastSaved.get(conversation.id) === conversation.turns) continue;
      this.lastSaved.set(conversation.id, conversation.turns);
      this.queueSave(projectId, conversation);
    }
  }

  private queueSave(projectId: string, conversation: Conversation): void {
    const previous = this.saving.get(conversation.id) ?? Promise.resolve();
    const next = previous.then(() => this.save(projectId, conversation));
    this.saving.set(conversation.id, next);
    void next.finally(() => {
      if (this.saving.get(conversation.id) === next) this.saving.delete(conversation.id);
    });
  }

  private async save(projectId: string, conversation: Conversation): Promise<void> {
    // Only the newest state of a conversation is worth writing.
    // Gone (deleted) or changed again meanwhile (a newer save is queued): nothing to write now.
    const current = this.controller.getState().conversations.find((c) => c.id === conversation.id);
    if (!current || this.lastSaved.get(conversation.id) !== conversation.turns) return;
    let savedId = this.savedIds.get(conversation.id);
    if (!savedId) {
      savedId = this.uuid();
      this.savedIds.set(conversation.id, savedId);
    }
    const chat = toChatToSave(conversation, savedId);
    if (!chat) return;
    try {
      const result = await this.api.saveChat({ projectId, chat });
      if (result.ok) {
        if (this.state.notice === 'ai.history.saveFailed' || this.state.notice === 'ai.history.tooLarge') {
          this.set({ notice: null });
        }
        if (this.state.listOpen) void this.refresh();
      } else {
        this.set({ notice: result.code === 'too-large' ? 'ai.history.tooLarge' : 'ai.history.saveFailed' });
      }
    } catch {
      this.set({ notice: 'ai.history.saveFailed' });
    }
  }
}
