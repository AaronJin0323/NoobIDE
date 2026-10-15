import { describe, expect, it, vi } from 'vitest';
import { NotOwnerError, ServerRegistry, type ManagedServer } from './server-registry';

/** S14.6: one server per open project, released on switch/close, with an ownership check. */

interface FakeServer extends ManagedServer {
  closed: boolean;
}

function registry(options: { fail?: boolean } = {}) {
  let next = 40_000;
  const started: FakeServer[] = [];
  const start = vi.fn(async (root: string, opts: { readonly preferredPort?: number | undefined }) => {
    await Promise.resolve();
    if (options.fail) throw new Error('EADDRINUSE');
    const server: FakeServer = {
      root,
      port: opts.preferredPort ?? next++,
      closed: false,
      close: vi.fn(async () => {
        server.closed = true;
      }),
    };
    started.push(server);
    return server;
  });
  return { reg: new ServerRegistry(start), start, started };
}

const A = { projectId: 'project-a', windowId: 1 };
const B = { projectId: 'project-b', windowId: 1 };

describe('server registry (S14.6)', () => {
  it('hands the same server to its owner: never two servers for one project', async () => {
    const { reg, start } = registry();
    const [one, two] = await Promise.all([reg.acquire(A, '/a'), reg.acquire(A, '/a')]);
    expect(one).toBe(two);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reg.projects).toEqual(['project-a']);
  });

  it('refuses a request from another window (ownership check) and leaves the server running', async () => {
    const { reg, started } = registry();
    await reg.acquire(A, '/a');
    await expect(reg.acquire({ projectId: 'project-a', windowId: 2 }, '/a')).rejects.toBeInstanceOf(NotOwnerError);
    expect(await reg.release('project-a', { projectId: 'project-a', windowId: 2 })).toBe(false);
    expect(await reg.release('project-a', { projectId: 'project-b', windowId: 1 })).toBe(false);
    expect(started[0]?.closed).toBe(false);
    expect(reg.isOwner(A)).toBe(true);
    expect(reg.isOwner({ projectId: 'project-a', windowId: 2 })).toBe(false);
    expect(reg.ownerOf('project-a')).toEqual(A);
  });

  it('the owner releases its server: it is closed and the next acquire starts a new one on the same port', async () => {
    const { reg, started } = registry();
    const first = await reg.acquire(A, '/a');
    expect(await reg.release('project-a', A)).toBe(true);
    expect(first.closed).toBe(true);
    expect(reg.projects).toEqual([]);
    const second = await reg.acquire(A, '/a');
    expect(second).not.toBe(first);
    expect(second.port).toBe(first.port); // same origin → same localStorage
    expect(started).toHaveLength(2);
  });

  it('switching projects shuts every other project’s server down', async () => {
    const { reg } = registry();
    const a = await reg.acquire(A, '/a');
    const b = await reg.acquire(B, '/b');
    await reg.releaseAllExcept('project-b');
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(reg.projects).toEqual(['project-b']);
    await reg.releaseAllExcept(null);
    expect(b.closed).toBe(true);
    expect(reg.projects).toEqual([]);
  });

  it('closing a project (main lifecycle, no requester) releases it whoever owns it', async () => {
    const { reg } = registry();
    const a = await reg.acquire({ projectId: 'project-a', windowId: 7 }, '/a');
    expect(await reg.release('project-a')).toBe(true);
    expect(a.closed).toBe(true);
    expect(await reg.release('project-a')).toBe(false);
  });

  it('a closed window releases only its own servers', async () => {
    const { reg } = registry();
    const a = await reg.acquire({ projectId: 'project-a', windowId: 1 }, '/a');
    const b = await reg.acquire({ projectId: 'project-b', windowId: 2 }, '/b');
    await reg.releaseWindow(1);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
  });

  it('a failed start leaves no entry behind', async () => {
    const { reg } = registry({ fail: true });
    await expect(reg.acquire(A, '/a')).rejects.toThrow('EADDRINUSE');
    expect(reg.projects).toEqual([]);
    expect(await reg.release('project-a')).toBe(false);
  });

  it('overlapping starts by the owner share one server: a superseded start does not close it (lease count)', async () => {
    const { reg, start } = registry();
    const first = reg.acquire(A, '/a'); // start 1 (superseded)
    const second = reg.acquire(A, '/a'); // start 2 (current)
    const server = await second;
    expect(await first).toBe(server);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await reg.release('project-a', A)).toBe(false); // start 1 gives its lease back
    expect(server.closed).toBe(false);
    expect(reg.projects).toEqual(['project-a']);
    expect(await reg.release('project-a')).toBe(true); // Stop
    expect(server.closed).toBe(true);
  });

  it('a release during start closes the server once it is up', async () => {
    const { reg } = registry();
    const pending = reg.acquire(A, '/a');
    await reg.release('project-a');
    const server = await pending;
    expect(server.closed).toBe(true);
    expect(reg.projects).toEqual([]);
  });
});
