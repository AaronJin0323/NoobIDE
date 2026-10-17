import type { MessageKey } from '../i18n/index';
import { formatBytes } from '../recovery/format';
import { MAX_IMPORT_FILE_BYTES, type ImportRefusal } from '../../shared/import-rules';
import { IMAGE_EXTENSIONS } from '../../shared/image-files';
import { COPY_LIMITS } from '../../shared/copy-limits';
import { fill } from './file-op-messages';

/**
 * S52.4: why a file from outside was not added, naming the limit or the type, so a beginner knows what to do. Pure:
 * every refusal is unit-tested to have a message in both languages.
 */
type Translate = (key: MessageKey) => string;

/** The ending as the user wrote it (`.BAT` stays `.BAT`). */
function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

export function importRefusalMessage(
  t: Translate,
  refusal: ImportRefusal,
  name: string,
  kind: 'file' | 'directory' | 'other' = 'file',
  detail = '',
): string {
  const limit = formatBytes(MAX_IMPORT_FILE_BYTES);
  switch (refusal) {
    case 'too-large':
      return kind === 'directory'
        ? fill(t('import.folderTooLarge'), {
            name,
            files: String(COPY_LIMITS.maxEntries),
            size: `${COPY_LIMITS.maxBytes / 1024 ** 3} GB`,
          })
        : fill(t('import.tooLarge'), { name, limit });
    case 'refused-type':
      return fill(t('import.refusedType'), { name, ext: extensionOf(name) });
    case 'contains-refused':
      return fill(t('import.containsRefused'), { name, inner: detail, ext: extensionOf(detail) });
    case 'contains-too-large':
      return fill(t('import.containsTooLarge'), { name, inner: detail, limit });
    case 'not-an-image':
      return fill(t('import.notImage'), { name, types: IMAGE_EXTENSIONS.map((e) => e.slice(1)).join(', ') });
    case 'not-a-file':
      return fill(t('import.notAFile'), { name });
  }
}

/** Codes of a failed import that only a new name can solve (the user is asked to rename or skip). */
export function needsNewName(code: string): boolean {
  return code === 'exists' || code === 'case-conflict' || code === 'invalid-name';
}

export function isImportRefusal(code: string): code is ImportRefusal {
  return (
    code === 'too-large' ||
    code === 'refused-type' ||
    code === 'not-an-image' ||
    code === 'not-a-file' ||
    code === 'contains-refused' ||
    code === 'contains-too-large'
  );
}
