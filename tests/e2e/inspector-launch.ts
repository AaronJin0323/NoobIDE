import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { electronArgs, repoRoot } from './launch';

/**
 * Launches the app from the production build with only the main process's Node inspector (`--inspect=0`), NOT
 * through Playwright. Playwright also connects to Chromium over the DevTools protocol and attaches to every page and
 * view, which changes how they start: a new preview view's slow first document (S05.8) never showed under it. Tests drive main with `evaluate` (an expression
 * evaluated in the main process; `__noobideTestHooks` and `process.mainModule.require` are available).
 */
export interface InspectedApp {
  readonly child: ChildProcess;
  evaluate<T>(expression: string): Promise<T>;
  /** Quits like the user does (app.quit) and waits until the main process has exited. */
  quit(): Promise<void>;
}

const electronPath = createRequire(path.join(repoRoot, 'package.json'))('electron') as string;

export async function launchInspected(userDataDir: string): Promise<InspectedApp> {
  const child = spawn(electronPath, ['--inspect=0', `--user-data-dir=${userDataDir}`, ...electronArgs()], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    return await connect(child, exited);
  } catch (e) {
    // A launch that never became drivable must not keep running: it would hold the app's single-instance lock.
    child.kill();
    throw e;
  }
}

async function connect(child: ChildProcess, exited: Promise<void>): Promise<InspectedApp> {
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no inspector URL: ${output}`)), 60_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ws:\/\/\S+/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', () => reject(new Error(`exited before the inspector was ready: ${output}`)));
  });
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('inspector connection failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  ws.addEventListener('close', () => {
    for (const answer of pending.values()) answer({ error: { message: 'inspector closed' } });
    pending.clear();
  });
  const send = (method: string, params: object) =>
    new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      ws.send(JSON.stringify({ id: nextId, method, params }));
    });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (answer.error) throw new Error(answer.error.message);
    const result = answer.result as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluation failed');
    return result.result?.value as T;
  };

  const quit = async () => {
    await evaluate('process.mainModule.require("electron").app.quit()').catch(() => undefined);
    // Node keeps an exiting process alive until its inspector client disconnects ("Waiting for the debugger to
    // disconnect…"), so disconnect first, then wait: the single-instance lock is released when main has exited.
    ws.close();
    const timer = setTimeout(() => child.kill(), 30_000);
    await exited;
    clearTimeout(timer);
  };

  return { child, evaluate, quit };
}
