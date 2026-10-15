import { describe, expect, it } from 'vitest';
import { ResourceFailureTracker } from './resource-failures';

describe('ResourceFailureTracker (S16.4)', () => {
  it('reports an error status that completes normally', () => {
    const t = new ResourceFailureTracker();
    t.responseStarted(1, 404);
    expect(t.completed(1, 404)).toEqual({ kind: 'status', status: 404 });
    expect(t.completed(2, 200)).toEqual({ kind: 'ignore' });
    expect(t.size).toBe(0);
  });

  it('reports a 404 whose body Chromium cancelled (ERR_ABORTED after the error response) — the load race', () => {
    const t = new ResourceFailureTracker();
    t.responseStarted(7, 404);
    expect(t.errored(7, 'net::ERR_ABORTED')).toEqual({ kind: 'status', status: 404 });
    expect(t.size).toBe(0);
  });

  it('ignores an abort without an error response (navigation away, reload)', () => {
    const t = new ResourceFailureTracker();
    t.responseStarted(3, 200);
    expect(t.errored(3, 'net::ERR_ABORTED')).toEqual({ kind: 'ignore' });
    expect(t.errored(4, 'net::ERR_ABORTED')).toEqual({ kind: 'ignore' });
  });

  it('reports network errors as errors', () => {
    const t = new ResourceFailureTracker();
    expect(t.errored(5, 'net::ERR_SOCKS_CONNECTION_FAILED')).toEqual({
      kind: 'error',
      error: 'net::ERR_SOCKS_CONNECTION_FAILED',
    });
  });

  it('stays bounded when end events never arrive', () => {
    const t = new ResourceFailureTracker(3);
    for (let id = 0; id < 10; id++) t.responseStarted(id, 500);
    expect(t.size).toBe(3);
    expect(t.errored(9, 'net::ERR_ABORTED')).toEqual({ kind: 'status', status: 500 });
    expect(t.errored(0, 'net::ERR_ABORTED')).toEqual({ kind: 'ignore' }); // evicted, oldest first
  });
});
