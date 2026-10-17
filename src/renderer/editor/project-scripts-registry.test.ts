import { afterEach, describe, expect, it } from 'vitest';
import { ProjectScripts } from './project-scripts';
import {
  cancelExpectedProjectScripts,
  expectProjectScripts,
  projectIndexing,
  registerProjectScripts,
  resetProjectScriptsRegistry,
  unregisterProjectScripts,
  whenProjectIndexed,
} from './project-scripts-registry';

/** A ProjectScripts whose reads never finish until `release()`. */
function slowScripts() {
  const gates: (() => void)[] = [];
  const scripts = new ProjectScripts({
    read: (rel) => new Promise((resolve) => gates.push(() => resolve({ text: 'let x;', uri: `file:///p/${rel}` }))),
    hasModel: () => false,
    libName: (u) => u,
    setLibs: () => undefined,
  });
  return { scripts, release: () => gates.splice(0).forEach((g) => g()) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('project-scripts registry (S57)', () => {
  afterEach(() => resetProjectScriptsRegistry());

  it('without a project nothing is indexing and the wait answers at once', async () => {
    expect(projectIndexing()).toBe(false);
    expect(await whenProjectIndexed(10_000)).toBe(true);
  });

  it('a project whose Monaco binding has not loaded yet counts as indexing; the wait spans both gaps', async () => {
    expectProjectScripts(); // the workbench effect ran; the dynamic import is pending
    expect(projectIndexing()).toBe(true);
    let settled: boolean | null = null;
    const wait = whenProjectIndexed(10_000).then((ok) => (settled = ok));
    await tick();
    expect(settled).toBeNull();

    const { scripts, release } = slowScripts();
    registerProjectScripts(scripts); // the import resolved…
    void scripts.open([{ relPath: 'a.js', uri: 'file:///p/a.js' }]); // …and the files are being read
    await tick();
    expect(settled).toBeNull(); // still indexing: the first gap closed, the second is open
    expect(projectIndexing()).toBe(true);

    release();
    expect(await wait).toBe(true);
    expect(projectIndexing()).toBe(false);
  });

  it('is bounded while the binding never arrives, and released when the project closes first', async () => {
    expectProjectScripts();
    let t = 0;
    const now = () => (t += 11_000);
    expect(await whenProjectIndexed(10_000, now)).toBe(false);

    expectProjectScripts();
    const wait = whenProjectIndexed(10_000);
    cancelExpectedProjectScripts(); // the project closed before the import resolved
    expect(await wait).toBe(true);
    expect(projectIndexing()).toBe(false);
  });

  it('unregistering the current instance releases waiters and forgets it', async () => {
    const { scripts } = slowScripts();
    registerProjectScripts(scripts);
    void scripts.open([{ relPath: 'a.js', uri: 'file:///p/a.js' }]);
    const wait = whenProjectIndexed(10_000);
    scripts.close(); // the binding's dispose() closes the scripts and unregisters
    unregisterProjectScripts(scripts);
    expect(await wait).toBe(true);
    expect(projectIndexing()).toBe(false);
  });
});
