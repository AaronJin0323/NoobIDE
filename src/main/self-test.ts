import type { WebContents } from 'electron';

/**
 * Packaged-app self-test (S02.4). With NOOBIDE_SELF_TEST=1 the renderer runs its Monaco worker probe and logs one
 * line `NOOBIDE_SELFTEST {json}`; main prints it to stdout and exits 0 (pass) or 1 (fail), 2 on timeout. This tests
 * the exact shipped binary, where Playwright cannot attach (the inspect fuse is off).
 */
export const SELF_TEST_ENV = 'NOOBIDE_SELF_TEST';
export const SELF_TEST_PREFIX = 'NOOBIDE_SELFTEST ';

export function selfTestRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SELF_TEST_ENV] === '1';
}

/**
 * S18.1: with NOOBIDE_SELF_TEST_OFFLINE=1 as well, the self-test runs with Chromium's network emulated offline, proving
 * the language services work without a network. The result line then reports `offline: true` and how many requests
 * the workbench's network guard refused (metadata only).
 */
export const SELF_TEST_OFFLINE_ENV = 'NOOBIDE_SELF_TEST_OFFLINE';

export function selfTestOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  return selfTestRequested(env) && env[SELF_TEST_OFFLINE_ENV] === '1';
}

/** Adds main-side facts to the renderer's result line. Unparsable lines are passed through unchanged. */
export function augmentSelfTestLine(message: string, extra: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(message.slice(SELF_TEST_PREFIX.length)) as Record<string, unknown>;
    return `${SELF_TEST_PREFIX}${JSON.stringify({ ...parsed, ...extra })}`;
  } catch {
    return message;
  }
}

export function withSelfTestQuery(url: string): string {
  const u = new URL(url);
  u.searchParams.set('selftest', '1');
  return u.toString();
}

export function watchSelfTest(
  contents: WebContents,
  exit: (code: number) => void,
  timeoutMs = 90_000,
  extra: () => Record<string, unknown> = () => ({}),
): void {
  const timer = setTimeout(() => {
    process.stdout.write(`${SELF_TEST_PREFIX}{"pass":false,"reason":"timeout"}\n`);
    exit(2);
  }, timeoutMs);
  contents.on('console-message', (event) => {
    const { message } = event;
    if (!message.startsWith(SELF_TEST_PREFIX)) return;
    clearTimeout(timer);
    const line = augmentSelfTestLine(message, extra());
    process.stdout.write(`${line}\n`);
    let pass: boolean;
    try {
      pass = (JSON.parse(line.slice(SELF_TEST_PREFIX.length)) as { pass?: unknown }).pass === true;
    } catch {
      pass = false;
    }
    exit(pass ? 0 : 1);
  });
}
