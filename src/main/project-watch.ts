import { EVENTS, type WatchEvent, type WorkspaceChanged } from '../shared/ipc/contract';
import { ProjectWatcher } from '../workspace/watcher';

/**
 * Keeps one file watcher for the open project (S07.3) and forwards its events only to the workbench window that
 * opened the project. Opening another project (from the folder dialog or crash recovery) or closing that window
 * stops the watcher, removes its `destroyed` listener and releases its snapshot.
 */
export interface EventTarget {
  send(channel: string, payload: WorkspaceChanged): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

interface Current {
  readonly watcher: ProjectWatcher;
  readonly target: EventTarget;
  readonly onDestroyed: () => void;
}

export class ProjectWatchHub {
  private current: Current | null = null;

  constructor(
    private readonly createWatcher: (root: string, emit: (events: WatchEvent[]) => void) => ProjectWatcher = (
      root,
      emit,
    ) => new ProjectWatcher(root, emit),
  ) {}

  watch(projectId: string, root: string, target: EventTarget): void {
    this.stop();
    const watcher = this.createWatcher(root, (events) => {
      if (!target.isDestroyed()) target.send(EVENTS.changed, { projectId, events });
    });
    const onDestroyed = () => {
      if (this.current?.watcher === watcher) this.stop();
    };
    this.current = { watcher, target, onDestroyed };
    target.once('destroyed', onDestroyed);
    // start() never rejects for OS watch failures (the watcher retries itself); a failing first scan is ignored.
    watcher.start().catch(() => undefined);
  }

  /** S13.3: whether a project is being watched (tests of closing a project). */
  get active(): boolean {
    return this.current !== null;
  }

  /** S25.1/S25.2: after sleep, the open project's watch is re-attached and the tree rescanned (watcher.resync). */
  async resync(): Promise<boolean> {
    const current = this.current;
    if (!current) return false;
    await current.watcher.resync();
    return true;
  }

  stop(): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    current.watcher.close();
    if (!current.target.isDestroyed()) current.target.removeListener('destroyed', current.onDestroyed);
  }
}
