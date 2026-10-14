import { stat } from 'node:fs/promises';
import path from 'node:path';
import { SerialQueue, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { projectKey } from '../recovery/keys';
import { parseProjectTabs, parseSessionLayout, type ProjectTabs, type SessionLayout } from '../shared/session';
import { backupFile, readJsonFile } from './json-file';

/**
 * Session state in app data (S13.4, `session.json`): the project that was open when the app last closed normally,
 * its open tabs and the visible one per project (keyed by the real root path), and the layout sizes. Never stored in
 * a project folder; tab paths are relative. A corrupt file is backed up and the session starts empty.
 */
export const SESSION_VERSION = 1;
const MAX_PROJECTS = 30;

interface ProjectSession extends ProjectTabs {
  readonly rootPath: string;
  readonly savedAt: number;
}

interface SessionData {
  lastProject: string | null;
  layout: SessionLayout | null;
  projects: Record<string, ProjectSession>;
}

export interface SessionStoreOptions {
  readonly file: string;
  readonly log?: RecoveryLogger;
  readonly now?: () => number;
}

function parseData(value: unknown): SessionData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== SESSION_VERSION) return null;
  const data: SessionData = { lastProject: null, layout: null, projects: {} };
  if (typeof raw.lastProject === 'string' && path.isAbsolute(raw.lastProject)) data.lastProject = raw.lastProject;
  data.layout = parseSessionLayout(raw.layout);
  if (typeof raw.projects === 'object' && raw.projects !== null) {
    for (const [key, entry] of Object.entries(raw.projects as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { rootPath, savedAt, tabs, active } = entry as Record<string, unknown>;
      const parsed = parseProjectTabs({ tabs, active });
      if (!parsed || typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || typeof savedAt !== 'number')
        continue;
      if (key !== projectKey(rootPath)) continue;
      data.projects[key] = { rootPath, savedAt, ...parsed };
    }
  }
  return data;
}

export class SessionStore {
  private data: SessionData = { lastProject: null, layout: null, projects: {} };
  private loaded: Promise<void> | null = null;
  private writable = true;
  private readonly queue = new SerialQueue();

  constructor(private readonly options: SessionStoreOptions) {}

  private load(): Promise<void> {
    this.loaded ??= this.queue.run(async () => {
      const read = await readJsonFile(this.options.file);
      if (read.kind === 'missing') return;
      if (read.kind === 'unreadable') {
        this.writable = false;
        return;
      }
      const parsed = read.kind === 'parsed' ? parseData(read.value) : null;
      if (parsed) this.data = parsed;
      else {
        const backup = await backupFile(this.options.file, 'corrupt');
        this.options.log?.('session-reset', { backedUp: backup !== null });
        if (backup === null) this.writable = false;
      }
    });
    return this.loaded;
  }

  private read<T>(get: (data: SessionData) => T): Promise<T> {
    void this.load();
    return this.queue.run(async () => get(this.data));
  }

  private change(apply: (data: SessionData) => void): Promise<void> {
    void this.load();
    return this.queue.run(async () => {
      apply(this.data);
      await this.persist();
    });
  }

  lastProject(): Promise<string | null> {
    return this.read((d) => d.lastProject);
  }

  layout(): Promise<SessionLayout | null> {
    return this.read((d) => d.layout);
  }

  tabsOf(rootPath: string): Promise<ProjectTabs | null> {
    return this.read((d) => {
      const entry = d.projects[projectKey(rootPath)];
      return entry ? { tabs: entry.tabs, active: entry.active } : null;
    });
  }

  /** A project is open (it becomes the one reopened on the next normal start). */
  projectOpened(rootPath: string): Promise<void> {
    return this.change((d) => {
      d.lastProject = rootPath;
    });
  }

  /** The user closed the project: the next start shows the welcome screen. Its tabs are kept for next time. */
  projectClosed(rootPath: string): Promise<void> {
    return this.change((d) => {
      if (d.lastProject === rootPath) d.lastProject = null;
    });
  }

  saveTabs(rootPath: string, tabs: ProjectTabs): Promise<void> {
    return this.change((d) => {
      d.projects[projectKey(rootPath)] = { rootPath, savedAt: this.options.now?.() ?? Date.now(), ...tabs };
      const keys = Object.keys(d.projects);
      if (keys.length > MAX_PROJECTS) {
        const oldest = keys.sort((a, b) => (d.projects[a]?.savedAt ?? 0) - (d.projects[b]?.savedAt ?? 0));
        for (const key of oldest.slice(0, keys.length - MAX_PROJECTS)) delete d.projects[key];
      }
    });
  }

  saveLayout(layout: SessionLayout): Promise<void> {
    return this.change((d) => {
      d.layout = layout;
    });
  }

  private async persist(): Promise<void> {
    if (!this.writable) return;
    try {
      const body = { version: SESSION_VERSION, ...this.data };
      await writeFileAtomic(this.options.file, `${JSON.stringify(body, null, 2)}\n`);
    } catch (e) {
      this.options.log?.('session-write-failed', { code: (e as { code?: string }).code ?? 'unknown' });
    }
  }
}

export type RestoreDecision =
  | { readonly kind: 'open'; readonly rootPath: string }
  | { readonly kind: 'skip'; readonly reason: 'disabled' | 'recovery-pending' | 'none' | 'missing' };

/**
 * Whether to reopen the last project on start. Crash recovery takes precedence: when the journal holds unsaved
 * buffers from an abnormal end, nothing is reopened automatically and the recovery dialog offers them instead.
 */
export async function decideRestore(input: {
  readonly enabled: boolean;
  readonly pendingRecovery: number;
  readonly lastProject: string | null;
  readonly isDirectory?: (p: string) => Promise<boolean>;
}): Promise<RestoreDecision> {
  if (!input.enabled) return { kind: 'skip', reason: 'disabled' };
  if (input.pendingRecovery > 0) return { kind: 'skip', reason: 'recovery-pending' };
  if (input.lastProject === null) return { kind: 'skip', reason: 'none' };
  const exists = await (input.isDirectory ?? isDirectory)(input.lastProject);
  return exists ? { kind: 'open', rootPath: input.lastProject } : { kind: 'skip', reason: 'missing' };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
