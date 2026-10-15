import type { PlatformId } from './labels';

/**
 * Electron `safeStorage` as the AI key store's encryptor (S31.2), per platform:
 *
 * - macOS (Keychain) and Windows (DPAPI) always have secure storage. Asking `isEncryptionAvailable()` touches the
 *   keychain item and can block the main process on a keychain prompt, so it is not asked at startup or for the
 *   status; the keychain is used only when a key is saved or read.
 * - Elsewhere (Linux dev runs) it must be a real backend: `basic_text` is obfuscation, not encryption, so it counts as
 *   unavailable and no key is stored.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface SecureStorage {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export function secureStorageFor(safeStorage: SafeStorageLike, platform: PlatformId): SecureStorage {
  const osBacked = platform === 'mac' || platform === 'windows';
  return {
    isAvailable: () => {
      if (osBacked) return true;
      if (!safeStorage.isEncryptionAvailable()) return false;
      return safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  };
}
