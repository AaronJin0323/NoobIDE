import { SerialQueue, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { DEFAULT_WALKTHROUGH, loadWalkthroughState, type WalkthroughState } from '../shared/walkthrough';
import { backupFile, readJsonFile } from './json-file';

export interface WalkthroughStoreOptions {
  /** `<userData>/walkthrough.json` (app data, never inside a project). */
  readonly file: string;
  readonly log?: RecoveryLogger;
}

/**
 * Onboarding walkthrough progress in app data (S23.1). Loaded once and validated field by field (an invalid field
 * takes its default). A file that is not JSON is moved aside to a timestamped backup, never silently overwritten; an
 * unreadable one makes the store work in memory only. Saves are serialized and atomic (temp file + rename).
 */
export class WalkthroughStore {
  private state: WalkthroughState = DEFAULT_WALKTHROUGH;
  private loaded: Promise<WalkthroughState> | null = null;
  private readonly queue = new SerialQueue();
  private writable = true;

  constructor(private readonly options: WalkthroughStoreOptions) {}

  get(): Promise<WalkthroughState> {
    this.load();
    return this.queue.run(async () => this.state);
  }

  save(state: WalkthroughState): Promise<void> {
    this.load(); // queued first (once), so a save is never overwritten by a later load
    return this.queue.run(async () => {
      this.state = state;
      if (!this.writable) return;
      try {
        await writeFileAtomic(this.options.file, `${JSON.stringify(state, null, 2)}\n`);
      } catch (e) {
        this.options.log?.('walkthrough-write-failed', { code: (e as { code?: string }).code ?? 'unknown' });
      }
    });
  }

  private load(): void {
    this.loaded ??= this.queue.run(() => this.loadNow());
  }

  private async loadNow(): Promise<WalkthroughState> {
    const read = await readJsonFile(this.options.file);
    if (read.kind === 'parsed') this.state = loadWalkthroughState(read.value);
    else if (read.kind === 'unreadable') {
      this.writable = false;
      this.options.log?.('walkthrough-unreadable', { code: read.code });
    } else if (read.kind === 'corrupt') {
      const backup = await backupFile(this.options.file, 'corrupt');
      if (backup === null) this.writable = false;
      this.options.log?.('walkthrough-reset', { backedUp: backup !== null });
    }
    return this.state;
  }
}
