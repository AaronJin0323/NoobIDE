import type { MessageKey } from '../i18n/index';
import type { FileOpError, RequestError } from '../../shared/ipc/contract';
import { checkFileName, type FileNameProblem } from '../../shared/file-names';

/**
 * Explanations for file operations (S08.2–S08.4). Pure so every refusal is tested to have a message; the text
 * itself lives in the i18n dictionaries. Templates use `{name}` and `{trash}` placeholders.
 */
export type Translate = (key: MessageKey) => string;

export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

const PROBLEM_KEYS: Record<FileNameProblem, MessageKey> = {
  empty: 'name.empty',
  'dot-name': 'name.dotName',
  'invalid-char': 'name.invalidChar',
  'control-char': 'name.controlChar',
  'reserved-windows': 'name.reservedWindows',
  'trailing-dot-or-space': 'name.trailingDotOrSpace',
  'starts-with-dot': 'name.startsWithDot',
  'too-long': 'name.tooLong',
};

/** Every problem with a new name, explained; `null` when the name is fine. */
export function nameProblemMessage(t: Translate, name: string): string | null {
  const check = checkFileName(name);
  if (check.ok) return null;
  return check.problems
    .map((problem) =>
      problem === 'invalid-char'
        ? `${t(PROBLEM_KEYS[problem])} ${check.invalidChars.join(' ')}`
        : t(PROBLEM_KEYS[problem]),
    )
    .join(' ');
}

/** The explanation for a refused or failed operation. `message` is main's detail (e.g. the existing name). */
export function opErrorMessage(t: Translate, code: FileOpError | RequestError, message: string, name: string): string {
  switch (code) {
    case 'exists':
      return fill(t('op.exists'), { name: message || name });
    case 'case-conflict':
      return fill(t('op.caseConflict'), { name: message });
    case 'invalid-name':
      return nameProblemMessage(t, name) ?? t('op.generic');
    case 'interrupted':
      return fill(t('op.interrupted'), { name: message });
    case 'into-itself':
      return t('op.intoItself');
    case 'not-found':
      return t('op.notFound');
    case 'permission-denied':
      return t('op.permission');
    case 'busy':
      return t('op.busy');
    case 'outside-project':
      return t('op.outside');
    default:
      return t('op.generic');
  }
}
