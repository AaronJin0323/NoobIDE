/**
 * Static-server lifecycle per project (S14.6, PLAN §8). At most one loopback server per open project; each one is
 * owned by the project and the workbench window that started it, and is shut down when that project is closed or
 * the window switches to another project. Generic over the server so the rules are unit-tested without sockets;
 * the preview manager uses it with the real `PreviewServer`.
 *
 * Ownership: a server is only handed out to, and only released for, its owner (same projectId and same window).
 * A request from another window — or one that names another project — is refused with `not-owner` and changes
 * nothing. Lifecycle events from main itself (project closed, project switched, app quit) release unconditionally.
 */
export interface ManagedServer {
  /** Real path of the project root the server is confined to. */
  readonly root: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface ServerOwner {
  readonly projectId: string;
  /** webContents id of the workbench window. */
  readonly windowId: number;
}

export type StartServer<S extends ManagedServer> = (
  root: string,
  options: { readonly preferredPort?: number | undefined },
) => Promise<S>;

export class NotOwnerError extends Error {
  readonly code = 'not-owner';
  constructor() {
    super('the server belongs to another project or window');
  }
}

interface Entry<S> {
  readonly owner: ServerOwner;
  readonly root: string;
  readonly server: Promise<S>;
  /** Outstanding acquires by the owner (overlapping starts share one server; the last owner release closes it). */
  leases: number;
}

export class ServerRegistry<S extends ManagedServer> {
  private readonly entries = new Map<string, Entry<S>>();
  /** Last port per project root, reused so the page keeps its origin (and its storage) across starts. */
  private readonly lastPorts = new Map<string, number>();

  constructor(private readonly startServer: StartServer<S>) {}

  /** Projects that have a server (starting or listening). */
  get projects(): string[] {
    return [...this.entries.keys()];
  }

  ownerOf(projectId: string): ServerOwner | undefined {
    return this.entries.get(projectId)?.owner;
  }

  isOwner(owner: ServerOwner): boolean {
    const entry = this.entries.get(owner.projectId);
    return entry !== undefined && entry.owner.windowId === owner.windowId;
  }

  /**
   * The project's server, started on first use. A second call by the same owner returns the same server (never a
   * second one); a call from another window is refused with NotOwnerError. A failed start leaves no entry.
   */
  acquire(owner: ServerOwner, root: string): Promise<S> {
    const existing = this.entries.get(owner.projectId);
    if (existing) {
      if (existing.owner.windowId !== owner.windowId) return Promise.reject(new NotOwnerError());
      if (existing.root === root) {
        existing.leases += 1;
        return existing.server;
      }
      // Same id with another root cannot happen (ids are per open project); be safe: replace it.
      void this.release(owner.projectId);
    }
    const server = this.startServer(root, { preferredPort: this.lastPorts.get(root) }).then(
      (started) => {
        this.lastPorts.set(root, started.port);
        return started;
      },
      (error: unknown) => {
        if (this.entries.get(owner.projectId)?.server === server) this.entries.delete(owner.projectId);
        throw error;
      },
    );
    this.entries.set(owner.projectId, { owner: { ...owner }, root, server, leases: 1 });
    return server;
  }

  /**
   * With `requester` (an owner giving back one acquire): only the owner may, and the server shuts down when its last
   * acquire is given back — so a superseded start never closes the server a newer start of the same owner uses.
   * Without `requester` (Stop, project switch/close, window closed): the server shuts down at once.
   * True when a server was shut down.
   */
  async release(projectId: string, requester?: ServerOwner): Promise<boolean> {
    const entry = this.entries.get(projectId);
    if (!entry) return false;
    if (requester) {
      if (requester.projectId !== projectId || requester.windowId !== entry.owner.windowId) return false;
      entry.leases -= 1;
      if (entry.leases > 0) return false;
    }
    this.entries.delete(projectId);
    try {
      await (await entry.server).close();
    } catch {
      // A server that failed to start has nothing to close.
    }
    return true;
  }

  /** Project switch: every server except `keep`'s is shut down (keep null: all of them). */
  async releaseAllExcept(keep: string | null): Promise<void> {
    await Promise.all(this.projects.filter((id) => id !== keep).map((id) => this.release(id)));
  }

  /** Every server owned by a window (the window closed). */
  async releaseWindow(windowId: number): Promise<void> {
    const owned = [...this.entries].filter(([, entry]) => entry.owner.windowId === windowId).map(([id]) => id);
    await Promise.all(owned.map((id) => this.release(id)));
  }
}
