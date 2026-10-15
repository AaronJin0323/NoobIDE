// Release readiness: the shipped app carries the license texts of every production dependency
// (scripts/third-party-notices.mjs, run by forge.config.ts prePackage, shipped as <resources>/THIRD_PARTY_NOTICES.txt).
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOW_NO_LICENSE_FILE,
  buildThirdPartyNotices,
  productionPackages,
} from '../../scripts/third-party-notices.mjs';

const ROOT = path.resolve(__dirname, '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'noobide notices 许可-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('third-party notices', () => {
  const outFile = path.join(tmp, 'THIRD_PARTY_NOTICES.txt');
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/third-party-notices.mjs'), outFile], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean; devOptional?: boolean; optional?: boolean; version?: string }>;
  };

  it('the CLI writes the file and exits 0', () => {
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/third-party-notices: \d+ package\(s\)/);
    expect(text.length).toBeGreaterThan(10_000);
  });

  it('lists every production package of the lockfile with its version, license and license text', () => {
    const prod = Object.entries(lock.packages).filter(([k, v]) => k !== '' && !v.dev && !v.devOptional);
    expect(prod.length).toBeGreaterThan(5);
    expect(
      productionPackages(ROOT)
        .map((p) => p.key)
        .sort(),
    ).toEqual(prod.map(([k]) => k).sort());
    const { included, skipped } = buildThirdPartyNotices(ROOT);
    // Only optional packages that are not installed here may be missing from the file.
    for (const s of skipped) expect(s.optional && !existsSync(s.dir)).toBe(true);
    expect(included.length + skipped.length).toBe(prod.length);
    for (const p of included) {
      const header = `${p.name} ${p.version}\nLicense: ${p.license}\n`;
      expect(text, p.name).toContain(header);
      // The section after the header holds a license file's text, or the allow-list reason.
      const section = text.slice(text.indexOf(header), text.indexOf(header) + header.length + 400);
      if (p.files.length > 0) expect(section).toMatch(/--- (LICEN[CS]E|COPYING|NOTICE)[^\n]* ---\n\n\s*\S/i);
      else expect(section).toContain(ALLOW_NO_LICENSE_FILE[p.name]!.source);
    }
    for (const dep of ['react', 'react-dom', 'monaco-editor', 'dompurify', 'marked']) {
      expect(included.some((p) => p.name === dep)).toBe(true);
    }
  });

  it('contains the actual license texts (react: Meta Platforms; Apache-2.0; MPL-2.0) and Monaco’s own notices', () => {
    expect(text).toContain('Meta Platforms');
    expect(text).toContain('Apache License');
    expect(text).toContain('Mozilla Public License');
    expect(text).toContain('monaco-editor: bundled third-party notices');
    expect(text).toContain(
      readFileSync(path.join(ROOT, 'node_modules/monaco-editor/ThirdPartyNotices.txt'), 'utf8')
        .replace(/\r\n/g, '\n')
        .trimEnd(),
    );
  });

  it('is deterministic', () => {
    expect(buildThirdPartyNotices(ROOT).text).toBe(text);
  });

  it('fails with a list of packages that have no license text and are not allow-listed', () => {
    const allowListedHere = buildThirdPartyNotices(ROOT).included.filter((p) => p.files.length === 0);
    if (allowListedHere.length === 0) return;
    expect(() => buildThirdPartyNotices(ROOT, { allow: {} })).toThrow(/no LICENSE\/LICENCE\/COPYING\/NOTICE file/);
    for (const p of allowListedHere) {
      expect(() => buildThirdPartyNotices(ROOT, { allow: {} })).toThrow(`${p.name}@${p.version}`);
    }
  });
});
