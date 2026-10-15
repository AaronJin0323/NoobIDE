/**
 * Pure state of the preview annotations strip (S41.5, decision 0030 "Drawing a region", "Showing and editing"):
 * the list, the ways of picking a target, the draft note, notices, the text shown for a target and its source, and
 * the region-drawing math. AnnotationsStrip.tsx applies it; everything here is unit-tested.
 *
 * Page-provided text (target text, candidate labels) only ever leaves this module as plain strings; the component
 * renders them as text, never as HTML.
 */
import {
  ANNOTATION_LIMITS,
  type Annotation,
  type AnnotationCandidate,
  type AnnotationPick,
  type AnnotationPickError,
  type AnnotationRegionShot,
  type AnnotationSource,
  type AnnotationSourceState,
  type AnnotationStoreError,
  type AnnotationTarget,
} from '../../shared/ipc/annotations-contract';
import type { RequestError } from '../../shared/ipc/contract';
import type { MessageKey } from '../i18n/index';

export type Translate = (key: MessageKey) => string;

/** Replaces `{name}` placeholders of a message. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

// ── Region drawing ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Rect extends Point, Size {}

/** Smallest region (image pixels) that can be confirmed: a plain click is not a region. */
export const MIN_REGION = 4;
/** Keyboard step: 2% of the picture per key press. */
export const KEY_STEP_FRACTION = 0.02;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The rectangle spanned by a drag (any direction), clamped to the picture. */
export function dragRect(start: Point, end: Point, size: Size): Rect {
  const x1 = clamp(Math.min(start.x, end.x), 0, size.width);
  const y1 = clamp(Math.min(start.y, end.y), 0, size.height);
  const x2 = clamp(Math.max(start.x, end.x), 0, size.width);
  const y2 = clamp(Math.max(start.y, end.y), 0, size.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Converts a point on the displayed picture (CSS pixels of its box) to picture pixels. */
export function toImagePoint(client: Point, box: Rect, size: Size): Point {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp(((client.x - box.x) * size.width) / box.width, 0, size.width),
    y: clamp(((client.y - box.y) * size.height) / box.height, 0, size.height),
  };
}

export function regionUsable(rect: Rect | null): rect is Rect {
  return rect !== null && rect.width >= MIN_REGION && rect.height >= MIN_REGION;
}

/** The region as fractions (0..1) of the viewport, for `resolve({ how: { kind: 'region', … } })`. */
export function regionFractions(rect: Rect, size: Size): Rect {
  const w = size.width > 0 ? size.width : 1;
  const h = size.height > 0 ? size.height : 1;
  const x = clamp(rect.x / w, 0, 1);
  const y = clamp(rect.y / h, 0, 1);
  return {
    x,
    y,
    width: clamp(rect.width / w, 0, 1 - x),
    height: clamp(rect.height / h, 0, 1 - y),
  };
}

/** The rectangle a keyboard user starts from: the middle quarter of the picture. */
export function initialKeyboardRect(size: Size): Rect {
  return { x: size.width / 4, y: size.height / 4, width: size.width / 2, height: size.height / 2 };
}

export type RegionKeyResult =
  { readonly kind: 'rect'; readonly rect: Rect } | { readonly kind: 'confirm' } | { readonly kind: 'cancel' } | null;

/**
 * A key press on the drawing canvas: arrows move the rectangle, Shift+arrows resize it (right/down grow, left/up
 * shrink), Enter confirms a usable region, Esc cancels. Everything stays inside the picture. null: not handled.
 */
export function regionKey(rect: Rect | null, key: string, shift: boolean, size: Size): RegionKeyResult {
  if (key === 'Escape') return { kind: 'cancel' };
  if (key === 'Enter') return regionUsable(rect) ? { kind: 'confirm' } : null;
  const dirs: Record<string, Point> = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
  };
  const dir = dirs[key];
  if (!dir) return null;
  const current = rect ?? initialKeyboardRect(size);
  const stepX = Math.max(1, size.width * KEY_STEP_FRACTION);
  const stepY = Math.max(1, size.height * KEY_STEP_FRACTION);
  if (rect === null) return { kind: 'rect', rect: current };
  if (shift) {
    const minW = Math.min(MIN_REGION, size.width);
    const minH = Math.min(MIN_REGION, size.height);
    const width = clamp(current.width + dir.x * stepX, minW, size.width - current.x);
    const height = clamp(current.height + dir.y * stepY, minH, size.height - current.y);
    return { kind: 'rect', rect: { ...current, width, height } };
  }
  const x = clamp(current.x + dir.x * stepX, 0, Math.max(0, size.width - current.width));
  const y = clamp(current.y + dir.y * stepY, 0, Math.max(0, size.height - current.height));
  return { kind: 'rect', rect: { ...current, x, y } };
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────────────────────────────

const TEXT_SHOWN = 40;

function shortText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > TEXT_SHOWN ? `${collapsed.slice(0, TEXT_SHOWN - 1)}…` : collapsed;
}

/** `button#send`, `div.card.big` — the element's tag with its id, else up to two classes. */
export function elementName(target: Pick<AnnotationTarget, 'tag' | 'id' | 'classes'>): string {
  const tag = target.tag.toLowerCase();
  if (target.id) return `${tag}#${target.id}`;
  return [tag, ...target.classes.slice(0, 2)].join('.');
}

/** `button#send "发送"`; a region: `区域 120×40 → div.card`. Plain text (page data), never HTML. */
export function targetSummary(target: AnnotationTarget, t: Translate): string {
  const text = shortText(target.text);
  const element = text ? `${elementName(target)} "${text}"` : elementName(target);
  if (target.kind === 'region' && target.region) {
    const region = fill(t('annotations.region'), {
      width: Math.round(target.region.width),
      height: Math.round(target.region.height),
    });
    return `${region} → ${element}`;
  }
  return element;
}

function locationText(t: Translate, relPath: string, startLine: number, endLine: number): string {
  const file = relPath.split('/').pop() ?? relPath;
  return startLine === endLine
    ? fill(t('annotations.source.line'), { file, line: startLine })
    : fill(t('annotations.source.lines'), { file, start: startLine, end: endLine });
}

const CSS_SHOWN = 2;

/** `index.html 第 14 行 · style.css 第 20–24 行` / `index.html line 14 · style.css lines 20–24`; '' when nothing. */
export function sourceSummary(source: AnnotationSource, t: Translate): string {
  const parts: string[] = [];
  if (source.html) parts.push(locationText(t, source.html.relPath, source.html.startLine, source.html.endLine));
  for (const css of source.css.slice(0, CSS_SHOWN))
    parts.push(locationText(t, css.relPath, css.startLine, css.endLine));
  if (source.css.length > CSS_SHOWN) {
    parts.push(fill(t('annotations.source.more'), { count: source.css.length - CSS_SHOWN }));
  }
  return parts.join(' · ');
}

/** The word for the source state (always shown next to its icon: never colour alone). */
export function stateWordKey(state: AnnotationSourceState): MessageKey {
  switch (state) {
    case 'found':
      return 'annotations.state.found';
    case 'approximate':
      return 'annotations.state.approximate';
    case 'not-found':
      return 'annotations.state.notFound';
    case 'no-file':
      return 'annotations.state.noFile';
  }
}

export function stateDetailKey(state: AnnotationSourceState): MessageKey | null {
  if (state === 'not-found') return 'annotations.state.notFound.detail';
  if (state === 'no-file') return 'annotations.state.noFile.detail';
  return null;
}

// ── Pages ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The page path of a preview URL (`http://127.0.0.1:5173/about.html` → `about.html`; `/` → ''). */
export function pagePathOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

/** '' and 'docs/' mean the folder's index page: compare them as 'index.html' / 'docs/index.html'. */
function samePage(a: string, b: string): boolean {
  const norm = (p: string) => (p === '' || p.endsWith('/') ? `${p}index.html` : p);
  return norm(a) === norm(b);
}

export function annotationsOnPage(items: readonly Annotation[], pagePath: string | null): readonly Annotation[] {
  if (pagePath === null) return items;
  return items.filter((item) => samePage(item.target.pagePath, pagePath));
}

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type AnnotationsErrorCode = AnnotationPickError | AnnotationStoreError | RequestError;

/** The notice for an API error; null for a cancelled pick (the user asked for it). */
export function errorNotice(code: AnnotationsErrorCode): MessageKey | null {
  switch (code) {
    case 'cancelled':
      return null;
    case 'not-running':
      return 'annotations.error.notRunning';
    case 'not-owner':
      return 'annotations.error.notOwner';
    case 'not-available':
      return 'annotations.error.notAvailable';
    case 'busy':
      return 'annotations.error.busy';
    case 'unknown-project':
      return 'annotations.error.unknownProject';
    case 'not-found':
      return 'annotations.error.notFound';
    case 'too-many':
      return 'annotations.error.tooMany';
    case 'write-failed':
      return 'annotations.error.writeFailed';
    case 'expired':
      return 'annotations.error.expired';
    default:
      return 'annotations.error.generic';
  }
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type PickMode =
  | { readonly kind: 'idle' }
  /** Waiting for main (candidates, picture of the page, resolving a choice). */
  | { readonly kind: 'loading' }
  | { readonly kind: 'picking' }
  | {
      readonly kind: 'choosing';
      readonly items: readonly AnnotationCandidate[];
      readonly truncated: boolean;
      readonly active: number;
    }
  | {
      readonly kind: 'drawing';
      readonly shot: AnnotationRegionShot;
      readonly rect: Rect | null;
      /** Where a mouse drag started (picture pixels), while it lasts. */
      readonly dragFrom: Point | null;
    }
  | { readonly kind: 'naming'; readonly pick: AnnotationPick; readonly saving: boolean };

export type Scope = 'page' | 'all';

export interface AnnotationsState {
  readonly projectId: string | null;
  readonly items: readonly Annotation[];
  readonly loaded: boolean;
  readonly expanded: boolean;
  readonly scope: Scope;
  readonly menuOpen: boolean;
  readonly mode: PickMode;
  readonly draft: string;
  readonly editing: { readonly id: string; readonly text: string; readonly saving: boolean } | null;
  readonly confirmDelete: string | null;
  readonly notice: MessageKey | null;
}

export const INITIAL_ANNOTATIONS: AnnotationsState = {
  projectId: null,
  items: [],
  loaded: false,
  expanded: true,
  scope: 'page',
  menuOpen: false,
  mode: { kind: 'idle' },
  draft: '',
  editing: null,
  confirmDelete: null,
  notice: null,
};

export type AnnotationsAction =
  | { readonly type: 'project'; readonly projectId: string | null }
  | { readonly type: 'listed'; readonly items: readonly Annotation[] }
  | { readonly type: 'toggle-expanded' }
  | { readonly type: 'scope'; readonly scope: Scope }
  | { readonly type: 'menu'; readonly open: boolean }
  | { readonly type: 'picking' }
  | { readonly type: 'loading' }
  | { readonly type: 'candidates'; readonly items: readonly AnnotationCandidate[]; readonly truncated: boolean }
  | { readonly type: 'move'; readonly to: 'next' | 'previous' | 'first' | 'last' | number }
  | { readonly type: 'shot'; readonly shot: AnnotationRegionShot }
  | { readonly type: 'drag-start'; readonly at: Point }
  | { readonly type: 'drag-move'; readonly at: Point }
  | { readonly type: 'drag-end'; readonly at: Point }
  | { readonly type: 'region-key'; readonly key: string; readonly shift: boolean }
  | { readonly type: 'picked'; readonly pick: AnnotationPick }
  | { readonly type: 'draft'; readonly text: string }
  | { readonly type: 'saving' }
  | { readonly type: 'saved'; readonly annotation: Annotation }
  | { readonly type: 'cancel' }
  | { readonly type: 'failed'; readonly code: AnnotationsErrorCode }
  | { readonly type: 'edit-start'; readonly id: string }
  | { readonly type: 'edit-text'; readonly text: string }
  | { readonly type: 'edit-saving' }
  | { readonly type: 'edit-cancel' }
  | { readonly type: 'updated'; readonly annotation: Annotation }
  | { readonly type: 'confirm-delete'; readonly id: string | null }
  | { readonly type: 'removed'; readonly id: string }
  | { readonly type: 'dismiss' };

const IDLE: PickMode = { kind: 'idle' };

function replaceItem(items: readonly Annotation[], annotation: Annotation): readonly Annotation[] {
  return items.some((item) => item.id === annotation.id)
    ? items.map((item) => (item.id === annotation.id ? annotation : item))
    : [...items, annotation];
}

const cutNote = (text: string) => text.slice(0, ANNOTATION_LIMITS.noteChars);

export function annotationsReducer(state: AnnotationsState, action: AnnotationsAction): AnnotationsState {
  const mode = state.mode;
  switch (action.type) {
    case 'project':
      if (action.projectId === state.projectId) return state;
      return { ...INITIAL_ANNOTATIONS, projectId: action.projectId, expanded: state.expanded, scope: state.scope };
    case 'listed':
      return { ...state, items: action.items, loaded: true };
    case 'toggle-expanded':
      return { ...state, expanded: !state.expanded };
    case 'scope':
      return { ...state, scope: action.scope };
    case 'menu':
      return { ...state, menuOpen: action.open && mode.kind === 'idle' };
    case 'picking':
      return { ...state, menuOpen: false, notice: null, mode: { kind: 'picking' } };
    case 'loading':
      return { ...state, menuOpen: false, notice: null, mode: { kind: 'loading' } };
    case 'candidates':
      if (mode.kind !== 'loading') return state;
      return { ...state, mode: { kind: 'choosing', items: action.items, truncated: action.truncated, active: 0 } };
    case 'move': {
      if (mode.kind !== 'choosing' || mode.items.length === 0) return state;
      const last = mode.items.length - 1;
      const to =
        action.to === 'next'
          ? Math.min(last, mode.active + 1)
          : action.to === 'previous'
            ? Math.max(0, mode.active - 1)
            : action.to === 'first'
              ? 0
              : action.to === 'last'
                ? last
                : clamp(action.to, 0, last);
      return { ...state, mode: { ...mode, active: to } };
    }
    case 'shot':
      if (mode.kind !== 'loading') return state;
      return { ...state, mode: { kind: 'drawing', shot: action.shot, rect: null, dragFrom: null } };
    case 'drag-start':
      if (mode.kind !== 'drawing') return state;
      return { ...state, mode: { ...mode, dragFrom: action.at, rect: dragRect(action.at, action.at, mode.shot) } };
    case 'drag-move':
    case 'drag-end':
      if (mode.kind !== 'drawing' || mode.dragFrom === null) return state;
      return {
        ...state,
        mode: {
          ...mode,
          rect: dragRect(mode.dragFrom, action.at, mode.shot),
          dragFrom: action.type === 'drag-end' ? null : mode.dragFrom,
        },
      };
    case 'region-key': {
      if (mode.kind !== 'drawing') return state;
      const result = regionKey(mode.rect, action.key, action.shift, mode.shot);
      if (result?.kind === 'rect') return { ...state, mode: { ...mode, rect: result.rect } };
      if (result?.kind === 'cancel') return { ...state, mode: IDLE };
      return state; // 'confirm' is carried out by the component (it calls resolve).
    }
    case 'picked':
      // A pick that arrives after the user cancelled is dropped.
      if (mode.kind !== 'picking' && mode.kind !== 'loading') return state;
      return { ...state, menuOpen: false, draft: '', mode: { kind: 'naming', pick: action.pick, saving: false } };
    case 'draft':
      return { ...state, draft: cutNote(action.text) };
    case 'saving':
      if (mode.kind !== 'naming') return state;
      return { ...state, mode: { ...mode, saving: true } };
    case 'saved':
      return { ...state, mode: IDLE, draft: '', expanded: true, items: replaceItem(state.items, action.annotation) };
    case 'cancel':
      return { ...state, menuOpen: false, mode: IDLE, draft: '' };
    case 'failed': {
      const notice = errorNotice(action.code);
      // A failed save keeps the note and the pick (the user can try again), unless the pick itself is gone.
      if (mode.kind === 'naming' && action.code !== 'expired' && action.code !== 'unknown-project') {
        return { ...state, notice, mode: { ...mode, saving: false } };
      }
      const editing = state.editing ? { ...state.editing, saving: false } : null;
      const pickFailed = mode.kind !== 'idle';
      return { ...state, notice, editing, mode: pickFailed ? IDLE : mode, draft: pickFailed ? '' : state.draft };
    }
    case 'edit-start': {
      const item = state.items.find((i) => i.id === action.id);
      if (!item) return state;
      return { ...state, confirmDelete: null, editing: { id: item.id, text: item.note, saving: false } };
    }
    case 'edit-text':
      return state.editing ? { ...state, editing: { ...state.editing, text: cutNote(action.text) } } : state;
    case 'edit-saving':
      return state.editing ? { ...state, editing: { ...state.editing, saving: true } } : state;
    case 'edit-cancel':
      return { ...state, editing: null };
    case 'updated':
      return {
        ...state,
        items: replaceItem(state.items, action.annotation),
        editing: state.editing?.id === action.annotation.id ? null : state.editing,
      };
    case 'confirm-delete':
      return { ...state, confirmDelete: action.id, editing: action.id ? null : state.editing };
    case 'removed':
      return {
        ...state,
        items: state.items.filter((item) => item.id !== action.id),
        confirmDelete: state.confirmDelete === action.id ? null : state.confirmDelete,
        editing: state.editing?.id === action.id ? null : state.editing,
      };
    case 'dismiss':
      return { ...state, notice: null };
  }
}

/** The live-region text for the current mode (null: nothing to announce). */
export function statusKey(mode: PickMode): MessageKey | null {
  switch (mode.kind) {
    case 'idle':
      return null;
    case 'loading':
      return 'annotations.status.loading';
    case 'picking':
      return 'annotations.status.picking';
    case 'choosing':
      return 'annotations.status.choosing';
    case 'drawing':
      return 'annotations.status.drawing';
    case 'naming':
      return 'annotations.status.naming';
  }
}

/** True while the frozen picture replaces the native view (it must be hidden, the stage counts as covered). */
export function coversStage(mode: PickMode): boolean {
  return mode.kind === 'drawing';
}

export function canSave(state: AnnotationsState): boolean {
  return state.mode.kind === 'naming' && !state.mode.saving && state.draft.trim().length > 0;
}
