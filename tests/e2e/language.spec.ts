import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot } from './launch';
import { packagedExecutable, runSelfTest } from './packaged';

/**
 * S18.1 / S18.2: the language services work in the PACKAGED app with the network disabled. The self-test runs the
 * capability suite (tests/fixtures/lang-capabilities) inside the shipped binary, in real editors, with Chromium's
 * network emulated offline (NOOBIDE_SELF_TEST_OFFLINE=1).
 */
test('HTML, CSS and JavaScript services answer offline in the packaged app (S18.1, S18.2)', async () => {
  test.setTimeout(180_000);
  const exe = packagedExecutable();
  expect(exe, 'packaged app in out/ (npm run test:e2e packages first)').toBeDefined();
  const { code, result } = await runSelfTest(exe!, { NOOBIDE_SELF_TEST_OFFLINE: '1' });
  expect(result, 'self-test result line').toBeDefined();
  const r = result as {
    pass: boolean;
    offline: boolean;
    blockedRequests: number;
    workers: string[];
    capabilities: { id: string; pass: boolean; seen?: string }[];
  };
  // Main enabled Chromium's offline network emulation for the session (and its network guard blocks the rest).
  expect(r.offline).toBe(true);
  expect(r.blockedRequests, 'nothing tried to reach the network').toBe(0);
  expect(r.workers).toEqual(expect.arrayContaining(['html', 'css', 'ts']));

  const suite = JSON.parse(
    readFileSync(path.join(repoRoot, 'tests/fixtures/lang-capabilities/cases.json'), 'utf8'),
  ) as {
    cases: { id: string }[];
  };
  expect(r.capabilities.map((c) => c.id)).toEqual(suite.cases.map((c) => c.id));
  const failed = r.capabilities.filter((c) => !c.pass);
  expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
  expect(r.pass).toBe(true);
  expect(code).toBe(0);
});
