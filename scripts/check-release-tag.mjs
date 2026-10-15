#!/usr/bin/env node
// Release readiness: a release build from a tag must carry the version the tag names. electron-forge stamps
// package.json "version" into the installers (Info.plist, FileVersion, the Squirrel package), and Squirrel decides
// upgrades by that version, so tag v1.0.0 building a 0.0.0 installer breaks updates. .github/workflows/release.yml
// runs this right after checkout with the ref passed through env (never interpolated into the script).
//
//   REF_TYPE=tag REF_NAME=v1.2.3 node scripts/check-release-tag.mjs
//
// A tag must equal "v" + package.json version, or the step fails. A manual dispatch on a branch (the dry run in
// docs/release/signing.md) is not a release: it logs a notice and passes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Returns { ok, message } for a ref and a package.json version. */
export function checkReleaseTag({ refType, refName, version }) {
  if (typeof version !== 'string' || version === '') {
    return { ok: false, message: 'package.json has no "version"' };
  }
  if (refType !== 'tag') {
    return {
      ok: true,
      message: `not a tag build (${refType || 'unknown'} "${refName}"): installers get package.json version ${version}`,
    };
  }
  const expected = `v${version}`;
  if (refName !== expected) {
    return {
      ok: false,
      message: `tag "${refName}" does not match package.json version ${version}: set "version" to "${refName.replace(/^v/, '')}" in package.json, or tag ${expected}`,
    };
  }
  return { ok: true, message: `tag ${refName} matches package.json version ${version}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const result = checkReleaseTag({
    refType: process.env.REF_TYPE ?? '',
    refName: process.env.REF_NAME ?? '',
    version,
  });
  if (result.ok)
    console.log(`${process.env.REF_TYPE === 'tag' ? '' : '::notice::'}check-release-tag: ${result.message}`);
  else {
    console.log(`::error::check-release-tag: ${result.message}`);
    process.exit(1);
  }
}
