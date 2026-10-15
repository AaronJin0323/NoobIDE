import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiTestEnv, setupAi } from './ai-main';
import { appDataPath } from './app-data-layout';
import type { KeyEncryptor } from '../ai/keys';

/**
 * S36.1 security review finding 1: NOOBIDE_AI_FAKE / NOOBIDE_AI_FAKE_AGENT (scripted provider + reversible test
 * encryptor) are honoured only in an unpackaged build; a packaged app uses the OS keychain and the real providers.
 */
describe('aiTestEnv', () => {
  const env = { NOOBIDE_AI_FAKE: '1', NOOBIDE_AI_FAKE_AGENT: 'edit-and-create' };

  it('unpackaged builds (npm start, tests, e2e) keep the test switches', () => {
    expect(aiTestEnv({ isPackaged: false, env })).toEqual({
      fakeScript: '1',
      fakeAgentScript: 'edit-and-create',
      ignored: false,
    });
  });

  it('a packaged app ignores them and says so', () => {
    expect(aiTestEnv({ isPackaged: true, env })).toEqual({
      fakeScript: undefined,
      fakeAgentScript: undefined,
      ignored: true,
    });
    expect(aiTestEnv({ isPackaged: true, env: {} }).ignored).toBe(false);
    expect(aiTestEnv({ isPackaged: false, env: { NOOBIDE_AI_FAKE: '' } }).fakeScript).toBeUndefined();
  });
});

describe('setupAi', () => {
  let userData: string;
  beforeEach(async () => {
    userData = await mkdtemp(path.join(os.tmpdir(), 'noobide-ai-main-'));
  });
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  function recordingKeychain() {
    const calls: string[] = [];
    const encryptor: KeyEncryptor = {
      isAvailable: () => true,
      encrypt: (plain) => {
        calls.push('encrypt');
        return Buffer.from(`os-keychain:${plain.length}`);
      },
      decrypt: () => {
        calls.push('decrypt');
        return 'x';
      },
    };
    return { calls, encryptor };
  }

  function setup(isPackaged: boolean, safeStorage: KeyEncryptor) {
    const logged: string[] = [];
    const ai = setupAi({
      ipcMain: { handle: () => undefined },
      allowedOrigin: 'noobide://app',
      userData,
      projects: {
        rootOf: () => undefined,
        read: async () => ({ ok: false }) as never,
        listDir: async () => ({ ok: false }) as never,
      },
      safeStorage,
      logger: () => undefined,
      log: (_level, event) => logged.push(event),
      isPackaged,
      fakeScript: '1',
      fakeAgentScript: 'edit-and-create',
    });
    return { ai, logged };
  }

  it('packaged + NOOBIDE_AI_FAKE: real providers and the OS keychain, never the test encryptor', async () => {
    const keychain = recordingKeychain();
    const { ai, logged } = setup(true, keychain.encryptor);
    expect(ai.fake).toBeNull();
    expect(logged).toContain('ai-fake-ignored');
    expect(await ai.service.setKey('anthropic', 'sk-ant-real-key-0123456789')).toEqual({ ok: true, value: null });
    expect(keychain.calls).toContain('encrypt');
    const stored = await readFile(appDataPath(userData, 'aiKeys'), 'utf8');
    expect(Buffer.from(stored).toString()).not.toContain('sk-ant-real-key');
    expect(stored).not.toContain(Buffer.from('noobide-test:').toString('base64').slice(0, 12));
  });

  it('unpackaged + NOOBIDE_AI_FAKE: the scripted fake and the test encryptor (keychain untouched)', async () => {
    const keychain = recordingKeychain();
    const { ai, logged } = setup(false, keychain.encryptor);
    expect(ai.fake).not.toBeNull();
    expect(logged).not.toContain('ai-fake-ignored');
    expect(await ai.service.setKey('anthropic', 'sk-ant-test')).toEqual({ ok: true, value: null });
    expect(keychain.calls).toEqual([]);
  });
});
