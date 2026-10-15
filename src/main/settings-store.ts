import { SerialQueue, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import {
  DEFAULT_SETTINGS,
  readNewerSettings,
  SETTINGS_MIGRATIONS,
  SETTINGS_VERSION,
  upgradeSettings,
  type AppSettings,
  type SettingsMigration,
  type SettingsNotice,
  type SettingsPatch,
} from '../shared/settings';
import { backupFile, readJsonFile } from './json-file';

export interface SettingsStoreOptions {
  /** `<userData>/settings.json` (app.getPath('userData'), never a hard-coded user path). */
  readonly file: string;
  readonly log?: RecoveryLogger;
  /** Injected for tests of the migration chain. */
  readonly migrations?: readonly SettingsMigration[];
  readonly version?: number;
  readonly now?: () => Date;
}

export interface SettingsState {
  readonly settings: AppSettings;
  /** Set once when the file was unusable and was backed up (shown to the user). */
  readonly notice: SettingsNotice;
  /** Where the unusable file was moved to, for the notice. */
  readonly backupPath: string | null;
}

/**
 * Versioned app settings in app data (S13.1). `load` reads, migrates and validates the file; a corrupt file (not JSON,
 * not an object, a broken version) is moved aside to a timestamped backup and the defaults are written in its place.
 * A file written by a newer NoobIDE (S28.4 downgrade) is read as far as this version understands it and is never
 * written: the store then works in memory only. Updates are serialized and written atomically. Settings never hold secrets or
 * file contents; the log gets event names and codes only.
 */
export class SettingsStore {
  private state: SettingsState = { settings: DEFAULT_SETTINGS, notice: null, backupPath: null };
  private loaded: Promise<SettingsState> | null = null;
  private readonly queue = new SerialQueue();
  /** False when the file could not be backed up or read: we keep working in memory and never overwrite it. */
  private writable = true;

  constructor(private readonly options: SettingsStoreOptions) {}

  /** Loads once; later calls return the same state. */
  load(): Promise<SettingsState> {
    this.loaded ??= this.queue.run(() => this.loadNow());
    return this.loaded;
  }

  get current(): SettingsState {
    return this.state;
  }

  /** The state after every earlier load and update (calls are served in arrival order). */
  snapshot(): Promise<SettingsState> {
    void this.load();
    return this.queue.run(async () => this.state);
  }

  update(patch: SettingsPatch): Promise<AppSettings> {
    void this.load(); // queued first (once), so the update applies to the loaded settings
    return this.queue.run(async () => {
      const next: AppSettings = { ...this.state.settings, ...patch, version: SETTINGS_VERSION };
      this.state = { ...this.state, settings: next };
      await this.persist(next);
      return next;
    });
  }

  private async loadNow(): Promise<SettingsState> {
    const { file } = this.options;
    const read = await readJsonFile(file);
    if (read.kind === 'missing') {
      this.state = { settings: DEFAULT_SETTINGS, notice: null, backupPath: null };
      return this.state;
    }
    if (read.kind === 'unreadable') {
      this.writable = false;
      this.log('settings-unreadable', { code: read.code });
      return this.state;
    }
    const upgraded =
      read.kind === 'parsed'
        ? upgradeSettings(
            read.value,
            this.options.migrations ?? SETTINGS_MIGRATIONS,
            this.options.version ?? SETTINGS_VERSION,
          )
        : ({ ok: false, reason: 'not-json' } as const);
    if (upgraded.ok) {
      this.state = { settings: upgraded.settings, notice: null, backupPath: null };
      if (upgraded.migratedFrom !== null || upgraded.resetFields.length > 0) {
        this.log('settings-upgraded', { from: upgraded.migratedFrom ?? -1, resetFields: upgraded.resetFields.length });
        await this.persist(upgraded.settings);
      }
      return this.state;
    }
    if (upgraded.reason === 'newer-version' && read.kind === 'parsed') {
      // S28.4 downgrade: use what this version understands, but never write, move or delete the newer file — the
      // newer NoobIDE must find it intact after the next upgrade. Changes made now last until the app quits.
      this.writable = false;
      this.log('settings-newer-version', { readOnly: true });
      this.state = { settings: readNewerSettings(read.value), notice: 'newer-version', backupPath: null };
      return this.state;
    }
    // Unusable: keep the user's file as a backup, never overwrite it, then start from the defaults.
    const notice: SettingsNotice = 'corrupt';
    const backupPath = await backupFile(file, 'corrupt', this.now());
    this.log('settings-reset', { reason: upgraded.reason, backedUp: backupPath !== null });
    this.state = { settings: DEFAULT_SETTINGS, notice, backupPath };
    if (backupPath === null) this.writable = false;
    else await this.persist(DEFAULT_SETTINGS);
    return this.state;
  }

  private async persist(settings: AppSettings): Promise<void> {
    if (!this.writable) return;
    try {
      await writeFileAtomic(this.options.file, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (e) {
      // The app keeps the setting for this run; the next change tries again.
      this.log('settings-write-failed', { code: (e as { code?: string }).code ?? 'unknown' });
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private log(event: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    this.options.log?.(event, fields);
  }
}
