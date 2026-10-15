import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotationPick, AnnotationTarget } from '../../shared/ipc/annotations-contract';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import {
  INITIAL_ANNOTATIONS,
  KEY_STEP_FRACTION,
  annotationsOnPage,
  annotationsReducer,
  canSave,
  coversStage,
  dragRect,
  errorNotice,
  initialKeyboardRect,
  pagePathOf,
  regionFractions,
  regionKey,
  regionUsable,
  sourceSummary,
  stateWordKey,
  statusKey,
  targetSummary,
  toImagePoint,
  type AnnotationsAction,
  type AnnotationsState,
} from './annotations-model';

const tr = (locale: Locale) => (key: MessageKey) => translate(locale, key);
const zh = tr('zh-CN');
const en = tr('en');

const TARGET: AnnotationTarget = {
  kind: 'element',
  pagePath: '',
  tag: 'BUTTON',
  id: 'send',
  classes: ['primary'],
  text: '  发送 ',
  selector: '#send',
  path: [1, 0, 2],
  ancestry: [{ tag: 'button', nth: 1 }],
  rect: { x: 10, y: 20, width: 80, height: 30 },
  viewport: { width: 800, height: 600 },
  rules: [],
};

const SOURCE: Annotation['source'] = {
  state: 'found',
  html: { relPath: 'index.html', startLine: 14, endLine: 14, match: 'exact' },
  css: [{ relPath: 'css/style.css', startLine: 20, endLine: 24, match: 'exact', selector: '#send' }],
};

const annotation = (id: string, pagePath = '', note = '变大'): Annotation => ({
  id,
  note,
  createdAt: 1,
  updatedAt: 1,
  target: { ...TARGET, pagePath },
  source: SOURCE,
});

const { id: _id, ...NO_ID } = TARGET;

const PICK: AnnotationPick = { pickId: 'p-1', target: TARGET, source: SOURCE };

const run = (actions: AnnotationsAction[], from: AnnotationsState = INITIAL_ANNOTATIONS) =>
  actions.reduce(annotationsReducer, from);

describe('formatting (S41.5)', () => {
  it('summarises an element target as tag#id "text"', () => {
    expect(targetSummary(TARGET, zh)).toBe('button#send "发送"');
    expect(targetSummary({ ...NO_ID, text: '' }, zh)).toBe('button.primary');
  });

  it('summarises a region with its size and the element that contains it', () => {
    const region: AnnotationTarget = {
      ...NO_ID,
      kind: 'region',
      tag: 'div',
      classes: ['card', 'big', 'third'],
      text: '',
      region: { x: 5, y: 5, width: 119.6, height: 40.2 },
    };
    expect(targetSummary(region, zh)).toBe('区域 120×40 → div.card.big');
    expect(targetSummary(region, en)).toBe('Region 120×40 → div.card.big');
  });

  it('cuts long page text', () => {
    const summary = targetSummary({ ...TARGET, text: 'x'.repeat(100) }, en);
    expect(summary.length).toBeLessThan(60);
    expect(summary.endsWith('…"')).toBe(true);
  });

  it('summarises the source with file names and lines in both languages', () => {
    expect(sourceSummary(SOURCE, zh)).toBe('index.html 第 14 行 · style.css 第 20–24 行');
    expect(sourceSummary(SOURCE, en)).toBe('index.html line 14 · style.css lines 20–24');
    expect(sourceSummary({ state: 'not-found', html: null, css: [] }, en)).toBe('');
    const many = { ...SOURCE, css: [SOURCE.css[0]!, SOURCE.css[0]!, SOURCE.css[0]!, SOURCE.css[0]!] };
    expect(sourceSummary(many, en)).toMatch(/· 2 more$/);
  });

  it('has a word for every source state', () => {
    expect(zh(stateWordKey('found'))).toBe('已找到');
    expect(en(stateWordKey('approximate'))).toBe('Approximate');
    expect(en(stateWordKey('not-found'))).toBe('Not found in the code');
    expect(en(stateWordKey('no-file'))).toBe('Page file missing');
  });

  it('maps API errors to notices (a cancelled pick is silent)', () => {
    expect(errorNotice('cancelled')).toBeNull();
    expect(errorNotice('not-running')).toBe('annotations.error.notRunning');
    expect(errorNotice('too-many')).toBe('annotations.error.tooMany');
    expect(errorNotice('forbidden-sender')).toBe('annotations.error.generic');
  });
});

describe('pages', () => {
  it('reads the page path from the preview URL', () => {
    expect(pagePathOf('http://127.0.0.1:5000/')).toBe('');
    expect(pagePathOf('http://127.0.0.1:5000/docs/%E5%85%B3%E4%BA%8E%20we.html?x=1')).toBe('docs/关于 we.html');
    expect(pagePathOf(undefined)).toBeNull();
    expect(pagePathOf('not a url')).toBeNull();
  });

  it('treats a folder and its index.html as the same page', () => {
    const items = [annotation('a', ''), annotation('b', 'about.html'), annotation('c', 'index.html')];
    expect(annotationsOnPage(items, '').map((i) => i.id)).toEqual(['a', 'c']);
    expect(annotationsOnPage(items, 'about.html').map((i) => i.id)).toEqual(['b']);
    expect(annotationsOnPage(items, null)).toHaveLength(3);
  });
});

describe('region drawing math', () => {
  const size = { width: 800, height: 600 };

  it('normalises a drag in any direction and clamps it to the picture', () => {
    expect(dragRect({ x: 300, y: 200 }, { x: 100, y: 50 }, size)).toEqual({ x: 100, y: 50, width: 200, height: 150 });
    expect(dragRect({ x: -20, y: 500 }, { x: 900, y: 700 }, size)).toEqual({ x: 0, y: 500, width: 800, height: 100 });
  });

  it('converts displayed coordinates to picture pixels', () => {
    const box = { x: 10, y: 20, width: 400, height: 300 }; // shown at half size
    expect(toImagePoint({ x: 210, y: 170 }, box, size)).toEqual({ x: 400, y: 300 });
    expect(toImagePoint({ x: 0, y: 1000 }, box, size)).toEqual({ x: 0, y: 600 });
  });

  it('gives fractions of the viewport (0..1)', () => {
    expect(regionFractions({ x: 200, y: 150, width: 400, height: 300 }, size)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
    const f = regionFractions({ x: 790, y: 590, width: 100, height: 100 }, size);
    expect(f.x + f.width).toBeLessThanOrEqual(1);
    expect(f.y + f.height).toBeLessThanOrEqual(1);
  });

  it('a click is not a region', () => {
    expect(regionUsable(dragRect({ x: 5, y: 5 }, { x: 6, y: 6 }, size))).toBe(false);
    expect(regionUsable(null)).toBe(false);
  });

  it('keyboard: the first arrow shows a box, arrows move it, Shift+arrows resize it, all clamped', () => {
    const first = regionKey(null, 'ArrowRight', false, size);
    expect(first).toEqual({ kind: 'rect', rect: initialKeyboardRect(size) });
    const start = initialKeyboardRect(size);
    const step = size.width * KEY_STEP_FRACTION; // 16
    expect(regionKey(start, 'ArrowRight', false, size)).toEqual({ kind: 'rect', rect: { ...start, x: 200 + step } });
    expect(regionKey(start, 'ArrowDown', true, size)).toEqual({
      kind: 'rect',
      rect: { ...start, height: 300 + size.height * KEY_STEP_FRACTION },
    });
    // Clamped at the edges.
    const corner = { x: 0, y: 0, width: 100, height: 100 };
    expect(regionKey(corner, 'ArrowLeft', false, size)).toEqual({ kind: 'rect', rect: corner });
    const full = { x: 0, y: 0, width: 800, height: 600 };
    expect(regionKey(full, 'ArrowRight', true, size)).toEqual({ kind: 'rect', rect: full });
    const tiny = { x: 0, y: 0, width: 5, height: 5 };
    const shrunk = regionKey(tiny, 'ArrowLeft', true, size);
    expect(shrunk?.kind === 'rect' && shrunk.rect.width).toBe(4);
  });

  it('keyboard: Enter confirms only a usable region, Esc cancels, other keys are ignored', () => {
    expect(regionKey({ x: 0, y: 0, width: 50, height: 50 }, 'Enter', false, size)).toEqual({ kind: 'confirm' });
    expect(regionKey(null, 'Enter', false, size)).toBeNull();
    expect(regionKey(null, 'Escape', false, size)).toEqual({ kind: 'cancel' });
    expect(regionKey(null, 'a', false, size)).toBeNull();
  });
});

describe('reducer', () => {
  it('starts from the list of the project and resets on project change (keeping view choices)', () => {
    let s = run([
      { type: 'project', projectId: 'p1' },
      { type: 'listed', items: [annotation('a')] },
    ]);
    expect(s.loaded).toBe(true);
    s = run(
      [
        { type: 'scope', scope: 'all' },
        { type: 'project', projectId: 'p2' },
      ],
      s,
    );
    expect(s.items).toEqual([]);
    expect(s.loaded).toBe(false);
    expect(s.scope).toBe('all');
  });

  it('page pick: picking → naming → saved, with an announced status', () => {
    let s = run([{ type: 'menu', open: true }, { type: 'picking' }]);
    expect(s.menuOpen).toBe(false);
    expect(statusKey(s.mode)).toBe('annotations.status.picking');
    s = run([{ type: 'picked', pick: PICK }], s);
    expect(s.mode.kind).toBe('naming');
    expect(canSave(s)).toBe(false);
    s = run([{ type: 'draft', text: '  把它变大  ' }], s);
    expect(canSave(s)).toBe(true);
    s = run([{ type: 'saving' }], s);
    expect(canSave(s)).toBe(false);
    s = run([{ type: 'saved', annotation: annotation('new') }], s);
    expect(s.mode.kind).toBe('idle');
    expect(s.draft).toBe('');
    expect(s.items.map((i) => i.id)).toEqual(['new']);
  });

  it('a failed save keeps the note; an expired pick goes back to idle', () => {
    const naming = run([
      { type: 'picking' },
      { type: 'picked', pick: PICK },
      { type: 'draft', text: '备注' },
      { type: 'saving' },
    ]);
    const failed = run([{ type: 'failed', code: 'write-failed' }], naming);
    expect(failed.mode).toEqual({ kind: 'naming', pick: PICK, saving: false });
    expect(failed.draft).toBe('备注');
    expect(failed.notice).toBe('annotations.error.writeFailed');
    const expired = run([{ type: 'failed', code: 'expired' }], naming);
    expect(expired.mode.kind).toBe('idle');
    expect(expired.notice).toBe('annotations.error.expired');
  });

  it('a cancelled pick returns to idle without a notice; a late pick is dropped', () => {
    const s = run([{ type: 'picking' }, { type: 'failed', code: 'cancelled' }]);
    expect(s.mode.kind).toBe('idle');
    expect(s.notice).toBeNull();
    expect(run([{ type: 'loading' }, { type: 'cancel' }, { type: 'picked', pick: PICK }]).mode.kind).toBe('idle');
  });

  it('list choice: candidates, keyboard moves (clamped)', () => {
    const items = [
      { path: [0], label: 'h1 "你好"' },
      { path: [1], label: 'button "发送"' },
    ];
    let s = run([{ type: 'loading' }, { type: 'candidates', items, truncated: false }]);
    expect(s.mode).toMatchObject({ kind: 'choosing', active: 0 });
    s = run(
      [
        { type: 'move', to: 'next' },
        { type: 'move', to: 'next' },
      ],
      s,
    );
    expect(s.mode).toMatchObject({ active: 1 });
    s = run(
      [
        { type: 'move', to: 'first' },
        { type: 'move', to: 'previous' },
      ],
      s,
    );
    expect(s.mode).toMatchObject({ active: 0 });
    // Candidates that arrive after a cancel are ignored.
    expect(run([{ type: 'cancel' }, { type: 'candidates', items, truncated: false }], s).mode.kind).toBe('idle');
  });

  it('region: the picture covers the stage; drag and keys draw; Esc cancels', () => {
    const shot = { dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 600 };
    let s = run([{ type: 'loading' }, { type: 'shot', shot }]);
    expect(coversStage(s.mode)).toBe(true);
    s = run(
      [
        { type: 'drag-start', at: { x: 100, y: 100 } },
        { type: 'drag-move', at: { x: 150, y: 120 } },
        { type: 'drag-end', at: { x: 220, y: 140 } },
      ],
      s,
    );
    expect(s.mode).toMatchObject({ rect: { x: 100, y: 100, width: 120, height: 40 }, dragFrom: null });
    s = run([{ type: 'region-key', key: 'ArrowRight', shift: false }], s);
    expect(s.mode).toMatchObject({ rect: { x: 116 } });
    s = run([{ type: 'region-key', key: 'Escape', shift: false }], s);
    expect(s.mode.kind).toBe('idle');
    expect(coversStage(s.mode)).toBe(false);
  });

  it('edit and delete', () => {
    let s = run([
      { type: 'listed', items: [annotation('a'), annotation('b')] },
      { type: 'edit-start', id: 'a' },
    ]);
    expect(s.editing).toEqual({ id: 'a', text: '变大', saving: false });
    s = run([{ type: 'edit-text', text: '更大' }, { type: 'edit-saving' }], s);
    s = run([{ type: 'updated', annotation: annotation('a', '', '更大') }], s);
    expect(s.editing).toBeNull();
    expect(s.items[0]?.note).toBe('更大');
    s = run([{ type: 'confirm-delete', id: 'b' }], s);
    expect(s.confirmDelete).toBe('b');
    s = run([{ type: 'removed', id: 'b' }], s);
    expect(s.items.map((i) => i.id)).toEqual(['a']);
    expect(s.confirmDelete).toBeNull();
  });

  it('notes are cut at the limit', () => {
    const s = run([{ type: 'draft', text: 'x'.repeat(5000) }]);
    expect(s.draft.length).toBe(2000);
  });
});
