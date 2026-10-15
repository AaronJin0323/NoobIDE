/**
 * S32.1: one inline suggestion at a time. A call waits for a pause in typing (debounce), starts an `inline` request,
 * collects the streamed `text` events of that request id until `done`, and returns the raw text. A newer call, a
 * cancelled token, a stale position or the timeout ends the current one: a request that already started is cancelled
 * in main (`ai.cancel`) so it stops costing tokens. Pure apart from the injected bridge and timers; unit-tested with a
 * fake bridge in inline-requester.test.ts.
 */
import type { AiApi, AiErrorCode, AiEvent, AiRequest } from '../../shared/ipc/ai-contract';
import type { RequestError } from '../../shared/ipc/contract';
import { INLINE_DEBOUNCE_MS, INLINE_TIMEOUT_MS } from './inline-context';

export type InlineAiRequest = Extract<AiRequest, { kind: 'inline' }>;

/** Monaco's CancellationToken has this shape. */
export interface CancelSignal {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Raw answers longer than this are cut off and the request stopped: no suggestion is shown that long. */
export const INLINE_MAX_RAW_CHARS = 16_000;

export interface InlineStats {
  /** Requests started in main. */
  requests: number;
  /** Requests cancelled in main (`ai.cancel`) because the user typed, moved the cursor, or time ran out. */
  cancels: number;
  /** Calls that ended during the debounce wait, before any request. */
  debounced: number;
  /** Requests that finished with text. */
  completed: number;
  /** Last error code from main, if any (codes only). */
  lastError: AiErrorCode | RequestError | null;
}

interface Pending {
  readonly key: string;
  timer: unknown;
  requestId: string | null;
  text: string;
  finished: boolean;
  subscription: { dispose(): void } | null;
  readonly resolve: (text: string | null) => void;
}

export class InlineRequester {
  private current: Pending | null = null;
  /** Events of ids whose `request()` has not answered yet (only kept while one of ours is starting). */
  private readonly early = new Map<string, AiEvent[]>();
  private starting = 0;
  private unsubscribe: (() => void) | null = null;
  readonly stats: InlineStats = { requests: 0, cancels: 0, debounced: 0, completed: 0, lastError: null };

  constructor(
    private readonly bridge: () => Pick<AiApi, 'request' | 'cancel' | 'onEvent'> | null,
    private readonly options: {
      readonly debounceMs?: number;
      readonly timeoutMs?: number;
      readonly timers?: Timers;
      /** Main refused or failed for a reason that may change the status (key, consent, AI off). */
      readonly onStatusError?: (code: AiErrorCode) => void;
    } = {},
  ) {}

  /**
   * Resolves with the raw text of a suggestion for `request`, or null. `key` identifies the document version and
   * cursor position the request was made for (see `cancelUnless`).
   */
  complete(request: InlineAiRequest, key: string, signal?: CancelSignal): Promise<string | null> {
    this.end();
    if (signal?.isCancellationRequested) return Promise.resolve(null);
    const timers = this.options.timers ?? realTimers;
    return new Promise<string | null>((resolve) => {
      const pending: Pending = {
        key,
        timer: null,
        requestId: null,
        text: '',
        finished: false,
        subscription: null,
        resolve,
      };
      this.current = pending;
      pending.subscription =
        signal?.onCancellationRequested(() => {
          if (this.current === pending) this.end();
        }) ?? null;
      pending.timer = timers.set(() => {
        pending.timer = null;
        if (this.current === pending) void this.start(pending, request);
      }, this.options.debounceMs ?? INLINE_DEBOUNCE_MS);
    });
  }

  /** The document or cursor changed: end the current call unless it was made for exactly `key`. */
  cancelUnless(key: string): void {
    if (this.current && this.current.key !== key) this.end();
  }

  /** Ends the current call (tab switch, editor disposed, inline switched off). */
  cancelAll(): void {
    this.end();
  }

  dispose(): void {
    this.cancelAll();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private listen(api: Pick<AiApi, 'onEvent'>): void {
    if (this.unsubscribe) return;
    this.unsubscribe = api.onEvent((event) => this.onEvent(event));
  }

  private async start(pending: Pending, request: InlineAiRequest): Promise<void> {
    const api = this.bridge();
    if (!api) return this.finish(pending, null);
    this.listen(api);
    this.starting += 1;
    let result: Awaited<ReturnType<AiApi['request']>>;
    try {
      result = await api.request(request);
    } catch {
      result = { ok: false, code: 'provider-error', message: '' };
    } finally {
      this.starting -= 1;
    }
    if (!result.ok) {
      this.early.clear();
      this.noteError(result.code);
      return this.finish(pending, null);
    }
    const { requestId } = result.value;
    this.stats.requests += 1;
    const buffered = this.early.get(requestId) ?? [];
    if (this.starting === 0) this.early.clear();
    else this.early.delete(requestId);
    if (pending.finished || this.current !== pending) {
      // Typed or moved while main was starting it: stop it right away.
      this.stats.cancels += 1;
      void api.cancel({ requestId }).catch(() => undefined);
      return;
    }
    pending.requestId = requestId;
    const timers = this.options.timers ?? realTimers;
    pending.timer = timers.set(() => {
      pending.timer = null;
      if (this.current === pending) this.end();
    }, this.options.timeoutMs ?? INLINE_TIMEOUT_MS);
    for (const event of buffered) this.onEvent(event);
  }

  private onEvent(event: AiEvent): void {
    const pending = this.current;
    if (!pending || pending.requestId !== event.requestId) {
      if (this.starting > 0) {
        const list = this.early.get(event.requestId) ?? [];
        list.push(event);
        this.early.set(event.requestId, list);
      }
      return;
    }
    switch (event.type) {
      case 'text':
        pending.text += event.text;
        if (pending.text.length > INLINE_MAX_RAW_CHARS) {
          const text = pending.text.slice(0, INLINE_MAX_RAW_CHARS);
          this.cancelInMain(pending);
          this.finish(pending, text);
        }
        return;
      case 'done':
        this.stats.completed += 1;
        this.finish(pending, pending.text);
        return;
      case 'error':
        if (event.code !== 'cancelled') this.noteError(event.code);
        this.finish(pending, null);
        return;
      default:
        // Inline requests carry no steps or proposals; anything else is ignored.
        return;
    }
  }

  private end(): void {
    const pending = this.current;
    if (!pending || pending.finished) return;
    if (pending.requestId === null) {
      if (pending.timer !== null) this.stats.debounced += 1;
      // A request still starting is cancelled when `request()` answers (see start()).
    } else {
      this.cancelInMain(pending);
    }
    this.finish(pending, null);
  }

  private cancelInMain(pending: Pending): void {
    const api = this.bridge();
    if (pending.requestId === null || !api) return;
    this.stats.cancels += 1;
    void api.cancel({ requestId: pending.requestId }).catch(() => undefined);
  }

  private finish(pending: Pending, text: string | null): void {
    if (pending.finished) return;
    pending.finished = true;
    pending.subscription?.dispose();
    if (pending.timer !== null) {
      (this.options.timers ?? realTimers).clear(pending.timer);
      pending.timer = null;
    }
    if (this.current === pending) this.current = null;
    pending.resolve(text);
  }

  private noteError(code: AiErrorCode | RequestError): void {
    this.stats.lastError = code;
    if (
      code === 'no-key' ||
      code === 'no-consent' ||
      code === 'disabled' ||
      code === 'unauthorized' ||
      code === 'budget-reached' // S39.2: the status line then says the suggestions are paused
    ) {
      this.options.onStatusError?.(code);
    }
  }
}
