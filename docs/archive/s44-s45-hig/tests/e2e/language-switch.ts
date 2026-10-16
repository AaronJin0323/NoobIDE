import type { Page } from '@playwright/test';

/**
 * Switches the interface to the other language the way a user does since S44.4: the More menu's Language group
 * (the top bar no longer carries a language button). Works with or without a project open.
 */
export async function switchLanguage(page: Page): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.lang);
  await page.getByTestId('app-menu').click();
  await page.getByTestId(current === 'en' ? 'menu-language-zh-CN' : 'menu-language-en').click();
}
