import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEncryptor, KeyStore, normalizeKey, type KeyEncryptor } from './keys';

/** S31.2: keys encrypted into app data, never in plaintext, never logged; no secure storage → not stored. */
const KEY = 'sk-ant-api03-SECRET-abcdefghijklmnopqrstuvwxyz0123456789';

let dir: string;
let file: string;
let logged: string[];
const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) =>
  logged.push(JSON.stringify({ event, ...fields }));

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-keys-'));
  file = path.join(dir, '密钥 目录', 'ai-keys.json');
  logged = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AI key store (S31.2)', () => {
  it('stores the key encrypted, reads it back in main, survives a restart and clears it', async () => {
    const store = new KeyStore({ file, encryptor: createTestEncryptor(true), log });
    expect(await store.stored()).toEqual({ anthropic: false, openai: false });
    expect(await store.set('anthropic', `  ${KEY}\n`)).toEqual({ ok: true, value: null });
    expect(await store.stored()).toEqual({ anthropic: true, openai: false });
    expect(await store.get('anthropic')).toBe(KEY);

    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text)).toMatchObject({ version: 1, keys: { anthropic: expect.any(String) } });

    const reopened = new KeyStore({ file, encryptor: createTestEncryptor(true), log });
    expect(await reopened.get('anthropic')).toBe(KEY);
    expect(await reopened.clear('anthropic')).toEqual({ ok: true, value: null });
    expect(await reopened.stored()).toEqual({ anthropic: false, openai: false });
    expect(await reopened.get('anthropic')).toBeNull();
    expect(await readFile(file, 'utf8')).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain('SECRET');
    expect(logged.some((line) => line.includes('ai-key-stored'))).toBe(true);
  });

  it('does not store a key without secure storage', async () => {
    const store = new KeyStore({ file, encryptor: createTestEncryptor(false), log });
    expect(store.secureStorageAvailable()).toBe(false);
    expect(await store.set('openai', KEY)).toMatchObject({ ok: false, code: 'no-secure-storage' });
    expect(await store.stored()).toEqual({ anthropic: false, openai: false });
    await expect(readdir(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a throwing keychain as unavailable', async () => {
    const broken: KeyEncryptor = {
      isAvailable: () => {
        throw new Error('no keychain');
      },
      encrypt: () => Buffer.alloc(0),
      decrypt: () => '',
    };
    const store = new KeyStore({ file, encryptor: broken });
    expect(await store.set('anthropic', KEY)).toMatchObject({ ok: false, code: 'no-secure-storage' });
  });

  it('rejects empty, oversized or non-key text and unknown providers', async () => {
    const store = new KeyStore({ file, encryptor: createTestEncryptor(true) });
    expect(await store.set('anthropic', '   ')).toMatchObject({ code: 'empty-key' });
    expect(await store.set('anthropic', 'a'.repeat(600))).toMatchObject({ code: 'empty-key' });
    expect(await store.set('anthropic', 'two words')).toMatchObject({ code: 'empty-key' });
    expect(await store.set('gemini' as 'openai', KEY)).toMatchObject({ code: 'invalid-provider' });
    expect(normalizeKey('密钥')).toBeNull();
  });

  it('a key that cannot be decrypted (another machine) reads as missing, without logging it', async () => {
    const store = new KeyStore({ file, encryptor: createTestEncryptor(true), log });
    await store.set('openai', KEY);
    const other: KeyEncryptor = {
      isAvailable: () => true,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => {
        throw new Error('cannot decrypt');
      },
    };
    expect(await new KeyStore({ file, encryptor: other, log }).get('openai')).toBeNull();
    expect(logged.some((l) => l.includes('ai-key-unreadable'))).toBe(true);
  });

  it('backs up a corrupt file and never writes a file from a newer NoobIDE', async () => {
    await new KeyStore({ file, encryptor: createTestEncryptor(true) }).set('anthropic', KEY);
    await writeFile(file, '{ not json');
    const store = new KeyStore({ file, encryptor: createTestEncryptor(true), log });
    expect(await store.stored()).toEqual({ anthropic: false, openai: false });
    expect((await readdir(path.dirname(file))).some((n) => n.startsWith('ai-keys.corrupt-'))).toBe(true);

    const newer = JSON.stringify({ version: 9, keys: {} });
    await writeFile(file, newer);
    const downgraded = new KeyStore({ file, encryptor: createTestEncryptor(true), log });
    expect(await downgraded.set('anthropic', KEY)).toMatchObject({ ok: false, code: 'write-failed' });
    expect(await readFile(file, 'utf8')).toBe(newer);
  });
});
