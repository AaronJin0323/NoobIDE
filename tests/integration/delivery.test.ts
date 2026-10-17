import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { deliveryArgs, prepareDelivery } from '../../scripts/deliver-release.mjs';

const roots: string[] = [];
const sha = 'a'.repeat(40);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noobide-delivery-'));
  roots.push(root);
  const input = path.join(root, 'input');
  for (const [target, state, extension] of [
    ['windows-x64', 'unsigned', 'exe'],
    ['macos-arm64', 'signed', 'dmg'],
  ]) {
    const dir = path.join(input, `noobide-${target}-${state}`, 'nested');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `NoobIDE.${extension}`), 'installer');
    await writeFile(path.join(dir, 'NoobIDE.zip'), target!);
  }
  return { root, input, output: path.join(root, 'output') };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('stages both platforms without filename collisions and checksums the delivered bytes', async () => {
  const { input, output } = await fixture();
  const result = await prepareDelivery(input, output, 'v1.2.3', sha);
  expect(result.assets).toHaveLength(5);
  const sums = await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  for (const file of result.assets.filter((f) => !f.endsWith('.txt'))) {
    expect(sums).toContain(
      `${createHash('sha256')
        .update(await readFile(file))
        .digest('hex')}  ${path.basename(file)}`,
    );
  }
  const notes = await readFile(result.notes, 'utf8');
  expect(notes).toContain('windows-x64: **unsigned**');
  expect(notes).toContain('macos-arm64: **signed**');
  expect(notes).toContain(sha);
  const args = deliveryArgs('v1.2.3', result.assets, result.notes);
  expect(args).toContain('--draft');
  expect(args).toContain('--verify-tag');
  expect(args).not.toContain('--clobber');
  expect(args).toContain('--notes-file');
});

it('refuses an incomplete platform set and missing installer', async () => {
  const { input, output } = await fixture();
  const mac = path.join(input, 'noobide-macos-arm64-signed');
  await rm(path.join(mac, 'nested', 'NoobIDE.dmg'));
  await expect(prepareDelivery(input, output, 'v1.2.3', sha)).rejects.toThrow('Missing installer');
  await rm(mac, { recursive: true });
  await expect(prepareDelivery(input, output, 'v1.2.3', sha)).rejects.toThrow('Expected one artifact');
});

it('refuses ambiguous signing artifacts, duplicate names and existing staging output', async () => {
  const { input, output } = await fixture();
  const extra = path.join(input, 'noobide-windows-x64-signed');
  await mkdir(extra);
  await expect(prepareDelivery(input, output, 'v1.2.3', sha)).rejects.toThrow('Expected one artifact');
  await rm(extra, { recursive: true });
  const duplicate = path.join(input, 'noobide-windows-x64-unsigned', 'NoobIDE.exe');
  await writeFile(duplicate, 'duplicate');
  await expect(prepareDelivery(input, output, 'v1.2.3', sha)).rejects.toThrow('Duplicate asset');
  await rm(duplicate);
  await mkdir(output);
  await writeFile(path.join(output, 'keep.txt'), 'keep');
  await expect(prepareDelivery(input, output, 'v1.2.3', sha)).rejects.toThrow();
  expect(await readFile(path.join(output, 'keep.txt'), 'utf8')).toBe('keep');
});

it('rejects invalid provenance before staging', async () => {
  const { input, output } = await fixture();
  await expect(prepareDelivery(input, output, 'main', sha)).rejects.toThrow('version tag');
  await expect(prepareDelivery(input, output, 'v1.2.3', 'short')).rejects.toThrow('source commit');
});
