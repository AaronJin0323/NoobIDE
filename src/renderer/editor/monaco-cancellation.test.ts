import { describe, expect, it } from 'vitest';
import { ignoreMonacoCancellations, isMonacoCancellation } from './monaco-cancellation';

function cancellation(): Error {
  const error = new Error('Canceled');
  error.name = 'Canceled';
  return error;
}

describe('Monaco cancellation rejections (S37.1)', () => {
  it('recognises only Monaco CancellationErrors', () => {
    expect(isMonacoCancellation(cancellation())).toBe(true);
    expect(isMonacoCancellation(new Error('Canceled'))).toBe(false);
    expect(isMonacoCancellation({ name: 'Canceled', message: 'Canceled' })).toBe(false);
    expect(isMonacoCancellation('Canceled')).toBe(false);
    expect(isMonacoCancellation(undefined)).toBe(false);
  });

  it('swallows cancellations and leaves every other rejection reported', () => {
    let listener: ((event: { reason: unknown; preventDefault(): void }) => void) | undefined;
    ignoreMonacoCancellations({ addEventListener: (_type, l) => (listener = l) });
    const dispatch = (reason: unknown) => {
      let prevented = false;
      listener?.({ reason, preventDefault: () => (prevented = true) });
      return prevented;
    };
    expect(dispatch(cancellation())).toBe(true);
    expect(dispatch(new TypeError('x is undefined'))).toBe(false);
    expect(dispatch(new Error('Canceled'))).toBe(false);
  });
});
