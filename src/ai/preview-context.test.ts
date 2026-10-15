import { describe, expect, it } from 'vitest';
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import {
  capturePreview,
  previewContextText,
  recentErrors,
  recordLocation,
  type PreviewSource,
} from './preview-context';
import { modelAcceptsImages } from './providers/provider';
import { toAnthropicMessages } from './providers/anthropic';
import { toOpenAiMessages } from './providers/openai';

const ORIGIN = 'http://127.0.0.1:5000';

describe('preview context (S38.2)', () => {
  it('names records by project file and line; other URLs by origin and path only', () => {
    const at = (url: string, line?: number): PreviewLogEntry => ({
      source: 'exception',
      level: 'error',
      message: 'x',
      url,
      ...(line ? { line } : {}),
      at: 1,
    });
    expect(recordLocation(at(`${ORIGIN}/js/%E8%84%9A%E6%9C%AC.js`, 3), ORIGIN)).toBe('js/脚本.js:3');
    expect(recordLocation(at(`${ORIGIN}/`, 9), ORIGIN)).toBe('index.html:9');
    expect(recordLocation(at('https://cdn.example.com/lib.js?token=secret', 1), ORIGIN)).toBe(
      'https://cdn.example.com/lib.js',
    );
  });

  it('keeps the last errors only, each bounded', () => {
    const many: PreviewLogEntry[] = Array.from({ length: 50 }, (_, i) => ({
      source: 'console',
      level: i % 2 === 0 ? 'error' : 'info',
      message: `${i} ${'m'.repeat(1000)}`,
      at: i,
    }));
    const errors = recentErrors(many, ORIGIN);
    expect(errors).toHaveLength(20);
    expect(errors.at(-1)).toMatch(/^console: 48 m+…$/);
    expect(errors.every((e) => e.length < 320)).toBe(true);
  });

  it('formats the chip text in the UI language and says what was not available', () => {
    const capture = {
      path: 'about.html',
      title: 'About',
      outline: null,
      outlineTruncated: false,
      errors: [],
      png: null,
      width: 0,
      height: 0,
    };
    expect(previewContextText(capture, 'en')).toBe(
      'Page: about.html\nTitle: About\nPage outline: not available (the page did not answer in time)\nRecent errors in the preview: none',
    );
    expect(previewContextText({ ...capture, path: '', outline: 'h1 "x"', outlineTruncated: true }, 'zh-CN')).toBe(
      '页面：（项目的首页）\n标题：About\n页面结构（标题、链接、按钮、表单、图片，按页面顺序）：\nh1 "x"\n（页面结构太长，后面的省略了）\n预览里最近的错误：没有',
    );
  });

  it('asks nothing of another project’s or a stopped preview', async () => {
    let asked = 0;
    const source: PreviewSource = {
      getStatus: () => ({ state: 'running', projectId: 'other' }),
      recentRecords: () => [],
      pageSnapshot: async () => {
        asked += 1;
        return { ok: false, code: 'not-available', message: '' };
      },
    };
    expect(await capturePreview(source, 'p1', { screenshot: true })).toMatchObject({ ok: false, code: 'not-running' });
    expect(asked).toBe(0);
  });
});

describe('images for providers (S38.2)', () => {
  it('knows which models read images', () => {
    expect(modelAcceptsImages('anthropic', 'claude-haiku-5-5')).toBe(true);
    for (const model of ['gpt-5', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4-turbo', 'o3', 'gpt-5-codex', '']) {
      expect(modelAcceptsImages('openai', model)).toBe(true);
    }
    for (const model of ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-0613', 'o1-mini', 'o3-mini']) {
      expect(modelAcceptsImages('openai', model)).toBe(false);
    }
  });

  it('sends a user message’s images as image blocks (Anthropic) and image_url parts (OpenAI)', () => {
    const messages = [
      { role: 'user' as const, text: 'look', images: [{ mediaType: 'image/png' as const, data: 'AAAA' }] },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'look' },
        ],
      },
    ]);
    expect(toOpenAiMessages('sys', messages)[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    // Without images nothing changes (plain string content).
    expect(toAnthropicMessages([{ role: 'user', text: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
