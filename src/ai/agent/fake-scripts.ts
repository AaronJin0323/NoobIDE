import type { TurnScript } from './scripted-model';

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
    case 'slow':
      return [{ text: ['Working on it…'], hang: true }];
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
