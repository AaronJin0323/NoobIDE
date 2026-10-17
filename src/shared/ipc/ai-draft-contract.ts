/**
 * Typed contract for the chat composer's unsent drafts (S48.7, zero-loss drafts). Pure TypeScript: no Electron, Node
 * or DOM imports. Exposed by the preload as `window.noobide.aiDrafts`.
 *
 * Invariants:
 * - Drafts live in the app-data directory only (one file per project, named by a hash of its real root, and one for
 *   chats without a project), never inside the project folder. Writes are atomic; sizes and counts are capped.
 * - A draft is what the user typed and the context chips they added (which can carry code). Never logged.
 * - One draft per conversation: `key` is the saved chat's id, or `new` for the conversation not started yet.
 * - The renderer names a project by its opaque `projectId` (null: no project open); main maps it to the root.
 */
import type { IpcResult } from './contract';

export const AI_DRAFT_CHANNELS = {
  getDrafts: 'ai:drafts-get',
  saveDraft: 'ai:drafts-save',
} as const;

/** The draft of the conversation not started yet. */
export const NEW_DRAFT_KEY = 'new';

/** A context chip of a draft: what it names and the text it carries (a selection's code, a problem's message). */
export interface AiDraftChip {
  readonly kind: 'file' | 'selection' | 'problem' | 'console' | 'annotation';
  readonly relPath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly label?: string;
  readonly text?: string;
}

export interface AiDraft {
  readonly prompt: string;
  readonly chips: readonly AiDraftChip[];
  readonly kind: 'chat' | 'agent';
  readonly mode: 'chat' | 'explain-code' | 'explain-problem';
}

export interface AiStoredDraft extends AiDraft {
  /** `new`, or the saved chat id (a UUID) of the conversation. */
  readonly key: string;
  /** Milliseconds since the epoch; main sets it. */
  readonly updatedAt: number;
}

export type AiSaveDraftError = 'unknown-project' | 'too-large' | 'write-failed';

export interface AiDraftApi {
  /** Every kept draft of the project (null: chats without a project), newest first. */
  getDrafts(request: {
    readonly projectId: string | null;
  }): Promise<IpcResult<{ readonly drafts: readonly AiStoredDraft[] }, 'unknown-project'>>;
  /** Keeps (or with `draft: null` forgets) one conversation's draft. */
  saveDraft(request: {
    readonly projectId: string | null;
    readonly key: string;
    readonly draft: AiDraft | null;
  }): Promise<IpcResult<null, AiSaveDraftError>>;
}
