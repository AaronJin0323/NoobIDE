import { SerialQueue, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { backupFile, readJsonFile, schemaVersionOf } from '../main/json-file';
import { AI_PROVIDERS, type AiKeyError, type AiProviderId } from '../shared/ipc/ai-contract';
import { err, ok, type Result } from '../shared/result';

/**
 * The user's AI API keys (S31.2, decision 0025), encrypted with Electron `safeStorage` (the OS keychain / DPAPI) into
 * `<userData>/ai-keys.json`. Main process only:
 *
 * - a key is written once (`set`) and read back only by main to build a provider (`get`); it is never returned to a
 *   renderer, never logged (the log gets event names and codes only) and never written into a project;
 * - without secure storage the key is not stored at all (`no-secure-storage`) and AI stays off with an explanation;
 * - the file holds only base64 ciphertext, so the key string never appears in it;
 * - same robustness as the other app-data stores: atomic writes, a corrupt file is backed up and reset, an
 *   unreadable one or one written by a newer NoobIDE (S28.4) is never overwritten (keys cannot be saved then).
 */
export const AI_KEYS_VERSION = 1;
/** Longest key accepted (real keys are ~100–200 characters). */
export const MAX_KEY_LENGTH = 512;

/** Encryption backed by the OS; `safeStorage` in the app, a fake in tests. */
export interface KeyEncryptor {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export interface KeyStoreOptions {
  readonly file: string;
  readonly encryptor: KeyEncryptor;
  readonly log?: RecoveryLogger;
}

interface KeyFile {
  readonly version: typeof AI_KEYS_VERSION;
  /** Base64 of the encrypted key, per provider. */
  readonly keys: Partial<Record<AiProviderId, string>>;
}

const EMPTY: KeyFile = { version: AI_KEYS_VERSION, keys: {} };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function loadKeyFile(raw: unknown): KeyFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY;
  const keys = (raw as { keys?: unknown }).keys;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return EMPTY;
  const out: Partial<Record<AiProviderId, string>> = {};
  for (const provider of AI_PROVIDERS) {
    const value = (keys as Record<string, unknown>)[provider];
    if (typeof value === 'string' && BASE64.test(value)) out[provider] = value;
  }
  return { version: AI_KEYS_VERSION, keys: out };
}

/** A key as pasted: trimmed; printable ASCII without spaces. Returns null when it cannot be a key. */
export function normalizeKey(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) return null;
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : null;
}

export class KeyStore {
  private state: KeyFile = EMPTY;
  private loaded: Promise<void> | null = null;
  private readonly queue = new SerialQueue();
  private writable = true;

  constructor(private readonly options: KeyStoreOptions) {}

  /** Whether keys can be stored (OS keychain available). */
  secureStorageAvailable(): boolean {
    try {
      return this.options.encryptor.isAvailable();
    } catch {
      return false;
    }
  }

  /** Which providers have a stored key. */
  async stored(): Promise<Record<AiProviderId, boolean>> {
    this.load();
    return this.queue.run(async () => ({
      anthropic: this.state.keys.anthropic !== undefined,
      openai: this.state.keys.openai !== undefined,
    }));
  }

  async set(provider: AiProviderId, key: string): Promise<Result<null, AiKeyError>> {
    if (!AI_PROVIDERS.includes(provider)) return err('invalid-provider', 'unknown provider');
    const normalized = normalizeKey(key);
    if (normalized === null) return err('empty-key', 'the key is empty or not a key');
    if (!this.secureStorageAvailable()) return err('no-secure-storage', 'secure storage is not available');
    let cipher: string;
    try {
      cipher = this.options.encryptor.encrypt(normalized).toString('base64');
    } catch {
      this.log('ai-key-encrypt-failed', { provider });
      return err('no-secure-storage', 'encryption failed');
    }
    return this.change(provider, cipher);
  }

  clear(provider: AiProviderId): Promise<Result<null, AiKeyError>> {
    if (!AI_PROVIDERS.includes(provider)) return Promise.resolve(err('invalid-provider', 'unknown provider'));
    return this.change(provider, undefined);
  }

  /** The decrypted key, for building a provider in main. Null when none is stored or it cannot be decrypted. */
  async get(provider: AiProviderId): Promise<string | null> {
    this.load();
    const cipher = await this.queue.run(async () => this.state.keys[provider]);
    if (cipher === undefined) return null;
    try {
      return this.options.encryptor.decrypt(Buffer.from(cipher, 'base64'));
    } catch {
      // A key encrypted on another machine or by another OS user cannot be decrypted: ask for it again.
      this.log('ai-key-unreadable', { provider });
      return null;
    }
  }

  private change(provider: AiProviderId, cipher: string | undefined): Promise<Result<null, AiKeyError>> {
    this.load();
    return this.queue.run(async () => {
      if (!this.writable) return err('write-failed', 'the key file cannot be written');
      const keys = { ...this.state.keys };
      if (cipher === undefined) delete keys[provider];
      else keys[provider] = cipher;
      const next: KeyFile = { version: AI_KEYS_VERSION, keys };
      try {
        await writeFileAtomic(this.options.file, `${JSON.stringify(next, null, 2)}\n`);
      } catch (e) {
        this.log('ai-keys-write-failed', { code: (e as { code?: string }).code ?? 'unknown' });
        return err('write-failed', 'the key file could not be written');
      }
      this.state = next;
      this.log(cipher === undefined ? 'ai-key-cleared' : 'ai-key-stored', { provider });
      return ok(null);
    });
  }

  private load(): void {
    this.loaded ??= this.queue.run(async () => {
      const read = await readJsonFile(this.options.file);
      if (read.kind === 'parsed') {
        this.state = loadKeyFile(read.value);
        if (schemaVersionOf(read.value, AI_KEYS_VERSION).kind === 'newer') {
          this.writable = false;
          this.log('ai-keys-newer-version', { readOnly: true });
        }
      } else if (read.kind === 'unreadable') {
        this.writable = false;
        this.log('ai-keys-unreadable', { code: read.code });
      } else if (read.kind === 'corrupt') {
        const backup = await backupFile(this.options.file, 'corrupt');
        if (backup === null) this.writable = false;
        this.log('ai-keys-reset', { backedUp: backup !== null });
      }
    });
  }

  private log(event: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    this.options.log?.(event, fields);
  }
}

/**
 * Test-only encryptor used when the app runs with NOOBIDE_AI_FAKE (e2e): a reversible transform so tests never
 * touch the developer's real keychain. `available: false` simulates a machine without secure storage.
 */
export function createTestEncryptor(available: boolean): KeyEncryptor {
  const flip = (buffer: Buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a));
  return {
    isAvailable: () => available,
    encrypt: (plain) => {
      if (!available) throw new Error('unavailable');
      return Buffer.concat([Buffer.from('noobide-test:'), flip(Buffer.from(plain, 'utf8'))]);
    },
    decrypt: (cipher) => flip(cipher.subarray('noobide-test:'.length)).toString('utf8'),
  };
}
