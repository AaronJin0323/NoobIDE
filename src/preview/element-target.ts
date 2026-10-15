/**
 * S41.3: describing an element of the preview for an annotation (decision 0030). Main process only, no Electron.
 *
 * The functions below are sent as text over the page guard's DevTools protocol session and run in an ISOLATED world
 * (like the S38.1 outline, decision 0026): they share only the DOM with the page, so the page cannot see them, their
 * results, or influence them through its own globals. They only read (no DOM writes, events, storage or network) and
 * bound themselves; main validates and caps what they return again ({@link parseTarget}, {@link parseCandidates}).
 */
import {
  ANNOTATION_LIMITS,
  type AnnotationCandidates,
  type AnnotationCssRule,
  type AnnotationRect,
  type AnnotationTarget,
} from '../shared/ipc/annotations-contract';
import { pagePathOf } from './page-snapshot';

export const TARGET_SCRIPT_LIMITS = {
  /** Elements one script looks at for ancestry, candidates or rules, at most. */
  visit: 20_000,
  /** Style rules looked at, at most. */
  rules: 5_000,
  /** The script stops looking after this long. */
  budgetMs: 300,
} as const;

/** Shared helpers of the scripts (a function body prefix; no free variables beyond the world's DOM globals). */
function helpers(): string {
  const L = JSON.stringify({ ...TARGET_SCRIPT_LIMITS, ...ANNOTATION_LIMITS });
  return `
  const L = ${L};
  const started = performance.now();
  let visited = 0;
  const spent = () => (visited += 1) > L.visit || performance.now() - started > L.budgetMs;
  const FLAT = new Set(['html', 'head', 'body', 'tbody']);
  const SKIP_TEXT = new Set(['script', 'style', 'template', 'noscript']);
  const clip = (s, n) => {
    const flat = String(s || '').replace(/\\s+/g, ' ').trim();
    return flat.length > n ? flat.slice(0, n) + '…' : flat;
  };
  const textOf = (el) => {
    let out = '';
    let nodes = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === 1 ? (SKIP_TEXT.has(n.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT,
    });
    while (out.length < L.textChars * 2 && nodes < 200 && walker.nextNode()) {
      nodes += 1;
      out += ' ' + String(walker.currentNode.nodeValue || '').slice(0, L.textChars * 2);
    }
    return clip(out, L.textChars);
  };
  const pathOf = (el) => {
    const path = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const parent = n.parentElement;
      if (!parent || path.length >= L.pathDepth) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, n));
      n = parent;
    }
    return n === document.documentElement ? path : null;
  };
  const effKids = (node, out) => {
    for (const child of node.children) {
      if (spent()) return false;
      if (FLAT.has(child.localName)) {
        if (!effKids(child, out)) return false;
      } else out.push(child);
    }
    return true;
  };
  const ancestryOf = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) if (!FLAT.has(n.localName)) chain.unshift(n);
    if (chain.length > L.pathDepth) return [];
    const steps = [];
    for (const n of chain) {
      let parent = n.parentElement;
      while (parent && FLAT.has(parent.localName)) parent = parent.parentElement;
      const kids = [];
      if (!effKids(parent || document.documentElement, kids)) return [];
      let nth = 0;
      for (const k of kids) {
        if (k.localName === n.localName) nth += 1;
        if (k === n) break;
      }
      steps.push({ tag: n.localName, nth });
    }
    return steps;
  };
  const uniqueId = (el) => {
    const id = el.getAttribute('id');
    if (!id) return null;
    try {
      return document.querySelectorAll('#' + CSS.escape(id)).length === 1 ? '#' + CSS.escape(id) : null;
    } catch {
      return null;
    }
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let n = el; n && n.localName !== 'html' && n.localName !== 'body'; n = n.parentElement) {
      const id = uniqueId(n);
      if (id) {
        parts.unshift(n.localName + id);
        break;
      }
      let k = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName) k += 1;
      parts.unshift(n.localName + ':nth-of-type(' + k + ')');
      if (parts.length >= 12) break;
    }
    return parts.join(' > ').slice(0, L.selectorChars);
  };
  `;
}

/**
 * Describes `this` (an element). Used with `Runtime.callFunctionOn` on an object of the isolated world. Returns null
 * for a node that is not an element of the main document.
 */
export function describeFunction(): string {
  return `function () {
  ${helpers()}
  const el = this;
  if (!el || el.nodeType !== 1 || el.ownerDocument !== document) return null;
  const rect = el.getBoundingClientRect();
  const round = (v) => Math.round(v * 10) / 10;
  const rules = [];
  const styleEls = Array.prototype.slice.call(document.querySelectorAll('style'));
  let looked = 0;
  // Every rule is counted (its occurrence must agree with the file, where @media blocks are searched too); only
  // rules of blocks that apply now are matched.
  const visitRules = (list, sheetRef, counts, active) => {
    for (const rule of list) {
      if (rules.length >= L.rules || (looked += 1) > ${TARGET_SCRIPT_LIMITS.rules} || performance.now() - started > L.budgetMs) return;
      if (rule.selectorText !== undefined && rule.style) {
        const sel = String(rule.selectorText);
        counts[sel] = (counts[sel] || 0) + 1;
        let hit = false;
        if (active) {
          try { hit = el.matches(sel); } catch { hit = false; }
        }
        if (hit && sel.length <= L.ruleSelectorChars) rules.push({ ...sheetRef, selector: sel, occurrence: counts[sel] });
        if (rule.cssRules && rule.cssRules.length) visitRules(rule.cssRules, sheetRef, counts, active);
      } else if (rule.cssRules) {
        const applies = !(rule.media && rule.media.mediaText && !matchMedia(rule.media.mediaText).matches);
        visitRules(rule.cssRules, sheetRef, counts, active && applies);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    if (!list || sheet.disabled) continue;
    const owner = sheet.ownerNode;
    const ref = owner && owner.localName === 'style'
      ? { styleIndex: styleEls.indexOf(owner) }
      : sheet.href ? { href: String(sheet.href) } : null;
    if (!ref || ref.styleIndex === -1) continue;
    visitRules(list, ref, {}, true);
  }
  const classes = Array.prototype.slice.call(el.classList, 0, L.classes).map((c) => String(c).slice(0, L.classChars));
  const id = el.getAttribute('id');
  return {
    tag: el.localName,
    id: id ? id.slice(0, L.idChars) : undefined,
    classes,
    text: textOf(el),
    selector: selectorOf(el),
    path: pathOf(el),
    ancestry: ancestryOf(el),
    rect: { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) },
    viewport: { width: innerWidth, height: innerHeight },
    rules,
  };
}`;
}

/** Finds the element at a child-index path (an expression evaluated in the isolated world; returns it or null). */
export function elementAtPathExpression(path: readonly number[]): string {
  const safe = path.filter((n) => Number.isInteger(n) && n >= 0 && n < 1_000_000).slice(0, ANNOTATION_LIMITS.pathDepth);
  return `(() => {
  let n = document.documentElement;
  for (const i of ${JSON.stringify(safe)}) {
    n = n && n.children[i];
  }
  return n || null;
})()`;
}

/**
 * The smallest element that contains a rectangle given as fractions of the viewport: the common ancestor of the
 * elements under its corners and centre (an expression evaluated in the isolated world).
 */
export function elementInRegionExpression(region: AnnotationRect): string {
  const r = JSON.stringify(region);
  return `(() => {
  const f = ${r};
  const x = f.x * innerWidth, y = f.y * innerHeight, w = f.width * innerWidth, h = f.height * innerHeight;
  const inset = (v, size) => Math.min(Math.max(v, 1), Math.max(1, size - 1));
  const points = [[x + 1, y + 1], [x + w - 1, y + 1], [x + 1, y + h - 1], [x + w - 1, y + h - 1], [x + w / 2, y + h / 2]];
  const hits = points
    .map(([px, py]) => document.elementFromPoint(inset(px, innerWidth), inset(py, innerHeight)))
    .filter(Boolean);
  if (hits.length === 0) return null;
  let common = hits[0];
  while (common && !hits.every((h) => common.contains(h))) common = common.parentElement;
  return common || hits[hits.length - 1];
})()`;
}

/** Notable elements for the keyboard list: landmarks, headings, buttons, links, fields, images, elements with an id. */
export function candidatesExpression(): string {
  return `(() => {
  ${helpers()}
  const LAND = new Set(['header', 'nav', 'main', 'footer', 'section', 'article', 'aside', 'form', 'ul', 'ol', 'table', 'p']);
  const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head', 'iframe', 'object', 'svg', 'math']);
  const items = [];
  let truncated = false;
  const root = document.body || document.documentElement;
  let el = root;
  let seen = 0;
  while (el) {
    seen += 1;
    if (seen > L.visit || items.length >= L.candidates || performance.now() - started > L.budgetMs) {
      truncated = true;
      break;
    }
    const tag = el.localName;
    const id = el.getAttribute('id');
    let label = null;
    if (/^h[1-6]$/.test(tag) || tag === 'button' || (tag === 'a' && el.hasAttribute('href')) || tag === 'label' || tag === 'li' || el.getAttribute('role') === 'button') {
      label = tag + (id ? '#' + id : '') + ' "' + textOf(el) + '"';
    } else if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const name = el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('type') || '';
      label = tag + (id ? '#' + id : '') + (name ? ' ' + clip(name, 60) : '');
    } else if (tag === 'img') {
      label = 'img' + (id ? '#' + id : '') + ' alt="' + clip(el.getAttribute('alt'), 60) + '"';
    } else if (LAND.has(tag) || id) {
      const text = textOf(el);
      label = tag + (id ? '#' + id : '') + (el.classList.length ? '.' + Array.prototype.slice.call(el.classList, 0, 3).join('.') : '') + (text ? ' "' + clip(text, 40) + '"' : '');
    }
    if (label) {
      const path = pathOf(el);
      if (path) items.push({ path, label: clip(label, L.candidateLabelChars) });
    }
    let next = SKIP.has(tag) ? null : el.firstElementChild;
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

function clipText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const finite = (v: unknown, max = 1e7) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-max, Math.min(max, v)) : 0); // prettier-ignore

function parseRect(v: unknown): AnnotationRect {
  const r = isRecord(v) ? v : {};
  return { x: finite(r.x), y: finite(r.y), width: Math.max(0, finite(r.width)), height: Math.max(0, finite(r.height)) };
}

function parsePath(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length > ANNOTATION_LIMITS.pathDepth) return null;
  return v.every((n) => Number.isInteger(n) && n >= 0 && n < 1_000_000) ? (v as number[]) : null;
}

const TAG = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Validates and caps what {@link describeFunction} returned (main never trusts a renderer's answer). Style sheets
 * that are not on the preview's origin are dropped; the others become project paths.
 */
export function parseTarget(
  value: unknown,
  context: { readonly origin: string; readonly pagePath: string; readonly kind: 'element' | 'region'; readonly region?: AnnotationRect }, // prettier-ignore
): AnnotationTarget | null {
  if (!isRecord(value) || typeof value.tag !== 'string' || !TAG.test(value.tag)) return null;
  const path = parsePath(value.path);
  if (!path) return null;
  // One step that does not fit (a custom tag like <my_widget>, SVG's foreignObject) makes the whole ancestry unusable:
  // a shorter chain could lead to another element. Without it the source is matched approximately (id, classes).
  const steps = Array.isArray(value.ancestry) ? value.ancestry : [];
  const validStep = (s: unknown): s is { tag: string; nth: number } =>
    isRecord(s) && typeof s.tag === 'string' && TAG.test(s.tag) && Number.isInteger(s.nth) && (s.nth as number) >= 1;
  const ancestry =
    steps.length <= ANNOTATION_LIMITS.pathDepth && steps.every(validStep)
      ? steps.map((s) => ({ tag: s.tag, nth: s.nth }))
      : [];
  const classes = Array.isArray(value.classes)
    ? value.classes
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .slice(0, ANNOTATION_LIMITS.classes)
        .map((c) => c.slice(0, ANNOTATION_LIMITS.classChars))
    : [];
  const rules: AnnotationCssRule[] = [];
  if (Array.isArray(value.rules)) {
    for (const raw of value.rules.slice(0, ANNOTATION_LIMITS.rules)) {
      if (!isRecord(raw) || typeof raw.selector !== 'string' || !raw.selector.trim()) continue;
      if (raw.selector.length > ANNOTATION_LIMITS.ruleSelectorChars) continue;
      const occurrence = Number.isInteger(raw.occurrence) && (raw.occurrence as number) >= 1 ? (raw.occurrence as number) : 1; // prettier-ignore
      if (typeof raw.href === 'string') {
        const file = pagePathOf(raw.href, context.origin);
        if (!file || file.endsWith('…')) continue;
        rules.push({ sheet: { kind: 'file', path: file }, selector: raw.selector, occurrence });
      } else if (Number.isInteger(raw.styleIndex) && (raw.styleIndex as number) >= 0) {
        rules.push({ sheet: { kind: 'style', index: raw.styleIndex as number }, selector: raw.selector, occurrence });
      }
    }
  }
  const id = clipText(value.id, ANNOTATION_LIMITS.idChars);
  const viewport = isRecord(value.viewport) ? value.viewport : {};
  return {
    kind: context.kind,
    pagePath: context.pagePath.slice(0, ANNOTATION_LIMITS.pagePathChars),
    tag: value.tag,
    ...(id ? { id } : {}),
    classes,
    text: clipText(value.text, ANNOTATION_LIMITS.textChars),
    selector: clipText(value.selector, ANNOTATION_LIMITS.selectorChars) || value.tag,
    path,
    ancestry,
    rect: parseRect(value.rect),
    viewport: { width: Math.max(0, finite(viewport.width, 1e5)), height: Math.max(0, finite(viewport.height, 1e5)) },
    ...(context.region ? { region: context.region } : {}),
    rules,
  };
}

export function parseCandidates(value: unknown): AnnotationCandidates | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = [];
  for (const raw of value.items.slice(0, ANNOTATION_LIMITS.candidates)) {
    if (!isRecord(raw)) continue;
    const path = parsePath(raw.path);
    const label = clipText(raw.label, ANNOTATION_LIMITS.candidateLabelChars);
    if (path && label) items.push({ path, label });
  }
  return { items, truncated: value.truncated === true || value.items.length > ANNOTATION_LIMITS.candidates };
}

/** A region given as fractions of the viewport, clamped to it; null when it is empty. */
export function clampRegion(r: AnnotationRect): AnnotationRect | null {
  const x = Math.min(Math.max(r.x, 0), 1);
  const y = Math.min(Math.max(r.y, 0), 1);
  const width = Math.min(Math.max(r.width, 0), 1 - x);
  const height = Math.min(Math.max(r.height, 0), 1 - y);
  return width > 0.001 && height > 0.001 ? { x, y, width, height } : null;
}
