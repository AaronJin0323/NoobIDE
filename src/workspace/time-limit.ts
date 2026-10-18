import vm from 'node:vm';

/**
 * Runs synchronous code with a hard time limit (S51.6). A user's regular expression can backtrack for minutes on one
 * line (`(a+)+$` over "aaaa…!"), and a regex call cannot be interrupted from JavaScript. Node's vm timeout can: a
 * watchdog thread terminates V8 execution after `ms`, wherever it is (also inside a regex and inside functions of
 * this realm called from the script), and the call throws ERR_SCRIPT_EXECUTION_TIMEOUT. Main is then blocked for at
 * most `ms`, never indefinitely.
 *
 * One context and one compiled script are reused: creating a context costs about 0.2 ms.
 */

const context = vm.createContext({ call: undefined as (() => unknown) | undefined });
const script = new vm.Script('call()', { filename: 'noobide-time-limit.vm' });

export type TimeLimited<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Runs `fn` for at most `ms` milliseconds; `{ ok: false }` when the limit stopped it. Other errors propagate. */
export function runWithTimeLimit<T>(fn: () => T, ms: number): TimeLimited<T> {
  context.call = fn;
  try {
    return { ok: true, value: script.runInContext(context, { timeout: Math.max(1, Math.ceil(ms)) }) as T };
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { ok: false };
    throw e;
  } finally {
    context.call = undefined;
  }
}
