/**
 * S47.3: the scroll-edge masks. Content dissolves under the edge it scrolls past along a seven-stop ladder
 * (motion.css). Where the engine has scroll-driven animations the fade lengths --edge-top / --edge-bottom follow the
 * scroll position natively (`animation-timeline: scroll(self)` under @supports); elsewhere this module is the sensor:
 * an onScroll listener and a ResizeObserver write the same two properties from the model below.
 */

/** Length of the faded edge. */
export const EDGE_FADE_PX = 28;
/** Scroll distance over which an edge fades in (the native path's animation-range). */
export const EDGE_RAMP_PX = 32;
/** Within this distance of an end there is no fade on that end. */
export const EDGE_SNAP_PX = 2;

/** The seven stops: alpha (%) at a position (% of the fade length), from the edge inwards. */
export const EDGE_LADDER: readonly (readonly [alpha: number, at: number])[] = [
  [5, 15],
  [15, 30],
  [30, 45],
  [50, 60],
  [70, 75],
  [85, 87],
  [100, 100],
];

/** The vertical scrollers that get the mask: tree, problems, chat log, console, palette, walkthrough text. */
export const SCROLL_EDGE_SELECTORS = [
  '.tree-scroll',
  '.problems-body',
  '.ai-body',
  '.preview-console',
  '.palette-list',
  '.walkthrough-main',
] as const;
export const SCROLL_EDGE_SELECTOR = SCROLL_EDGE_SELECTORS.join(', ');

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Fade length (px) of each end: 0 within EDGE_SNAP_PX of that end, ramping to EDGE_FADE_PX over EDGE_RAMP_PX. */
export function edgeFade({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): { top: number; bottom: number } {
  const ramp = (distance: number) =>
    distance <= EDGE_SNAP_PX ? 0 : Math.round(EDGE_FADE_PX * Math.min(1, distance / EDGE_RAMP_PX) * 100) / 100;
  const remaining = scrollHeight - clientHeight - scrollTop;
  return { top: ramp(scrollTop), bottom: ramp(remaining) };
}

/** True when the engine drives the masks itself (Chromium 115+). */
export function nativeScrollEdges(css: { supports?(condition: string): boolean } | undefined): boolean {
  return css?.supports?.('animation-timeline: scroll()') === true;
}

function apply(el: HTMLElement): void {
  const { top, bottom } = edgeFade(el);
  el.style.setProperty('--edge-top', `${top}px`);
  el.style.setProperty('--edge-bottom', `${bottom}px`);
}

/**
 * The fallback sensor for engines without scroll-driven animations: one capturing scroll listener for every masked
 * scroller, and a ResizeObserver (content or box changes move the ends too) on each one as it appears. No-op where the
 * native path works. Returns the uninstaller.
 */
export function installScrollEdgeFallback(doc: Document = document): () => void {
  const win = doc.defaultView;
  if (!win || nativeScrollEdges(win.CSS) || typeof win.ResizeObserver === 'undefined') return () => undefined;
  const watched = new WeakSet<Element>();
  const resize = new win.ResizeObserver((entries) => {
    for (const entry of entries) apply(entry.target as HTMLElement);
  });
  const watch = (root: ParentNode) => {
    const found = root instanceof win.Element && root.matches(SCROLL_EDGE_SELECTOR) ? [root] : [];
    for (const el of [...found, ...Array.from(root.querySelectorAll(SCROLL_EDGE_SELECTOR))]) {
      if (watched.has(el)) continue;
      watched.add(el);
      resize.observe(el);
      for (const child of Array.from(el.children)) resize.observe(child);
      apply(el as HTMLElement);
    }
  };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof win.HTMLElement && target.matches(SCROLL_EDGE_SELECTOR)) apply(target);
  };
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  const added = new win.MutationObserver((records) => {
    for (const record of records)
      for (const node of Array.from(record.addedNodes)) if (node instanceof win.Element) watch(node);
  });
  added.observe(doc.body, { childList: true, subtree: true });
  watch(doc.body);
  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    added.disconnect();
    resize.disconnect();
  };
}
