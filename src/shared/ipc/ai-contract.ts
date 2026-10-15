/**
 * Typed contract for the AI assistant (S31–S36, decision 0025): chat, explain, inline completions, inline edit and
 * agent mode, powered by the user's own Anthropic or OpenAI API key. Pure TypeScript: no Electron, Node or DOM imports.
 *
 * Invariants (decision 0025):
 * - Provider SDK calls and the API key live in main only. The key is written once (setKey) and never sent back to a
 *   renderer, logged or written into a project; it is encrypted with Electron safeStorage in the app-data dir.
 * - Code sent to a provider is shown/consented first: a project must have AI consent (`setConsent`) before any request
 *   that carries its files; every chat/agent request carries the exact context list the user saw.
 * - Logs never contain source code, prompts or responses — only request ids, kinds, token counts and error codes.
 * - The agent never writes files itself: it emits proposals; the workbench applies accepted ones through the normal
 *   save pipeline (atomic write, local history snapshot, undo).
 * - The preview page never reaches these channels (no preload there).
 * - Without a key or without network, nothing else in NoobIDE changes (offline-first).
 */
import type { IpcResult } from './contract';

export type AiProviderId = 'anthropic' | 'openai';
export const AI_PROVIDERS: readonly AiProviderId[] = ['anthropic', 'openai'];

/** What a request is for; each has its own model setting. */
export type AiPurpose = 'chat' | 'agent' | 'inline' | 'edit';
export const AI_PURPOSES: readonly AiPurpose[] = ['chat', 'agent', 'inline', 'edit'];

export const AI_CHANNELS = {
  status: 'ai:status',
  setKey: 'ai:set-key',
  clearKey: 'ai:clear-key',
  testKey: 'ai:test-key',
  listModels: 'ai:list-models',
  setConfig: 'ai:set-config',
  setConsent: 'ai:set-consent',
  request: 'ai:request',
  cancel: 'ai:cancel',
  resolveProposal: 'ai:resolve-proposal',
} as const;

/** Main → workbench stream of events for running requests. */
export const AI_EVENT_CHANNEL = 'ai:event';

export interface AiConfig {
  /** On by default once a key exists (owner decision); the user can switch AI off entirely. */
  readonly enabled: boolean;
  readonly provider: AiProviderId | null;
  /** Model id per purpose for the active provider (user-selectable; listModels offers the provider's list). */
  readonly models: Readonly<Record<AiPurpose, string>>;
  /** Inline completions can be switched off on their own. */
  readonly inlineCompletions: boolean;
}

export interface AiStatus {
  readonly config: AiConfig;
  /** Which providers have a stored key. The key itself is never returned. */
  readonly keyStored: Readonly<Record<AiProviderId, boolean>>;
  /** safeStorage is available (OS keychain). When false, keys cannot be stored and AI stays off — explained in UI. */
  readonly secureStorage: boolean;
  /** Projects (by id) the user allowed to send code from, for the open project only. */
  readonly projectConsent: boolean;
  /** S39.2: the optional daily token budget is used up: new requests are refused, inline suggestions pause. */
  readonly budgetReached?: boolean;
}

export type AiKeyError = 'invalid-provider' | 'empty-key' | 'no-secure-storage' | 'write-failed';
export type AiTestError =
  'no-key' | 'unauthorized' | 'rate-limited' | 'offline' | 'provider-error' | 'model-not-found' | 'invalid-provider';

export interface AiModelInfo {
  readonly id: string;
  readonly displayName: string;
}

/** A file or excerpt the user saw in the context list before sending. Paths are project-relative. */
export interface AiContextItem {
  readonly kind: 'file' | 'selection' | 'problem' | 'console';
  readonly relPath?: string;
  /** 1-based inclusive line range for selections and excerpts. */
  readonly startLine?: number;
  readonly endLine?: number;
  /** Text as shown to the user (open editor buffer, may be unsaved). Main re-reads files from disk when absent. */
  readonly text?: string;
  /** Short label shown in the context list (e.g. a problem's title). */
  readonly label?: string;
}

export interface AiChatMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export type AiRequest =
  | {
      readonly kind: 'chat';
      readonly projectId: string | null;
      /** Earlier turns of this conversation (text only), oldest first. */
      readonly history: readonly AiChatMessage[];
      readonly prompt: string;
      readonly context: readonly AiContextItem[];
      /** 'explain-code' / 'explain-problem' use tuned beginner-friendly instructions. */
      readonly mode?: 'chat' | 'explain-code' | 'explain-problem';
      /** UI language for the answer. */
      readonly locale: 'zh-CN' | 'en';
    }
  | {
      readonly kind: 'inline';
      readonly projectId: string;
      readonly relPath: string;
      readonly languageId: string;
      /** Text before / after the cursor, already bounded by the renderer. */
      readonly prefix: string;
      readonly suffix: string;
    }
  | {
      readonly kind: 'edit';
      readonly projectId: string;
      readonly relPath: string;
      readonly languageId: string;
      readonly instruction: string;
      /** The selected text to rewrite (or the whole file when nothing is selected), with surrounding lines. */
      readonly selection: string;
      readonly before: string;
      readonly after: string;
      readonly locale: 'zh-CN' | 'en';
    }
  | {
      readonly kind: 'agent';
      readonly projectId: string;
      readonly history: readonly AiChatMessage[];
      readonly prompt: string;
      readonly context: readonly AiContextItem[];
      readonly locale: 'zh-CN' | 'en';
    };

/** One file change the agent proposes; applied only after the user accepts it. */
export type AiFileChange =
  | { readonly kind: 'edit'; readonly relPath: string; readonly before: string; readonly after: string }
  | { readonly kind: 'create'; readonly relPath: string; readonly after: string }
  | { readonly kind: 'rename'; readonly relPath: string; readonly to: string }
  | { readonly kind: 'delete'; readonly relPath: string };

export type AiErrorCode =
  | 'disabled'
  | 'no-key'
  | 'no-consent'
  | 'unauthorized'
  | 'rate-limited'
  | 'offline'
  | 'context-too-large'
  | 'refused'
  | 'cancelled'
  | 'provider-error'
  | 'unknown-project'
  /** S34: an agent turn reached its step, token or wall-time budget and stopped (accepted changes are kept). */
  | 'budget-exhausted'
  /** S39.2: today's optional token budget (Settings → AI) is used up; new requests wait until tomorrow. */
  | 'budget-reached';

export type AiEvent =
  | { readonly requestId: string; readonly type: 'text'; readonly text: string }
  /** Agent: a tool it ran (read-only tools), shown as a step ("read index.html"). Never contains file contents. */
  | { readonly requestId: string; readonly type: 'step'; readonly tool: string; readonly summary: string }
  | {
      readonly requestId: string;
      readonly type: 'proposal';
      readonly proposalId: string;
      readonly changes: readonly AiFileChange[];
      /** One-sentence reason from the agent, shown above the diff. */
      readonly reason: string;
    }
  | {
      readonly requestId: string;
      readonly type: 'done';
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    }
  | { readonly requestId: string; readonly type: 'error'; readonly code: AiErrorCode; readonly message: string };

export interface AiProposalDecision {
  readonly requestId: string;
  readonly proposalId: string;
  /** Per change index: accepted and applied (with the outcome), or rejected. The agent sees the outcome. */
  readonly results: readonly (
    | { readonly accepted: true; readonly applied: boolean; readonly error?: string }
    | {
        readonly accepted: false;
      }
  )[];
}

export interface AiApi {
  status(request: { readonly projectId: string | null }): Promise<IpcResult<AiStatus, never>>;
  setKey(request: { readonly provider: AiProviderId; readonly key: string }): Promise<IpcResult<null, AiKeyError>>;
  clearKey(request: { readonly provider: AiProviderId }): Promise<IpcResult<null, AiKeyError>>;
  testKey(request: { readonly provider: AiProviderId }): Promise<IpcResult<null, AiTestError>>;
  listModels(request: { readonly provider: AiProviderId }): Promise<IpcResult<readonly AiModelInfo[], AiTestError>>;
  setConfig(request: { readonly config: AiConfig }): Promise<IpcResult<AiConfig, 'invalid-config'>>;
  setConsent(request: {
    readonly projectId: string;
    readonly allowed: boolean;
  }): Promise<IpcResult<null, 'unknown-project'>>;
  /** Starts a request; events arrive through onEvent with the returned id. */
  request(request: AiRequest): Promise<IpcResult<{ readonly requestId: string }, AiErrorCode>>;
  cancel(request: { readonly requestId: string }): Promise<IpcResult<null, never>>;
  /** The workbench reports what happened to a proposal; the agent continues with that outcome. */
  resolveProposal(decision: AiProposalDecision): Promise<IpcResult<null, 'unknown-request'>>;
  onEvent(listener: (event: AiEvent) => void): () => void;
}
