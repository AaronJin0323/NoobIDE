/**
 * State of the AI chat panel (S33.1): conversations per project (in memory only, decision 0025), the draft (prompt,
 * context chips, mode) and each turn's streamed answer. Pure: the controller (chat-controller.ts) performs the IPC and
 * feeds results in as actions, so every rule here is unit-tested without Electron or React.
 */
import type {
  AiChatMessage,
  AiContextItem,
  AiErrorCode,
  AiEvent,
  AiFileChange,
  AiProviderId,
  AiStatus,
} from '../../shared/ipc/ai-contract';

/** Key of a project's conversations; chats without an open project use ''. */
export type ProjectKey = string;
export const projectKeyOf = (projectId: string | null): ProjectKey => projectId ?? '';

export type ChatMode = 'chat' | 'explain-code' | 'explain-problem';
/** 'agent' turns are sent as agent requests (S34 turns the switch on; see chat-extensions.ts). */
export type TurnKind = 'chat' | 'agent';

/** One context item the user sees (and can remove) before sending. Exactly these items are sent. */
export interface ChatChip {
  readonly id: string;
  readonly item: AiContextItem;
}

export interface ChatDraft {
  readonly prompt: string;
  readonly chips: readonly ChatChip[];
  readonly mode: ChatMode;
  readonly kind: TurnKind;
}

export const EMPTY_DRAFT: ChatDraft = { prompt: '', chips: [], mode: 'chat', kind: 'chat' };

/** What a turn's answer is made of, in arrival order. 'step' and 'proposal' come from agent turns (S34). */
export type TurnPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'step'; readonly tool: string; readonly summary: string }
  | {
      readonly kind: 'proposal';
      readonly proposalId: string;
      readonly changes: readonly AiFileChange[];
      readonly reason: string;
    };

export type TurnStatus = 'sending' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface ChatTurn {
  readonly id: string;
  readonly kind: TurnKind;
  readonly mode: ChatMode;
  readonly prompt: string;
  /** Exactly what was sent with the prompt. */
  readonly context: readonly AiContextItem[];
  readonly requestId: string | null;
  readonly status: TurnStatus;
  /** Stop was pressed; waiting for main to end the stream. */
  readonly stopping: boolean;
  readonly parts: readonly TurnPart[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** An AiErrorCode, or an IPC error code ('invalid-request', 'forbidden-sender') shown with the generic text. */
  readonly error?: { readonly code: AiErrorCode | string; readonly message: string };
}

export interface Conversation {
  readonly id: string;
  readonly projectKey: ProjectKey;
  /** The first prompt, shortened; the list shows it. */
  readonly title: string;
  readonly turns: readonly ChatTurn[];
}

export type AiAvailability =
  /** No AI bridge in this build (S31 not present): no AI surface is shown. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'loading' }
  /** AI switched off in Settings: no AI surface is shown (S31.4). */
  | { readonly kind: 'disabled' }
  | { readonly kind: 'no-secure-storage' }
  | { readonly kind: 'no-key' }
  | { readonly kind: 'ready'; readonly provider: AiProviderId; readonly consent: boolean };

export function availabilityOf(status: AiStatus): AiAvailability {
  if (!status.config.enabled) return { kind: 'disabled' };
  const provider = status.config.provider;
  if (!provider || !status.keyStored[provider]) {
    return status.secureStorage ? { kind: 'no-key' } : { kind: 'no-secure-storage' };
  }
  return { kind: 'ready', provider, consent: status.projectConsent };
}

/** Whether AI entry points (rail button, commands, Explain, Ask AI) are offered at all. */
export const aiSurfacesShown = (availability: AiAvailability): boolean =>
  availability.kind !== 'unavailable' && availability.kind !== 'disabled' && availability.kind !== 'loading';

export interface ChatState {
  readonly open: boolean;
  readonly availability: AiAvailability;
  readonly conversations: readonly Conversation[];
  /** The conversation shown per project; absent or null: a new, empty conversation. */
  readonly active: Readonly<Record<ProjectKey, string | null>>;
  readonly drafts: Readonly<Record<ProjectKey, ChatDraft>>;
  /** The consent question is shown for this project (a send is waiting for the answer). */
  readonly consentFor: ProjectKey | null;
  /** A short notice under the chips (e.g. "select some code first"), by message key. */
  readonly notice: string | null;
  /** Bumped when the input should take the keyboard focus (panel opened by a command, Explain, Ask AI). */
  readonly focusSeq: number;
}

export const INITIAL_CHAT_STATE: ChatState = {
  open: false,
  availability: { kind: 'loading' },
  conversations: [],
  active: {},
  drafts: {},
  consentFor: null,
  notice: null,
  focusSeq: 0,
};

export type ChatAction =
  | { readonly type: 'setOpen'; readonly open: boolean; readonly focus?: boolean }
  | { readonly type: 'availability'; readonly availability: AiAvailability }
  | { readonly type: 'newConversation'; readonly projectKey: ProjectKey }
  | { readonly type: 'selectConversation'; readonly projectKey: ProjectKey; readonly id: string }
  | { readonly type: 'setPrompt'; readonly projectKey: ProjectKey; readonly prompt: string }
  | { readonly type: 'setKind'; readonly projectKey: ProjectKey; readonly kind: TurnKind }
  | { readonly type: 'addChip'; readonly projectKey: ProjectKey; readonly chip: ChatChip }
  | { readonly type: 'removeChip'; readonly projectKey: ProjectKey; readonly id: string }
  /** Explain / Ask AI: a fresh conversation whose draft holds exactly these chips, this mode and a suggested prompt. */
  | {
      readonly type: 'startExplain';
      readonly projectKey: ProjectKey;
      readonly chips: readonly ChatChip[];
      readonly mode: ChatMode;
      readonly prompt: string;
    }
  | {
      readonly type: 'turnStarted';
      readonly projectKey: ProjectKey;
      readonly conversationId: string;
      readonly turn: ChatTurn;
    }
  | { readonly type: 'requestAssigned'; readonly turnId: string; readonly requestId: string }
  | { readonly type: 'requestFailed'; readonly turnId: string; readonly code: string; readonly message: string }
  | { readonly type: 'stopping'; readonly turnId: string }
  /** Stop was confirmed by main without a final event: the turn ends as cancelled. */
  | { readonly type: 'stopped'; readonly turnId: string }
  | { readonly type: 'event'; readonly event: AiEvent }
  | { readonly type: 'consent'; readonly projectKey: ProjectKey | null }
  | { readonly type: 'notice'; readonly notice: string | null };

const TITLE_CHARS = 40;
export function titleOf(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat;
}

/** Two chips are the same context when they name the same thing (adding it twice keeps one). */
export function chipKey(item: AiContextItem): string {
  return [item.kind, item.relPath ?? '', item.startLine ?? '', item.endLine ?? '', item.label ?? ''].join('\u0000');
}

export function draftOf(state: ChatState, key: ProjectKey): ChatDraft {
  return state.drafts[key] ?? EMPTY_DRAFT;
}

export function activeConversation(state: ChatState, key: ProjectKey): Conversation | null {
  const id = state.active[key];
  return (id && state.conversations.find((c) => c.id === id)) || null;
}

export function conversationsOf(state: ChatState, key: ProjectKey): Conversation[] {
  return state.conversations.filter((c) => c.projectKey === key);
}

/** The turn still waiting for or receiving its answer in a conversation, if any (one at a time). */
export function runningTurn(conversation: Conversation | null): ChatTurn | null {
  const last = conversation?.turns.at(-1);
  return last && (last.status === 'sending' || last.status === 'streaming') ? last : null;
}

/** The answer text of a turn (all its text parts). */
export function answerText(turn: ChatTurn): string {
  return turn.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
}

/** Earlier turns as provider history (text only, oldest first); turns without an answer are left out. */
export function historyOf(conversation: Conversation | null): AiChatMessage[] {
  const messages: AiChatMessage[] = [];
  for (const turn of conversation?.turns ?? []) {
    const answer = answerText(turn);
    if (!answer || (turn.status !== 'done' && turn.status !== 'cancelled')) continue;
    messages.push({ role: 'user', text: turn.prompt }, { role: 'assistant', text: answer });
  }
  return messages;
}

function withDraft(state: ChatState, key: ProjectKey, update: (draft: ChatDraft) => ChatDraft): ChatState {
  return { ...state, drafts: { ...state.drafts, [key]: update(draftOf(state, key)) } };
}

function mapTurn(state: ChatState, match: (turn: ChatTurn) => boolean, update: (turn: ChatTurn) => ChatTurn) {
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (!conversation.turns.some(match)) return conversation;
    changed = true;
    return { ...conversation, turns: conversation.turns.map((turn) => (match(turn) ? update(turn) : turn)) };
  });
  return changed ? { ...state, conversations } : state;
}

const isRunning = (turn: ChatTurn) => turn.status === 'sending' || turn.status === 'streaming';

function applyEvent(turn: ChatTurn, event: AiEvent): ChatTurn {
  if (!isRunning(turn)) return turn; // a late event after the end changes nothing
  switch (event.type) {
    case 'text': {
      const last = turn.parts.at(-1);
      const parts =
        last?.kind === 'text'
          ? [...turn.parts.slice(0, -1), { kind: 'text' as const, text: last.text + event.text }]
          : [...turn.parts, { kind: 'text' as const, text: event.text }];
      return { ...turn, status: 'streaming', parts };
    }
    case 'step':
      return {
        ...turn,
        status: 'streaming',
        parts: [...turn.parts, { kind: 'step', tool: event.tool, summary: event.summary }],
      };
    case 'proposal':
      return {
        ...turn,
        status: 'streaming',
        parts: [
          ...turn.parts,
          { kind: 'proposal', proposalId: event.proposalId, changes: event.changes, reason: event.reason },
        ],
      };
    case 'done':
      return { ...turn, status: 'done', stopping: false, ...(event.usage ? { usage: event.usage } : {}) };
    case 'error':
      return event.code === 'cancelled'
        ? { ...turn, status: 'cancelled', stopping: false }
        : { ...turn, status: 'error', stopping: false, error: { code: event.code, message: event.message } };
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'setOpen':
      return {
        ...state,
        open: action.open,
        focusSeq: action.open && action.focus ? state.focusSeq + 1 : state.focusSeq,
      };
    case 'availability':
      return { ...state, availability: action.availability };
    case 'newConversation':
      return { ...state, active: { ...state.active, [action.projectKey]: null }, notice: null };
    case 'selectConversation':
      if (!state.conversations.some((c) => c.id === action.id && c.projectKey === action.projectKey)) return state;
      return { ...state, active: { ...state.active, [action.projectKey]: action.id }, notice: null };
    case 'setPrompt':
      return withDraft(state, action.projectKey, (draft) => ({ ...draft, prompt: action.prompt }));
    case 'setKind':
      return withDraft(state, action.projectKey, (draft) => ({ ...draft, kind: action.kind }));
    case 'addChip': {
      const key = chipKey(action.chip.item);
      const next = withDraft(state, action.projectKey, (draft) =>
        draft.chips.some((chip) => chipKey(chip.item) === key)
          ? draft
          : { ...draft, chips: [...draft.chips, action.chip] },
      );
      return { ...next, notice: null };
    }
    case 'removeChip':
      return withDraft(state, action.projectKey, (draft) => ({
        ...draft,
        chips: draft.chips.filter((chip) => chip.id !== action.id),
      }));
    case 'startExplain': {
      const current = activeConversation(state, action.projectKey);
      // A conversation still answering keeps going in the list; Explain starts a fresh one.
      const active =
        current && current.turns.length > 0 ? { ...state.active, [action.projectKey]: null } : state.active;
      return {
        ...state,
        open: true,
        active,
        notice: null,
        consentFor: null,
        focusSeq: state.focusSeq + 1,
        drafts: {
          ...state.drafts,
          [action.projectKey]: { prompt: action.prompt, chips: action.chips, mode: action.mode, kind: 'chat' },
        },
      };
    }
    case 'turnStarted': {
      const exists = state.conversations.some((c) => c.id === action.conversationId);
      const conversations = exists
        ? state.conversations.map((c) =>
            c.id === action.conversationId ? { ...c, turns: [...c.turns, action.turn] } : c,
          )
        : [
            ...state.conversations,
            {
              id: action.conversationId,
              projectKey: action.projectKey,
              title: titleOf(action.turn.prompt),
              turns: [action.turn],
            },
          ];
      // The chips stay for a follow-up question (the user removes what no longer applies); the mode is per question.
      const drafts = {
        ...state.drafts,
        [action.projectKey]: { ...draftOf(state, action.projectKey), prompt: '', mode: 'chat' as const },
      };
      return {
        ...state,
        conversations,
        drafts,
        active: { ...state.active, [action.projectKey]: action.conversationId },
        notice: null,
      };
    }
    case 'requestAssigned':
      return mapTurn(
        state,
        (turn) => turn.id === action.turnId,
        (turn) => (turn.status === 'sending' ? { ...turn, requestId: action.requestId, status: 'streaming' } : turn),
      );
    case 'requestFailed':
      return mapTurn(
        state,
        (turn) => turn.id === action.turnId,
        (turn) =>
          action.code === 'cancelled'
            ? { ...turn, status: 'cancelled', stopping: false }
            : { ...turn, status: 'error', stopping: false, error: { code: action.code, message: action.message } },
      );
    case 'stopping':
      return mapTurn(
        state,
        (turn) => turn.id === action.turnId && isRunning(turn),
        (turn) => ({ ...turn, stopping: true }),
      );
    case 'stopped':
      return mapTurn(
        state,
        (turn) => turn.id === action.turnId && isRunning(turn),
        (turn) => ({ ...turn, status: 'cancelled', stopping: false }),
      );
    case 'event':
      return mapTurn(
        state,
        (turn) => turn.requestId === action.event.requestId,
        (turn) => applyEvent(turn, action.event),
      );
    case 'consent':
      return { ...state, consentFor: action.projectKey };
    case 'notice':
      return { ...state, notice: action.notice };
  }
}
