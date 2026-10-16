import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import type { EditorContextAction, EditorSelection } from '../editor/editor-handle';
import { EditorAiActionsView, EXPLAIN_ACTION, INLINE_EDIT_ACTION } from './EditorAiActions';
import type { PlatformId } from '../../platform/labels';

const editAction = (run = vi.fn()): EditorContextAction => ({
  id: INLINE_EDIT_ACTION,
  label: translate('zh-CN', 'ai.editor.inlineEdit'),
  needsSelection: false,
  run,
});
const explainAction = (run = vi.fn()): EditorContextAction => ({
  id: EXPLAIN_ACTION,
  label: translate('zh-CN', 'ai.editor.explain'),
  needsSelection: true,
  run,
});

function view(
  actions: EditorContextAction[],
  options: { locale?: Locale; platform?: PlatformId; selection?: EditorSelection | null } = {},
) {
  const locale = options.locale ?? 'zh-CN';
  return EditorAiActionsView({
    actions,
    platform: options.platform ?? 'windows',
    selection: () => options.selection ?? null,
    t: (key: MessageKey) => translate(locale, key),
  });
}
const html = (...args: Parameters<typeof view>) => {
  const element = view(...args);
  return element ? renderToStaticMarkup(element) : '';
};

describe('Edit with AI / Explain under the code (editor status bar)', () => {
  it('is shown only while AI registered the editor actions (same condition as the context menu)', () => {
    expect(view([])).toBeNull();
    expect(html([editAction()])).toContain('data-testid="editor-ai-edit"');
    expect(html([editAction()])).not.toContain('editor-ai-explain');
    expect(html([explainAction()])).toContain('data-testid="editor-ai-explain"');
  });

  it('shows the sparkle, the written label and the shortcut on each platform', () => {
    const win = html([editAction(), explainAction()]);
    expect(win).toMatch(
      /class="ai-entry"[^>]*data-testid="editor-ai-edit"[^>]*><svg[^]*?<\/svg><span class="editor-ai-edit-label">AI 编辑<\/span><kbd/,
    );
    expect(win).toContain('>Ctrl+I</kbd>');
    expect(win).toContain('title="用 AI 修改这段代码 (Ctrl+I)"');
    expect(win).toContain('aria-keyshortcuts="Control+I"');
    expect(win).toContain('aria-label="让 AI 解释这段代码"');
    const mac = html([editAction()], { platform: 'mac', locale: 'en' });
    expect(mac).toContain('Edit with AI');
    expect(mac).toContain('>⌘I</kbd>');
    expect(mac).toContain('aria-keyshortcuts="Meta+I"');
  });

  it('runs the same action as the context menu, with the editor selection', () => {
    const runEdit = vi.fn();
    const runExplain = vi.fn();
    const selection: EditorSelection = { uri: 'file:///a.js', startLine: 1, endLine: 2, text: 'x' };
    const element = view([editAction(runEdit), explainAction(runExplain)], { selection });
    const buttons = collectButtons(element);
    buttons.find((b) => b.props['data-testid'] === 'editor-ai-edit')?.props.onClick();
    buttons.find((b) => b.props['data-testid'] === 'editor-ai-explain')?.props.onClick();
    expect(runEdit).toHaveBeenCalledWith(selection);
    expect(runExplain).toHaveBeenCalledWith(selection);
  });
});

interface Node {
  type: unknown;
  props: Record<string, unknown> & { onClick: () => void; children?: unknown };
}
function collectButtons(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out);
    return out;
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const element = node as Node;
  if (element.type === 'button') out.push(element);
  collectButtons(element.props.children, out);
  return out;
}
