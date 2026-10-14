import { EVENTS, type WatchEvent, type WorkspaceChanged } from '../shared/ipc/contract';
import { ProjectWatcher } from '../workspace/watcher';

/**
 * Keeps one file watcher for the open project (S07.3) and forwards its events only to the workbench window that
 * opened the project. Opening another project or closing that window stops the watcher.
 */
export interface EventTarget {
  send(channel: string, payload: WorkspaceChanged): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

export class ProjectWatchHub {
  private current: ProjectWatcher | null = null;

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
    this.current = watcher;
    target.once('destroyed', () => {
      if (this.current === watcher) this.stop();
    });
    // A watcher that cannot start (e.g. too many open handles) leaves the tree working with manual reloads.
    watcher.start().catch(() => undefined);
  }

  stop(): void {
    this.current?.close();
    this.current = null;
  }
}
