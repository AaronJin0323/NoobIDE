#!/usr/bin/env node
// Third-party license notices for the shipped app (release readiness).
//
// The renderer and main bundles inline production dependencies and Vite drops their license comments, so the
// packaged app carries the notices as a separate file: <resources>/THIRD_PARTY_NOTICES.txt (forge.config.ts runs this
// script in prePackage and ships the file with extraResource). The About dialog opens it.
//
// Source of truth: package-lock.json (lockfileVersion 3). Every "packages" entry that is not dev / devOptional is a
// production package; for each one the file lists name, version, the license field and the full text of its
// LICENSE* / LICENCE* / COPYING* / NOTICE* files from node_modules. A package without such a file fails the run unless
// it is in ALLOW_NO_LICENSE_FILE with a reason. Optional packages that are not installed on this platform are not
// shipped by this build and are listed as skipped. Monaco's own ThirdPartyNotices.txt is appended in full.
//
// Usage: node scripts/third-party-notices.mjs [output file]   (default build/THIRD_PARTY_NOTICES.txt)
// Pure Node, no dependencies; output is deterministic (no dates) so two runs on the same tree are identical.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_OUTPUT = path.join('build', 'THIRD_PARTY_NOTICES.txt');

/**
 * Production packages that ship no license file in their npm tarball. Each needs a reason and where the license
 * text can be read; the notices file prints both. Keep this list short and re-check it when a version changes.
 */
export const ALLOW_NO_LICENSE_FILE = {
  standardwebhooks: {
    reason: 'the npm package (1.1.1) contains no license file; its package.json declares "MIT".',
    source: 'https://github.com/standard-webhooks/standard-webhooks/blob/main/LICENSE',
  },
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;
const RULE = '='.repeat(100);

/** Production packages from the lockfile: [{ key, dir, name, version, license, optional }], sorted by name. */
export function productionPackages(root) {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== 'object') {
    throw new Error('third-party-notices: package-lock.json must be lockfileVersion 3 with a "packages" map');
  }
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.dev === true || entry.devOptional === true) continue;
    const dir = path.join(root, ...key.split('/'));
    // The name is the part after the last node_modules/ (scoped names keep their scope).
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({
      key,
      dir,
      name,
      version: entry.version ?? '',
      license: typeof entry.license === 'string' ? entry.license : null,
      optional: entry.optional === true,
    });
  }
  return out.sort((a, b) => (a.name === b.name ? a.key.localeCompare(b.key) : a.name.localeCompare(b.name)));
}

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
    .sort();
}

function licenseOf(pkg) {
  if (pkg.license) return pkg.license;
  try {
    const json = JSON.parse(readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));
    return typeof json.license === 'string' ? json.license : (json.license?.type ?? 'UNKNOWN');
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Builds the notices text. Returns { text, included, skipped }; throws listing every production package that has no
 * license text and is not allow-listed.
 */
export function buildThirdPartyNotices(root, { allow = ALLOW_NO_LICENSE_FILE } = {}) {
  const included = [];
  const skipped = [];
  const missing = [];
  const sections = [];
  for (const pkg of productionPackages(root)) {
    if (!existsSync(pkg.dir)) {
      if (pkg.optional) {
        skipped.push(pkg);
        continue;
      }
      missing.push(`${pkg.name}@${pkg.version} (not installed: run npm ci)`);
      continue;
    }
    const files = licenseFiles(pkg.dir);
    const license = licenseOf(pkg);
    const head = [RULE, `${pkg.name} ${pkg.version}`, `License: ${license}`];
    if (files.length === 0) {
      const allowed = allow[pkg.name];
      if (!allowed) {
        missing.push(`${pkg.name}@${pkg.version} (${pkg.key})`);
        continue;
      }
      sections.push(
        [
          ...head,
          RULE,
          `No license file is included in this package: ${allowed.reason}`,
          `License text: ${allowed.source}`,
          '',
        ].join('\n'),
      );
    } else {
      const bodies = files.map((f) => {
        const body = readFileSync(path.join(pkg.dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd();
        return `--- ${f} ---\n\n${body}\n`;
      });
      sections.push([...head, RULE, '', ...bodies].join('\n'));
    }
    included.push({ ...pkg, license, files });
  }
  if (missing.length > 0) {
    throw new Error(
      `third-party-notices: no LICENSE/LICENCE/COPYING/NOTICE file for these production packages ` +
        `(add the text upstream, or allow-list them with a reason in scripts/third-party-notices.mjs):\n  ` +
        missing.join('\n  '),
    );
  }

  const parts = [
    'NoobIDE — third-party software notices',
    '',
    'NoobIDE includes the third-party software listed below. Each entry gives the package name, version, the license',
    'declared by the package, and the full text of the license and notice files it ships. Electron and Chromium',
    'license texts are in the LICENSE and LICENSES.chromium.html files installed next to the NoobIDE application.',
    '',
    `Packages: ${included.map((p) => `${p.name} ${p.version}`).join(', ')}`,
  ];
  if (skipped.length > 0) {
    parts.push(
      `Optional packages not installed on the build platform (not shipped in this build): ` +
        skipped.map((p) => `${p.name} ${p.version}`).join(', '),
    );
  }
  parts.push('', ...sections);

  const monacoNotices = path.join(root, 'node_modules', 'monaco-editor', 'ThirdPartyNotices.txt');
  if (existsSync(monacoNotices)) {
    parts.push(
      RULE,
      'monaco-editor: bundled third-party notices (node_modules/monaco-editor/ThirdPartyNotices.txt)',
      RULE,
      '',
      readFileSync(monacoNotices, 'utf8').replace(/\r\n/g, '\n').trimEnd(),
      '',
    );
  }
  return { text: `${parts.join('\n')}\n`, included, skipped };
}

/** Writes the notices file (creating its folder) and returns the build result. */
export function writeThirdPartyNotices(root, outFile) {
  const result = buildThirdPartyNotices(root);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, result.text, 'utf8');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outFile = path.resolve(root, process.argv[2] ?? DEFAULT_OUTPUT);
  try {
    const { included, skipped } = writeThirdPartyNotices(root, outFile);
    console.log(
      `third-party-notices: ${included.length} package(s)` +
        (skipped.length ? `, ${skipped.length} optional package(s) not installed` : '') +
        ` -> ${path.relative(root, outFile)}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
