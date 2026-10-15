import type { ModelTurnRequest } from './model-port';
import { lastToolResults, type TurnScript } from './scripted-model';

/** The first CSS location an Annotation chip names (`- 样式 表.css 第 3–6 行 (.cta)` / `- style.css lines 3–6 (.cta)`). */
export function annotationCssLocation(request: ModelTurnRequest): { path: string; start: number; end: number } | null {
  const text = (request.messages[0]?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  if (!text.includes('context="annotation"')) return null;
  const m = /^- (.+?) (?:lines (\d+)–(\d+)|line (\d+)|第 (\d+)–(\d+) 行|第 (\d+) 行) \(/m.exec(text);
  if (!m?.[1]) return null;
  const start = Number(m[2] ?? m[4] ?? m[5] ?? m[7]);
  const end = Number(m[3] ?? m[4] ?? m[6] ?? m[7]);
  return { path: m[1], start, end };
}

/**
 * S41.7 `follow-annotation`: an agent that does only what the Annotation chip says — it reads the first CSS rule the
 * chip names and proposes a bigger `padding` there. Used by tests/e2e/preview-annotations.spec.ts.
 */
const FOLLOW_ANNOTATION: readonly TurnScript[] = [
  (request) => {
    const at = annotationCssLocation(request);
    return at
      ? {
          text: ['我先看看标注的 CSS 规则。'],
          toolCalls: [{ name: 'read_file', input: { path: at.path, start_line: at.start, end_line: at.end } }],
          usage: { inputTokens: 900, outputTokens: 30 },
        }
      : { text: ['没有找到标注里的 CSS 位置。'] };
  },
  (request) => {
    const at = annotationCssLocation(request);
    const padding = /padding:[^;\n]+;/.exec(lastToolResults(request)[0]?.content ?? '')?.[0];
    if (!at || !padding) return { text: ['这里没有可以改的 padding。'] };
    return {
      toolCalls: [
        {
          name: 'propose_edit',
          input: {
            path: at.path,
            old_text: padding,
            new_text: 'padding: 12px 24px;',
            reason: '按钮的内边距变大，按钮就变大了。',
          },
        },
      ],
      usage: { inputTokens: 1200, outputTokens: 60 },
    };
  },
  { text: ['我把按钮的 padding 改大了。'], usage: { inputTokens: 1300, outputTokens: 10 } },
];

/**
 * Agent scripts for the fake provider (NOOBIDE_AI_FAKE, decision 0025) used by tests/e2e/ai-agent.spec.ts (S34.2).
 * S31's fake provider plays one for requests of kind 'agent':
 * `new ScriptedModel(fakeAgentScript(process.env.NOOBIDE_AI_FAKE_AGENT))`.
 *
 * - `edit-and-create` (default): reads index.html and style.css, proposes an edit of style.css plus a new
 *   about.html in one proposal, then ends with a short text.
 * - `slow`: streams a little text, then waits until Stop.
 */
export function fakeAgentScript(name: string | undefined): readonly TurnScript[] {
  switch (name) {
    case 'follow-annotation':
      return FOLLOW_ANNOTATION;
    case 'slow':
      return [{ text: ['Working on it…'], hang: true }];
    case 'all-kinds':
      // S34.2 undo from History: one proposal with every kind of change (edit, create, rename, delete).
      return [
        {
          toolCalls: [
            { name: 'read_file', input: { path: 'style.css' } },
            { name: 'list_files', input: {} },
          ],
          usage: { inputTokens: 900, outputTokens: 30 },
        },
        {
          toolCalls: [
            {
              name: 'propose_edit',
              input: { path: 'style.css', old_text: 'color: red;', new_text: 'color: blue;', reason: 'Blue heading.' },
            },
            {
              name: 'propose_create',
              input: { path: 'about.html', content: '<h1>About me</h1>\n', reason: 'Add an about page.' },
            },
            {
              name: 'propose_rename',
              input: { path: 'notes.txt', new_path: 'old notes.txt', reason: 'Mark the notes as old.' },
            },
            { name: 'propose_delete', input: { path: 'unused.html', reason: 'Nothing links to it.' } },
          ],
          usage: { inputTokens: 1500, outputTokens: 160 },
        },
        { text: ['Done.'], usage: { inputTokens: 1700, outputTokens: 5 } },
      ];
    case 'edit-and-create':
    default:
      return [
        {
          text: ['Let me look at your page.'],
          toolCalls: [
            { name: 'read_file', input: { path: 'index.html' } },
            { name: 'read_file', input: { path: 'style.css' } },
          ],
          usage: { inputTokens: 1200, outputTokens: 40 },
        },
        {
          toolCalls: [
            {
              name: 'propose_edit',
              input: {
                path: 'style.css',
                old_text: 'color: red;',
                new_text: 'color: blue;',
                reason: 'Make the heading blue.',
              },
            },
            {
              name: 'propose_create',
              input: {
                path: 'about.html',
                content: '<!doctype html>\n<html>\n<body>\n<h1>About me</h1>\n</body>\n</html>\n',
                reason: 'Add an about page.',
              },
            },
          ],
          usage: { inputTokens: 1800, outputTokens: 120 },
        },
        {
          text: ['I proposed two changes; you decided on each of them.'],
          usage: { inputTokens: 2000, outputTokens: 20 },
        },
      ];
  }
}
