import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCheckpointsIpcHandlers } from '../../src/main/checkpoints-ipc';
import { CheckpointStore } from '../../src/recovery/checkpoints';
import { SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers } from '../../src/recovery/history-triggers';
import { AgentDecisionStore, type ProposalRef } from '../../src/renderer/ai/agent-decisions';
import type { AgentApplyHost } from '../../src/renderer/ai/agent-apply';
import { fakeAgentHost } from '../../src/renderer/ai/agent-host.test-util';
import { autoCheckpointName, takeAutoCheckpoint } from '../../src/renderer/checkpoints/auto-checkpoint';
import { CHECKPOINT_CHANNELS, type CheckpointsApi } from '../../src/shared/ipc/checkpoints-contract';
import type { AiApi } from '../../src/shared/ipc/ai-contract';
import { ProjectService } from '../../src/workspace/project-service';

/**
 * S56.3 integration: automatic checkpoints over the real main side (checkpoint IPC handlers, store, project folder
 * with Chinese characters and spaces), taken right before an AI agent proposal is applied (through the decision store
 * the chat uses) and before a local-history restore (through the hook the workbench uses), labelled with the cause.
 */
const ORIGIN = 'noobide://app';
const event = { senderFrame: { url: `${ORIGIN}/index.html`, parent: null }, sender: { id: 1 } } as unknown as IpcMainInvokeEvent; // prettier-ignore

let tmp: string;
let root: string;
let history: SnapshotStore;
let checkpoints: CheckpointStore;
let projects: ProjectService;
let projectId: string;
let api: CheckpointsApi;

beforeEach(async () => {
  // The real path: on hosted Windows runners TEMP is an 8.3 short name (C:UsersRUNNER~1...) and the store
  // keys projects by the real root ProjectService opens, so the raw mkdtemp path would never be found.
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-cp-auto-')));
  root = path.join(tmp, '我的 网站');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'style.css'), 'red');
  await writeFile(path.join(root, 'index.html'), '<h1>旧</h1>');
  history = new SnapshotStore({ dir: path.join(tmp, 'app data', 'history') });
  checkpoints = new CheckpointStore({ dir: path.join(tmp, 'app data', 'checkpoints'), history });
  projects = new ProjectService({ history: new HistoryTriggers(history) });
  const opened = await projects.open(root);
  if (!opened.ok) throw new Error(opened.code);
  projectId = opened.value.projectId;
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  registerCheckpointsIpcHandlers(
    { handle: (ch: string, fn: unknown) => void handlers.set(ch, fn as never) } as unknown as IpcMain,
    { allowedOrigin: ORIGIN, store: checkpoints, projects },
  );
  api = Object.fromEntries(
    Object.entries(CHECKPOINT_CHANNELS).map(([key, channel]) => [
      key,
      (request: unknown) => handlers.get(channel)?.(event, request),
    ]),
  ) as unknown as CheckpointsApi;
});

afterEach(async () => {
  await history.idle();
  await rm(tmp, { recursive: true, force: true });
});

async function content(id: string, relPath: string): Promise<string> {
  const data = await checkpoints.readFile(root, id, relPath);
  if (!data.ok) throw new Error(data.code);
  return new TextDecoder().decode(data.value);
}

describe('S56.3 automatic checkpoints', () => {
  it('are taken once right before an agent proposal is applied, labelled with the cause and the request', async () => {
    const env = fakeAgentHost({ 'style.css': { text: 'red', hash: 'h0' } });
    const order: string[] = [];
    // The agent's writes land on the real project files, so the checkpoint can be checked against them.
    const writeFile0 = env.host.workspace.writeFile;
    const host: AgentApplyHost = {
      ...env.host,
      workspace: {
        ...env.host.workspace,
        async writeFile(request) {
          order.push(`write ${request.relPath}`);
          await writeFile(path.join(root, ...request.relPath.split('/')), request.text);
          return writeFile0(request);
        },
      },
      checkpointBeforeAi: async (label) => {
        order.push('checkpoint');
        await takeAutoCheckpoint(api, projectId, 'before-ai', `Before AI assistant changes: ${label}`);
      },
    };
    const proposal: ProposalRef = {
      requestId: 'r1-request-id',
      label: 'Make it blue and add an about page',
      proposalId: 'p1',
      changes: [
        { kind: 'edit', relPath: 'style.css', before: 'red', after: 'blue' },
        { kind: 'create', relPath: 'about.html', after: '<h1>About</h1>' },
      ],
    };
    const store = new AgentDecisionStore();
    const ctx = {
      api: { resolveProposal: async () => ({ ok: true, value: null }) } as unknown as AiApi,
      host,
      live: () => true,
    };
    await store.acceptAll(ctx, proposal);
    // One checkpoint for the proposal, before its first change.
    expect(order).toEqual(['checkpoint', 'write style.css', 'write about.html']);
    const listed = await api.list({ projectId });
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value.checkpoints).toHaveLength(1);
    const cp = listed.value.checkpoints[0]!;
    expect(cp).toMatchObject({ kind: 'auto', cause: 'before-ai' });
    expect(cp.name).toBe('Before AI assistant changes: Make it blue and add an about page');
    // It holds the project as it was before the change.
    expect(await content(cp.id, 'style.css')).toBe('red');
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe('blue');
  });

  it('the agent change still goes ahead when no checkpoint can be taken', async () => {
    const env = fakeAgentHost({ 'style.css': { text: 'red', hash: 'h0' } });
    const host: AgentApplyHost = {
      ...env.host,
      checkpointBeforeAi: async () => {
        throw new Error('storage full');
      },
    };
    const store = new AgentDecisionStore();
    const ctx = {
      api: { resolveProposal: async () => ({ ok: true, value: null }) } as unknown as AiApi,
      host,
      live: () => true,
    };
    await store.accept(
      ctx,
      {
        requestId: 'r2-request-id',
        label: 'x',
        proposalId: 'p2',
        changes: [{ kind: 'edit', relPath: 'style.css', before: 'red', after: 'blue' }],
      },
      0,
    );
    expect(env.files['style.css']?.text).toBe('blue');
  });

  it('are taken before a local-history restore, labelled with the cause', async () => {
    // A version in local history, then the restore the History window does (keep the current content, write the
    // version through the save path) — preceded by the automatic checkpoint the workbench takes.
    await history.snapshot(root, 'index.html', new TextEncoder().encode('<h1>旧</h1>'), 'after-save');
    await writeFile(path.join(root, 'index.html'), '<h1>新 但是 坏了</h1>');
    const taken = await takeAutoCheckpoint(
      api,
      projectId,
      'before-history-restore',
      'Before restoring index.html from local history',
    );
    expect(taken).toEqual({ taken: true, deduped: false });
    await new HistoryTriggers(history).beforeRestore(root, 'index.html', path.join(root, 'index.html'));
    const written = await projects.write({ projectId, relPath: 'index.html', text: '<h1>旧</h1>', bom: false });
    expect(written.ok).toBe(true);

    const listed = await api.list({ projectId });
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value.checkpoints.map((c) => [c.kind, c.cause, c.name])).toEqual([
      ['auto', 'before-history-restore', 'Before restoring index.html from local history'],
    ]);
    expect(await content(listed.value.checkpoints[0]!.id, 'index.html')).toBe('<h1>新 但是 坏了</h1>');
  });

  it('a second automatic checkpoint of an unchanged project is not stored again; long labels are clipped', async () => {
    expect((await takeAutoCheckpoint(api, projectId, 'before-ai', 'one')).taken).toBe(true);
    expect(await takeAutoCheckpoint(api, projectId, 'before-history-restore', 'two')).toEqual({
      taken: true,
      deduped: true,
    });
    expect(autoCheckpointName('x'.repeat(200))).toHaveLength(80);
    expect(await takeAutoCheckpoint(undefined, projectId, 'before-ai', 'no bridge')).toEqual({
      taken: false,
      code: 'no-bridge',
    });
  });
});
