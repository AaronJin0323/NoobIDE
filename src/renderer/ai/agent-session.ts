import type {
  AiChatMessage,
  AiErrorCode,
  AiEvent,
  AiFileChange,
  AiProposalDecision,
} from '../../shared/ipc/ai-contract';
import { failureForAgent, type ApplyFailure } from './agent-apply';

/**
 * State of the agent panel's conversation (S34.2): the user's prompts, the agent's streamed text and steps, its
 * proposals with a decision state per change, and how each turn ended. Pure (reducer + helpers), unit-tested.
 */
export type ChangeState = 'pending' | 'applying' | 'applied' | 'failed' | 'rejected' | 'expired';

export interface ChangeView {
  readonly state: ChangeState;
  readonly failure?: ApplyFailure;
}

export type AgentItem =
  | { readonly kind: 'prompt'; readonly id: number; readonly requestId: string; readonly text: string }
  | { readonly kind: 'text'; readonly id: number; readonly requestId: string; readonly text: string }
  | { readonly kind: 'step'; readonly id: number; readonly requestId: string; readonly summary: string }
  | {
      readonly kind: 'proposal';
      readonly id: number;
      readonly requestId: string;
      readonly proposalId: string;
      readonly changes: readonly AiFileChange[];
      readonly reason: string;
      readonly views: readonly ChangeView[];
      /** The decision was sent to the agent (or could not be: `reportFailed`). */
      readonly reported: boolean;
      readonly reportFailed?: boolean;
    }
  | {
      readonly kind: 'end';
      readonly id: number;
      readonly requestId: string;
      readonly error?: { readonly code: AiErrorCode; readonly message: string };
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    };

export interface AgentSessionState {
  readonly items: readonly AgentItem[];
  /** The running turn, if any. */
  readonly running: string | null;
  readonly nextId: number;
}

export const INITIAL_AGENT_SESSION: AgentSessionState = { items: [], running: null, nextId: 1 };

export type AgentAction =
  | { readonly type: 'started'; readonly requestId: string; readonly prompt: string }
  | { readonly type: 'event'; readonly event: AiEvent }
  | { readonly type: 'change'; readonly proposalId: string; readonly index: number; readonly view: ChangeView }
  | { readonly type: 'reported'; readonly proposalId: string; readonly failed: boolean };

export function agentReducer(state: AgentSessionState, action: AgentAction): AgentSessionState {
  switch (action.type) {
    case 'started':
      return {
        items: [...state.items, { kind: 'prompt', id: state.nextId, requestId: action.requestId, text: action.prompt }],
        running: action.requestId,
        nextId: state.nextId + 1,
      };
    case 'event':
      return applyEvent(state, action.event);
    case 'change':
      return mapProposal(state, action.proposalId, (item) => ({
        ...item,
        views: item.views.map((v, i) => (i === action.index ? action.view : v)),
      }));
    case 'reported':
      return mapProposal(state, action.proposalId, (item) => ({
        ...item,
        reported: true,
        ...(action.failed ? { reportFailed: true } : {}),
      }));
  }
}

type ProposalItem = Extract<AgentItem, { kind: 'proposal' }>;

function mapProposal(state: AgentSessionState, proposalId: string, f: (item: ProposalItem) => ProposalItem) {
  return {
    ...state,
    items: state.items.map((item) => (item.kind === 'proposal' && item.proposalId === proposalId ? f(item) : item)),
  };
}

function applyEvent(state: AgentSessionState, event: AiEvent): AgentSessionState {
  // Only the running turn's events are shown; a late event of an ended turn is ignored.
  if (event.requestId !== state.running) return state;
  const id = state.nextId;
  const push = (item: AgentItem): AgentSessionState => ({ ...state, items: [...state.items, item], nextId: id + 1 });
  switch (event.type) {
    case 'text': {
      const last = state.items[state.items.length - 1];
      if (last?.kind === 'text' && last.requestId === event.requestId) {
        return { ...state, items: [...state.items.slice(0, -1), { ...last, text: last.text + event.text }] };
      }
      return push({ kind: 'text', id, requestId: event.requestId, text: event.text.replace(/^\n+/, '') });
    }
    case 'step':
      return push({ kind: 'step', id, requestId: event.requestId, summary: event.summary });
    case 'proposal':
      return push({
        kind: 'proposal',
        id,
        requestId: event.requestId,
        proposalId: event.proposalId,
        changes: event.changes,
        reason: event.reason,
        views: event.changes.map(() => ({ state: 'pending' })),
        reported: false,
      });
    case 'done':
    case 'error': {
      // Undecided changes of the ended turn can no longer reach the agent: they expire, nothing is applied.
      const items = state.items.map((item) =>
        item.kind === 'proposal' && item.requestId === event.requestId
          ? { ...item, views: item.views.map((v) => (v.state === 'pending' ? { state: 'expired' as const } : v)) }
          : item,
      );
      const end: AgentItem =
        event.type === 'done'
          ? { kind: 'end', id, requestId: event.requestId, ...(event.usage ? { usage: event.usage } : {}) }
          : { kind: 'end', id, requestId: event.requestId, error: { code: event.code, message: event.message } };
      return { items: [...items, end], running: null, nextId: id + 1 };
    }
  }
}

/** The decision to send once every change of a proposal is decided (null while any is pending or applying). */
export function decisionOf(item: ProposalItem): AiProposalDecision | null {
  if (item.views.some((v) => v.state === 'pending' || v.state === 'applying' || v.state === 'expired')) return null;
  return {
    requestId: item.requestId,
    proposalId: item.proposalId,
    results: item.views.map((v) =>
      v.state === 'applied'
        ? { accepted: true as const, applied: true }
        : v.state === 'failed'
          ? { accepted: true as const, applied: false, error: v.failure ? failureForAgent(v.failure) : 'failed' }
          : { accepted: false as const },
    ),
  };
}

/** Earlier turns as text, oldest first, for the next request (the agent's own words and the user's prompts). */
export function conversationHistory(items: readonly AgentItem[]): AiChatMessage[] {
  const out: AiChatMessage[] = [];
  for (const item of items) {
    if (item.kind === 'prompt') out.push({ role: 'user', text: item.text });
    else if (item.kind === 'text' && item.text.trim() !== '') {
      const last = out[out.length - 1];
      if (last?.role === 'assistant') out[out.length - 1] = { role: 'assistant', text: `${last.text}\n\n${item.text}` };
      else out.push({ role: 'assistant', text: item.text });
    }
  }
  return out;
}
