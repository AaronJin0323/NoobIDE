import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** S03.2: the repository ESLint config forbids `process.platform` everywhere except src/platform. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = 'export const onMac = process.platform === "darwin";\n';

async function ruleIds(relFile: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(SOURCE, { filePath: path.join(repoRoot, relFile) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

describe('process.platform lint rule (S03.2)', () => {
  it.each(['src/main/x.ts', 'src/workspace/x.ts', 'src/shared/x.ts', 'src/preload/x.ts'])(
    'is an error in %s',
    async (file) => {
      expect(await ruleIds(file)).toContain('no-restricted-properties');
    },
    20_000,
  );

  it('is an error in renderer components too', async () => {
    expect(await ruleIds('src/renderer/x.tsx')).toContain('no-restricted-properties');
  }, 20_000);

  it('is allowed inside src/platform', async () => {
    expect(await ruleIds('src/platform/x.ts')).not.toContain('no-restricted-properties');
  }, 20_000);
});
