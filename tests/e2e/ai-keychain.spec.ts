import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { electronArgs, repoRoot, tempRoot } from './launch';

/**
 * S37.1: an AI key stored through the REAL Electron safeStorage survives an app restart on Windows (DPAPI). Every
 * other AI spec runs with NOOBIDE_AI_FAKE, which also swaps safeStorage for the reversible test encryptor
 * (src/main/ai-main.ts), so none of them touches the OS keychain. This one launches the built app with the AI test
 * switches explicitly cleared, so main wires `secureStorageFor(safeStorage)` and the real providers.
 *
 * No provider is reached: tests/e2e/offline-guard.cjs (preloaded into main with `-r`) makes every non-loopback
 * connection fail like an unplugged network. That also gives the restart check its app-level proof: after the
 * restart, "Test connection" answers "cannot reach the provider" — it only gets that far when main decrypted the
 * stored key (an unreadable key answers "save a key first").
 *
 * Windows only: on macOS the real safeStorage of an unpackaged Electron asks for the login keychain in a system
 * dialog, and Linux has no keyring on CI. The test's app data is a temporary folder; DPAPI binds the key to this
 * Windows user, which is exactly what is under test. The developer's own keychain entries are not touched.
 */
const KEY = 'sk-ant-e2e-DPAPISECRET-0123456789abcdef';
const guard = path.join(repoRoot, 'tests', 'e2e', 'offline-guard.cjs');

let tmp: string;
let userData: string;

test.skip(process.platform !== 'win32', 'real safeStorage (DPAPI) check runs on Windows');

test.beforeEach(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-ai-keychain-'));
  userData = path.join(tmp, '用户 数据');
});

test.afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function start(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['-r', guard, `--user-data-dir=${userData}`, ...electronArgs()],
    cwd: repoRoot,
    // Cleared, not merely absent: a value inherited from the shell would put the app back on the test encryptor.
    env: { ...process.env, NOOBIDE_AI_FAKE: '', NOOBIDE_AI_FAKE_AGENT: '' } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  return { app, page };
}

async function openSettings(page: Page) {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-ai-settings').click();
  await expect(page.getByTestId('ai-settings')).toBeVisible();
}

async function storedCipher(): Promise<Buffer> {
  const file = JSON.parse(await readFile(path.join(userData, 'ai-keys.json'), 'utf8')) as {
    keys: { anthropic?: string };
  };
  expect(file.keys.anthropic).toMatch(/^[A-Za-z0-9+/=]+$/);
  return Buffer.from(file.keys.anthropic ?? '', 'base64');
}

test('a key saved through the real safeStorage (DPAPI) is still saved and readable after a restart (S37.1)', async () => {
  let { app, page } = await start();
  try {
    expect(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())).toBe(true);
    await openSettings(page);
    await expect(page.getByTestId('ai-no-secure-storage')).toHaveCount(0);
    await expect(page.getByTestId('ai-key-state')).toHaveText('还没有保存密钥');
    await page.getByTestId('ai-key-input').fill(KEY);
    await page.getByTestId('ai-key-save').click();
    await expect(page.getByTestId('ai-key-message')).toHaveText('密钥已保存。');
    await expect(page.getByTestId('ai-key-state')).toHaveText('✓ 已保存密钥（不会再显示）');
    await page.getByTestId('ai-settings-close').click();
  } finally {
    await app.close();
  }

  // The key file holds Chromium's OS-crypt ciphertext ("v10" + AES-GCM under a DPAPI-protected key), not the test
  // encryptor's "noobide-test:" form and not the key itself.
  const cipher = await storedCipher();
  expect(cipher.subarray(0, 3).toString('latin1')).toBe('v10');
  expect(cipher.toString('latin1')).not.toContain('noobide-test:');
  expect(cipher.toString('latin1')).not.toContain('DPAPISECRET');
  expect(await readFile(path.join(userData, 'ai-keys.json'), 'utf8')).not.toContain('DPAPISECRET');

  // Restart on the same app data: still saved, never shown, and main can decrypt it.
  ({ app, page } = await start());
  try {
    await openSettings(page);
    await expect(page.getByTestId('ai-key-state')).toHaveText('✓ 已保存密钥（不会再显示）');
    await expect(page.getByTestId('ai-key-input')).toHaveValue('');
    // Main decrypted the key and tried the provider, which the offline guard cut off.
    await page.getByTestId('ai-test').click();
    await expect(page.getByTestId('ai-test-message')).toContainText('连不上服务商：请检查网络连接。');
    const attempts = await app.evaluate(
      () => (globalThis as unknown as { __noobideOfflineAttempts: string[] }).__noobideOfflineAttempts,
    );
    expect(attempts).toContain('api.anthropic.com');
    // The same ciphertext decrypts to the key with the restarted process's safeStorage.
    const plain = await app.evaluate(
      ({ safeStorage }, base64) => safeStorage.decryptString(Buffer.from(base64, 'base64')),
      (await storedCipher()).toString('base64'),
    );
    expect(plain === KEY).toBe(true); // compared as a boolean so a failure never prints the key
    await page.getByTestId('ai-settings-close').click();
  } finally {
    await app.close();
  }
});
