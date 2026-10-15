import { describe, expect, it } from 'vitest';
import type { AiApi, AiProposalDecision } from '../../shared/ipc/ai-contract';
import { AgentDecisionStore, decisionOf, type DecisionContext, type ProposalRef } from './agent-decisions';
import { fakeAgentHost } from './agent-host.test-util';

const proposal: ProposalRef = {
  requestId: 'r1-request-id',
  label: 'Make it blue and add an about page',
  proposalId: 'p1',
  changes: [
    { kind: 'edit', relPath: 'style.css', before: 'red', after: 'blue' },
    { kind: 'create', relPath: 'about.html', after: '<h1>About</h1>' },
  ],
};

function setup(live = true) {
  const env = fakeAgentHost({ 'style.css': { text: 'red', hash: 'h0' } });
  const sent: AiProposalDecision[] = [];
  const api = {
    resolveProposal: async (decision: AiProposalDecision) => {
      sent.push(decision);
      return { ok: true, value: null };
    },
  } as unknown as AiApi;
  const ctx: DecisionContext = { api, host: env.host, live: () => live };
  const text = () => Object.fromEntries(Object.entries(env.files).map(([k, v]) => [k, v.text]));
  return { store: new AgentDecisionStore(), ctx, sent, text, ...env };
}

describe('AgentDecisionStore (S34.2)', () => {
  it('applies an accepted change, records a rejection, and reports once when every change is decided', async () => {
    const { store, ctx, text, sent } = setup();
    await store.accept(ctx, proposal, 0);
    expect(text()['style.css']).toBe('blue');
    expect(sent).toHaveLength(0);
    store.reject(ctx, proposal, 1);
    expect(text()['about.html']).toBeUndefined();
    expect(sent).toEqual([
      {
        requestId: 'r1-request-id',
        proposalId: 'p1',
        results: [{ accepted: true, applied: true }, { accepted: false }],
      },
    ]);
    store.reject(ctx, proposal, 1);
    expect(sent).toHaveLength(1);
    expect(store.state(proposal).views.map((v) => v.state)).toEqual(['applied', 'rejected']);
  });

  it('records accepted changes in the turn’s local-history group, labelled with the request', async () => {
    const { store, ctx, groups } = setup();
    await store.acceptAll(ctx, proposal);
    const group = groups.get('r1-request-id');
    expect(group?.label).toBe(proposal.label);
    expect(group?.steps.map((s) => [s.kind, s.relPath])).toEqual([
      ['edit', 'style.css'],
      ['create', 'about.html'],
    ]);
  });

  it('a failed apply is reported to the agent as accepted but not applied', async () => {
    const { store, ctx, files, sent } = setup();
    files['about.html'] = { text: 'already here', hash: 'hx' };
    await store.acceptAll(ctx, proposal);
    expect(files['about.html']?.text).toBe('already here');
    expect(sent[0]?.results[1]).toEqual({
      accepted: true,
      applied: false,
      error: 'Something with that name already exists. (changed-on-disk)',
    });
  });

  it('an ended turn takes no decisions and nothing is applied', async () => {
    const { store, ctx, text, sent } = setup(false);
    await store.accept(ctx, proposal, 0);
    store.rejectAll(ctx, proposal);
    expect(text()['style.css']).toBe('red');
    expect(sent).toHaveLength(0);
  });

  it('undoes the turn from its history group, once; a new store (after a reload) can undo it too', async () => {
    const { store, ctx, text, host, groups } = setup();
    await store.acceptAll(ctx, proposal);
    expect(store.canUndo('r1-request-id')).toBe(true);
    const result = await store.undo(host, 'r1-request-id');
    expect(result).toEqual({ undone: 2, failures: [] });
    expect(text()).toEqual({ 'style.css': 'red' });
    expect(store.undoResult('r1-request-id')).toEqual({ undone: 2, failures: [] });
    expect(store.canUndo('r1-request-id')).toBe(false);
    expect(groups.get('r1-request-id')?.undoneAt).not.toBeNull();

    // Reload: the decisions store is new and empty; the History window undoes from local history alone.
    const again = setup();
    await again.store.acceptAll(again.ctx, proposal);
    const fresh = new AgentDecisionStore();
    expect(fresh.canUndo('r1-request-id')).toBe(false);
    expect(await fresh.undo(again.host, 'r1-request-id')).toEqual({ undone: 2, failures: [] });
    expect(again.text()).toEqual({ 'style.css': 'red' });
  });

  it('decisionOf waits for every change', () => {
    expect(decisionOf(proposal, [{ state: 'applied' }, { state: 'applying' }])).toBeNull();
    expect(decisionOf(proposal, [{ state: 'applied' }])).toBeNull();
  });
});
