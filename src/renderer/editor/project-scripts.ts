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
  setLibs(libs: readonly { readonly filePath: string; readonly content: string }[]): void;
}

export class ProjectScripts {
  /** relPath → last text read from disk. */
  private readonly texts = new Map<string, { uri: string; text: string }>();
  private generation = 0;
  private published = '';
  /** S57: a project script was left out (over MAX_SCRIPTS, too large or unreadable): the service sees a part. */
  private partial = false;

  constructor(private readonly host: ScriptHost) {}

  /** A project was opened: loads its scripts (replacing any previous project's). */
  async open(files: readonly FileEntry[]): Promise<void> {
    const generation = ++this.generation;
    this.texts.clear();
    this.publish();
    const all = files.filter((f) => isProjectScript(f.relPath));
    this.partial = all.length > MAX_SCRIPTS;
    const scripts = all.slice(0, MAX_SCRIPTS);
    for (const file of scripts) {
      if (generation !== this.generation) return;
      await this.load(file.relPath, generation);
    }
    this.publish();
  }

  /** The project closed. */
  close(): void {
    this.generation += 1;
    this.texts.clear();
    this.publish();
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
    this.publish();
  }

  /** A file was saved or its tab closed: its disk text may be newer than what we hold. */
  async refresh(relPath: string): Promise<void> {
    if (!isProjectScript(relPath)) return;
    await this.load(relPath, this.generation);
    this.publish();
  }

  /** The editor model of `uri` was disposed (tab closed): read the file again, since its last edits are on disk. */
  async modelClosed(uri: string): Promise<void> {
    for (const [relPath, entry] of this.texts) {
      if (entry.uri === uri || this.host.libName(entry.uri) === uri) return this.refresh(relPath);
    }
    this.publish();
  }

  /** Editor models came or went: re-decide which files are extra libs. */
  modelsChanged(): void {
    this.publish();
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

  private publish(): void {
    const libs = this.libs();
    // setExtraLibs makes the worker rebuild its program; skip when nothing changed.
    const key = JSON.stringify(libs.map((l) => [l.filePath, l.content.length, hash(l.content)]));
    if (key === this.published) return;
    this.published = key;
    this.host.setLibs(libs);
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
