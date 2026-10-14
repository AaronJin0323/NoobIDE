import { useI18n } from '../i18n/I18nProvider';
import { fileRoleDetailKey, fileRoleFor, fileRoleLabelKey } from './file-role';

/**
 * S20.3 presentational pieces. Both render nothing for files without a role, so they can be dropped into any file row
 * or editor header without layout changes elsewhere.
 */

/** Short role label after a file name in a file row, e.g. "index.html 页面结构". The tooltip carries the detail. */
export function FileRoleTag({ relPath }: { relPath: string }) {
  const { t } = useI18n();
  const role = fileRoleFor(relPath);
  if (!role) return null;
  return (
    <span className="file-role" data-testid="file-role" data-role={role} title={t(fileRoleDetailKey(role))}>
      {t(fileRoleLabelKey(role))}
    </span>
  );
}

/** One-line hint above the editor: "页面结构：写网页上有什么内容（标题、段落、按钮、图片）。" */
export function FileRoleHint({ relPath }: { relPath: string }) {
  const { t } = useI18n();
  const role = fileRoleFor(relPath);
  if (!role) return null;
  return (
    <p
      className="file-role-hint"
      role="note"
      aria-label={t('fileRole.hintLabel')}
      data-testid="file-role-hint"
      data-role={role}
    >
      <strong>{t(fileRoleLabelKey(role))}</strong>
      <span>{t(fileRoleDetailKey(role))}</span>
    </p>
  );
}
