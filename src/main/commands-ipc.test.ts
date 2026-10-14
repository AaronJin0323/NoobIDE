import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerCommandIpcHandlers } from './commands-ipc';
import { COMMAND_CHANNELS } from '../shared/ipc/commands-contract';

const ORIGIN = 'noobide://app';
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
const eventFrom = (url: string | null, topLevel = true) =>
  ({
    sender: { id: 3 },
    senderFrame: url === null ? null : { url, parent: topLevel ? null : {} },
  }) as unknown as IpcMainInvokeEvent;

function setup() {
  const handlers = new Map<string, Handler>();
  const setContext = vi.fn();
  registerCommandIpcHandlers(
    { handle: (channel, h) => void handlers.set(channel, h as Handler) },
    {
      allowedOrigin: ORIGIN,
      setContext,
    },
  );
  const call = (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    (handlers.get(COMMAND_CHANNELS.setContext) as Handler)(event, ...args);
  return { call, setContext };
}

const CONTEXT = { hasProject: true, hasActiveTab: false, modalOpen: false };

describe('command context channel (S24.2)', () => {
  it('accepts a valid context from the workbench', async () => {
    const { call, setContext } = setup();
    expect(await call(eventFrom(`${ORIGIN}/index.html`), CONTEXT)).toEqual({ ok: true, value: null });
    expect(setContext).toHaveBeenCalledWith(3, CONTEXT);
  });

  it('refuses other senders and malformed payloads before anything runs', async () => {
    const { call, setContext } = setup();
    for (const stranger of [eventFrom('https://evil.example/'), eventFrom(`${ORIGIN}/`, false), eventFrom(null)]) {
      expect(await call(stranger, CONTEXT)).toMatchObject({ ok: false, code: 'forbidden-sender' });
    }
    const workbench = eventFrom(`${ORIGIN}/index.html`);
    expect(await call(workbench)).toMatchObject({ code: 'invalid-request' });
    expect(await call(workbench, CONTEXT, CONTEXT)).toMatchObject({ code: 'invalid-request' });
    expect(await call(workbench, { ...CONTEXT, run: 'rm' })).toMatchObject({ code: 'invalid-request' });
    expect(await call(workbench, { ...CONTEXT, hasProject: 'yes' })).toMatchObject({ code: 'invalid-request' });
    expect(setContext).not.toHaveBeenCalled();
  });
});
