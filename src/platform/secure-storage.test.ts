import { describe, expect, it, vi } from 'vitest';
import { secureStorageFor } from './secure-storage';

/** S31.2: the keychain is not touched to answer "is secure storage available" on macOS / Windows. */
describe('secure storage per platform', () => {
  const fake = (available: boolean, backend?: string) => ({
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
  });

  it('macOS and Windows: available without asking the keychain', () => {
    for (const platform of ['mac', 'windows'] as const) {
      const storage = fake(false);
      expect(secureStorageFor(storage, platform).isAvailable()).toBe(true);
      expect(storage.isEncryptionAvailable).not.toHaveBeenCalled();
    }
  });

  it('elsewhere: a real backend is required; basic_text is not encryption', () => {
    expect(secureStorageFor(fake(true, 'gnome_libsecret'), 'other').isAvailable()).toBe(true);
    expect(secureStorageFor(fake(true, 'basic_text'), 'other').isAvailable()).toBe(false);
    expect(secureStorageFor(fake(false), 'other').isAvailable()).toBe(false);
  });
});
