import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotationTarget } from '../../shared/ipc/annotations-contract';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { AnnotationsStripView, type AnnotationsStripOps } from './AnnotationsStrip';
import { INITIAL_ANNOTATIONS, type AnnotationsState } from './annotations-model';

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

describe('AnnotationsStripView (S41.5)', () => {
  it('lists the annotations with a numbered list and every action', () => {
    const html = render();
    expect(html.match(/data-testid="annotation-item"/g)).toHaveLength(2);
    expect(html).toContain('<ol');
    for (const id of [
      'annotation-show',
      'annotation-edit',
      'annotation-delete',
      'annotate-menu',
      'annotations-toggle',
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('aria-expanded="true"');
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

  it('hides Annotate when the preview is not running, and Show is disabled', () => {
    const html = render({}, { running: false });
    expect(html).not.toContain('annotate-menu');
    expect(html).toMatch(/data-testid="annotation-show" disabled=""/);
  });

  it('offers the three ways of annotating when the menu is open', () => {
    const html = render({ menuOpen: true });
    expect(html).toContain('在页面上点选');
    expect(html).toContain('从列表中选择');
    expect(html).toContain('框选一块区域');
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
  });

  it('delete asks for confirmation inline', () => {
    const html = render({ confirmDelete: 'a' });
    expect(html).toContain('data-testid="annotation-delete-confirm"');
  });
});
