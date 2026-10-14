/**
 * Typed contract of the onboarding walkthrough (S23): its progress lives in app data so it can be resumed after a
 * restart (the "reopen" step needs exactly that) and revisited from Help. Same rules as contract.ts: pure
 * TypeScript, main validates every payload with parseWalkthroughState and checks the sender before the store is
 * touched. The state never holds file contents or absolute paths.
 */
import { parseWalkthroughState, type WalkthroughState } from '../walkthrough';
import type { IpcResult } from './contract';

export const WALKTHROUGH_CHANNELS = {
  get: 'walkthrough:get',
  save: 'walkthrough:save',
} as const;

export interface WalkthroughApi {
  /** The stored progress (the defaults when nothing was stored or the file was unusable). */
  get(): Promise<IpcResult<WalkthroughState, never>>;
  /** Replaces the stored progress (written atomically). */
  save(state: WalkthroughState): Promise<IpcResult<null, never>>;
}

export { parseWalkthroughState };
export type { WalkthroughState };
