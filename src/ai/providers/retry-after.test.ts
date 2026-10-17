import { describe, expect, it } from 'vitest';
import { ModelPortError } from '../agent/model-port';
import { parseFakeScript } from '../fake-provider';
import { requestErrorOf } from '../service';
import { toModelPortError } from './model-port-adapter';
import { ProviderError, requestOptions, retryAfterOf } from './provider';

/** S48.7: a provider's 429 / 503 reaches the renderer with its HTTP status and Retry-After (never a body). */
describe('Retry-After and HTTP status of provider failures (S48.7)', () => {
  const headers = (value: string | null) => new Headers(value === null ? {} : { 'retry-after': value });

  it('reads Retry-After as seconds or an HTTP date, bounded', () => {
    expect(retryAfterOf(headers('30'))).toBe(30);
    expect(retryAfterOf(headers('1.2'))).toBe(2);
    expect(retryAfterOf(headers('999999'))).toBe(3600);
    const now = Date.parse('2026-10-18T10:00:00Z');
    expect(retryAfterOf(headers('Sun, 18 Oct 2026 10:01:00 GMT'), now)).toBe(60);
    expect(retryAfterOf(headers('Sun, 18 Oct 2026 09:00:00 GMT'), now)).toBe(0);
    expect(retryAfterOf(headers('soon'))).toBeUndefined();
    expect(retryAfterOf(headers(null))).toBeUndefined();
    expect(retryAfterOf(undefined)).toBeUndefined();
    expect(retryAfterOf({ 'retry-after': '5' })).toBeUndefined(); // not a Headers object
  });

  it('passes the status and Retry-After into the error event of chat and agent requests', () => {
    expect(requestErrorOf(new ProviderError('rate-limited', 'anthropic 429', 429, 12))).toEqual({
      code: 'rate-limited',
      message: 'anthropic 429',
      status: 429,
      retryAfterSeconds: 12,
    });
    expect(requestErrorOf(new ProviderError('provider-error', 'openai 503', 503))).toEqual({
      code: 'provider-error',
      message: 'openai 503',
      status: 503,
    });
    expect(requestErrorOf(new ProviderError('offline', 'connection failed'))).toEqual({
      code: 'offline',
      message: 'connection failed',
    });
    const port = toModelPortError(new ProviderError('provider-error', 'anthropic 503', 503, 7));
    expect(port).toBeInstanceOf(ModelPortError);
    expect(port).toMatchObject({ code: 'provider-error', status: 503, retryAfterSeconds: 7 });
  });

  it('the fake provider reproduces an HTTP failure for the e2e suites', () => {
    const script = parseFakeScript({
      turns: [{ steps: [{ type: 'error', code: 'provider-error', status: 503, retryAfter: 1 }] }],
    });
    expect(script.turns?.[0]?.steps[0]).toEqual({ type: 'error', code: 'provider-error', status: 503, retryAfter: 1 });
    expect(
      parseFakeScript({ turns: [{ steps: [{ type: 'error', code: 'offline', status: 99, retryAfter: -1 }] }] })
        .turns?.[0]?.steps[0],
    ).toEqual({ type: 'error', code: 'offline' });
  });

  it('chat and agent turns never retry inside the SDK (the chat backoff does, visibly); inline and edit still do', () => {
    const signal = new AbortController().signal;
    expect(requestOptions({ purpose: 'chat', signal })).toEqual({ signal, maxRetries: 0 });
    expect(requestOptions({ purpose: 'agent' })).toEqual({ maxRetries: 0 });
    expect(requestOptions({ purpose: 'inline', signal })).toEqual({ signal });
    expect(requestOptions({ purpose: 'edit' })).toEqual({});
  });
});
