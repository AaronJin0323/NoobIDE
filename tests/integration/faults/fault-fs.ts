import path from 'node:path';
import type * as FsPromises from 'node:fs/promises';

/**
 * Fault injection for the S26.1 suite (docs/release/fault-matrix.md). Every product module reaches the disk through
 * `node:fs/promises`; a test file replaces that module with {@link faultyFs} and arms faults on {@link faults}:
 *
 * ```ts
 * vi.mock('node:fs/promises', async (importOriginal) =>
 *   (await import('./fault-fs')).faultyFs(await importOriginal()));
 * ```
 *
 * A fault fails one kind of operation on matching paths with a real errno code (ENOSPC, EACCES, EBUSY, EIO…), so
 * disk-full, permission, lock and I/O failures run on any OS without root, ACL tools or a full disk. A `crash` fault
 * simulates the process dying in the middle of an operation: half of the data reaches the disk, and from then on
 * every file system call fails until {@link FaultPlan.restart} — exactly what a killed process leaves behind, with
 * no cleanup code running.
 */
export type FaultOp =
  | 'open'
  | 'write'
  | 'sync'
  | 'close'
  | 'rename'
  | 'mkdir'
  | 'readFile'
  | 'writeFile'
  | 'readdir'
  | 'stat'
  | 'lstat'
  | 'unlink'
  | 'rm'
  | 'link'
  | 'copyFile'
  | 'access';

export interface Fault {
  readonly op: FaultOp;
  /** errno code of the simulated failure. Ignored for `crash`. */
  readonly code?: string;
  /** Which paths fail; default: every path. */
  readonly where?: (target: string) => boolean;
  /** Only open() with these flags (e.g. `wx` = creating a temp file). */
  readonly flags?: string;
  /** How many times it fails before the operation works again; default: always. */
  readonly times?: number;
  /** The process "dies" at this operation: before it runs, or for `write` after half the bytes landed on disk. */
  readonly crash?: boolean;
}

/** Thrown once the simulated process has died; nothing after it reaches the disk. */
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'SimulatedCrash';
  }
}

export class FaultPlan {
  private faults: { fault: Fault; left: number }[] = [];
  private dead = false;
  /** Every failure that was injected, as `op code basename` (for assertions that a fault really fired). */
  readonly fired: string[] = [];

  add(fault: Fault): this {
    this.faults.push({ fault, left: fault.times ?? Infinity });
    return this;
  }

  /** Clears all faults and brings the "process" back (a restart after a crash). */
  restart(): void {
    this.faults = [];
    this.dead = false;
  }

  get crashed(): boolean {
    return this.dead;
  }

  reset(): void {
    this.restart();
    this.fired.length = 0;
  }

  /** Throws the injected error for this call, if any. Returns the matching crash fault for `write`. */
  check(op: FaultOp, target: unknown, flags?: unknown): Fault | null {
    if (this.dead) throw new SimulatedCrash();
    const p = typeof target === 'string' ? target : target instanceof URL ? target.pathname : String(target);
    for (const entry of this.faults) {
      const { fault } = entry;
      if (fault.op !== op || entry.left <= 0) continue;
      if (fault.flags !== undefined && fault.flags !== flags) continue;
      if (fault.where && !fault.where(p)) continue;
      entry.left -= 1;
      this.fired.push(`${op} ${fault.crash ? 'CRASH' : fault.code} ${path.basename(p)}`);
      if (fault.crash && op === 'write') return fault;
      if (fault.crash) this.die();
      const code = fault.code ?? 'EIO';
      throw Object.assign(new Error(`${code}: simulated failure, ${op} '${p}'`), { code, syscall: op, path: p });
    }
    return null;
  }

  die(): never {
    this.dead = true;
    throw new SimulatedCrash();
  }
}

export const faults = new FaultPlan();

/** Paths below `dir` (or `dir` itself); `dir` may be a getter for a folder created per test. */
export const under =
  (dir: string | (() => string)) =>
  (target: string): boolean => {
    const rel = path.relative(typeof dir === 'string' ? dir : dir(), target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

/** Temp files of the atomic writers (`.<name>.<uuid>.noobide-tmp`). */
export const isTempFile = (target: string): boolean => target.endsWith('.noobide-tmp');

type AnyFn = (...args: never[]) => Promise<unknown>;

export function faultyFs(actual: typeof FsPromises): typeof FsPromises {
  const plain = <K extends keyof typeof FsPromises>(name: K, op: FaultOp) => {
    const fn = actual[name] as unknown as AnyFn;
    return (async (...args: unknown[]) => {
      faults.check(op, args[0]);
      if (op === 'rename' || op === 'link' || op === 'copyFile') faults.check(op, args[1]);
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as (typeof FsPromises)[K];
  };

  const open = (async (target: unknown, flags?: unknown, mode?: unknown) => {
    faults.check('open', target, flags);
    const handle = await (actual.open as (...a: unknown[]) => Promise<FsPromises.FileHandle>)(target, flags, mode);
    return new Proxy(handle, {
      get(real, key) {
        if (key === 'writeFile') {
          return async (data: Uint8Array | string, ...rest: unknown[]) => {
            const crash = faults.check('write', target);
            if (crash?.crash) {
              const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
              await real.writeFile(bytes.subarray(0, Math.floor(bytes.length / 2)));
              faults.die();
            }
            return (real.writeFile as (...a: unknown[]) => Promise<void>)(data, ...rest);
          };
        }
        if (key === 'sync' || key === 'datasync') {
          return async () => {
            faults.check('sync', target);
            return real[key]();
          };
        }
        if (key === 'close') {
          return async () => {
            // A dead process cannot run code, but the OS closes its handles: keep the descriptor table clean.
            if (faults.crashed) {
              await real.close();
              throw new SimulatedCrash();
            }
            try {
              faults.check('close', target);
            } catch (e) {
              await real.close(); // a failed close() still releases the descriptor
              throw e;
            }
            return real.close();
          };
        }
        const value = Reflect.get(real, key, real) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    });
  }) as unknown as typeof FsPromises.open;

  const mocked = {
    open,
    rename: plain('rename', 'rename'),
    mkdir: plain('mkdir', 'mkdir'),
    readFile: plain('readFile', 'readFile'),
    writeFile: plain('writeFile', 'writeFile'),
    readdir: plain('readdir', 'readdir'),
    stat: plain('stat', 'stat'),
    lstat: plain('lstat', 'lstat'),
    unlink: plain('unlink', 'unlink'),
    rm: plain('rm', 'rm'),
    link: plain('link', 'link'),
    copyFile: plain('copyFile', 'copyFile'),
    access: plain('access', 'access'),
  };
  return { ...actual, ...mocked, default: { ...actual, ...mocked } } as typeof FsPromises;
}
