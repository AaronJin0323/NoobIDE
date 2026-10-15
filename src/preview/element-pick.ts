/**
 * S41.3: picking, finding and showing an element of the preview for an annotation (decision 0030). Main process only;
 * structural Electron types keep it unit-testable.
 *
 * Everything goes over the page guard's existing DevTools protocol session; nothing is added to the page:
 * - **Pick**: `Overlay.setInspectMode('searchForNode')` — Chromium's own inspector overlay draws the highlight and the
 *   tag/size tooltip outside the page's DOM, and while it is on, mouse input goes to the inspector, not to the page.
 *   The pick arrives as `Overlay.inspectNodeRequested`; the node is resolved into an isolated world and described
 *   there (element-target.ts). Ends on a pick, {@link ElementPicker.cancel} (Esc, Cancel, Stop, navigation) or a time
 *   limit.
 * - **Find**: by child-index path or by a drawn region, evaluated in the isolated world.
 * - **Show**: `Overlay.highlightNode` for a few seconds.
 * The DOM and Overlay domains are enabled only while one of these runs (counted), so a big, changing page costs main
 * nothing the rest of the time. Page text is never logged.
 */
import type { AnnotationCandidates, AnnotationRect } from '../shared/ipc/annotations-contract';
import {
  candidatesExpression,
  describeFunction,
  elementAtPathExpression,
  elementInRegionExpression,
  parseCandidates,
} from './element-target';

export const PICK_LIMITS = {
  /** Pick mode ends by itself after this long. */
  pickTimeoutMs: 120_000,
  /** One protocol command (describe, find, list) is waited for at most this long. */
  commandTimeoutMs: 2_000,
  /** How long "Show" keeps the highlight. */
  highlightMs: 3_000,
} as const;

/** The isolated world's name (a page cannot name or enter it). */
export const ANNOTATION_WORLD = 'noobide-annotations';

export interface PickDebugger {
  isAttached(): boolean;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): void;
  off(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): void;
}

export interface PickContents {
  isDestroyed(): boolean;
  readonly debugger: PickDebugger;
}

export type PickFailure = 'cancelled' | 'not-available' | 'busy';
export type Picked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: PickFailure };

/** Chromium's highlight colours (the same as DevTools' element highlight), plus the tag/size tooltip. */
const HIGHLIGHT = {
  showInfo: true,
  showStyles: false,
  showAccessibilityInfo: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.55 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One per preview view. */
export class ElementPicker {
  private domUsers = 0;
  private picking: { finish: (result: Picked<number>) => void } | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Inspect mode is on in the page (set once Chromium confirmed it; for tests and diagnostics). */
  private inspecting = false;

  constructor(
    private readonly contents: PickContents,
    private readonly limits: { readonly [K in keyof typeof PICK_LIMITS]: number } = PICK_LIMITS,
  ) {}

  get isPicking(): boolean {
    return this.picking !== null;
  }
  get isInspecting(): boolean {
    return this.inspecting;
  }

  private get dbg(): PickDebugger | null {
    return this.contents.isDestroyed() || !this.contents.debugger.isAttached() ? null : this.contents.debugger;
  }

  private send(method: string, params?: object): Promise<unknown> {
    const dbg = this.dbg;
    if (!dbg) return Promise.reject(new Error('no protocol'));
    return withTimeout(dbg.sendCommand(method, params), this.limits.commandTimeoutMs);
  }

  /** DOM + Overlay on while at least one user needs them. On failure nothing is counted (and it throws). */
  private async acquire(): Promise<void> {
    this.domUsers += 1;
    if (this.domUsers > 1) return;
    try {
      await this.send('DOM.enable');
      await this.send('Overlay.enable');
    } catch (e) {
      this.domUsers = Math.max(0, this.domUsers - 1);
      throw e;
    }
  }
  private async release(): Promise<void> {
    this.domUsers = Math.max(0, this.domUsers - 1);
    if (this.domUsers > 0) return;
    await this.send('Overlay.disable').catch(() => undefined);
    await this.send('DOM.disable').catch(() => undefined);
  }

  private async world(): Promise<number> {
    let frameId: unknown;
    try {
      frameId = ((await this.send('Target.getTargetInfo')) as { targetInfo?: { targetId?: unknown } }).targetInfo
        ?.targetId;
    } catch {
      frameId = undefined;
    }
    if (typeof frameId !== 'string') {
      const tree = (await this.send('Page.getFrameTree')) as { frameTree?: { frame?: { id?: unknown } } };
      frameId = tree.frameTree?.frame?.id;
    }
    if (typeof frameId !== 'string') throw new Error('no main frame');
    const world = (await this.send('Page.createIsolatedWorld', {
      frameId,
      worldName: ANNOTATION_WORLD,
      grantUniveralAccess: false,
    })) as { executionContextId?: unknown };
    if (typeof world.executionContextId !== 'number') throw new Error('no isolated world');
    return world.executionContextId;
  }

  /** Describes an object of the isolated world (an element) with element-target.ts's function. */
  private async describe(objectId: string): Promise<unknown> {
    const result = (await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: describeFunction(),
      returnByValue: true,
      silent: true,
      userGesture: false,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error('describe failed');
    return result.result?.value ?? null;
  }

  /** Evaluates an expression returning an element (or null) in a fresh isolated world; its object id. */
  private async elementObject(expression: string): Promise<string | null> {
    const contextId = await this.world();
    const result = (await this.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: false,
      silent: true,
      awaitPromise: false,
      userGesture: false,
      includeCommandLineAPI: false,
      timeout: this.limits.commandTimeoutMs,
    })) as { result?: { objectId?: unknown; subtype?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error('find failed');
    return typeof result.result?.objectId === 'string' && result.result.subtype === 'node' ? result.result.objectId : null; // prettier-ignore
  }

  /**
   * Inspect mode until the user clicks an element; resolves with that element's description (raw, for parseTarget).
   * A second pick while one runs is refused with `busy`.
   */
  async pick(): Promise<Picked<unknown>> {
    const dbg = this.dbg;
    if (!dbg) return { ok: false, reason: 'not-available' };
    if (this.picking) return { ok: false, reason: 'busy' };
    let finish!: (result: Picked<number>) => void;
    const picked = new Promise<Picked<number>>((resolve) => (finish = resolve));
    const entry = { finish: (result: Picked<number>) => finish(result) };
    this.picking = entry;
    const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
      // Only the page itself (child targets of the guard come with a session id).
      if (sessionId || method !== 'Overlay.inspectNodeRequested' || !isRecord(params)) return;
      if (typeof params.backendNodeId === 'number') finish({ ok: true, value: params.backendNodeId });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'cancelled' }), this.limits.pickTimeoutMs);
    dbg.on('message', onMessage);
    let acquired = false;
    try {
      await this.acquire();
      acquired = true;
      await this.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT });
      if (this.picking === entry) this.inspecting = true;
    } catch {
      finish({ ok: false, reason: 'not-available' });
    }
    const result = await picked;
    clearTimeout(timer);
    dbg.off('message', onMessage);
    if (this.picking === entry) this.picking = null;
    this.inspecting = false;
    await this.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT }).catch(() => undefined);
    try {
      if (!result.ok) return result;
      const contextId = await this.world();
      const resolved = (await this.send('DOM.resolveNode', {
        backendNodeId: result.value,
        executionContextId: contextId,
      })) as { object?: { objectId?: unknown } };
      const objectId = resolved.object?.objectId;
      if (typeof objectId !== 'string') return { ok: false, reason: 'not-available' };
      return { ok: true, value: await this.describe(objectId) };
    } catch {
      // A node of another frame (an iframe) or a page that went away.
      return { ok: false, reason: 'not-available' };
    } finally {
      if (acquired) await this.release();
    }
  }

  /** Ends pick mode (Esc, Cancel, Stop, a navigation). */
  cancel(): void {
    this.picking?.finish({ ok: false, reason: 'cancelled' });
  }

  /** The element at a child-index path, described; or not-available when it is gone. */
  async describePath(path: readonly number[]): Promise<Picked<unknown>> {
    return this.describeFound(elementAtPathExpression(path));
  }

  /** The smallest element containing a region (fractions of the viewport), described. */
  async describeRegion(region: AnnotationRect): Promise<Picked<unknown>> {
    return this.describeFound(elementInRegionExpression(region));
  }

  private async describeFound(expression: string): Promise<Picked<unknown>> {
    if (!this.dbg) return { ok: false, reason: 'not-available' };
    try {
      const objectId = await this.elementObject(expression);
      if (!objectId) return { ok: false, reason: 'not-available' };
      const value = await this.describe(objectId);
      return value ? { ok: true, value } : { ok: false, reason: 'not-available' };
    } catch {
      return { ok: false, reason: 'not-available' };
    }
  }

  /** Notable elements for the keyboard list. */
  async candidates(): Promise<Picked<AnnotationCandidates>> {
    if (!this.dbg) return { ok: false, reason: 'not-available' };
    try {
      const contextId = await this.world();
      const result = (await this.send('Runtime.evaluate', {
        expression: candidatesExpression(),
        contextId,
        returnByValue: true,
        silent: true,
        userGesture: false,
        includeCommandLineAPI: false,
        timeout: this.limits.commandTimeoutMs,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      const parsed = result.exceptionDetails ? null : parseCandidates(result.result?.value);
      return parsed ? { ok: true, value: parsed } : { ok: false, reason: 'not-available' };
    } catch {
      return { ok: false, reason: 'not-available' };
    }
  }

  /** Highlights the element at `path` for a while (`null` hides the highlight at once). */
  async highlight(path: readonly number[] | null): Promise<Picked<null>> {
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
      await this.send('Overlay.hideHighlight').catch(() => undefined);
      await this.release();
    }
    if (!path) return { ok: true, value: null };
    if (!this.dbg) return { ok: false, reason: 'not-available' };
    try {
      const objectId = await this.elementObject(elementAtPathExpression(path));
      if (!objectId) return { ok: false, reason: 'not-available' };
      await this.acquire(); // throws (counting nothing) when the domains cannot be enabled
      try {
        await this.send('Overlay.highlightNode', { objectId, highlightConfig: HIGHLIGHT });
      } catch {
        await this.release();
        return { ok: false, reason: 'not-available' };
      }
      this.highlightTimer = setTimeout(() => {
        this.highlightTimer = null;
        void this.send('Overlay.hideHighlight')
          .catch(() => undefined)
          .then(() => this.release());
      }, this.limits.highlightMs);
      return { ok: true, value: null };
    } catch {
      return { ok: false, reason: 'not-available' };
    }
  }

  /** The view is going away or navigating: end everything. */
  dispose(): void {
    this.cancel();
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
  }
}
