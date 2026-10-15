/**
 * S42.3 (decision 0031): an inline `/ai` prompt line that has not been run yet. NoobIDE's own warning marker (code
 * below, owner `noobide-ai-prompt`) makes a pending prompt visible in Problems: until it is run or deleted it is saved
 * into the file as plain text.
 */
import { msg } from '../messages';
import type { Rule } from './types';

/** Code of the warning marker on a pending `/ai` line (src/renderer/ai/ai-prompt-model.ts uses the same value). */
export const AI_PROMPT_PENDING_CODE = 'ai-prompt-pending';

export const aiPromptPendingRule: Rule = {
  id: 'ai-prompt-pending',
  explain(record) {
    if (record.source !== 'static' || record.code !== AI_PROMPT_PENDING_CODE) return null;
    return {
      certainty: 'certain',
      title: msg('aiPrompt.title'),
      explanation: msg('aiPrompt.explanation'),
      checks: [
        record.line ? msg('aiPrompt.check.runAtLine', { line: record.line }) : msg('aiPrompt.check.run'),
        msg('aiPrompt.check.delete'),
      ],
    };
  },
};
