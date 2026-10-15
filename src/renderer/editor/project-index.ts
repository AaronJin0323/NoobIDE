/**
 * Project index for context-aware suggestions and indentation (S43.3, S43.4, decision 0032). Knows the project's
 * files (for path suggestions), the ids and classes its HTML and CSS define (for selector suggestions), and the
 * indentation of its HTML / CSS / JavaScript files (for the project convention new files follow).
 *
 * Bounded like ProjectScripts (S18.4): at most MAX_INDEXED_FILES files of at most MAX_INDEXED_CHARS characters are
 * read. Only what was extracted is kept (names and an indentation guess), never the text, and nothing is logged.
 * Files open in the editor are read from their live model by the caller (`symbols(live)`), so the open buffer wins over
 * the disk copy.
 *
 * Monaco-free: the host is injected, so the bookkeeping is unit-tested.
 */
import type { FileEntry, WatchEvent } from '../../shared/ipc/contract';
import { detectIndentation, projectConvention, type IndentGuess, type IndentStyle } from './indent-detect';
import { extractCssSymbols, extractHtmlSymbols, type FileSymbols } from './project-symbols';

export const MAX_INDEXED_FILES = 200;
export const MAX_INDEXED_CHARS = 256 * 1024;
/** Paths offered for completion: the listing can be long, but a suggestion list never needs more. */
export const MAX_LISTED_PATHS = 5_000;

const HTML = /\.html?$/i;
const CSS = /\.css$/i;
const SCRIPT = /\.(?:js|mjs)$/i;

export type IndexedLanguage = 'html' | 'css' | 'javascript';

export function indexedLanguage(relPath: string): IndexedLanguage | null {
  if (HTML.test(relPath)) return 'html';
  if (CSS.test(relPath)) return 'css';
  if (SCRIPT.test(relPath)) return 'javascript';
  return null;
}

/** Hidden files and folders (.noobide, .git, .DS_Store) are never suggested. */
const isHidden = (relPath: string) => relPath.split('/').some((part) => part.startsWith('.'));

export function symbolsOf(language: IndexedLanguage, text: string): FileSymbols {
  if (language === 'html') return extractHtmlSymbols(text);
  if (language === 'css') return extractCssSymbols(text);
  return { ids: [], classes: [] };
}

export interface IndexHost {
  /** Reads a project file; null when it cannot be read (gone, too large, another encoding). */
  read(relPath: string): Promise<{ readonly text: string } | null>;
}

interface Entry {
  readonly language: IndexedLanguage;
  readonly symbols: FileSymbols;
  readonly guess: IndentGuess;
}

/** Where a name is defined: the files (portable relPaths) in index order. */
export interface SymbolTable {
  readonly ids: ReadonlyMap<string, readonly string[]>;
  readonly classes: ReadonlyMap<string, readonly string[]>;
}

/** The symbols of a file's live editor model (unsaved edits included), or null when the file is not open. */
export type LiveSymbols = (relPath: string) => FileSymbols | null;

export class ProjectIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly paths = new Set<string>();
  private generation = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly host: IndexHost) {}

  /** A project was opened: lists its files and reads the indexed ones (replacing any previous project's). */
  async open(files: readonly FileEntry[]): Promise<void> {
    const generation = ++this.generation;
    this.entries.clear();
    this.paths.clear();
    for (const file of files) this.addPath(file.relPath);
    this.emit();
    const indexed = files.filter((f) => indexedLanguage(f.relPath) && !isHidden(f.relPath));
    for (const file of indexed.slice(0, MAX_INDEXED_FILES)) {
      if (generation !== this.generation) return;
      await this.load(file.relPath, generation);
    }
    this.emit();
  }

  close(): void {
    this.generation += 1;
    this.entries.clear();
    this.paths.clear();
    this.emit();
  }

  /** Files changed on disk (watcher events). */
  async changed(events: readonly WatchEvent[]): Promise<void> {
    const generation = this.generation;
    for (const event of events) {
      if (event.type === 'rescan') continue;
      if (event.type === 'renamed') {
        this.paths.delete(event.from);
        this.entries.delete(event.from);
        this.addPath(event.to);
        if (indexedLanguage(event.to)) await this.load(event.to, generation);
      } else if (event.type === 'deleted') {
        this.paths.delete(event.relPath);
        this.entries.delete(event.relPath);
      } else {
        this.addPath(event.relPath);
        if (indexedLanguage(event.relPath)) await this.load(event.relPath, generation);
      }
    }
    this.emit();
  }

  /** A file was saved: its disk text is newer than what we hold. */
  async refresh(relPath: string): Promise<void> {
    if (!indexedLanguage(relPath)) return;
    this.addPath(relPath);
    await this.load(relPath, this.generation);
    this.emit();
  }

  /** Portable relPaths of the project's visible files, for path suggestions. */
  files(): string[] {
    return [...this.paths];
  }

  /**
   * Ids and classes of the project. `live` supplies the symbols of open files (their unsaved edits win); `extra` adds
   * files that are not on disk at all (open untitled or probe models), keyed by a relPath-like name.
   */
  symbols(live?: LiveSymbols, extra?: ReadonlyMap<string, FileSymbols>): SymbolTable {
    const ids = new Map<string, string[]>();
    const classes = new Map<string, string[]>();
    const add = (table: Map<string, string[]>, name: string, relPath: string) => {
      const list = table.get(name);
      if (!list) table.set(name, [relPath]);
      else if (!list.includes(relPath)) list.push(relPath);
    };
    const addAll = (relPath: string, symbols: FileSymbols) => {
      for (const id of symbols.ids) add(ids, id, relPath);
      for (const name of symbols.classes) add(classes, name, relPath);
    };
    for (const [relPath, entry] of this.entries) {
      addAll(relPath, live?.(relPath) ?? entry.symbols);
    }
    for (const [relPath, symbols] of extra ?? []) if (!this.entries.has(relPath)) addAll(relPath, symbols);
    return { ids, classes };
  }

  /** The project's indentation convention (decision 0032), or null without two agreeing confident files. */
  convention(): IndentStyle | null {
    return projectConvention([...this.entries.values()].map((entry) => entry.guess));
  }

  /** Called whenever the index changed (files listed or read). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private addPath(relPath: string): void {
    if (!isHidden(relPath) && this.paths.size < MAX_LISTED_PATHS) this.paths.add(relPath);
  }

  private async load(relPath: string, generation: number): Promise<void> {
    const language = indexedLanguage(relPath);
    if (!language || isHidden(relPath)) return;
    if (!this.entries.has(relPath) && this.entries.size >= MAX_INDEXED_FILES) return;
    const file = await this.host.read(relPath);
    if (generation !== this.generation) return;
    if (!file || file.text.length > MAX_INDEXED_CHARS) {
      this.entries.delete(relPath);
      return;
    }
    this.entries.set(relPath, {
      language,
      symbols: symbolsOf(language, file.text),
      guess: detectIndentation(file.text, language),
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
