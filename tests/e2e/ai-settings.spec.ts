import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { axeScan } from './a11y-helpers';
import { launchApp, tempRoot } from './launch';
import { makeProject, openProject, switchLanguage } from './project';

/**
 * S31.4 Settings → AI end to end, against the scripted fake provider (NOOBIDE_AI_FAKE, decision 0025: no test calls a
 * real provider): key entry (masked, write-only) → "stored" and never displayed again, Test success and failure
 * explained, models from the provider's list, AI on/off and inline on/off persisted in app data, consent per project,
 * zh-CN and en, keyboard and axe. S31.2: the key string appears in no renderer state (DOM, storage), and in no file of
 * the app-data directory (logs included); without secure storage the key is not stored and AI stays off, explained.
 */
const GOOD_KEY = 'sk-ant-e2e-GOODSECRET-0123456789abcdef';
const BAD_KEY = 'sk-ant-e2e-BADSECRET-rejected-000';

let tmp: string;
let userData: string;
let scriptFile: string;

test.beforeEach(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-ai-settings-'));
  userData = path.join(tmp, '用户 数据');
  scriptFile = path.join(tmp, 'fake-ai.json');
  await writeFile(
    scriptFile,
    JSON.stringify({
      includeBuiltin: true,
      rejectKeys: [BAD_KEY],
      models: [
        { id: 'fake-large', displayName: 'Fake Large' },
        { id: 'fake-small', displayName: 'Fake Small' },
      ],
    }),
  );
});

test.afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function start(script = scriptFile): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp({ NOOBIDE_AI_FAKE: script }, { userDataDir: userData });
  const page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  return { app, page };
}

async function openSettings(page: Page) {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-ai-settings').click();
  await expect(page.getByTestId('ai-settings')).toBeVisible();
}

/** Every text file under a folder, recursively (the app-data directory). */
async function allText(dir: string): Promise<string> {
  const out: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) out.push(await allText(full));
    else if (info.size < 5_000_000) out.push(await readFile(full, 'latin1').catch(() => ''));
  }
  return out.join('\n');
}

async function rendererHas(page: Page, needle: string): Promise<boolean> {
  return page.evaluate((secret) => {
    const inputs = [...document.querySelectorAll('input')].map((i) => i.value).join('\n');
    const storage = [localStorage, sessionStorage]
      .map((s) =>
        Object.keys(s)
          .map((k) => `${k}=${s.getItem(k) ?? ''}`)
          .join('\n'),
      )
      .join('\n');
    return [document.documentElement.outerHTML, inputs, storage].some((text) => text.includes(secret));
  }, needle);
}

test('enter a key: stored, never shown again; Test explains failure and success (S31.4, S31.2)', async () => {
  let { app, page } = await start();
  // AI is on by default but nothing works without a key; no AI surface yet.
  await openSettings(page);
  const dialog = page.getByTestId('ai-settings');
  await expect(dialog.getByRole('heading', { name: 'AI 设置' })).toBeVisible();
  await expect(page.getByTestId('ai-key-state')).toHaveText('还没有保存密钥');
  await expect(page.getByTestId('ai-enabled-state')).toHaveText('保存一个 API 密钥后 AI 才能使用。');
  await expect(page.getByTestId('ai-test')).toBeDisabled();
  const input = page.getByTestId('ai-key-input');
  await expect(input).toHaveAttribute('type', 'password');
  expect(await axeScan(page)).toEqual([]);

  // A key the provider rejects: stored, then Test explains why it fails.
  await input.fill(BAD_KEY);
  await page.getByTestId('ai-key-save').click();
  await expect(page.getByTestId('ai-key-message')).toHaveText('密钥已保存。');
  await expect(page.getByTestId('ai-key-state')).toHaveText('✓ 已保存密钥（不会再显示）');
  await expect(input).toHaveValue('');
  await page.getByTestId('ai-test').click();
  await expect(page.getByTestId('ai-test-message')).toContainText('服务商拒绝了这个密钥');
  await expect(page.getByTestId('ai-test-message')).toHaveAttribute('role', 'alert');

  // Replace it with a good key (keyboard only: type, Enter submits).
  await input.focus();
  await page.keyboard.type(GOOD_KEY);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-key-message')).toHaveText('密钥已保存。');
  await expect(page.getByTestId('ai-key-state')).toHaveText('✓ 已保存密钥（不会再显示）');
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('ai-test')).toBeEnabled();
  await page.getByTestId('ai-test').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-test-message')).toHaveText('✓ 连接成功：这个密钥可以使用。');
  expect(await rendererHas(page, GOOD_KEY)).toBe(false);
  expect(await rendererHas(page, 'GOODSECRET')).toBe(false);
  expect(await rendererHas(page, 'BADSECRET')).toBe(false);

  // Models come from the provider's list; the choice is kept in app data.
  const inline = page.getByTestId('ai-model-inline');
  // "Default", the current choice (claude-haiku-5-5, not in the fake's list) and the provider's two models.
  await expect(inline.locator('option')).toHaveCount(4);
  await expect(inline).toHaveValue('claude-haiku-5-5');
  await inline.selectOption('fake-small');
  await expect
    .poll(async () => JSON.parse(await readFile(path.join(userData, 'ai-config.json'), 'utf8').catch(() => '{}')))
    .toMatchObject({
      version: 1,
      enabled: true,
      provider: 'anthropic',
      models: { anthropic: { inline: 'fake-small' } },
    });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ai-settings')).toHaveCount(0);
  await expect(page.getByTestId('rail-ai')).toBeVisible();
  await app.close();

  // After a restart the key is still stored and still never shown.
  ({ app, page } = await start());
  await openSettings(page);
  await expect(page.getByTestId('ai-key-state')).toHaveText('✓ 已保存密钥（不会再显示）');
  await expect(page.getByTestId('ai-key-input')).toHaveValue('');
  await expect(page.getByTestId('ai-model-inline')).toHaveValue('fake-small');
  expect(await rendererHas(page, 'GOODSECRET')).toBe(false);
  await page.getByTestId('ai-settings-close').click();
  await app.close();

  // Nothing in app data holds the key in plain text: not the key file, not the settings, not the logs.
  const appData = await allText(userData);
  expect(appData).toContain('ai-key-stored'); // the log records the event…
  expect(appData).not.toContain('GOODSECRET'); // …never the key
  expect(appData).not.toContain('BADSECRET');
  expect(await readFile(path.join(userData, 'ai-keys.json'), 'utf8')).toMatch(/"anthropic": "[A-Za-z0-9+/=]+"/);
});

test('AI off removes the AI surfaces; inline completions switch off on their own; consent is revocable (S31.4)', async () => {
  const { tmp: projectTmp, root } = await makeProject('noobide-e2e-ai-设置-');
  const { app, page } = await start();
  try {
    await openProject(app, page, root);
    await openSettings(page);
    await page.getByTestId('ai-key-input').fill(GOOD_KEY);
    await page.getByTestId('ai-key-save').click();
    await expect(page.getByTestId('ai-enabled-state')).toHaveText('AI 已开启');

    // Consent for the open project, from the reusable prompt; then revoked.
    await expect(page.getByTestId('ai-consent-state')).toContainText('还没有允许这个项目发送代码');
    await page.getByTestId('ai-consent-allow').click();
    await expect(page.getByTestId('ai-consent-state')).toHaveText('✓ 已允许把这个项目的代码发送给 AI 服务商。');
    await page.getByTestId('ai-consent-revoke').click();
    await expect(page.getByTestId('ai-consent-state')).toContainText('还没有允许这个项目发送代码');
    expect(await readFile(path.join(userData, 'ai-consent.json'), 'utf8')).not.toContain(root);

    await page.getByTestId('ai-inline').uncheck();
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(userData, 'ai-config.json'), 'utf8')).inlineCompletions)
      .toBe(false);

    await page.getByTestId('ai-enabled').uncheck();
    await expect(page.getByTestId('ai-enabled-state')).toHaveText('AI 已关闭：编辑器里不会出现任何 AI 功能。');
    await page.getByTestId('ai-settings-close').click();
    await expect(page.getByTestId('rail-ai')).toHaveCount(0);

    await openSettings(page);
    await page.getByTestId('ai-enabled').check();
    await page.getByTestId('ai-settings-close').click();
    await expect(page.getByTestId('rail-ai')).toBeVisible();

    // English.
    await switchLanguage(page);
    await openSettings(page);
    await expect(page.getByRole('heading', { name: 'AI settings' })).toBeVisible();
    await expect(page.getByTestId('ai-key-state')).toHaveText('✓ Key saved (never shown again)');
    await page.getByTestId('ai-test').click();
    await expect(page.getByTestId('ai-test-message')).toHaveText('✓ Connected: this key works.');
    await page.getByTestId('ai-settings-close').click();
    await switchLanguage(page);
  } finally {
    await app.close();
    await rm(projectTmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('without secure storage the key is not stored and AI stays off, explained (S31.2)', async () => {
  const noKeychain = path.join(tmp, 'no-keychain.json');
  await writeFile(noKeychain, JSON.stringify({ secureStorage: false }));
  const { app, page } = await start(noKeychain);
  try {
    await openSettings(page);
    await expect(page.getByTestId('ai-no-secure-storage')).toContainText('这台电脑上没有可用的安全存储');
    await expect(page.getByTestId('ai-key-input')).toBeDisabled();
    await expect(page.getByTestId('ai-key-state')).toHaveText('还没有保存密钥');
    // Even a direct call through the bridge stores nothing.
    const result = await page.evaluate(() =>
      (
        window.noobide as unknown as {
          ai: { setKey(r: { provider: string; key: string }): Promise<{ ok: boolean; code?: string }> };
        }
      ).ai.setKey({ provider: 'openai', key: 'sk-NOKEYCHAIN-123' }),
    );
    expect(result).toMatchObject({ ok: false, code: 'no-secure-storage' });
    // No request can run: there is no key (the chat panel, if opened, only explains why).
    const refused = await page.evaluate(() =>
      (
        window.noobide as unknown as { ai: { request(r: unknown): Promise<{ ok: boolean; code?: string }> } }
      ).ai.request({ kind: 'chat', projectId: null, history: [], prompt: 'hi', context: [], locale: 'zh-CN' }),
    );
    expect(refused).toMatchObject({ ok: false, code: 'no-key' });
    await page.getByTestId('ai-settings-close').click();
    await switchLanguage(page);
    await openSettings(page);
    await expect(page.getByTestId('ai-no-secure-storage')).toContainText('No secure storage');
    await page.getByTestId('ai-settings-close').click();
    await switchLanguage(page);
  } finally {
    await app.close();
  }
  expect(await allText(userData)).not.toContain('NOKEYCHAIN');
});
