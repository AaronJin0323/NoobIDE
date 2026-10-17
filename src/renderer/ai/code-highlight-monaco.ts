/**
 * S48.5: tokenizes a chat code block with the bundled Monaco tokenizer (imported lazily by Markdown.tsx, so Monaco
 * stays in its own chunk). `colorize` first makes sure the language's tokenizer — and the CSS / JavaScript ones an
 * HTML block embeds — are loaded; `tokenize` then gives the token types that code-highlight.ts colours.
 */
import { monaco } from '../editor/monaco-setup';
import { toTokenLines, type CodeToken } from './code-highlight';

const ready = new Map<string, Promise<unknown>>();

function loaded(languageId: string): Promise<unknown> {
  let promise = ready.get(languageId);
  if (!promise) {
    const embedded = languageId === 'html' ? ['css', 'javascript'] : [];
    promise = Promise.all([languageId, ...embedded].map((id) => monaco.editor.colorize('', id, {})));
    ready.set(languageId, promise);
  }
  return promise;
}

export async function tokenizeCode(text: string, languageId: string): Promise<CodeToken[][]> {
  await loaded(languageId);
  return toTokenLines(text, monaco.editor.tokenize(text, languageId));
}
