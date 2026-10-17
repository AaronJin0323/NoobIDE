/**
 * S48.7 zero-loss drafts: keeps the composer's unsent text and context chips of each conversation in app data
 * (`window.noobide.aiDrafts`, main's AiDraftStore — never the project folder), 300 ms after the last change, and
 * brings them back after a restart (the new conversation's draft at once, a saved chat's draft when it is reopened)
 * with a status line saying so. No React and no DOM, so it is unit-tested against a fake bridge and a fake clock.
 *
 * Keys: a conversation's draft is kept under its saved chat id (chat-history.ts) and the draft of a conversation not
 * saved yet under `new`, which is also what the panel shows first after a restart. Preview chips are not kept: their
 * screenshot expires with the window (S38.2).
 */
import { NEW_DRAFT_KEY, type AiDraft, type AiDraftApi, type AiDraftChip } from '../../shared/ipc/ai-draft-contract';
import { AI_DRAFT_LIMITS } from '../../shared/ipc/ai-draft-parse';
import type { AiChatController } from './chat-controller';
import {
  draftKeyOf,
  draftOf,
  isEmptyDraft,
  projectKeyOf,
  type ChatChip,
  type ChatDraft,
  type ChatState,
} from './chat-model';

export const DRAFT_DEBOUNCE_MS = 300;

export function aiDraftBridge(): AiDraftApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window.noobide as { readonly aiDrafts?: AiDraftApi } | undefined)?.aiDrafts;
}

export interface DraftClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: DraftClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The draft as it is kept: chips without the Preview's expiring snapshot, sizes within the store's limits. */
export function toStoredDraft(draft: ChatDraft): AiDraft | null {
  const chips: AiDraftChip[] = [];
  for (const chip of draft.chips) {
    const item = chip.item;
    if (item.kind === 'preview' || chips.length >= AI_DRAFT_LIMITS.chips) continue;
    if (item.text !== undefined && item.text.length > AI_DRAFT_LIMITS.chipTextChars) continue;
    chips.push({
      kind: item.kind,
      ...(item.relPath !== undefined ? { relPath: item.relPath } : {}),
      ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
      ...(item.endLine !== undefined ? { endLine: item.endLine } : {}),
      ...(item.label !== undefined ? { label: item.label.slice(0, AI_DRAFT_LIMITS.labelChars) } : {}),
      ...(item.text !== undefined ? { text: item.text } : {}),
    });
  }
  const prompt = draft.prompt.slice(0, AI_DRAFT_LIMITS.promptChars);
  if (prompt === '' && chips.length === 0) return null;
  return { prompt, chips, kind: draft.kind, mode: draft.mode };
}

/** A kept draft back in the panel's form (fresh chip ids). */
export function fromStoredDraft(stored: AiDraft, chipId: () => string): ChatDraft {
  const chips: ChatChip[] = stored.chips.map((chip) => ({ id: chipId(), item: { ...chip } }));
  return { prompt: stored.prompt, chips, kind: stored.kind, mode: stored.mode };
}

/** Whether the kept form holds all of the draft (nothing cut to the store's limits, Preview chips aside). */
function keptWhole(draft: ChatDraft, stored: AiDraft): boolean {
  return (
    stored.prompt.length === draft.prompt.length &&
    stored.chips.length === draft.chips.filter((chip) => chip.item.kind !== 'preview').length
  );
}

const serialize = (draft: AiDraft | null): string => (draft ? JSON.stringify(draft) : '');

interface Pending {
  readonly projectId: string | null;
  readonly key: string;
  readonly draft: AiDraft | null;
}

export class DraftSync {
  private unsubscribe: (() => void) | null = null;
  /** The project whose drafts are loaded (undefined: none loaded yet). */
  private projectId: string | null | undefined = undefined;
  /** What the store holds for the loaded project, by key (serialized). */
  private readonly persisted = new Map<string, string>();
  /** Kept drafts of saved chats not reopened yet: restored when their chat is shown. */
  private readonly waiting = new Map<string, AiDraft>();
  /** The panel conversation whose draft was last kept under `new` (null: the new conversation itself). */
  private newOwner: string | null = null;
  private readonly pending = new Map<string, Pending>();
  private timer: unknown = null;
  private writing: Promise<void> = Promise.resolve();
  private chipSeq = 0;
  private failedNoticeShown = false;
  /** The newest write per key, so an older queued value never lands after a newer one. */
  private readonly writeSeq = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly api: AiDraftApi,
    private readonly controller: Pick<AiChatController, 'getState' | 'subscribe' | 'restoreDraft' | 'showNotice'>,
    private readonly currentProject: () => string | null,
    /** The saved chat id of a panel conversation (chat-history.ts), or null. */
    private readonly savedIdOf: (conversationId: string | null) => string | null,
    private readonly clock: DraftClock = REAL_CLOCK,
  ) {}

  /** Starts keeping drafts. Returns the stop function; idempotent. */
  start(): () => void {
    if (!this.unsubscribe) this.unsubscribe = this.controller.subscribe(() => this.onChatState());
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  /** The open project changed (or the window started): keep what is pending, then load the project's drafts. */
  async projectChanged(): Promise<void> {
    const projectId = this.currentProject();
    if (projectId === this.projectId) return;
    await this.flush();
    this.projectId = projectId;
    this.persisted.clear();
    this.waiting.clear();
    this.newOwner = null;
    let drafts: readonly (AiDraft & { readonly key: string })[] = [];
    try {
      const result = await this.api.getDrafts({ projectId });
      if (result.ok) drafts = result.value.drafts;
    } catch {
      // Nothing kept can be read: the panel starts empty, as without drafts.
    }
    if (this.currentProject() !== projectId) return; // switched again meanwhile
    for (const stored of drafts) {
      const draft: AiDraft = { prompt: stored.prompt, chips: stored.chips, kind: stored.kind, mode: stored.mode };
      this.persisted.set(stored.key, serialize(draft));
      if (stored.key === NEW_DRAFT_KEY) this.restore(null, draft);
      else this.waiting.set(stored.key, draft);
    }
    this.onChatState();
  }

  /** Writes what is pending now (before the window closes, and in tests). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
    await this.writing;
  }

  /**
   * The window is closing: what is pending leaves now, without waiting behind a write in flight (main serializes the
   * writes, and the quit waits for them).
   */
  flushNow(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.write(true);
  }

  private restore(conversationId: string | null, draft: AiDraft): void {
    this.controller.restoreDraft(
      this.projectId ?? null,
      conversationId,
      fromStoredDraft(draft, () => `draft-chip-${++this.chipSeq}`),
    );
  }

  private onChatState(): void {
    if (this.projectId === undefined) return; // not loaded yet: nothing to compare with
    const state: ChatState = this.controller.getState();
    const projectId = this.projectId;
    if (this.currentProject() !== projectId) return;
    const projectKey = projectKeyOf(projectId);
    const active = state.active[projectKey] ?? null;
    const savedId = this.savedIdOf(active);

    // A reopened saved chat gets its kept draft back (once).
    if (savedId !== null && this.waiting.has(savedId)) {
      const draft = this.waiting.get(savedId) as AiDraft;
      this.waiting.delete(savedId);
      this.restore(active, draft);
      this.onChatState(); // the state the restore made (idempotent if a nested call saw it already)
      return;
    }

    // The conversation whose draft was kept under `new` has been saved: that draft now lives under its own id.
    if (this.newOwner !== null && this.savedIdOf(this.newOwner) !== null) {
      this.newOwner = null;
      this.queue(projectId, NEW_DRAFT_KEY, null);
    }

    const draft = draftOf(state, projectKey);
    const stored = isEmptyDraft(draft) ? null : toStoredDraft(draft);
    if (stored !== null && !keptWhole(draft, stored)) this.failedOnce();
    if (savedId !== null) {
      this.queue(projectId, savedId, stored);
      return;
    }
    // Conversations not saved yet (and every chat without a project) share the `new` slot, which is what the panel
    // shows after a restart. It holds the last one that had unsent text; an empty draft in another conversation
    // forgets it only when its owner's text is gone too (sent, or cleared).
    if (stored !== null) {
      this.newOwner = active;
      this.queue(projectId, NEW_DRAFT_KEY, stored);
      return;
    }
    const owner = state.drafts[draftKeyOf(projectKey, this.newOwner)];
    if (active === this.newOwner || !owner || isEmptyDraft(owner)) {
      this.newOwner = active;
      this.queue(projectId, NEW_DRAFT_KEY, null);
    }
  }

  private queue(projectId: string | null, key: string, draft: AiDraft | null): void {
    const text = serialize(draft);
    const known = this.pending.has(key) ? serialize(this.pending.get(key)?.draft ?? null) : this.persisted.get(key);
    if ((known ?? '') === text) return;
    this.pending.set(key, { projectId, key, draft });
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.write();
    }, DRAFT_DEBOUNCE_MS);
  }

  private bump(key: string): number {
    this.seq += 1;
    this.writeSeq.set(key, this.seq);
    return this.seq;
  }

  /** The store could not take the draft (whole): said once, so typing is not interrupted; the text stays here. */
  private failedOnce(): void {
    if (this.failedNoticeShown) return;
    this.failedNoticeShown = true;
    this.controller.showNotice('ai.draft.saveFailed');
  }

  private write(now = false): void {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()].map((item) => ({ item, seq: this.bump(item.key) }));
    this.pending.clear();
    for (const { item } of batch) this.persisted.set(item.key, serialize(item.draft));
    if (now) {
      // A queued older value of the same key is superseded by these (its turn in the chain is skipped).
      for (const { item } of batch) void this.api.saveDraft(item).catch(() => undefined);
      return;
    }
    this.writing = this.writing.then(async () => {
      for (const { item, seq } of batch) {
        if (this.writeSeq.get(item.key) !== seq) continue; // a newer value of this key was sent meanwhile
        let ok: boolean;
        try {
          ok = (await this.api.saveDraft({ projectId: item.projectId, key: item.key, draft: item.draft })).ok;
        } catch {
          ok = false;
        }
        if (!ok) {
          // The text stays in the panel; the store did not take it. Said once, so typing is not interrupted.
          if (item.projectId === this.projectId) this.persisted.delete(item.key);
          this.failedOnce();
        }
      }
    });
  }
}
