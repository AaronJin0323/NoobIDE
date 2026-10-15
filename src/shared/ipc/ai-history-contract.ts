/**
 * Typed contract for saved AI chats and token usage (S39, decision 0025). Pure TypeScript: no Electron, Node or DOM
 * imports. Exposed by the preload as `window.noobide.aiHistory`, next to `window.noobide.ai` (ai-contract.ts).
 *
 * Invariants:
 * - Saved chats live in the app-data directory only (one folder per project, named by a hash of its real root),
 *   never inside the project folder. Writes are atomic; the number and size of saved chats per project are capped
 *   and the oldest are pruned first. A chat file that cannot be read is skipped (and counted), never a crash.
 * - Chat files hold the user's questions and the answers (which can quote code). Their content is never logged.
 * - Usage totals are kept per day and per provider (token counts only). The optional daily budget refuses NEW AI
 *   requests once reached (`budget-reached`); running requests finish; non-AI features are never affected.
 * - The renderer names a project by its opaque `projectId` (or a recent entry by its id); main maps it to the root.
 */
import type { AiProviderId } from './ai-contract';
import type { IpcResult } from './contract';

export const AI_HISTORY_CHANNELS = {
  listChats: 'ai:chats-list',
  getChat: 'ai:chats-get',
  saveChat: 'ai:chats-save',
  deleteChat: 'ai:chats-delete',
  deleteProjectChats: 'ai:chats-delete-project',
  countRecentChats: 'ai:chats-count-recent',
  deleteRecentChats: 'ai:chats-delete-recent',
  usage: 'ai:usage',
  setDailyBudget: 'ai:usage-set-budget',
} as const;

/** A context item as remembered in a saved chat: what it named, without the code it carried. */
export interface AiSavedContextItem {
  // S38.2 preview / S41.6 annotation: the chip's name only
  readonly kind: 'file' | 'selection' | 'problem' | 'console' | 'preview' | 'annotation';
  readonly relPath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly label?: string;
}

/** A file change an agent proposed, as remembered (what and where, not the contents). */
export interface AiSavedChange {
  readonly kind: 'edit' | 'create' | 'rename' | 'delete';
  readonly relPath: string;
  readonly to?: string;
}

export type AiSavedPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'step'; readonly tool: string; readonly summary: string }
  | { readonly kind: 'proposal'; readonly reason: string; readonly changes: readonly AiSavedChange[] };

export interface AiSavedTurn {
  readonly kind: 'chat' | 'agent';
  readonly mode: 'chat' | 'explain-code' | 'explain-problem';
  readonly prompt: string;
  readonly context: readonly AiSavedContextItem[];
  /** Only ended turns are saved. */
  readonly status: 'done' | 'error' | 'cancelled';
  readonly parts: readonly AiSavedPart[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** The error code of a failed turn (explained in the UI language when shown again). */
  readonly errorCode?: string;
}

/** What the renderer sends to save a conversation. Main sets the dates. */
export interface AiChatToSave {
  /** A UUID chosen by the renderer for this conversation. */
  readonly id: string;
  readonly title: string;
  readonly turns: readonly AiSavedTurn[];
}

export interface AiSavedChat extends AiChatToSave {
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AiSavedChatSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly turnCount: number;
}

export interface AiChatList {
  /** Newest first. */
  readonly chats: readonly AiSavedChatSummary[];
  /** Saved chats that could not be read (damaged, or from a newer NoobIDE) and were skipped. */
  readonly skipped: number;
}

export interface AiUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiUsageSummary {
  /** Today in local time, `YYYY-MM-DD`. */
  readonly day: string;
  readonly perProvider: Readonly<Record<AiProviderId, AiUsageTotals>>;
  /** Input + output tokens of all providers today. */
  readonly totalTokens: number;
  /** Optional daily limit on input + output tokens; null = no limit (the default). */
  readonly dailyBudget: number | null;
  readonly budgetReached: boolean;
}

export type AiSaveChatError = 'unknown-project' | 'too-large' | 'write-failed';

export interface AiHistoryApi {
  listChats(request: { readonly projectId: string }): Promise<IpcResult<AiChatList, 'unknown-project'>>;
  getChat(request: {
    readonly projectId: string;
    readonly chatId: string;
  }): Promise<IpcResult<AiSavedChat, 'unknown-project' | 'not-found'>>;
  /** Saves (creates or replaces) one conversation; older chats beyond the caps are pruned. */
  saveChat(request: {
    readonly projectId: string;
    readonly chat: AiChatToSave;
  }): Promise<IpcResult<AiSavedChatSummary, AiSaveChatError>>;
  deleteChat(request: {
    readonly projectId: string;
    readonly chatId: string;
  }): Promise<IpcResult<null, 'unknown-project' | 'delete-failed'>>;
  /** Deletes every saved chat of the open project (offered when its AI consent is revoked). */
  deleteProjectChats(request: {
    readonly projectId: string;
  }): Promise<IpcResult<{ readonly deleted: number }, 'unknown-project'>>;
  /** How many chats a recent-projects entry has (asked before the entry is removed from the list). */
  countRecentChats(request: { readonly id: string }): Promise<IpcResult<{ readonly count: number }, 'unknown-recent'>>;
  deleteRecentChats(request: {
    readonly id: string;
  }): Promise<IpcResult<{ readonly deleted: number }, 'unknown-recent'>>;
  usage(): Promise<IpcResult<AiUsageSummary, never>>;
  /** null switches the budget off. */
  setDailyBudget(request: {
    readonly dailyTokens: number | null;
  }): Promise<IpcResult<AiUsageSummary, 'invalid-budget'>>;
}
