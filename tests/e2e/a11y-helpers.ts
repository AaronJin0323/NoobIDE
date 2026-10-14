import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

export interface AxeFinding {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly targets: string[];
}

/**
 * Runs axe-core (S24.3) in the workbench page. The source is evaluated through the DevTools protocol, which the
 * page's Content-Security-Policy does not apply to, so the app needs no test hook. Monaco's own editing surface is
 * excluded: it is a third-party widget whose ARIA is maintained upstream (its keyboard use is covered by the editing
 * e2e suites); the editor's surrounding controls are scanned.
 */
export async function axeScan(page: Page, impacts: readonly string[] = ['serious', 'critical']): Promise<AxeFinding[]> {
  await page.evaluate(AXE_SOURCE);
  const findings = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<AxeResults> } }).axe;
    interface AxeResults {
      violations: { id: string; impact: string | null; help: string; nodes: { target: string[] }[] }[];
    }
    const results = await axe.run(
      { exclude: [['.monaco-editor']] },
      {
        resultTypes: ['violations'],
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
      },
    );
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(' ')),
    }));
  });
  return findings.filter((f) => f.impact !== null && impacts.includes(f.impact));
}
