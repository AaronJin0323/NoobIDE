import { createHash } from 'node:crypto';
import { SerialQueue, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { backupFile, readJsonFile, schemaVersionOf } from './json-file';

/**
 * Preview decisions kept in app data (`<userData>/preview.json`, never inside a project — AGENTS.md):
 *
 * - S14.4 trust: PLAN §8 — built-in templates preview at once; a folder opened from disk runs its scripts only after
 *   the user pressed "Start preview" once. Folders are remembered by a SHA-256 of their real path, so the file holds
 *   no path text. Capped at MAX_TRUSTED (oldest forgotten first: that folder simply asks again).
 * - S14.2 one-time notes: "refreshing reloads the page and clears what it was doing" is shown once, then never again.
 *
 * Same robustness as the other app-data stores: a corrupt file is backed up and reset, an unreadable one or one
 * written by a newer NoobIDE (S28.4) makes the store work in memory only, writes are serialized and atomic.
 */
export const PREVIEW_STORE_VERSION = 1;
export const MAX_TRUSTED = 500;

export type PreviewNote = 'reload-clears-state';
const NOTES: readonly PreviewNote[] = ['reload-clears-state'];

interface PreviewStoreState {
  readonly version: typeof PREVIEW_STORE_VERSION;
  /** Hashes of trusted project roots, oldest first. */
  readonly trusted: readonly string[];
  readonly notesSeen: readonly PreviewNote[];
}

const EMPTY: PreviewStoreState = { version: PREVIEW_STORE_VERSION, trusted: [], notesSeen: [] };
const HASH = /^[0-9a-f]{64}$/;

export function trustKey(realRoot: string): string {
  return createHash('sha256').update(`noobide-trust:${realRoot}`, 'utf8').digest('hex');
}

/** Validates the file field by field; anything unknown or malformed is dropped. */
export function loadPreviewStoreState(raw: unknown): PreviewStoreState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY;
  const value = raw as Record<string, unknown>;
  const trusted = Array.isArray(value.trusted)
    ? value.trusted.filter((h): h is string => typeof h === 'string' && HASH.test(h)).slice(-MAX_TRUSTED)
    : [];
  const notesSeen = Array.isArray(value.notesSeen)
    ? NOTES.filter((note) => (value.notesSeen as unknown[]).includes(note))
    : [];
  return { version: PREVIEW_STORE_VERSION, trusted: [...new Set(trusted)], notesSeen };
}

export interface PreviewStoreOptions {
  readonly file: string;
  readonly log?: RecoveryLogger;
}

export class PreviewStore {
  private state: PreviewStoreState = EMPTY;
  private loaded: Promise<void> | null = null;
  private readonly queue = new SerialQueue();
  private writable = true;

  constructor(private readonly options: PreviewStoreOptions) {}

  async isTrusted(realRoot: string): Promise<boolean> {
    this.load();
    return this.queue.run(async () => this.state.trusted.includes(trustKey(realRoot)));
  }

  /** Remembers that this folder may preview without asking (Start pressed, or created from a built-in template). */
  trust(realRoot: string): Promise<void> {
    const key = trustKey(realRoot);
    return this.change((state) => {
      if (state.trusted.includes(key)) return state;
      return { ...state, trusted: [...state.trusted, key].slice(-MAX_TRUSTED) };
    });
  }

  async noteSeen(note: PreviewNote): Promise<boolean> {
    this.load();
    return this.queue.run(async () => this.state.notesSeen.includes(note));
  }

  markNoteSeen(note: PreviewNote): Promise<void> {
    return this.change((state) =>
      state.notesSeen.includes(note) ? state : { ...state, notesSeen: [...state.notesSeen, note] },
    );
  }

  private change(update: (state: PreviewStoreState) => PreviewStoreState): Promise<void> {
    this.load();
    return this.queue.run(async () => {
      const next = update(this.state);
      if (next === this.state) return;
      this.state = next;
      if (!this.writable) return;
      try {
        await writeFileAtomic(this.options.file, `${JSON.stringify(next, null, 2)}\n`);
      } catch (e) {
        this.options.log?.('preview-store-write-failed', { code: (e as { code?: string }).code ?? 'unknown' });
      }
    });
  }

  private load(): void {
    this.loaded ??= this.queue.run(async () => {
      const read = await readJsonFile(this.options.file);
      if (read.kind === 'parsed') {
        this.state = loadPreviewStoreState(read.value);
        if (schemaVersionOf(read.value, PREVIEW_STORE_VERSION).kind === 'newer') {
          // S28.4 downgrade: written by a newer NoobIDE — use it, never write it (decisions last until quit).
          this.writable = false;
          this.options.log?.('preview-store-newer-version', { readOnly: true });
        }
      } else if (read.kind === 'unreadable') {
        this.writable = false;
        this.options.log?.('preview-store-unreadable', { code: read.code });
      } else if (read.kind === 'corrupt') {
        const backup = await backupFile(this.options.file, 'corrupt');
        if (backup === null) this.writable = false;
        this.options.log?.('preview-store-reset', { backedUp: backup !== null });
      }
    });
  }
}
