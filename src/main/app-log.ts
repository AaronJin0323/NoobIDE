import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Local log in the app-data directory (S13.6, PLAN §6: "Logs should not record complete source code").
 *
 * - One JSON object per line: time, level, event name and a few fields. The first line of every run records the
 *   app, Electron, Chromium and Node versions and the OS, so a log sent with a bug report says what it came from.
 * - Content-free by construction: field values are numbers, booleans or short single-line tokens (error codes,
 *   hashed keys, state names). Any other string — a line of code, a file's text, a message from a webpage — is
 *   replaced by `[redacted N chars]`, so a careless call can never write source code into the log.
 * - Rotating: when the current file would grow past `maxBytes` it becomes `noobide.1.log` (older ones shift up) and
 *   at most `maxFiles` files are kept. Logging never throws and never blocks a save.
 */
export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface AppLogOptions {
  /** `<userData>/logs`. */
  readonly dir: string;
  readonly maxBytes?: number;
  /** Files kept, including the current one. */
  readonly maxFiles?: number;
  readonly now?: () => Date;
}

export interface VersionInfo {
  readonly app: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
}

export const LOG_FILE = 'noobide.log';
const SAFE_TOKEN = /^[\w.:@/+=-]{0,64}$/;
const MAX_KEYS = 16;

/** A field value as it may appear in the log; anything that could carry content is redacted. */
export function safeValue(value: unknown): string | number | boolean {
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return SAFE_TOKEN.test(value) ? value : `[redacted ${value.length} chars]`;
  return '[redacted]';
}

export class AppLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private size = -1;
  private failed = false;

  constructor(private readonly options: AppLogOptions) {
    this.file = path.join(options.dir, LOG_FILE);
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.maxFiles = Math.max(1, options.maxFiles ?? 5);
  }

  get dir(): string {
    return this.options.dir;
  }

  /** First line of a run: what produced this log. */
  started(versions: VersionInfo): void {
    this.write('info', 'app-start', { ...versions });
  }

  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields).slice(0, MAX_KEYS)) {
      if (SAFE_TOKEN.test(key)) safe[key] = safeValue(value);
    }
    const now = this.options.now?.() ?? new Date();
    const line = `${JSON.stringify({ t: now.toISOString(), level, event: String(safeValue(event)), ...safe })}\n`;
    this.append(line);
  }

  private append(line: string): void {
    try {
      mkdirSync(this.options.dir, { recursive: true });
      if (this.size < 0) this.size = currentSize(this.file);
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.file, line, { encoding: 'utf8' });
      this.size += bytes;
      this.failed = false;
    } catch {
      // A full disk or a locked file must never break the app; try again on the next line.
      this.size = -1;
      this.failed = true;
    }
  }

  /** noobide.log → noobide.1.log → … → noobide.{maxFiles-1}.log; the oldest is dropped. */
  private rotate(): void {
    const numbered = (n: number) => path.join(this.options.dir, `noobide.${n}.log`);
    rmSync(numbered(this.maxFiles - 1), { force: true });
    for (let n = this.maxFiles - 2; n >= 1; n -= 1) {
      try {
        renameSync(numbered(n), numbered(n + 1));
      } catch {
        // that generation does not exist yet
      }
    }
    if (this.maxFiles > 1) renameSync(this.file, numbered(1));
    else rmSync(this.file, { force: true });
    this.size = 0;
  }

  /** For tests and diagnostics: whether the last write failed. */
  get lastWriteFailed(): boolean {
    return this.failed;
  }
}

function currentSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
