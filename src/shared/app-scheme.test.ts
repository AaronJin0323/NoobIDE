import { describe, expect, it } from 'vitest';
import { APP_SCHEME } from './app-scheme';
import { APP_SCHEME as MAIN_APP_SCHEME } from '../main/app-asset';

describe('app scheme (S52.6)', () => {
  it('the renderer builds image URLs with the scheme main serves', () => {
    expect(APP_SCHEME).toBe(MAIN_APP_SCHEME);
  });
});
