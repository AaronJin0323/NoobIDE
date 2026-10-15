import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import type { AiPreviewSnapshot } from '../../shared/ipc/ai-contract';
import { AiChatController, type AiChatHost } from './chat-controller';
import { ChatPanelView, type ChatPanelActions } from './ChatPanel';
import { INITIAL_CHAT_STATE, draftOf, type ChatChip, type ChatState } from './chat-model';
import { fakeAiApi } from './fake-ai-api';

/** S38.2: the chat's Preview chip shows exactly what will be sent and is sent only like other project context. */
const SNAPSHOT: AiPreviewSnapshot = {
  snapshotId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f',
  path: '',
  text: '页面：（项目的首页）\n标题：<b>我的</b> 网页\n页面结构（…）：\nbutton "发送" id="send"\n预览里最近的错误：\nexception 脚本.js:3: Uncaught ReferenceError: sendMesage is not defined',
  screenshot: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 640, height: 400 },
  imagesAccepted: { chat: true, agent: false },
};

function controllerWith(snapshot: AiPreviewSnapshot | 'not-running' | 'not-available') {
  const api = fakeAiApi();
  api.snapshot = snapshot;
  const host: AiChatHost = {
    projectId: () => 'p1',
    locale: () => 'zh-CN',
    activeFile: () => null,
    fileText: () => undefined,
    selection: () => null,
  };
  const controller = new AiChatController(api, host);
  controller.start();
  return { api, controller, draft: () => draftOf(controller.getState(), 'p1') };
}

describe('Preview chip: controller (S38.2)', () => {
  it('adds one chip with the snapshot text and id; a new snapshot replaces it; nothing is sent', async () => {
    const { api, controller, draft } = controllerWith(SNAPSHOT);
    expect(await controller.addPreview()).toBe(true);
    expect(api.snapshotRequests).toEqual([{ projectId: 'p1', locale: 'zh-CN' }]);
    expect(draft().chips).toHaveLength(1);
    expect(draft().chips[0]?.item).toEqual({
      kind: 'preview',
      label: '',
      text: SNAPSHOT.text,
      snapshotId: SNAPSHOT.snapshotId,
    });
    expect(draft().chips[0]?.preview?.thumbnail).toBe(SNAPSHOT.screenshot?.dataUrl);
    api.snapshot = { ...SNAPSHOT, snapshotId: '9a1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f', path: 'about.html' };
    await controller.addPreview();
    expect(draft().chips.map((c) => c.item.snapshotId)).toEqual(['9a1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f']);
    expect(api.requests).toHaveLength(0);
  });

  it('sends the chip like other context: after consent, exactly its text and snapshot id', async () => {
    const { api, controller } = controllerWith(SNAPSHOT);
    api.current = { ...api.current, projectConsent: false };
    await controller.addPreview();
    controller.setPrompt('为什么按钮没反应？');
    await controller.send();
    expect(api.requests).toHaveLength(0); // the consent question comes first
    expect(controller.getState().consentFor).toBe('p1');
    api.current = { ...api.current, projectConsent: true };
    await controller.consentGiven();
    const request = api.requests[0];
    expect(request?.kind === 'chat' && request.context).toEqual([
      { kind: 'preview', label: '', text: SNAPSHOT.text, snapshotId: SNAPSHOT.snapshotId },
    ]);
  });

  it('explains when the preview is not running or not answering', async () => {
    for (const [code, notice] of [
      ['not-running', 'ai.chat.context.previewNotRunning'],
      ['not-available', 'ai.chat.context.previewUnavailable'],
    ] as const) {
      const { controller, draft } = controllerWith(code);
      expect(await controller.addPreview()).toBe(false);
      expect(draft().chips).toHaveLength(0);
      expect(controller.getState().notice).toBe(notice);
    }
  });
});

const noop = () => undefined;
const actions: ChatPanelActions = {
  close: noop,
  newConversation: noop,
  selectConversation: noop,
  setPrompt: noop,
  setKind: noop,
  removeChip: noop,
  addCurrentFile: () => true,
  addSelection: () => true,
  addPreview: async () => true,
  send: async () => undefined,
  stop: async () => undefined,
  consentGiven: async () => undefined,
  consentDeclined: noop,
};

function render(chips: ChatChip[], locale: Locale = 'zh-CN', kind: 'chat' | 'agent' = 'chat') {
  const state: ChatState = {
    ...INITIAL_CHAT_STATE,
    open: true,
    availability: { kind: 'ready', provider: 'anthropic', consent: true },
    drafts: { p1: { prompt: '', mode: 'chat', kind, chips } },
  };
  return renderToStaticMarkup(
    createElement(ChatPanelView, {
      state,
      projectId: 'p1',
      actions,
      consent: () => null,
      extensions: { agent: true },
      t: (key: MessageKey) => translate(locale, key),
    }),
  );
}

const chip = (overrides: Partial<NonNullable<ChatChip['preview']>> = {}): ChatChip => ({
  id: 'c1',
  item: { kind: 'preview', label: '', text: SNAPSHOT.text, snapshotId: SNAPSHOT.snapshotId },
  preview: { thumbnail: SNAPSHOT.screenshot?.dataUrl ?? null, imagesAccepted: SNAPSHOT.imagesAccepted, ...overrides },
});

describe('Preview chip: panel (S38.2)', () => {
  it('offers "Add preview" next to the other context buttons', () => {
    expect(render([])).toMatch(
      /<button type="button" class="quiet-button" data-testid="ai-add-preview">添加预览<\/button>/,
    );
    expect(render([], 'en')).toContain('>Add preview</button>');
  });

  it('shows the exact text as text (never HTML), the thumbnail with alt text and whether it is sent', () => {
    const out = render([chip()]);
    expect(out).toContain('预览：首页');
    expect(out).toContain('aria-label="移除：预览：首页"');
    // A native disclosure: keyboard reachable without any script.
    expect(out).toMatch(
      /<details class="ai-chip-preview" data-testid="ai-preview-details"><summary>看看会发送什么<\/summary>/,
    );
    expect(out).toContain('&lt;b&gt;我的&lt;/b&gt; 网页');
    expect(out).not.toContain('<b>我的</b>');
    expect(out).toContain('exception 脚本.js:3: Uncaught ReferenceError: sendMesage is not defined');
    expect(out).toMatch(
      /<img class="ai-preview-thumbnail" data-testid="ai-preview-thumbnail" src="data:image\/png;base64,[^"]+" alt="预览的截图（会和问题一起发送）"/,
    );
    expect(out).toContain('截图会和文字一起发送。');
    // The agent model of this snapshot cannot read images: the chip says only the text goes.
    expect(render([chip()], 'zh-CN', 'agent')).toContain('现在的 AI 模型看不了图片');
    expect(render([chip({ thumbnail: null })], 'en')).toContain('No screenshot could be taken');
    expect(render([{ ...chip(), item: { ...chip().item, label: 'about.html' } }], 'en')).toContain(
      'Preview: about.html',
    );
  });
});
