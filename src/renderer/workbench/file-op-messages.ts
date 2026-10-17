import type { MessageKey } from '../i18n/index';
import type { FileOpError, RequestError } from '../../shared/ipc/contract';
import { checkFileName, type FileNameProblem } from '../../shared/file-names';
import { protectedFolderKey, type PlatformId } from '../../platform/labels';

/**
 * Explanations for file operations (S08.2–S08.4). Pure so every refusal is tested to have a message; the text
 * itself lives in the i18n dictionaries. Templates use `{name}` and `{trash}` placeholders.
 */
export type Translate = (key: MessageKey) => string;

export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** The platform preload exposes; `other` outside the app (unit tests, no bridge). */
export function rendererPlatform(): PlatformId {
  return (typeof window === 'undefined' ? undefined : window.noobide?.platform) ?? 'other';
}

/**
 * Why writing a file failed (a WriteFileError / FileOpError code), as a plain explanation. Shared by the save
 * banner, "save a copy", AI proposals and fix cards, so no surface shows the raw code ('permission-denied') itself.
 */
export function saveErrorKey(code: string, platform: PlatformId = rendererPlatform()): MessageKey {
  switch (code) {
    case 'protected-folder':
      return protectedFolderKey(platform); // S25.3
    case 'permission-denied':
      return 'save.error.permission';
    case 'busy':
      return 'save.error.busy';
    case 'disk-full':
      return 'save.error.diskFull';
    case 'not-found':
      return 'save.error.notFound';
    default:
      return 'save.error.generic';
  }
}

/** S25.3: the OS privacy protection blocked the folder; says how to allow NoobIDE on this platform. */
export function protectedFolderMessage(t: Translate, platform: PlatformId = rendererPlatform()): string {
  return t(protectedFolderKey(platform));
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
  return nameProblemsText(t, check.problems, check.invalidChars);
}

/** The explanations of the given name problems (S13.5 reuses them for names found in a transferred project). */
export function nameProblemsText(
  t: Translate,
  problems: readonly FileNameProblem[],
  invalidChars: readonly string[],
): string {
  return problems
    .map((problem) =>
      problem === 'invalid-char' ? `${t(PROBLEM_KEYS[problem])} ${invalidChars.join(' ')}` : t(PROBLEM_KEYS[problem]),
    )
    .join(' ');
}

/** The explanation for a refused or failed operation. `message` is main's detail (e.g. the existing name). */
export function opErrorMessage(
  t: Translate,
  code: FileOpError | RequestError,
  message: string,
  name: string,
  platform: PlatformId = rendererPlatform(),
): string {
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
    case 'not-a-folder':
      return t('op.notAFolder'); // S52.1
    case 'not-found':
      return t('op.notFound');
    case 'permission-denied':
      return t('op.permission');
    case 'protected-folder':
      return protectedFolderMessage(t, platform);
    case 'busy':
      return t('op.busy');
    case 'outside-project':
      return t('op.outside');
    default:
      return t('op.generic');
  }
}
