import { describe, expect, it } from 'vitest';
import type { AiApi, AiProposalDecision } from '../../shared/ipc/ai-contract';
import type { AgentApplyHost } from './agent-apply';
import { AgentDecisionStore, decisionOf, type DecisionContext, type ProposalRef } from './agent-decisions';

const proposal: ProposalRef = {
  requestId: 'r1',
  proposalId: 'p1',
  changes: [
    { kind: 'edit', relPath: 'style.css', before: 'red', after: 'blue' },
    { kind: 'create', relPath: 'about.html', after: '<h1>About</h1>' },
  ],
};

function setup(live = true) {
  const files: Record<string, string> = { 'style.css': 'red' };
  const sent: AiProposalDecision[] = [];
  const host = {
    projectId: 'p',
    workspace: {
      readFile: async ({ relPath }: { relPath: string }) =>
        files[relPath] === undefined
          ? { ok: false, code: 'not-found', message: '' }
          : {
              ok: true,
              value: {
                text: files[relPath],
                eol: '\n',
                bom: false,
                uri: '',
                mixedEol: false,
                version: { mtimeMs: 1, size: 1, hash: 'h' },
              },
            },
      writeFile: async ({ relPath, text, create }: { relPath: string; text: string; create?: boolean }) => {
        if (create && files[relPath] !== undefined) return { ok: false, code: 'changed-on-disk', message: '' };
        files[relPath] = text;
        return { ok: true, value: { savedAt: 1, version: { mtimeMs: 1, size: 1, hash: 'x' } } };
      },
      createEntry: async () => ({ ok: true, value: { relPath: '' } }),
      renameEntry: async () => ({ ok: false, code: 'not-found', message: '' }),
      trashEntry: async ({ relPath }: { relPath: string }) => {
        delete files[relPath];
        return { ok: true, value: null };
      },
    },
    history: {
      versions: async () => ({ ok: true, value: [] }),
      restoreDeleted: async () => ({ ok: false, code: 'not-found', message: '' }),
    },
    fileOps: { beforeChange: async () => true, afterChange: () => undefined },
    openTab: () => undefined,
    replaceOpenText: async () => null,
    openFile: () => undefined,
  } as unknown as AgentApplyHost;
  const api = {
    resolveProposal: async (decision: AiProposalDecision) => {
      sent.push(decision);
      return { ok: true, value: null };
    },
  } as unknown as AiApi;
  const ctx: DecisionContext = { api, host, live: () => live };
  return { store: new AgentDecisionStore(), ctx, files, sent, host };
}

describe('AgentDecisionStore (S34.2)', () => {
  it('applies an accepted change, records a rejection, and reports once when every change is decided', async () => {
    const { store, ctx, files, sent } = setup();
    await store.accept(ctx, proposal, 0);
    expect(files['style.css']).toBe('blue');
    expect(sent).toHaveLength(0);
    store.reject(ctx, proposal, 1);
    expect(files['about.html']).toBeUndefined();
    expect(sent).toEqual([
      { requestId: 'r1', proposalId: 'p1', results: [{ accepted: true, applied: true }, { accepted: false }] },
    ]);
    store.reject(ctx, proposal, 1);
    expect(sent).toHaveLength(1);
    expect(store.state(proposal).views.map((v) => v.state)).toEqual(['applied', 'rejected']);
  });

  it('a failed apply is reported to the agent as accepted but not applied', async () => {
    const { store, ctx, files, sent } = setup();
    files['about.html'] = 'already here';
    await store.acceptAll(ctx, proposal);
    expect(files['about.html']).toBe('already here');
    expect(sent[0]?.results[1]).toEqual({
      accepted: true,
      applied: false,
      error: 'Something with that name already exists. (changed-on-disk)',
    });
  });

  it('an ended turn takes no decisions and nothing is applied', async () => {
    const { store, ctx, files, sent } = setup(false);
    await store.accept(ctx, proposal, 0);
    store.rejectAll(ctx, proposal);
    expect(files['style.css']).toBe('red');
    expect(sent).toHaveLength(0);
  });

  it('undoes the turn’s applied changes as a group, once', async () => {
    const { store, ctx, files, host } = setup();
    await store.acceptAll(ctx, proposal);
    expect(store.canUndo('r1')).toBe(true);
    await store.undo(host, 'r1');
    expect(files).toEqual({ 'style.css': 'red' });
    expect(store.undoResult('r1')).toEqual({ undone: 2, failures: [] });
    expect(store.canUndo('r1')).toBe(false);
  });

  it('decisionOf waits for every change', () => {
    expect(decisionOf(proposal, [{ state: 'applied' }, { state: 'applying' }])).toBeNull();
    expect(decisionOf(proposal, [{ state: 'applied' }])).toBeNull();
  });
});
