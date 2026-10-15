/**
 * S38.1: a bounded snapshot of what the preview shows, for the AI assistant (docs/decisions/0026). Main process only.
 *
 * Captured entirely from main, without adding anything to the preview: no preload, no IPC into the page, no script in
 * the page's own (main) world, no new permission, no network.
 *
 * - **Outline** (headings, links, buttons, form fields, images with alt): one `Runtime.evaluate` over the DevTools
 *   protocol session main already holds for the page guard (decision 0016), in an ISOLATED world created for it with
 *   `Page.createIsolatedWorld` (no universal access). An isolated world shares only the DOM with the page: it has its
 *   own globals and its own DOM wrappers, so the page cannot see the script, its variables or its result, and cannot
 *   influence it through prototypes, getters, `Error.prepareStackTrace` or anything else it can change in its own
 *   world. The script only reads the DOM (no layout-dependent APIs except `checkVisibility`, no events, no mutation).
 *   It bounds itself (elements visited, items, characters per item, a time budget), so what crosses the protocol
 *   is small whatever the page is; main validates and caps the result again. The CDP DOM / DOMSnapshot /
 *   Accessibility domains were not used: they return the page's strings unbounded, and main would have to parse a
 *   huge page's whole tree (decision 0026).
 * - **Screenshot**: `webContents.capturePage()` (a copy of the composited frame, no page script), scaled in main to at
 *   most {@link SNAPSHOT_LIMITS.screenshotMaxSide} pixels and refused above {@link SNAPSHOT_LIMITS.screenshotMaxBytes}.
 * - **Budgets**: each part has a wall-time budget; a page that is busy (an endless loop) or gone gives "not
 *   available" within it and main never waits longer. One snapshot runs at a time per preview (callers share it).
 *
 * Nothing here logs. Page text is untrusted data: the AI layer frames it (src/ai) and never logs it.
 */

export const SNAPSHOT_LIMITS = {
  /** Elements the outline script looks at, at most. */
  visitElements: 20_000,
  /** Outline items (headings, links, …), at most. */
  items: 300,
  /** Characters of one item's text or attribute. */
  itemChars: 160,
  /** Characters of the formatted outline. */
  outlineChars: 12_000,
  titleChars: 200,
  pathChars: 512,
  /** The outline script stops looking after this long (in the page's renderer). */
  scriptBudgetMs: 400,
  /** Main waits at most this long for the outline. */
  outlineTimeoutMs: 1_500,
  /** Main waits at most this long for the screenshot. */
  screenshotTimeoutMs: 2_000,
  /** Longest side of the screenshot, in pixels. */
  screenshotMaxSide: 1_024,
  /** PNG bytes, at most. */
  screenshotMaxBytes: 1_500_000,
} as const;

export type SnapshotLimits = { readonly [K in keyof typeof SNAPSHOT_LIMITS]: number };

/** The isolated world's name (a page cannot name or enter it). */
export const SNAPSHOT_WORLD = 'noobide-snapshot';

export type OutlineItem =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string; readonly hidden?: boolean }
  | { readonly kind: 'link'; readonly text: string; readonly href: string; readonly hidden?: boolean }
  | { readonly kind: 'button'; readonly text: string; readonly id?: string; readonly hidden?: boolean }
  | {
      readonly kind: 'field';
      readonly tag: string;
      readonly type?: string;
      readonly name?: string;
      readonly id?: string;
      readonly label?: string;
      readonly placeholder?: string;
      readonly hidden?: boolean;
    }
  | { readonly kind: 'image'; readonly alt: string; readonly src: string; readonly hidden?: boolean };

export interface PageOutline {
  readonly items: readonly OutlineItem[];
  /** The script stopped early (too many elements or items, or its time budget). */
  readonly truncated: boolean;
}

export interface PageScreenshot {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

export type SnapshotUnavailable = 'busy' | 'timeout' | 'no-protocol' | 'failed' | 'hidden' | 'too-large';

export interface PageSnapshot {
  /** URL path of the shown page inside the project ('' = the project's index page); null when not on the preview. */
  readonly path: string | null;
  readonly title: string;
  readonly outline: PageOutline | null;
  readonly outlineUnavailable?: SnapshotUnavailable;
  readonly screenshot: PageScreenshot | null;
  readonly screenshotUnavailable?: SnapshotUnavailable;
  /** Wall time the snapshot took (ms), for tests and diagnostics. */
  readonly ms: number;
}

/**
 * The outline script. Runs in the isolated world only. No free variables except the DOM globals of that world;
 * every limit is a literal, so the text is fixed per build (checked by the unit tests).
 */
export function outlineScript(limits: SnapshotLimits = SNAPSHOT_LIMITS): string {
  const L = JSON.stringify({
    visit: limits.visitElements,
    items: limits.items,
    chars: limits.itemChars,
    budget: limits.scriptBudgetMs,
  });
  return `(() => {
  const L = ${L};
  const started = performance.now();
  const items = [];
  let visited = 0;
  let truncated = false;
  const clip = (s) => {
    const flat = String(s || '').replace(/\\s+/g, ' ').trim();
    return flat.length > L.chars ? flat.slice(0, L.chars) + '…' : flat;
  };
  const attr = (el, name) => {
    const v = el.getAttribute(name);
    return v === null ? undefined : clip(v.slice(0, L.chars * 2));
  };
  // Text of an element from its first text nodes only (never the whole subtree of a huge element).
  const textOf = (el) => {
    let out = '';
    let nodes = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (out.length < L.chars * 2 && nodes < 200 && walker.nextNode()) {
      nodes += 1;
      out += ' ' + String(walker.currentNode.nodeValue || '').slice(0, L.chars * 2);
    }
    return clip(out);
  };
  const named = (el) => textOf(el) || attr(el, 'aria-label') || attr(el, 'title') || attr(el, 'value') || '';
  const hidden = (el) => (typeof el.checkVisibility === 'function' && !el.checkVisibility() ? { hidden: true } : {});
  const opt = (k, v) => (v === undefined || v === '' ? {} : { [k]: v });
  const SKIP = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head', 'iframe', 'object']);
  const BUTTON_TYPES = new Set(['button', 'submit', 'reset', 'image']);
  const describe = (el) => {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) return { kind: 'heading', level: Number(tag[1]), text: textOf(el), ...hidden(el) };
    if (tag === 'a' && el.hasAttribute('href'))
      return { kind: 'link', text: named(el), href: attr(el, 'href') || '', ...hidden(el) };
    if (tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'input' && BUTTON_TYPES.has(String(el.getAttribute('type') || '').toLowerCase())))
      return { kind: 'button', text: named(el), ...opt('id', attr(el, 'id')), ...hidden(el) };
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const label = el.labels && el.labels.length > 0 ? textOf(el.labels[0]) : attr(el, 'aria-label');
      return {
        kind: 'field',
        tag,
        ...opt('type', tag === 'input' ? attr(el, 'type') || 'text' : undefined),
        ...opt('name', attr(el, 'name')),
        ...opt('id', attr(el, 'id')),
        ...opt('label', label),
        ...opt('placeholder', attr(el, 'placeholder')),
        ...hidden(el),
      };
    }
    if (tag === 'img') return { kind: 'image', alt: attr(el, 'alt') || '', src: attr(el, 'src') || '', ...hidden(el) };
    return null;
  };
  const root = document.body || document.documentElement;
  let el = root;
  while (el) {
    visited += 1;
    if (visited > L.visit || items.length >= L.items || performance.now() - started > L.budget) {
      truncated = true;
      break;
    }
    const item = describe(el);
    if (item) items.push(item);
    // Headings, links and buttons are read with their text; their children are not listed again.
    let next = item && item.kind !== 'field' && item.kind !== 'image' ? null : SKIP.has(el.localName) ? null : el.firstElementChild;
    if (!next) {
      let up = el;
      while (up && up !== root && !up.nextElementSibling) up = up.parentElement;
      next = up && up !== root ? up.nextElementSibling : null;
    }
    el = next;
  }
  return { items, truncated };
})()`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Validates and caps what the outline script returned. Anything that does not have the expected shape is dropped
 * (the script cannot be influenced by the page, but main never trusts a renderer's answer).
 */
export function parseOutline(value: unknown, limits: SnapshotLimits = SNAPSHOT_LIMITS): PageOutline | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const max = limits.itemChars;
  const items: OutlineItem[] = [];
  for (const raw of value.items.slice(0, limits.items)) {
    if (!isRecord(raw)) continue;
    const hidden = raw.hidden === true ? { hidden: true as const } : {};
    const opt = (k: string, v: unknown) => {
      const c = clipText(v, max);
      return c ? { [k]: c } : {};
    };
    switch (raw.kind) {
      case 'heading': {
        const level = typeof raw.level === 'number' && raw.level >= 1 && raw.level <= 6 ? Math.floor(raw.level) : 1;
        items.push({ kind: 'heading', level, text: clipText(raw.text, max) ?? '', ...hidden });
        break;
      }
      case 'link':
        items.push({
          kind: 'link',
          text: clipText(raw.text, max) ?? '',
          href: clipText(raw.href, max) ?? '',
          ...hidden,
        });
        break;
      case 'button':
        items.push({ kind: 'button', text: clipText(raw.text, max) ?? '', ...opt('id', raw.id), ...hidden });
        break;
      case 'field': {
        const tag = raw.tag === 'select' || raw.tag === 'textarea' ? raw.tag : 'input';
        items.push({
          kind: 'field',
          tag,
          ...opt('type', raw.type),
          ...opt('name', raw.name),
          ...opt('id', raw.id),
          ...opt('label', raw.label),
          ...opt('placeholder', raw.placeholder),
          ...hidden,
        } as OutlineItem);
        break;
      }
      case 'image':
        items.push({ kind: 'image', alt: clipText(raw.alt, max) ?? '', src: clipText(raw.src, max) ?? '', ...hidden });
        break;
      default:
        break;
    }
  }
  return { items, truncated: value.truncated === true || value.items.length > limits.items };
}

const quote = (s: string) => JSON.stringify(s);

/** One line per outline item, in page order, capped at `outlineChars` (plain text; the AI layer frames it). */
export function formatOutline(
  outline: PageOutline,
  limits: SnapshotLimits = SNAPSHOT_LIMITS,
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  let size = 0;
  let truncated = outline.truncated;
  for (const item of outline.items) {
    const hidden = item.hidden ? ' (hidden)' : '';
    let line: string;
    switch (item.kind) {
      case 'heading':
        line = `h${item.level} ${quote(item.text)}`;
        break;
      case 'link':
        line = `link ${quote(item.text)} -> ${item.href || '(no href)'}`;
        break;
      case 'button':
        line = `button ${quote(item.text)}${item.id ? ` id=${quote(item.id)}` : ''}`;
        break;
      case 'field':
        line = [
          `field ${item.tag}${item.type ? `[type=${item.type}]` : ''}`,
          item.id ? `id=${quote(item.id)}` : '',
          item.name ? `name=${quote(item.name)}` : '',
          item.label ? `label=${quote(item.label)}` : '',
          item.placeholder ? `placeholder=${quote(item.placeholder)}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        break;
      case 'image':
        line = `image alt=${quote(item.alt)} src=${item.src || '(none)'}`;
        break;
    }
    line += hidden;
    if (size + line.length + 1 > limits.outlineChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return { text: lines.join('\n'), truncated };
}

/** The shown page's path inside the project, or null when the URL is not on the preview's origin. */
export function pagePathOf(url: string, origin: string, limits: SnapshotLimits = SNAPSHOT_LIMITS): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(origin).origin) return null;
    let path: string;
    try {
      path = decodeURIComponent(u.pathname);
    } catch {
      path = u.pathname;
    }
    path = path.replace(/^\/+/, '');
    return path.length > limits.pathChars ? `${path.slice(0, limits.pathChars)}…` : path;
  } catch {
    return null;
  }
}

/** Width and height after scaling the longest side down to `maxSide` (never up). */
export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// ── Electron side (structural types keep this module unit-testable without Electron) ──

interface DebuggerLike {
  isAttached(): boolean;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
}

interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): NativeImageLike;
  toPNG(): Buffer;
}

export interface SnapshotContents {
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  readonly debugger: DebuggerLike;
  capturePage(): Promise<NativeImageLike>;
}

type Timed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: SnapshotUnavailable };

function withBudget<T>(work: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(
      (value): Timed<T> => ({ ok: true, value }),
      (): Timed<T> => ({ ok: false, reason: 'failed' }),
    ),
    new Promise<Timed<T>>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The main frame's protocol id (for a page target it is the target id). */
async function mainFrameId(dbg: DebuggerLike): Promise<string | null> {
  try {
    const info = (await dbg.sendCommand('Target.getTargetInfo')) as { targetInfo?: { targetId?: unknown } };
    if (typeof info.targetInfo?.targetId === 'string') return info.targetInfo.targetId;
  } catch {
    // fall back to the frame tree below
  }
  const tree = (await dbg.sendCommand('Page.getFrameTree')) as { frameTree?: { frame?: { id?: unknown } } };
  return typeof tree.frameTree?.frame?.id === 'string' ? tree.frameTree.frame.id : null;
}

/** The outline, read in an isolated world through the existing protocol session. */
export async function captureOutline(
  contents: SnapshotContents,
  limits: SnapshotLimits = SNAPSHOT_LIMITS,
): Promise<Timed<PageOutline>> {
  const dbg = contents.debugger;
  if (contents.isDestroyed() || !dbg.isAttached()) return { ok: false, reason: 'no-protocol' };
  const work = (async () => {
    const frameId = await mainFrameId(dbg);
    if (!frameId) throw new Error('no main frame');
    const world = (await dbg.sendCommand('Page.createIsolatedWorld', {
      frameId,
      worldName: SNAPSHOT_WORLD,
      grantUniveralAccess: false,
    })) as { executionContextId?: unknown };
    if (typeof world.executionContextId !== 'number') throw new Error('no isolated world');
    const result = (await dbg.sendCommand('Runtime.evaluate', {
      expression: outlineScript(limits),
      contextId: world.executionContextId,
      returnByValue: true,
      silent: true,
      awaitPromise: false,
      userGesture: false,
      includeCommandLineAPI: false,
      // A backstop: V8 ends the evaluation itself after this long (the script bounds itself well before).
      timeout: limits.outlineTimeoutMs,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error('outline script failed');
    const outline = parseOutline(result.result?.value, limits);
    if (!outline) throw new Error('unexpected outline');
    return outline;
  })();
  return withBudget(work, limits.outlineTimeoutMs);
}

/** A PNG of what the view shows, scaled down and size-checked; nothing when the view shows nothing. */
export async function captureScreenshot(
  contents: SnapshotContents,
  limits: SnapshotLimits = SNAPSHOT_LIMITS,
): Promise<Timed<PageScreenshot>> {
  if (contents.isDestroyed()) return { ok: false, reason: 'failed' };
  const captured = await withBudget(contents.capturePage(), limits.screenshotTimeoutMs);
  if (!captured.ok) return captured;
  const image = captured.value;
  if (image.isEmpty()) return { ok: false, reason: 'hidden' };
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return { ok: false, reason: 'hidden' };
  const target = scaledSize(size.width, size.height, limits.screenshotMaxSide);
  const scaled =
    target.width === size.width && target.height === size.height ? image : image.resize({ ...target, quality: 'good' });
  const png = scaled.toPNG();
  if (png.length > limits.screenshotMaxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true, value: { png, ...target } };
}

/** Takes one snapshot of `contents` (outline and, if asked, screenshot in parallel). */
export async function takeSnapshot(
  contents: SnapshotContents,
  options: { readonly origin: string; readonly screenshot: boolean; readonly now?: () => number },
  limits: SnapshotLimits = SNAPSHOT_LIMITS,
): Promise<PageSnapshot> {
  const now = options.now ?? Date.now;
  const started = now();
  const [outline, screenshot] = await Promise.all([
    captureOutline(contents, limits),
    options.screenshot ? captureScreenshot(contents, limits) : Promise.resolve<Timed<PageScreenshot> | null>(null),
  ]);
  const destroyed = contents.isDestroyed();
  const url = destroyed ? '' : contents.getURL();
  const title = destroyed ? '' : (clipText(contents.getTitle(), limits.titleChars) ?? '');
  return {
    path: pagePathOf(url, options.origin, limits),
    title,
    outline: outline.ok ? outline.value : null,
    ...(outline.ok ? {} : { outlineUnavailable: outline.reason }),
    screenshot: screenshot?.ok ? screenshot.value : null,
    ...(screenshot && !screenshot.ok ? { screenshotUnavailable: screenshot.reason } : {}),
    ms: now() - started,
  };
}
