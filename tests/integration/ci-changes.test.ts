// S50.1 — scripts/ci-changes.mjs: the path classifier behind the `changes` job in ci.yml. Pure path lists, no git:
// the OS build matrix is skipped only for docs-only pushes, so every doubtful case must land on `code`.
import { describe, expect, it } from 'vitest';
import { baseSha, changedFiles, classify, CODE, DOCS_ONLY, isCodePath } from '../../scripts/ci-changes.mjs';

describe('isCodePath', () => {
  it.each([
    'src/main/index.ts',
    'src/renderer/workbench/ime.ts',
    'tests/integration/ci-workflow.test.ts',
    'tests/e2e/shards.json',
    'tests/fixtures/sample.html',
    'scripts/ci-changes.mjs',
    'resources/templates/blank/index.html',
    'resources/lessons/01.md',
    '.github/workflows/ci.yml',
    '.github/workflows/perf.yml',
    'harness/session.mjs',
    'harness/verify.mjs',
    'harness/features.json',
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'vitest.perf.config.ts',
    'forge.config.ts',
    'vite.renderer.config.ts',
    'eslint.config.js',
    'signing.config.ts',
  ])('treats %s as code', (file) => {
    expect(isCodePath(file)).toBe(true);
  });

  it.each([
    'docs/ci/ci-stability-and-speed-plan.md',
    'docs/decisions/0037-ci-stability-and-speed.md',
    'docs/perf/ci-runners.md',
    'harness/PROGRESS.md',
    'harness/MANUAL-CHECKS.md',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'PLAN.md',
    'LICENSE',
    '.nvmrc',
    '.gitignore',
    '.prettierrc',
    'harness/notes/config.md',
    'docs/vitest.config.ts',
  ])('treats %s as docs', (file) => {
    expect(isCodePath(file)).toBe(false);
  });

  it('accepts backslashes and a leading ./ but never an empty path', () => {
    expect(isCodePath('src\\main\\index.ts')).toBe(true);
    expect(isCodePath('./scripts/e2e.mjs')).toBe(true);
    expect(isCodePath('')).toBe(false);
    expect(isCodePath('   ')).toBe(false);
  });

  it('does not match code directories by prefix of a longer name', () => {
    expect(isCodePath('srcdocs/readme.md')).toBe(false);
    expect(isCodePath('tests-notes.md')).toBe(false);
    expect(isCodePath('scripts.md')).toBe(false);
  });
});

describe('classify', () => {
  it('is docs-only when every changed path is documentation', () => {
    expect(classify(['docs/ci/ci-stability-and-speed-plan.md', 'harness/PROGRESS.md', 'harness/features.json'])).toBe(
      CODE,
    );
    expect(
      classify(['docs/ci/ci-stability-and-speed-plan.md', 'harness/PROGRESS.md', 'harness/MANUAL-CHECKS.md']),
    ).toBe(DOCS_ONLY);
  });

  it('is code as soon as one path is code', () => {
    expect(classify(['README.md', 'src/main/index.ts'])).toBe(CODE);
    expect(classify(['docs/testing.md', 'package-lock.json'])).toBe(CODE);
    expect(classify(['AGENTS.md', '.github/workflows/ci.yml'])).toBe(CODE);
  });

  it('is docs-only for an empty change list (nothing for the matrix to build)', () => {
    expect(classify([])).toBe(DOCS_ONLY);
  });
});

describe('base commit selection', () => {
  it('uses the PR base for pull requests and the previous head for pushes', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(baseSha({ GITHUB_EVENT_NAME: 'pull_request', CI_BASE_SHA: a, CI_BEFORE_SHA: b })).toBe(a);
    expect(baseSha({ GITHUB_EVENT_NAME: 'push', CI_BASE_SHA: a, CI_BEFORE_SHA: b })).toBe(b);
  });

  it('has no base for workflow_dispatch or an unknown event, so the run counts as code', () => {
    expect(baseSha({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_BEFORE_SHA: 'b'.repeat(40) })).toBe('');
    expect(baseSha({})).toBe('');
    expect(changedFiles('', process.cwd())).toBeNull();
  });

  it('treats a missing or all-zero base (new branch, force-push) as unusable', () => {
    expect(changedFiles(undefined, process.cwd())).toBeNull();
    expect(changedFiles('0'.repeat(40), process.cwd())).toBeNull();
  });

  it('returns null when git cannot diff against the base instead of guessing', () => {
    expect(changedFiles('f'.repeat(40), process.cwd())).toBeNull();
  });
});
