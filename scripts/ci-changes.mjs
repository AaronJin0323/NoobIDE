// S50.1 — classify a CI push as `code` or `docs-only` (docs/ci/ci-stability-and-speed-plan.md §4).
// The `changes` job in .github/workflows/ci.yml runs this script and the OS build matrix is skipped when the
// result is `docs-only`. No third-party action: `git diff --name-only` against the base commit, then a pure
// path classifier (unit-tested in tests/integration/ci-changes.test.ts). Any doubt resolves to `code`.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE = 'code';
export const DOCS_ONLY = 'docs-only';

/** Directories (with their whole subtree) whose files are code. */
const CODE_DIRS = ['src', 'tests', 'scripts', 'resources', '.github'];
/** Exact repository-relative files that are code. */
const CODE_FILES = ['harness/features.json', 'package.json', 'package-lock.json'];

/** Normalise a git path: forward slashes, no leading `./`. Git prints forward slashes on every platform. */
function normalise(file) {
  return file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True when a single repository-relative path is part of the code the OS matrix must build and test. */
export function isCodePath(file) {
  const p = normalise(file);
  if (p === '') return false;
  const [top, ...rest] = p.split('/');
  if (CODE_DIRS.includes(top)) return true;
  if (CODE_FILES.includes(p)) return true;
  // harness/*.mjs: the session CLI and verify.mjs, not harness/PROGRESS.md or MANUAL-CHECKS.md.
  if (top === 'harness' && rest.length === 1 && rest[0].endsWith('.mjs')) return true;
  // Root-level *.config.* (vitest.config.ts, forge.config.ts, vite.*.config.ts, eslint.config.js, …).
  if (rest.length === 0 && /\.config\./.test(top)) return true;
  return false;
}

/** `code` when any changed path is code, else `docs-only`. An empty list is `docs-only` (nothing to build). */
export function classify(files) {
  return files.some((f) => isCodePath(f)) ? CODE : DOCS_ONLY;
}

/** Changed files between `base` and HEAD, or null when the base is missing, all zeros or not in the clone. */
export function changedFiles(base, cwd) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map(normalise)
      .filter((f) => f !== '');
  } catch {
    return null;
  }
}

/**
 * Pick the base commit from the Actions event: the PR base for pull requests, the previous head for pushes.
 * Anything else (workflow_dispatch, a force-push with an unknown `before`) has no base, which means `code`.
 */
export function baseSha(env) {
  if (env.GITHUB_EVENT_NAME === 'pull_request') return env.CI_BASE_SHA ?? '';
  if (env.GITHUB_EVENT_NAME === 'push') return env.CI_BEFORE_SHA ?? '';
  return '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = changedFiles(baseSha(process.env), process.cwd());
  // A missing or unusable base must never skip the matrix: treat it as a code change.
  const kind = files === null ? CODE : classify(files);
  const reason = files === null ? 'no usable base commit' : `${files.length} changed file(s)`;
  console.log(`kind=${kind} (${reason})`);
  if (files) for (const f of files) console.log(`  ${isCodePath(f) ? 'code ' : 'docs '} ${f}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `kind=${kind}\n`);
}
