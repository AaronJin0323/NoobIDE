// S28.7: prepare explicit platform downloads and create a draft; never publish or overwrite a release.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function filesIn(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release artifacts must not contain symlinks');
    if (entry.isDirectory()) files.push(...(await filesIn(file)));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

export async function prepareDelivery(input, output, tag, sha) {
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('A version tag and full source commit are required');
  }
  const targets = ['windows-x64', 'macos-arm64'];
  const entries = await readdir(input, { withFileTypes: true });
  const selected = [];
  const signing = [];
  for (const target of targets) {
    const matches = entries.filter((e) => new RegExp(`^noobide-${target}-(signed|unsigned)$`).test(e.name));
    if (matches.length !== 1 || !matches[0].isDirectory()) throw new Error(`Expected one artifact for ${target}`);
    const artifact = matches[0].name;
    const state = artifact.endsWith('-unsigned') ? 'unsigned' : 'signed';
    signing.push(`${target}: **${state}**`);
    const files = (await filesIn(path.join(input, artifact))).filter((f) => /\.(exe|dmg|zip)$/.test(f));
    const installer = target === 'windows-x64' ? '.exe' : '.dmg';
    if (!files.some((f) => f.endsWith(installer)) || !files.some((f) => f.endsWith('.zip'))) {
      throw new Error(`Missing installer or ZIP for ${target}`);
    }
    for (const file of files) {
      const basename = path.basename(file);
      if (!/^[a-zA-Z0-9._-]+$/.test(basename)) throw new Error('Unexpected asset filename');
      selected.push({ file, name: `${tag}-${target}-${state}-${basename}` });
    }
  }
  if (new Set(selected.map((s) => s.name)).size !== selected.length) throw new Error('Duplicate asset names');
  // Refuse an existing output directory; do not overwrite local staging files.
  await mkdir(output);
  const assets = [];
  const sums = [];
  for (const { file, name } of selected) {
    const destination = path.join(output, name);
    await copyFile(file, destination);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${name}`);
    assets.push(destination);
  }
  const checksum = path.join(output, 'SHA256SUMS.txt');
  await writeFile(checksum, `${sums.join('\n')}\n`);
  assets.push(checksum);
  const notes = path.join(output, 'release-notes.md');
  await writeFile(
    notes,
    [
      `# NoobIDE ${tag}`,
      '',
      `Source commit: ${sha}`,
      '',
      ...signing,
      '',
      'Draft for review. Unsigned builds are for internal validation only.',
      'Before publishing: complete signing and downloaded-install/upgrade acceptance on both platforms,',
      'confirm supported OS versions, replace these notes with the release notes, and obtain owner go/no-go.',
      'SHA256SUMS.txt covers every installer and ZIP. Updates are manual; no automatic-update feed is provided.',
      '',
    ].join('\n'),
  );
  return { assets, notes };
}

export function deliveryArgs(tag, assets, notes) {
  return [
    'release',
    'create',
    tag,
    ...assets,
    '--draft',
    '--verify-tag',
    '--title',
    `NoobIDE ${tag}`,
    '--notes-file',
    notes,
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.env.REF_NAME ?? '';
  const { assets, notes } = await prepareDelivery(
    'release-artifacts',
    'release-staging',
    tag,
    process.env.GITHUB_SHA ?? '',
  );
  // gh refuses an existing release. No --clobber, editing, publishing, or implicit tag creation.
  execFileSync('gh', deliveryArgs(tag, assets, notes), { stdio: 'inherit' });
}
