/**
 * Multi-file JavaScript awareness (S18.4). The JavaScript language service only knows the files it is given. Open
 * files are editor models; this keeps the project's other .js / .mjs files in the service as read-only "extra libs",
 * so that names from another script and relative ES module imports (`import { greet } from './util.mjs'`) are known
 * for completion and hover, and an import of a closed file is not reported as an undefined name.
 *
 * A file that is open in a tab is never also an extra lib (its live model wins); when the tab closes the file is read
 * again from disk. Bounded: at most MAX_SCRIPTS files of at most MAX_SCRIPT_CHARS characters each. The texts stay in memory and
 * in the language worker only (never logged).
 *
 * S57: the set is "indexing" from `open()` until every script has been read. Navigation (F12 / Shift+F12 / F2)
 * waits for `whenIndexed()` instead of answering "not found" from a half-read project.
 *
 * Monaco-free: the host is injected, so the bookkeeping is unit-tested.
 */
import type { FileEntry, WatchEvent } from '../../shared/ipc/contract';

export const MAX_SCRIPTS = 60;
export const MAX_SCRIPT_CHARS = 256 * 1024;

const SCRIPT = /\.(?:js|mjs)$/i;
export const isProjectScript = (relPath: string): boolean => SCRIPT.test(relPath);

export interface ScriptHost {
  /** Reads a project file; null when it cannot be read (gone, too large, another encoding). */
  read(relPath: string): Promise<{ readonly text: string; readonly uri: string } | null>;
  /** True while an editor model exists for this file URI (the file is open). */
  hasModel(uri: string): boolean;
  /** The language service's file name for a file URI (Monaco's normalised URI string). */
  libName(uri: string): string;
  /**
   * Gives the language service the extra libs. May return a promise that resolves once the service has taken them
   * (Monaco tells its worker on a timer): the index counts as ready only then, so a waiting F12 never queries a
   * worker that still holds the previous set.
   */
  setLibs(libs: readonly { readonly filePath: string; readonly content: string }[]): void | Promise<void>;
}

export class ProjectScripts {
  /** relPath → last text read from disk. */
  private readonly texts = new Map<string, { uri: string; text: string }>();
  private generation = 0;
  private published = '';
  /** S57: a project script was left out (over MAX_SCRIPTS, too large or unreadable): the service sees a part. */
  private partial = false;
  /** S57: the `open()` still reading scripts, and who waits for it; null once every script is known. */
  private pending: { readonly done: Promise<void>; resolve(): void } | null = null;

  constructor(private readonly host: ScriptHost) {}

  /** S57: true while `open()` is still reading the project's scripts (an answer now could miss a file). */
  indexing(): boolean {
    return this.pending !== null;
  }

  /**
   * S57: resolves `true` once the project's scripts are all read (or no project is open), `false` when they still are
   * not after `timeoutMs`. A project opened in the meantime is waited for as well, within the same bound.
   */
  async whenIndexed(timeoutMs: number, now: () => number = Date.now): Promise<boolean> {
    const deadline = now() + timeoutMs;
    while (this.pending) {
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      if (await timedOut(this.pending.done, remaining)) return false;
    }
    return true;
  }

  private beginIndexing(): void {
    if (this.pending) return;
    let resolve = () => undefined as void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.pending = { done, resolve };
  }

  private endIndexing(generation: number): void {
    if (generation !== this.generation || !this.pending) return;
    this.pending.resolve();
    this.pending = null;
  }

  /** A project was opened: loads its scripts (replacing any previous project's). */
  async open(files: readonly FileEntry[]): Promise<void> {
    const generation = ++this.generation;
    this.beginIndexing();
    this.texts.clear();
    void this.publish();
    const all = files.filter((f) => isProjectScript(f.relPath));
    this.partial = all.length > MAX_SCRIPTS;
    const scripts = all.slice(0, MAX_SCRIPTS);
    for (const file of scripts) {
      if (generation !== this.generation) return; // a newer open() or close() owns the index now
      await this.load(file.relPath, generation);
    }
    await this.publish(); // the service has the libs: only now is an answer complete
    this.endIndexing(generation);
  }

  /** The project closed. */
  close(): void {
    this.generation += 1;
    this.texts.clear();
    void this.publish();
    this.endIndexing(this.generation); // nothing left to index: waiters may answer (nothing is a project script)
  }

  /** Files changed on disk (watcher events). */
  async changed(events: readonly WatchEvent[]): Promise<void> {
    const generation = this.generation;
    for (const event of events) {
      if (event.type === 'rescan') continue;
      if (event.type === 'renamed') {
        this.texts.delete(event.from);
        if (isProjectScript(event.to)) await this.load(event.to, generation);
      } else if (event.type === 'deleted') {
        this.texts.delete(event.relPath);
      } else if (isProjectScript(event.relPath)) {
        await this.load(event.relPath, generation);
      }
    }
    await this.publish();
  }

  /** A file was saved or its tab closed: its disk text may be newer than what we hold. */
  async refresh(relPath: string): Promise<void> {
    if (!isProjectScript(relPath)) return;
    await this.load(relPath, this.generation);
    await this.publish();
  }

  /** The editor model of `uri` was disposed (tab closed): read the file again, since its last edits are on disk. */
  async modelClosed(uri: string): Promise<void> {
    for (const [relPath, entry] of this.texts) {
      if (entry.uri === uri || this.host.libName(entry.uri) === uri) return this.refresh(relPath);
    }
    await this.publish();
  }

  /** Editor models came or went: re-decide which files are extra libs. */
  modelsChanged(): void {
    void this.publish();
  }

  /**
   * S57: the project file a language-service file name (an open model's URI or an extra lib's name) belongs to, or
   * null when it is not one of the project's scripts.
   */
  relPathOf(fileName: string): string | null {
    for (const [relPath, entry] of this.texts) {
      if (entry.uri === fileName || this.host.libName(entry.uri) === fileName) return relPath;
    }
    return null;
  }

  /** S57: whether every script of the project is known to the language service (none left out by the limits). */
  complete(): boolean {
    return !this.partial;
  }

  /** The extra libs currently given to the language service (tests). */
  libs(): { filePath: string; content: string }[] {
    const libs: { filePath: string; content: string }[] = [];
    for (const { uri, text } of this.texts.values()) {
      if (!this.host.hasModel(uri)) libs.push({ filePath: this.host.libName(uri), content: text });
    }
    return libs.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
  }

  private async load(relPath: string, generation: number): Promise<void> {
    if (!this.texts.has(relPath) && this.texts.size >= MAX_SCRIPTS) {
      this.partial = true;
      return;
    }
    const file = await this.host.read(relPath);
    if (generation !== this.generation) return;
    if (!file || file.text.length > MAX_SCRIPT_CHARS) {
      this.texts.delete(relPath);
      if (file) this.partial = true; // too large to give to the service
    } else this.texts.set(relPath, { uri: file.uri, text: file.text });
  }

  /** Resolves once the service has the current libs (at once when nothing changed). */
  private async publish(): Promise<void> {
    const libs = this.libs();
    // setExtraLibs makes the worker rebuild its program; skip when nothing changed.
    const key = JSON.stringify(libs.map((l) => [l.filePath, l.content.length, hash(l.content)]));
    if (key === this.published) return;
    this.published = key;
    await this.host.setLibs(libs);
  }
}

/** `true` when `ms` pass before `done` settles; the timer is cleared either way. */
export async function timedOut(done: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap content fingerprint (FNV-1a) so an unchanged set of libs is not re-sent. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
