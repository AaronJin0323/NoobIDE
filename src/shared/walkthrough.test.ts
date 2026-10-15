import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALKTHROUGH,
  MAX_BASELINE_LENGTH,
  WALKTHROUGH_STEPS,
  loadWalkthroughState,
  parseWalkthroughState,
  type WalkthroughState,
} from './walkthrough';

const ACTIVE: WalkthroughState = {
  ...DEFAULT_WALKTHROUGH,
  status: 'active',
  step: 'style',
  completed: ['create', 'files', 'heading'],
  baseline: '["color:#2563eb"]',
};

describe('walkthrough state (S23.1)', () => {
  it('follows the PLAN §2 journey in order', () => {
    expect(WALKTHROUGH_STEPS).toEqual([
      'create',
      'files',
      'heading',
      'style',
      'interaction',
      'error',
      'restore',
      'reopen',
    ]);
  });

  it('accepts exactly a valid state over IPC', () => {
    expect(parseWalkthroughState(ACTIVE)).toEqual(ACTIVE);
    expect(parseWalkthroughState(DEFAULT_WALKTHROUGH)).toEqual(DEFAULT_WALKTHROUGH);
    // completed steps come back in journey order
    expect(parseWalkthroughState({ ...ACTIVE, completed: ['heading', 'create'] })?.completed).toEqual([
      'create',
      'heading',
    ]);
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an extra key', { ...ACTIVE, path: '/Users/x' }],
    ['a missing key', { ...ACTIVE, baseline: undefined }],
    ['an unknown step', { ...ACTIVE, step: 'deploy' }],
    ['an unknown status', { ...ACTIVE, status: 'running' }],
    ['duplicate completed steps', { ...ACTIVE, completed: ['create', 'create'] }],
    ['a huge baseline', { ...ACTIVE, baseline: 'x'.repeat(MAX_BASELINE_LENGTH + 1) }],
    ['a newer version', { ...ACTIVE, version: 2 }],
    ['an unknown task status', { ...ACTIVE, task: 'won' }],
  ])('rejects %s', (_name, payload) => {
    expect(parseWalkthroughState(payload)).toBeNull();
  });

  it('loads a stored file leniently: a bad field takes its default, the others are kept', () => {
    expect(loadWalkthroughState({ ...ACTIVE, step: 'deploy' })).toEqual({ ...ACTIVE, step: 'create' });
    expect(loadWalkthroughState({ ...ACTIVE, completed: 'all' })).toEqual({ ...ACTIVE, completed: [] });
    expect(loadWalkthroughState('garbage')).toEqual(DEFAULT_WALKTHROUGH);
    // S28.4: a file from a newer NoobIDE keeps the fields this version understands; a broken version does not.
    expect(loadWalkthroughState({ ...ACTIVE, version: 99, extra: 'x' })).toEqual(ACTIVE);
    expect(loadWalkthroughState({ ...ACTIVE, version: 'two' })).toEqual(DEFAULT_WALKTHROUGH);
  });
});
