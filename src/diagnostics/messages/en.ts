import type { DiagnosticsMessageKey } from './zh-CN';

/** Problem explanation texts, English (required locale). Must define exactly the keys of zh-CN.ts. */
export const en: Record<DiagnosticsMessageKey, string> = {
  // Location and headings
  'location.fileLine': '{file}, line {line}: ',
  'location.file': '{file}: ',
  'heading.possibleCauses': 'Possible causes:',
  'heading.checks': 'Things to check:',
  'certainty.certain': 'Cause confirmed',
  'certainty.likely': 'Likely cause',
  'certainty.possible': 'Possible cause',
  'certainty.unknown': 'Cause not certain',

  // Actions
  'action.goToCode': 'Go to code',
  'action.showOriginal': 'Show original error',
  'action.revealInFiles': 'Show {path} in the file tree',
  'action.replaceWith': 'Change to {name}',

  // Fallback (no rule matched)
  'fallback.title.static': 'The code check found a problem.',
  'fallback.title.runtime': 'An error happened while the page was running.',
  'fallback.title.resource': 'A file did not load.',
  'fallback.title.console': 'The page printed an error to the console.',
  'fallback.explanation':
    'NoobIDE cannot tell the cause yet. The original error is what the browser reported; the names or files it mentions may be the clue.',
  'fallback.check.goToCode': 'Click “Go to code” and look at the line where it happened.',
  'fallback.check.readOriginal':
    'Expand “Show original error” and look for variable names, file names or line numbers in it.',
};
