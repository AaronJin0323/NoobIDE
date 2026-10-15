import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiFileChange } from '../../shared/ipc/ai-contract';
import type { AnnotationContext } from '../../shared/ipc/annotations-contract';
import { I18nValueProvider } from '../i18n/I18nProvider';
import { translate, type Locale } from '../i18n/index';
import { changedLines, placementOf } from './annotation-placement';
import { AiChatController } from './chat-controller';
import { activeConversation, draftOf } from './chat-model';
import { contextLabel } from './chat-text';
import { fakeAiApi } from './fake-ai-api';
import { ProposalReview } from './ProposalReview';

/** S41.6: Annotation chips in the chat, agent turns that carry the annotated ranges, and the proposal's placement. */
const CHIP: AnnotationContext = {
  id: '00000000-0000-4000-8000-000000000001',
  label: '标注 1：把这个按钮变大一点',
  text: '标注 1\n用户的要求："把这个按钮变大一点"\n…',
  relPath: 'index.html',
  startLine: 17,
  endLine: 17,
  ranges: [
    { relPath: 'index.html', startLine: 17, endLine: 17 },
    { relPath: 'style.css', startLine: 3, endLine: 6 },
  ],
};
const CSS = 'body { margin: 0; }\n\n.cta {\n  padding: 4px 8px;\n  font-size: 14px;\n}\n';
const edit = (after: string): AiFileChange => ({ kind: 'edit', relPath: 'style.css', before: CSS, after });

describe('annotation placement (S41.6)', () => {
  it('finds the changed lines of an edit', () => {
    expect(changedLines('a\nb\nc', 'a\nB\nc')).toEqual({ start: 2, end: 2 });
    expect(changedLines('a\nb\nc', 'a\nb\nx\nc')).toEqual({ start: 3, end: 3 }); // an insertion before line 3
    expect(changedLines('a\nb', 'a\nb')).toBeNull();
  });
  it('inside an annotated range, outside elsewhere, nothing without annotations', () => {
    const inside = edit(CSS.replace('padding: 4px 8px;', 'padding: 12px 24px;'));
    expect(placementOf(inside, CHIP.ranges)).toBe('inside');
    expect(placementOf(edit(CSS.replace('margin: 0;', 'margin: 4px;')), CHIP.ranges)).toBe('outside');
    expect(placementOf({ ...inside, relPath: 'other.css' }, CHIP.ranges)).toBe('outside');
    expect(placementOf({ kind: 'create', relPath: 'style.css', after: 'x' }, CHIP.ranges)).toBe('outside');
    expect(placementOf(inside, [])).toBeNull();
  });
});

describe('Ask AI on annotations (S41.6)', () => {
  it('opens an agent draft with the Annotation chips; the turn sent carries the chip and its ranges', async () => {
    const api = fakeAiApi();
    const controller = new AiChatController(api, {
      projectId: () => 'p1',
      locale: () => 'zh-CN',
      activeFile: () => null,
      fileText: () => undefined,
      selection: () => null,
    });
    controller.start();
    controller.askAboutAnnotations([CHIP], '请按这个标注修改代码：把这个按钮变大一点');
    const draft = draftOf(controller.getState(), 'p1');
    expect(controller.getState().open).toBe(true);
    expect(draft).toMatchObject({ kind: 'agent', prompt: '请按这个标注修改代码：把这个按钮变大一点' });
    expect(draft.chips.map((c) => c.item)).toEqual([
      { kind: 'annotation', text: CHIP.text, label: CHIP.label, relPath: 'index.html', startLine: 17, endLine: 17 },
    ]);
    expect(api.requests).toHaveLength(0); // nothing is sent before Send
    await controller.send();
    expect(api.requests[0]).toMatchObject({ kind: 'agent', context: [{ kind: 'annotation', text: CHIP.text }] });
    const turn = activeConversation(controller.getState(), 'p1')?.turns.at(-1);
    expect(turn?.annotationRanges).toEqual(CHIP.ranges);
  });

  it('the chip label is the label main built', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('en', key);
    expect(contextLabel(t, { kind: 'annotation', text: 'x', label: 'Annotation 1: bigger' })).toBe(
      'Annotation 1: bigger',
    );
    expect(contextLabel(t, { kind: 'annotation', text: 'x' })).toBe('Annotation');
  });
});

function review(locale: Locale, change: AiFileChange, ranges = CHIP.ranges) {
  return renderToStaticMarkup(
    createElement(
      I18nValueProvider,
      { value: { locale, t: (key) => translate(locale, key), setLocale: () => undefined } },
      createElement(ProposalReview, {
        proposalId: 'p',
        changes: [change],
        reason: 'r',
        views: [{ state: 'pending' }],
        busy: false,
        onAccept: () => undefined,
        onReject: () => undefined,
        onAcceptAll: () => undefined,
        onRejectAll: () => undefined,
        ...(ranges.length ? { placement: (c: AiFileChange) => placementOf(c, ranges) } : {}),
      }),
    ),
  );
}

describe('proposal card placement (S41.6)', () => {
  it('says in words (not colour) whether a change is in the annotated part', () => {
    const inside = review('zh-CN', edit(CSS.replace('padding: 4px 8px;', 'padding: 12px 24px;')));
    expect(inside).toContain('data-placement="inside"');
    expect(inside).toContain('改的是标注的位置');
    const outside = review('en', { kind: 'delete', relPath: 'index.html' });
    expect(outside).toContain('data-placement="outside"');
    expect(outside).toContain('Changes something outside the annotated part');
    expect(review('en', { kind: 'delete', relPath: 'index.html' }, [])).not.toContain('agent-change-annotated');
  });
});
