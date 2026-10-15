import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanPortability } from '../../src/workspace/portability-scan';
import { ProjectService } from '../../src/workspace/project-service';
import type { PortabilityIssue } from '../../src/shared/portability';

/**
 * S13.5 on a real file system: a project moved between Windows and macOS (tests/fixtures/跨平台 迁移, copied to a
 * path with Chinese characters and spaces). Hazards the committed fixture cannot hold are added to the copy when
 * this volume allows them; on volumes that refuse them (Windows names, case-insensitive Macs) the detector is proven
 * with injected listings in src/shared/portability.test.ts. Every issue is reported and nothing on disk changes.
 */
const FIXTURE = path.join(__dirname, '..', 'fixtures', '跨平台 迁移');
const NFC = 'café.html';
const NFD = 'café.html';
const NFD_ONLY = 'résumé.html';

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-transfer-'));
  root = path.join(tmp, '网页 练习', '跨平台 迁移');
  await cp(FIXTURE, root, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Creates a file unless the volume refuses or already has that name (case/normalisation-insensitive). */
async function tryCreate(relPath: string, text = 'x\n'): Promise<boolean> {
  try {
    await writeFile(path.join(root, ...relPath.split('/')), text, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/** Every entry under `dir` (names as raw UTF-8 hex, so a re-normalised or re-cased name is a change), with content. */
async function snapshot(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    const key = `${rel}/${Buffer.from(name).toString('hex')}`;
    if (info.isDirectory()) out.push(`${key}/ ${info.mtimeMs}`, ...(await snapshot(full, key)));
    else {
      const hash = createHash('sha256')
        .update(await readFile(full))
        .digest('hex');
      out.push(`${key} ${info.size} ${info.mtimeMs} ${hash}`);
    }
  }
  return out;
}

describe('cross-platform project transfer (S13.5)', () => {
  it('reports mixed line endings and leaves CRLF, LF and NFC files alone', async () => {
    const report = await scanPortability(root);
    expect(report.truncated).toBe(false);
    expect(report.issues).toEqual([{ kind: 'mixed-eol', relPath: 'crlf-mixed.js' }]);
    // The committed bytes are what the test claims (CRLF only, mixed, NFC name).
    expect(await readFile(path.join(root, 'crlf-style.css'), 'latin1')).toMatch(/^[^\n]*\r\n[^\n]*\r\n\}\r\n$/);
    expect(await readdir(path.join(root, '页面'))).toEqual([NFC]);
  });

  it('reports case conflicts, Unicode twins and unportable names; nothing is renamed or rewritten', async () => {
    const expected: PortabilityIssue[] = [{ kind: 'mixed-eol', relPath: 'crlf-mixed.js' }];
    await writeFile(path.join(root, 'Logo.svg'), '<svg/>\n');
    if (await tryCreate('logo.svg', '<svg></svg>\n')) {
      expected.push({ kind: 'case-conflict', folder: '', names: ['Logo.svg', 'logo.svg'] });
    }
    if (await tryCreate(`页面/${NFD}`)) {
      expected.push({ kind: 'unicode-conflict', folder: '页面', names: [NFC, NFD] });
      expected.push({ kind: 'decomposed-name', relPath: `页面/${NFD}` });
    }
    // A decomposed name on its own (a file from an older Mac): every volume can hold it.
    if ((await tryCreate(`页面/${NFD_ONLY}`)) && (await readdir(path.join(root, '页面'))).includes(NFD_ONLY)) {
      expected.push({ kind: 'decomposed-name', relPath: `页面/${NFD_ONLY}` });
    }
    // Names Windows refuses (only creatable on macOS / Linux).
    if (await tryCreate('what?.html')) {
      expected.push({
        kind: 'unportable-name',
        relPath: 'what?.html',
        problems: ['invalid-char'],
        invalidChars: ['?'],
      });
    }
    if (await tryCreate('CON.txt')) {
      expected.push({ kind: 'unportable-name', relPath: 'CON.txt', problems: ['reserved-windows'], invalidChars: [] });
    }
    if (await tryCreate('notes.')) {
      expected.push({
        kind: 'unportable-name',
        relPath: 'notes.',
        problems: ['trailing-dot-or-space'],
        invalidChars: [],
      });
    }
    // Dotfiles are not part of the listed project and never reported.
    await writeFile(path.join(root, '.DS_Store'), 'x');

    const before = await snapshot(tmp);
    const report = await scanPortability(root);
    // Opening the project and listing it read the same tree; neither may change it.
    const projects = new ProjectService();
    const opened = await projects.open(root);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect((await projects.listDir({ projectId: opened.value.projectId, relPath: '' })).ok).toBe(true);
      expect((await projects.listDir({ projectId: opened.value.projectId, relPath: '页面' })).ok).toBe(true);
    }
    expect(await snapshot(tmp)).toEqual(before);

    const sortKey = (i: PortabilityIssue) => JSON.stringify(i);
    expect([...report.issues].map(sortKey).sort()).toEqual(expected.map(sortKey).sort());
    // On macOS / Linux at least the Windows-invalid names and the decomposed name were really on disk.
    if (process.platform !== 'win32') {
      expect(report.issues.filter((i) => i.kind === 'unportable-name').length).toBe(3);
      expect(report.issues.some((i) => i.kind === 'decomposed-name')).toBe(true);
    }
  });

  it('stops at its limits and says so', async () => {
    const report = await scanPortability(root, { maxEntries: 2, maxDepth: 8, maxTextFiles: 500 });
    expect(report.truncated).toBe(true);
    const shallow = await scanPortability(root, { maxEntries: 5000, maxDepth: 1, maxTextFiles: 0 });
    expect(shallow).toEqual({ issues: [], truncated: true });
  });
});
