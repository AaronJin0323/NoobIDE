/**
 * F6 / Shift+F6 move the keyboard focus between the workbench regions (S24.3). Tab cannot leave the code editor —
 * it indents, as a code editor should — so without this a keyboard user would be stuck there. The order is the
 * visual order of PLAN §3: top bar, tool bar, files, editor, preview, AI chat (S33), then the bands under the middle
 * row — the walkthrough (S47.6), the notice stack, Problems — and the editor's end of the status strip (S47.5).
 * Hidden regions, and regions with nothing to focus (an empty notice stack), are skipped.
 */
export const REGION_SELECTORS = [
  '[data-testid="region-topbar"]',
  '[data-testid="rail"]',
  '[data-testid="region-files"]',
  '[data-testid="region-editor"]',
  '[data-testid="region-preview"]',
  '[data-testid="region-ai"]', // S33.1 AI chat (when open)
  '[data-testid="walkthrough"], [data-testid="final-task"]', // S23 walkthrough band / final task card (when open)
  '[data-testid="app-notice-stack"]', // S13 notices (when any is shown)
  '[data-testid="region-problems"]',
  '[data-testid="region-status"]', // S47.5 the editor's end of the status strip
] as const;

const FOCUSABLE = [
  'button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'a[href]',
  '[tabindex="0"]',
].join(', ');

function isShown(element: Element): boolean {
  return element.getClientRects().length > 0 && !element.closest('[hidden]');
}

/** Where focus lands in a region: the code editor itself, the tree's current row, else its first control. */
function entryPoint(region: Element): HTMLElement | null {
  // Monaco takes keyboard input through its EditContext element (or a textarea where EditContext is unavailable).
  const monaco = region.querySelector('.monaco-editor');
  const editor =
    monaco?.querySelector<HTMLElement>('.native-edit-context') ?? monaco?.querySelector<HTMLElement>('textarea');
  if (monaco && editor && isShown(monaco) && region.querySelector('[role="tab"][aria-selected="true"]')) return editor;
  const candidates = [...region.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => isShown(el) && !el.closest('.monaco-editor'),
  );
  return candidates.find((el) => el.getAttribute('role') === 'treeitem') ?? candidates[0] ?? null;
}

/** Moves the focus to the next (1) or previous (-1) shown region that has something to focus. Returns success. */
export function focusRegion(step: 1 | -1, doc: Document = document): boolean {
  const regions = REGION_SELECTORS.map((selector) => doc.querySelector(selector)).filter(
    (region): region is Element => region !== null && isShown(region),
  );
  if (regions.length === 0) return false;
  const active = doc.activeElement;
  const current = regions.findIndex((region) => active !== null && region.contains(active));
  for (let i = 1; i <= regions.length; i += 1) {
    const index = current === -1 ? (step === 1 ? i - 1 : regions.length - i) : current + step * i;
    const region = regions[(index + regions.length * 2) % regions.length];
    const target = region ? entryPoint(region) : null;
    if (target) {
      target.focus();
      return true;
    }
  }
  return false;
}
