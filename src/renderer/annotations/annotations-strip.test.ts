import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotationTarget } from '../../shared/ipc/annotations-contract';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { AnnotateEntryView, AnnotationsStripView, type AnnotationsStripOps } from './AnnotationsStrip';
import {
  INITIAL_ANNOTATIONS,
  annotateEntry,
  annotationsReducer,
  focusAfter,
  focusStateOf,
  type AnnotationsAction,
  type AnnotationsState,
  type FocusState,
} from './annotations-model';

const noop = () => undefined;
const ops: AnnotationsStripOps = {
  pick: noop,
  candidates: noop,
  region: noop,
  cancel: noop,
  choose: noop,
  confirmRegion: noop,
  save: noop,
  show: noop,
  saveEdit: noop,
  remove: noop,
};

const HOSTILE = '<img src=x onerror=alert(1)>';

const target: AnnotationTarget = {
  kind: 'element',
  pagePath: '',
  tag: 'button',
  id: 'send',
  classes: [],
  text: HOSTILE,
  selector: '#send',
  path: [1, 0],
  ancestry: [],
  rect: { x: 0, y: 0, width: 10, height: 10 },
  viewport: { width: 800, height: 600 },
  rules: [],
};

const item = (id: string, state: Annotation['source']['state']): Annotation => ({
  id,
  note: '把按钮变大',
  createdAt: 1,
  updatedAt: 1,
  target,
  source: {
    state,
    html: state === 'found' ? { relPath: 'index.html', startLine: 14, endLine: 14, match: 'exact' } : null,
    css: [],
  },
});

function render(
  overrides: Partial<AnnotationsState> = {},
  options: { locale?: Locale; askAi?: boolean; running?: boolean } = {},
) {
  const state: AnnotationsState = {
    ...INITIAL_ANNOTATIONS,
    projectId: 'p1',
    loaded: true,
    expanded: true,
    items: [item('a', 'found'), item('b', 'not-found')],
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(AnnotationsStripView, {
      state,
      dispatch: noop,
      ops,
      t: (key: MessageKey) => translate(options.locale ?? 'zh-CN', key),
      running: options.running ?? true,
      pagePath: '',
      onAskAi: options.askAi ? noop : undefined,
    }),
  );
}

function renderEntry(overrides: Partial<AnnotationsState> = {}, options: { locale?: Locale; running?: boolean } = {}) {
  const state: AnnotationsState = {
    ...INITIAL_ANNOTATIONS,
    projectId: 'p1',
    loaded: true,
    items: [item('a', 'found'), item('b', 'not-found')],
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(AnnotateEntryView, {
      state,
      dispatch: noop,
      t: (key: MessageKey) => translate(options.locale ?? 'zh-CN', key),
      running: options.running ?? true,
      pagePath: '',
      ids: { list: 'list-id', ways: 'ways-id' },
      reasonId: 'reason-id',
    }),
  );
}

describe('the Annotate entry in the preview header (key feature, always shown)', () => {
  it('is one primary "Annotate page" button with the count, and one separate "View annotations (N)" toggle', () => {
    const html = renderEntry();
    expect(html.match(/data-testid="annotate-menu"/g)).toHaveLength(1);
    expect(html.match(/data-testid="annotations-toggle"/g)).toHaveLength(1);
    expect(html).toContain('class="annotate-button"');
    expect(html).toMatch(/data-testid="annotate-menu"[^>]*><svg/); // an icon next to the words
    expect(html).toContain('<span>标注页面</span>');
    expect(html).toContain('data-testid="annotations-count"');
    expect(html).toContain('这个页面有 2 条标注');
    expect(html).toContain('查看标注（2）');
    expect(html).toContain('aria-controls="list-id"');
    expect(html).not.toContain('aria-disabled');
    // Exactly two buttons: no second control labelled 标注 for the same purpose.
    expect(html.match(/<button/g)).toHaveLength(2);
    const en = renderEntry({}, { locale: 'en' });
    expect(en).toContain('Annotate page');
    expect(en).toContain('View annotations (2)');
  });

  it('stays rendered when the preview is not running: disabled-looking, focusable, with the reason', () => {
    const html = renderEntry({}, { running: false });
    expect(html).toContain('data-testid="annotate-menu"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(' disabled=""'); // still focusable
    expect(html).toContain('aria-describedby="reason-id"');
    expect(html).toMatch(/id="reason-id"[^>]*>先启动预览再标注</);
    expect(html).toContain('title="先启动预览再标注"');
    expect(renderEntry({}, { running: false, locale: 'en' })).toContain('Start the preview first, then annotate');
  });

  it('opens the ways only when it can start a pick, and says why not during a step', () => {
    expect(renderEntry({ menuOpen: true })).toContain('aria-expanded="true" aria-controls="ways-id"');
    expect(renderEntry({ menuOpen: true }, { running: false })).toContain('aria-expanded="false"');
    expect(renderEntry({ mode: { kind: 'picking' } })).toContain('正在标注：请先完成或取消当前这一步');
    expect(annotateEntry(true, { kind: 'idle' })).toEqual({ available: true, reason: null });
    expect(annotateEntry(false, { kind: 'idle' })).toEqual({
      available: false,
      reason: 'annotations.entry.needsPreview',
    });
    expect(annotateEntry(true, { kind: 'loading' }).reason).toBe('annotations.entry.busy');
  });

  it('the list starts collapsed (the entry shows the count instead)', () => {
    expect(INITIAL_ANNOTATIONS.expanded).toBe(false);
    expect(renderEntry({ expanded: false })).toContain('aria-expanded="false" aria-controls="list-id"');
  });
});

describe('AnnotationsStripView (S41.5)', () => {
  it('lists the annotations with a numbered list and every action', () => {
    const html = render();
    expect(html.match(/data-testid="annotation-item"/g)).toHaveLength(2);
    expect(html).toContain('<ol');
    for (const id of ['annotation-show', 'annotation-edit', 'annotation-delete', 'annotations-scope-page']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    // The entry lives in the header, not in the strip: no duplicate Annotate control here.
    expect(html).not.toContain('data-testid="annotate-menu"');
    expect(html).not.toContain('data-testid="annotations-toggle"');
  });

  it('is empty (zero height) when idle with the list closed', () => {
    const html = render({ expanded: false });
    expect(html).toContain('data-mode="idle"');
    expect(html).toMatch(/data-testid="annotations-panel" hidden=""/);
    expect(html).not.toContain('annotate-ways');
  });

  it('offers Ask AI only when the prop is given', () => {
    expect(render()).not.toContain('annotation-ask-ai');
    expect(render()).not.toContain('annotations-ask-all');
    const withAi = render({}, { askAi: true });
    expect(withAi.match(/data-testid="annotation-ask-ai"/g)).toHaveLength(2);
    expect(withAi).toContain('data-testid="annotations-ask-all"');
    expect(withAi).toContain('问 AI');
  });

  it('says the source state in words next to the icon (not colour alone)', () => {
    const html = render();
    expect(html).toContain('已找到');
    expect(html).toContain('index.html 第 14 行');
    expect(html).toContain('代码里没找到');
    const en = render({}, { locale: 'en' });
    expect(en).toContain('Found');
    expect(en).toContain('index.html line 14');
    expect(en).toContain('Not found in the code');
  });

  it('renders page text as text only', () => {
    const html = render();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('Show is disabled when the preview is not running, and the ways are not offered', () => {
    const html = render({ menuOpen: true }, { running: false });
    expect(html).not.toContain('annotate-ways');
    expect(html).toMatch(/data-testid="annotation-show" disabled=""/);
  });

  it('offers the three ways of annotating when the menu is open, with a way to close them', () => {
    const html = render({ menuOpen: true });
    expect(html).toContain('在页面上点选');
    expect(html).toContain('从列表中选择');
    expect(html).toContain('框选一块区域');
    expect(html).toContain('data-testid="annotate-ways-close"');
  });

  it('announces pick mode in a live region with a Cancel button', () => {
    const html = render({ mode: { kind: 'picking' } });
    expect(html).toMatch(
      /role="status" aria-live="polite" data-testid="annotate-status">请在预览中点击一个元素，按 Esc 取消</,
    );
    expect(html).toContain('data-testid="annotate-cancel"');
  });

  it('shows candidates as a keyboard listbox of text', () => {
    const html = render({
      mode: { kind: 'choosing', items: [{ path: [0], label: HOSTILE }], truncated: false, active: 0 },
    });
    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-testid="annotation-candidates"');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain('<img src=x');
  });

  it('naming: what was picked, where it is, the note field and Save', () => {
    const html = render({
      mode: { kind: 'naming', pick: { pickId: 'k', target, source: item('a', 'found').source }, saving: false },
    });
    expect(html).toContain('data-testid="annotation-note-input"');
    expect(html).toContain('placeholder="例如：把这个按钮变大一点"');
    expect(html).toMatch(/data-testid="annotation-save" disabled=""/);
    // Save and Cancel sit in the step's action row (sticky, so they are never scrolled away).
    expect(html).toMatch(
      /class="annotations-actions"><button type="button" class="annotations-primary" data-testid="annotation-save"/,
    );
  });

  it('drawing: the picture and a canvas reachable by keyboard', () => {
    const html = render({
      mode: {
        kind: 'drawing',
        shot: { dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 600 },
        rect: { x: 100, y: 100, width: 120, height: 40 },
        dragFrom: null,
      },
    });
    expect(html).toMatch(/data-testid="annotation-region-canvas"/);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('已框选：120×40');
    expect(html).toContain('data-testid="annotation-region-confirm"');
    // The picture is fitted into a frame that takes the stage's place; Confirm is outside the frame.
    expect(html).toMatch(/class="annotation-region-frame"><div[^>]*data-testid="annotation-region-canvas"/);
    expect(html).toContain('data-mode="drawing"');
  });

  it('delete asks for confirmation inline', () => {
    const html = render({ confirmDelete: 'a' });
    expect(html).toContain('data-testid="annotation-delete-confirm"');
    // The question is a focusable group (focus moves there, see focusAfter), named by the question itself.
    expect(html).toMatch(/role="group" tabindex="-1" aria-label="[^"]+" data-testid="annotation-delete-question"/);
  });
});

describe('focus in the annotations strip is never lost (focusAfter)', () => {
  const at = (mode: FocusState['mode'], editing: string | null = null, deleting: string | null = null): FocusState => ({
    mode,
    editing,
    deleting,
  });

  it('moves into a step that starts', () => {
    expect(focusAfter(at('idle'), at('idle', 'a'))).toEqual({ kind: 'edit-input' });
    expect(focusAfter(at('idle'), at('idle', null, 'a'))).toEqual({ kind: 'delete-question' });
    expect(focusAfter(at('idle', 'a'), at('idle', null, 'a'))).toEqual({ kind: 'delete-question' });
    expect(focusAfter(at('loading'), at('choosing'))).toEqual({ kind: 'mode', mode: 'choosing' });
    expect(focusAfter(at('loading'), at('drawing'))).toEqual({ kind: 'mode', mode: 'drawing' });
    expect(focusAfter(at('loading'), at('naming'))).toEqual({ kind: 'mode', mode: 'naming' });
  });

  it('returns to the control that started a step when it ends (Save, Cancel, Delete)', () => {
    expect(focusAfter(at('idle', 'a'), at('idle'))).toEqual({ kind: 'item-control', id: 'a', control: 'edit' });
    expect(focusAfter(at('idle', null, 'a'), at('idle'))).toEqual({ kind: 'item-control', id: 'a', control: 'delete' });
    expect(focusAfter(at('naming'), at('idle'))).toEqual({ kind: 'annotate-menu' });
    expect(focusAfter(at('choosing'), at('idle'))).toEqual({ kind: 'annotate-menu' });
    expect(focusAfter(at('idle'), at('idle'))).toBeNull();
    expect(focusAfter(at('naming', 'a'), at('naming', 'a'))).toBeNull();
  });

  it('follows the reducer: edit, save and delete', () => {
    let state: AnnotationsState = {
      ...INITIAL_ANNOTATIONS,
      projectId: 'p1',
      loaded: true,
      items: [item('a', 'found')],
    };
    const step = (action: AnnotationsAction) => {
      const before = focusStateOf(state);
      state = annotationsReducer(state, action);
      return focusAfter(before, focusStateOf(state));
    };
    expect(step({ type: 'edit-start', id: 'a' })).toEqual({ kind: 'edit-input' });
    expect(step({ type: 'edit-cancel' })).toEqual({ kind: 'item-control', id: 'a', control: 'edit' });
    expect(step({ type: 'confirm-delete', id: 'a' })).toEqual({ kind: 'delete-question' });
    expect(step({ type: 'removed', id: 'a' })).toEqual({ kind: 'item-control', id: 'a', control: 'delete' });
  });
});
