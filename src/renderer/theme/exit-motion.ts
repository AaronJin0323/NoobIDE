import { useEffect, type RefObject } from 'react';
import { REDUCED_MOTION_QUERY } from './motion';

/**
 * S47.2: the exit half of panel, band and notice motion. React removes a closed panel at once; to let it leave with
 * the token-timed fade instead of vanishing, a removed element is put back as an inert *ghost* — a copy with no ids, no
 * test ids and no accessible content — that plays the `[data-motion='exit']` keyframe of motion.css and is removed
 * when it ends. The real element is already gone, so state, focus and the accessibility tree change at the same moment
 * as before; only the picture lingers for --dur-fast. Under reduced motion nothing is copied.
 */

/** Where a removed element may leave with an exit: the parent it was removed from and what the element is. */
export interface ExitSlot {
  readonly parent: string;
  readonly child: string;
}

/** The slots of the workbench: the walkthrough band, the AI chat panel and every app notice. */
export const EXIT_SLOTS: readonly ExitSlot[] = [
  { parent: '.workbench', child: '.walkthrough' },
  { parent: '.workbench-middle', child: '.ai-chat' },
  { parent: '.app-notice-stack', child: '*' },
];

/** The part of an element the decision needs (a DOM Element in the app, a plain object in the unit test). */
export interface Matchable {
  matches(selector: string): boolean;
  readonly nodeType?: number;
}

/** Longest a ghost may stay when its animationend never comes (a hidden window does not run animations). */
export const GHOST_MAX_MS = 1000;

/**
 * Should `removed`, taken out of `parent` in one batch of mutations that also added `added`, leave with an exit?
 * Only an element of a known slot does, and not when the same batch put a new element of a one-element slot in (React
 * swapped one band for another, e.g. the compact walkthrough): then the new one simply enters.
 */
export function exitSlotFor(
  parent: Matchable,
  removed: Matchable,
  added: readonly Matchable[],
  slots: readonly ExitSlot[] = EXIT_SLOTS,
): ExitSlot | null {
  if (removed.nodeType !== undefined && removed.nodeType !== 1) return null;
  if (removed.matches('[data-motion="exit"]')) return null;
  for (const slot of slots) {
    if (!parent.matches(slot.parent) || !removed.matches(slot.child)) continue;
    // A slot of one (the band, the panel) is swapped when a new one comes in; notices are separate items.
    const replaced =
      slot.child !== '*' &&
      added.some((node) => (node.nodeType === undefined || node.nodeType === 1) && node.matches(slot.child));
    return replaced ? null : slot;
  }
  return null;
}

/** How long a ghost plays: its computed animation duration plus delay (the longest of a list), capped. */
export function ghostLifetimeMs(duration: string, delay: string): number {
  const ms = (value: string) =>
    Math.max(
      0,
      ...value.split(',').map((part) => {
        const v = part.trim();
        const n = Number.parseFloat(v);
        if (!Number.isFinite(n)) return 0;
        return v.endsWith('ms') ? n : n * 1000;
      }),
    );
  return Math.min(GHOST_MAX_MS, ms(duration) + ms(delay));
}

/** A copy of `el` that looks the same and is nothing else: no ids, test ids, live regions, focus or pointer events. */
function makeGhost(el: Element): Element {
  const ghost = el.cloneNode(true) as Element;
  for (const node of [ghost, ...Array.from(ghost.querySelectorAll('*'))]) {
    node.removeAttribute('id');
    node.removeAttribute('data-testid');
    node.removeAttribute('aria-live');
    if (node.getAttribute('role') === 'status' || node.getAttribute('role') === 'alert') node.removeAttribute('role');
  }
  ghost.setAttribute('data-motion', 'exit');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  return ghost;
}

/** Watches the direct children of `containers` and gives a removed slot element its exit. Returns the disconnect. */
export function watchExits(containers: readonly Element[], win: Window = window): () => void {
  const reduced = win.matchMedia?.(REDUCED_MOTION_QUERY);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const observer = new MutationObserver((records) => {
    if (reduced?.matches) return;
    const added = records.flatMap((r) => Array.from(r.addedNodes)) as unknown as Matchable[];
    for (const record of records) {
      const parent = record.target as Element;
      for (const node of Array.from(record.removedNodes)) {
        if (!exitSlotFor(parent, node as unknown as Matchable, added)) continue;
        const ghost = makeGhost(node as Element);
        const before = record.nextSibling && record.nextSibling.parentNode === parent ? record.nextSibling : null;
        parent.insertBefore(ghost, before);
        const style = win.getComputedStyle(ghost);
        const remove = () => ghost.remove();
        ghost.addEventListener('animationend', (event) => event.target === ghost && remove());
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            remove();
          },
          ghostLifetimeMs(style.animationDuration, style.animationDelay) + 50,
        );
        timers.add(timer);
      }
    }
  });
  for (const container of containers) observer.observe(container, { childList: true });
  return () => {
    observer.disconnect();
    for (const timer of timers) clearTimeout(timer);
  };
}

/** Workbench hook: exits for the slots under `root` (the .workbench element). */
export function useExitMotion(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    const containers = [el, ...Array.from(el.querySelectorAll('.workbench-middle, .app-notice-stack'))];
    return watchExits(containers);
  }, [root]);
}
