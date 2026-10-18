import os from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * Keeps every core busy, 1.5 busy threads per core (one per core was not enough to stall the first document of a
 * preview, S05.8), until the returned call. Each thread stops by itself after 10 minutes.
 */
export function loadCpu(): () => Promise<void> {
  const workers = Array.from(
    { length: Math.ceil(os.availableParallelism() * 1.5) },
    () =>
      new Worker('const end = Date.now() + 600000; while (Date.now() < end) Math.sqrt(Math.random());', { eval: true }),
  );
  return async () => {
    await Promise.all(workers.map((w) => w.terminate()));
  };
}

let background: (() => Promise<void>) | null = null;

/**
 * S58.4: `NOOBIDE_E2E_LOAD=1` runs the e2e suite on a loaded machine, the conditions of a shared hosted runner, so an
 * intermittent can be reproduced and a fix proven locally (`--repeat-each=20`). The load starts with the first app
 * launch of a Playwright worker and lasts until that worker ends; it is renewed if a run outlasts its 10 minutes.
 */
export function backgroundLoadFromEnv(): void {
  if (process.env.NOOBIDE_E2E_LOAD !== '1' || background) return;
  background = loadCpu();
  const renew = setInterval(() => {
    void background?.();
    background = loadCpu();
  }, 540_000);
  renew.unref();
}
