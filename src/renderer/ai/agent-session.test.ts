import { describe, expect, it } from 'vitest';
import {
  INITIAL_AGENT_SESSION,
  agentReducer,
  conversationHistory,
  decisionOf,
  type AgentSessionState,
} from './agent-session';

const started = agentReducer(INITIAL_AGENT_SESSION, { type: 'started', requestId: 'r1', prompt: 'Add an about page' });
const withProposal = agentReducer(started, {
  type: 'event',
  event: {
    requestId: 'r1',
    type: 'proposal',
    proposalId: 'p1',
    reason: 'Because.',
    changes: [
      { kind: 'edit', relPath: 'index.html', before: 'a', after: 'b' },
      { kind: 'create', relPath: 'about.html', after: 'c' },
    ],
  },
});
const proposalOf = (state: AgentSessionState) => {
  const item = state.items.find((i) => i.kind === 'proposal');
  if (!item || item.kind !== 'proposal') throw new Error('no proposal');
  return item;
};

describe('agent session (S34.2)', () => {
  it('collects streamed text into one item per stretch and ignores other requests', () => {
    let state = agentReducer(started, { type: 'event', event: { requestId: 'r1', type: 'text', text: 'Hel' } });
    state = agentReducer(state, { type: 'event', event: { requestId: 'r1', type: 'text', text: 'lo' } });
    state = agentReducer(state, { type: 'event', event: { requestId: 'other', type: 'text', text: 'nope' } });
    state = agentReducer(state, {
      type: 'event',
      event: { requestId: 'r1', type: 'step', tool: 'read_file', summary: 'Read a' },
    });
    state = agentReducer(state, { type: 'event', event: { requestId: 'r1', type: 'text', text: '\n\nDone' } });
    expect(state.items.map((i) => (i.kind === 'text' ? i.text : i.kind))).toEqual(['prompt', 'Hello', 'step', 'Done']);
  });

  it('reports a decision only when every change is decided, with each outcome', () => {
    expect(decisionOf(proposalOf(withProposal))).toBeNull();
    let state = agentReducer(withProposal, { type: 'change', proposalId: 'p1', index: 0, view: { state: 'applied' } });
    expect(decisionOf(proposalOf(state))).toBeNull();
    state = agentReducer(state, { type: 'change', proposalId: 'p1', index: 1, view: { state: 'applying' } });
    expect(decisionOf(proposalOf(state))).toBeNull();
    state = agentReducer(state, {
      type: 'change',
      proposalId: 'p1',
      index: 1,
      view: { state: 'failed', failure: { code: 'exists' } },
    });
    expect(decisionOf(proposalOf(state))).toEqual({
      requestId: 'r1',
      proposalId: 'p1',
      results: [
        { accepted: true, applied: true },
        { accepted: true, applied: false, error: 'Something with that name already exists.' },
      ],
    });
    const rejected = agentReducer(withProposal, {
      type: 'change',
      proposalId: 'p1',
      index: 0,
      view: { state: 'rejected' },
    });
    const both = agentReducer(rejected, { type: 'change', proposalId: 'p1', index: 1, view: { state: 'rejected' } });
    expect(decisionOf(proposalOf(both))?.results).toEqual([{ accepted: false }, { accepted: false }]);
  });

  it('when the turn ends, undecided changes expire (never applied) and the turn stops running', () => {
    const state = agentReducer(withProposal, {
      type: 'event',
      event: { requestId: 'r1', type: 'error', code: 'cancelled', message: 'Stopped.' },
    });
    expect(state.running).toBeNull();
    expect(proposalOf(state).views.map((v) => v.state)).toEqual(['expired', 'expired']);
    expect(decisionOf(proposalOf(state))).toBeNull();
    expect(state.items[state.items.length - 1]).toMatchObject({ kind: 'end', error: { code: 'cancelled' } });
  });

  it('builds the text history of earlier turns', () => {
    let state = agentReducer(started, { type: 'event', event: { requestId: 'r1', type: 'text', text: 'I will' } });
    state = agentReducer(state, { type: 'event', event: { requestId: 'r1', type: 'step', tool: 'x', summary: 's' } });
    state = agentReducer(state, { type: 'event', event: { requestId: 'r1', type: 'text', text: 'Done.' } });
    state = agentReducer(state, { type: 'event', event: { requestId: 'r1', type: 'done' } });
    expect(conversationHistory(state.items)).toEqual([
      { role: 'user', text: 'Add an about page' },
      { role: 'assistant', text: 'I will\n\nDone.' },
    ]);
  });
});
