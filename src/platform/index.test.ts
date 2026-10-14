import { describe, expect, it } from 'vitest';
import {
  canSyncDirectory,
  lockedRenameBackoffMs,
  platformId,
  quitsWhenLastWindowCloses,
  recreatesWindowOnActivate,
} from './index';

describe('save-related platform rules (S10.1)', () => {
  it('retries locked renames on Windows only and syncs directories elsewhere', () => {
    expect(lockedRenameBackoffMs('win32').length).toBeGreaterThan(0);
    expect(lockedRenameBackoffMs('darwin')).toEqual([]);
    expect(canSyncDirectory('win32')).toBe(false);
    expect(canSyncDirectory('darwin')).toBe(true);
  });
});

describe('platform adapter', () => {
  it('maps Node platform ids to the two supported platforms', () => {
    expect(platformId('darwin')).toBe('mac');
    expect(platformId('win32')).toBe('windows');
    expect(platformId('linux')).toBe('other');
  });

  it('follows each platform window-lifecycle convention (PLAN §3)', () => {
    expect(quitsWhenLastWindowCloses('win32')).toBe(true);
    expect(quitsWhenLastWindowCloses('darwin')).toBe(false);
    expect(recreatesWindowOnActivate('darwin')).toBe(true);
    expect(recreatesWindowOnActivate('win32')).toBe(false);
  });
});
