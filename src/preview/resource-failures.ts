/**
 * S16.4: which finished preview requests are resource failures. The preview session's webRequest events end a
 * request with `onCompleted` (with its HTTP status) or `onErrorOccurred`. Chromium does not always read the body of
 * an error response: a 404 image or module script is often cancelled once its headers arrive, and the request then
 * ends with `net::ERR_ABORTED` instead of `onCompleted`, depending on timing (more often on a busy machine). The
 * server did answer with an error status, so that status is remembered from `onResponseStarted` and reported. A
 * request aborted without an error response (navigation away, reload, window.stop) is not a failure.
 */
export type RequestOutcome =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'error'; readonly error: string };

const ABORTED = 'net::ERR_ABORTED';

export class ResourceFailureTracker {
  /** Request id → error status (≥ 400) of a request still in flight. */
  private readonly errorStatus = new Map<number, number>();

  /** Bounded: a request whose end event never arrives must not grow the map forever. */
  constructor(private readonly maxTracked = 1_000) {}

  /** `onResponseStarted`: the response headers arrived. */
  responseStarted(id: number, status: number): void {
    if (status < 400) return;
    if (this.errorStatus.size >= this.maxTracked) {
      const oldest = this.errorStatus.keys().next().value;
      if (oldest !== undefined) this.errorStatus.delete(oldest);
    }
    this.errorStatus.set(id, status);
  }

  /** `onCompleted`. */
  completed(id: number, status: number): RequestOutcome {
    this.errorStatus.delete(id);
    return status >= 400 ? { kind: 'status', status } : { kind: 'ignore' };
  }

  /** `onErrorOccurred`. */
  errored(id: number, error: string): RequestOutcome {
    const status = this.errorStatus.get(id);
    this.errorStatus.delete(id);
    if (error !== ABORTED) return { kind: 'error', error };
    return status === undefined ? { kind: 'ignore' } : { kind: 'status', status };
  }

  /** Requests currently remembered (tests). */
  get size(): number {
    return this.errorStatus.size;
  }
}
