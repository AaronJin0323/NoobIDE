import path from 'node:path';
import { errorCode, SerialQueue, silentLogger, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { projectKey } from '../recovery/keys';
import { backupFile, readJsonFile, schemaVersionOf } from './json-file';
import { ANNOTATION_LIMITS, type AnnotationTarget } from '../shared/ipc/annotations-contract';
import { isAnnotationId, parseAnnotationTarget } from '../shared/ipc/annotations-parse';
import { err, ok, type Result } from '../shared/result';

/**
 * Preview annotations per project (S41.4, decision 0030), in app data: `<dir>/<projectKey(realRoot)>.json` (the same
 * hash chats, history and the session store use; no file name contains a user path). Never inside the project.
 *
 * - Writes are atomic (writeFileAtomic) and serialized; at most {@link ANNOTATION_LIMITS.perProject} per project.
 * - A file that cannot be parsed is moved aside (`.corrupt-<time>`) and the project starts empty; single entries that
 *   do not match the format are dropped. A file written by a newer NoobIDE is read as far as possible and never
 *   written (S28.4): changes are refused with `write-failed`.
 * - The source location is not stored: it is computed again from the files whenever annotations are listed.
 * - Logs carry event names, counts and error codes only — never notes, page text or paths.
 */
export const ANNOTATIONS_VERSION = 1;

export interface StoredAnnotation {
  readonly id: string;
  readonly note: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly target: AnnotationTarget;
}

type Loaded = { readonly items: StoredAnnotation[]; readonly writable: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseEntry(v: unknown): StoredAnnotation | null {
  if (!isRecord(v) || !isAnnotationId(v.id) || typeof v.note !== 'string') return null;
  if (v.note.length > ANNOTATION_LIMITS.noteChars) return null;
  if (typeof v.createdAt !== 'number' || typeof v.updatedAt !== 'number') return null;
  const target = parseAnnotationTarget(v.target);
  return target ? { id: v.id, note: v.note, createdAt: v.createdAt, updatedAt: v.updatedAt, target } : null;
}

export class AnnotationStore {
  private readonly queue = new SerialQueue();
  private readonly log: RecoveryLogger;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly options: {
      readonly dir: string;
      readonly newId: () => string;
      readonly log?: RecoveryLogger;
      readonly now?: () => number;
      readonly maxPerProject?: number;
    },
  ) {
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.newId = options.newId;
  }

  file(realRoot: string): string {
    return path.join(this.options.dir, `${projectKey(realRoot)}.json`);
  }

  list(realRoot: string): Promise<readonly StoredAnnotation[]> {
    return this.queue.run(async () => (await this.load(realRoot)).items);
  }

  get(realRoot: string, id: string): Promise<StoredAnnotation | null> {
    return this.queue.run(async () => (await this.load(realRoot)).items.find((a) => a.id === id) ?? null);
  }

  add(
    realRoot: string,
    note: string,
    target: AnnotationTarget,
  ): Promise<Result<StoredAnnotation, 'too-many' | 'write-failed'>> {
    return this.queue.run(async () => {
      const loaded = await this.load(realRoot);
      if (loaded.items.length >= (this.options.maxPerProject ?? ANNOTATION_LIMITS.perProject)) {
        return err('too-many', 'too many annotations in this project');
      }
      const now = this.now();
      const entry: StoredAnnotation = {
        id: this.newId(),
        note: note.slice(0, ANNOTATION_LIMITS.noteChars),
        createdAt: now,
        updatedAt: now,
        target,
      };
      const written = await this.write(realRoot, loaded, [...loaded.items, entry]);
      return written.ok ? ok(entry) : written;
    });
  }

  update(realRoot: string, id: string, note: string): Promise<Result<StoredAnnotation, 'not-found' | 'write-failed'>> {
    return this.queue.run(async () => {
      const loaded = await this.load(realRoot);
      const current = loaded.items.find((a) => a.id === id);
      if (!current) return err('not-found', 'no such annotation');
      const entry = { ...current, note: note.slice(0, ANNOTATION_LIMITS.noteChars), updatedAt: this.now() };
      const written = await this.write(
        realRoot,
        loaded,
        loaded.items.map((a) => (a.id === id ? entry : a)),
      );
      return written.ok ? ok(entry) : written;
    });
  }

  remove(realRoot: string, id: string): Promise<Result<null, 'not-found' | 'write-failed'>> {
    return this.queue.run(async () => {
      const loaded = await this.load(realRoot);
      if (!loaded.items.some((a) => a.id === id)) return err('not-found', 'no such annotation');
      return this.write(
        realRoot,
        loaded,
        loaded.items.filter((a) => a.id !== id),
      );
    });
  }

  // ── internals (inside the queue) ──

  private async write(
    realRoot: string,
    loaded: Loaded,
    items: readonly StoredAnnotation[],
  ): Promise<Result<null, 'write-failed'>> {
    if (!loaded.writable) return err('write-failed', 'saved by a newer NoobIDE');
    try {
      await writeFileAtomic(
        this.file(realRoot),
        `${JSON.stringify({ version: ANNOTATIONS_VERSION, annotations: items }, null, 2)}\n`,
      );
      return ok(null);
    } catch (e) {
      this.log('annotations-write-failed', { code: errorCode(e) });
      return err('write-failed', errorCode(e));
    }
  }

  private async load(realRoot: string): Promise<Loaded> {
    const file = this.file(realRoot);
    const read = await readJsonFile(file);
    if (read.kind === 'missing') return { items: [], writable: true };
    if (read.kind === 'unreadable') {
      this.log('annotations-unreadable', { code: read.code });
      return { items: [], writable: false };
    }
    const version = read.kind === 'parsed' ? schemaVersionOf(read.value, ANNOTATIONS_VERSION) : null;
    const value = read.kind === 'parsed' ? read.value : null;
    // A newer NoobIDE's file is never moved or written, whatever its shape.
    if (version?.kind === 'newer' && !(isRecord(value) && Array.isArray(value.annotations))) {
      return { items: [], writable: false };
    }
    if (!version || version.kind === 'invalid' || !isRecord(value) || !Array.isArray(value.annotations)) {
      const moved = await backupFile(file, 'corrupt', new Date(this.now()));
      this.log('annotations-corrupt', { movedAside: moved !== null });
      return { items: [], writable: moved !== null };
    }
    const items: StoredAnnotation[] = [];
    let dropped = 0;
    for (const raw of value.annotations) {
      const entry = parseEntry(raw);
      if (entry && !items.some((a) => a.id === entry.id)) items.push(entry);
      else dropped += 1;
    }
    if (dropped > 0) this.log('annotations-entries-dropped', { count: dropped });
    return { items, writable: version.kind !== 'newer' };
  }
}
