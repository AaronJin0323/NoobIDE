import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { THEMES, type ColorScheme } from '../theme/tokens';
import { buildMonacoTheme } from '../theme/monaco-theme';
import { fenceInfo, parseMarkdown } from './md-parse';
import { Markdown, type CodeEditTarget, type MarkdownLabels } from './Markdown';
import { languageIdOf, rememberTokens, tokenStyle, toTokenLines } from './code-highlight';
import { ChatPanelView, type ChatPanelActions } from './ChatPanel';
import { INITIAL_CHAT_STATE, type ChatState } from './chat-model';

const labels: MarkdownLabels = {
  copy: 'Copy code',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  codeCaption: (lang) => lang || 'Code',
  codeFile: (file) => `File: ${file}`,
  insert: 'Insert at cursor',
  replace: 'Replace selection',
  outcome: (outcome) => outcome,
};
const editor = (available: boolean): CodeEditTarget => ({ available, apply: () => 'ok' });

describe('code block fence info (S48.5)', () => {
  it('reads a lowercase language and an optional file name', () => {
    expect(fenceInfo('JS')).toEqual({ lang: 'js', file: '' });
    expect(fenceInfo('html index.html')).toEqual({ lang: 'html', file: 'index.html' });
    expect(fenceInfo('css:styles/主页.css')).toEqual({ lang: 'css', file: 'styles/主页.css' });
    expect(fenceInfo('js title="scripts\\app.js"')).toEqual({ lang: 'js', file: 'scripts/app.js' });
    expect(fenceInfo('app.JS')).toEqual({ lang: 'js', file: 'app.JS' });
    expect(fenceInfo('')).toEqual({ lang: '', file: '' });
    // Never a path that climbs out, and never markup.
    expect(fenceInfo('js ../../secret.js').file).toBe('');
    expect(fenceInfo('js <b>.js').file).toBe('');
    expect(parseMarkdown('```Html page.html\n<p>hi</p>\n```')).toEqual([
      { type: 'code', lang: 'html', file: 'page.html', text: '<p>hi</p>', closed: true },
    ]);
  });
});

describe('code colours from the editor theme (S48.5)', () => {
  it('maps fence languages to the bundled Monaco languages only', () => {
    expect(languageIdOf('js')).toBe('javascript');
    expect(languageIdOf('HTML')).toBe('html');
    expect(languageIdOf('css')).toBe('css');
    expect(languageIdOf('python')).toBeNull();
    expect(languageIdOf('')).toBeNull();
  });

  it('colours Monaco token types the way the editor theme does, in both schemes', () => {
    for (const scheme of ['dark', 'light'] as const) {
      const t = THEMES[scheme];
      const hex = (value: string) => value.toUpperCase();
      expect(hex(tokenStyle(scheme, 'keyword.js').color)).toBe(hex(t.syntaxKeyword));
      expect(hex(tokenStyle(scheme, 'string.js').color)).toBe(hex(t.syntaxString));
      expect(hex(tokenStyle(scheme, 'number.js').color)).toBe(hex(t.syntaxNumber));
      expect(hex(tokenStyle(scheme, 'tag.html').color)).toBe(hex(t.syntaxTag));
      expect(hex(tokenStyle(scheme, 'metatag.content.html').color)).toBe(hex(t.syntaxTag));
      expect(hex(tokenStyle(scheme, 'attribute.name.html').color)).toBe(hex(t.syntaxAttribute));
      expect(hex(tokenStyle(scheme, 'attribute.value.css').color)).toBe(hex(t.syntaxString));
      expect(hex(tokenStyle(scheme, 'identifier.js').color)).toBe(hex(t.text));
      expect(hex(tokenStyle(scheme, '').color)).toBe(hex(t.text));
      expect(tokenStyle(scheme, 'comment.js')).toMatchObject({ italic: true, color: expect.any(String) });
      expect(hex(tokenStyle(scheme, 'comment.js').color)).toBe(hex(t.syntaxComment));
      // Every theme rule resolves to its own colour (the table is the editor's, not a copy).
      for (const rule of buildMonacoTheme(scheme).rules) {
        if (rule.token) expect(tokenStyle(scheme, rule.token).color.slice(1)).toBe(rule.foreground);
      }
    }
  });

  it('splits lines at the tokenizer offsets', () => {
    expect(
      toTokenLines('let a = 1;\n\n// x', [
        [
          { offset: 0, type: 'keyword.js' },
          { offset: 3, type: '' },
          { offset: 4, type: 'identifier.js' },
          { offset: 8, type: 'number.js' },
          { offset: 9, type: 'delimiter.js' },
        ],
        [],
        [{ offset: 0, type: 'comment.js' }],
      ]),
    ).toEqual([
      [
        { text: 'let', type: 'keyword.js' },
        { text: ' ', type: '' },
        { text: 'a = ', type: 'identifier.js' },
        { text: '1', type: 'number.js' },
        { text: ';', type: 'delimiter.js' },
      ],
      [],
      [{ text: '// x', type: 'comment.js' }],
    ]);
  });
});

const SOURCE = '```js app.js\nlet n = 1;\n// done\n```';
const CODE = 'let n = 1;\n// done';
rememberTokens(
  'javascript',
  CODE,
  toTokenLines(CODE, [
    [
      { offset: 0, type: 'keyword.js' },
      { offset: 3, type: '' },
      { offset: 4, type: 'identifier.js' },
      { offset: 8, type: 'number.js' },
      { offset: 9, type: 'delimiter.js' },
    ],
    [{ offset: 0, type: 'comment.js' }],
  ]),
);

const render = (scheme: ColorScheme, edit?: CodeEditTarget) =>
  renderToStaticMarkup(createElement(Markdown, { source: SOURCE, labels, code: { scheme, edit } }));

describe('chat code blocks (S48.5)', () => {
  it('show a lowercase caption, the file name, a hidden line gutter and the code with theme colours, in both themes', () => {
    for (const scheme of ['dark', 'light'] as const) {
      const out = render(scheme, editor(true));
      const t = THEMES[scheme];
      expect(out).toContain(`data-scheme="${scheme}"`);
      expect(out).toContain('<span class="md-code-lang">js</span>');
      expect(out).toContain('data-testid="md-code-file" title="app.js"');
      expect(out).toContain('<span class="sr-only">File: app.js</span>');
      expect(out).toContain('<span class="md-code-gutter" aria-hidden="true">1\n2</span>');
      expect(out).toContain(`data-token="keyword.js" style="color:${'#' + t.syntaxKeyword.slice(1)}">let</span>`);
      expect(out).toContain(`data-token="number.js" style="color:#${t.syntaxNumber.slice(1)}">1</span>`);
      expect(out).toContain(`data-token="comment.js" style="color:#${t.syntaxComment.slice(1)};font-style:italic">`);
      // The code's text content is exactly the code (line breaks are text): copying or reading it loses nothing.
      const code = /<code>([\s\S]*)<\/code>/.exec(out)?.[1] ?? '';
      expect(code.replace(/<[^>]+>/g, '')).toBe(CODE);
    }
    expect(render('dark')).not.toBe(render('light'));
  });

  it('uncoloured until tokens arrive, and for languages Monaco does not bundle', () => {
    const out = renderToStaticMarkup(
      createElement(Markdown, { source: '```python\nprint(1)\n```', labels, code: { scheme: 'dark' } }),
    );
    expect(out).toContain('<pre tabindex="0"><code>print(1)</code></pre>');
    expect(out).toContain('<span class="md-code-lang">python</span>');
  });

  it('Copy always; Insert at cursor and Replace selection only with an editor target, focusable even when unavailable', () => {
    const plain = renderToStaticMarkup(createElement(Markdown, { source: SOURCE, labels }));
    expect(plain).toContain('data-testid="md-copy"');
    expect(plain).not.toContain('md-insert');
    const open = render('dark', editor(true));
    expect(open).toMatch(
      /<button type="button" class="quiet-button" data-testid="md-insert">Insert at cursor<\/button>/,
    );
    expect(open).toMatch(/data-testid="md-replace">Replace selection<\/button>/);
    expect(open).toContain('role="group" aria-label="js"');
    const closed = render('dark', editor(false));
    expect(closed).toContain('data-testid="md-insert" aria-disabled="true"');
    expect(closed).toContain('data-testid="md-replace" aria-disabled="true"');
    expect(closed).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('the stylesheet keeps code unwrapped with a tabular-nums gutter', () => {
    const css = readFileSync(new URL('./ai-chat.css', import.meta.url), 'utf8');
    const rule = (selector: string) =>
      new RegExp(`${selector.replace(/[.[\]']/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1];
    expect(rule('.md-code-gutter')).toMatch(/font-variant-numeric: tabular-nums;/);
    expect(rule('.md-code-gutter')).toMatch(/user-select: none;/);
    expect(rule('.md-code pre')).toMatch(/white-space: pre;/);
    expect(rule('.md-code pre')).toMatch(/overflow-x: auto;/);
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

describe('chat code block actions are localised (S48.5)', () => {
  const state: ChatState = {
    ...INITIAL_CHAT_STATE,
    open: true,
    availability: { kind: 'ready', provider: 'anthropic', consent: true },
    conversations: [
      {
        id: 'c1',
        projectKey: 'p1',
        title: 'x',
        turns: [
          {
            id: 't1',
            kind: 'chat',
            mode: 'chat',
            prompt: 'q',
            context: [],
            requestId: 'r1',
            status: 'done',
            stopping: false,
            parts: [{ kind: 'text', text: `${SOURCE}\n\n\`\`\`\nplain\n\`\`\`` }],
          },
        ],
      },
    ],
    active: { p1: 'c1' },
  };
  const panel = (locale: Locale) =>
    renderToStaticMarkup(
      createElement(ChatPanelView, {
        state,
        projectId: 'p1',
        actions,
        consent: () => null,
        codeBlocks: { scheme: 'light', edit: editor(true) },
        t: (key: MessageKey) => translate(locale, key),
      }),
    );

  it('names Copy, Insert at cursor and Replace selection in zh-CN and en', () => {
    const zh = panel('zh-CN');
    expect(zh).toContain('>复制代码</button>');
    expect(zh).toContain('>插入到光标处</button>');
    expect(zh).toContain('>替换选中内容</button>');
    expect(zh).toContain('<span class="sr-only">文件：app.js</span>');
    expect(zh).toContain('<span class="md-code-lang">代码</span>');
    const en = panel('en');
    expect(en).toContain('>Copy code</button>');
    expect(en).toContain('>Insert at cursor</button>');
    expect(en).toContain('>Replace selection</button>');
    expect(en).toContain('<span class="sr-only">File: app.js</span>');
    expect(en).toContain('<span class="md-code-lang">Code</span>');
  });

  it('every outcome has its own sentence in both locales', () => {
    const keys: MessageKey[] = [
      'ai.chat.code.inserted',
      'ai.chat.code.replaced',
      'ai.chat.code.noEditor',
      'ai.chat.code.readOnly',
      'ai.chat.code.noSelection',
    ];
    for (const locale of ['zh-CN', 'en'] as const) {
      const texts = keys.map((key) => translate(locale, key));
      expect(new Set(texts).size).toBe(keys.length);
    }
  });
});
