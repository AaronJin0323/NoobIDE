import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { RoleHintMemory, fileRoleDetailKey, fileRoleFor, fileRoleLabelKey, roleHintKey } from './file-role';

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

/** One per app run: which files have had their first showing (S47.5). */
const memory = new RoleHintMemory();

/**
 * One-line hint above the editor: "页面结构：写网页上有什么内容（标题、段落、按钮、图片）。"
 * S47.5: shown the first time a file is the active tab and collapsed once the user has moved to another file, so at
 * most one persistent band sits above the code; the tree's role tag and the tab's tooltip keep the role afterwards.
 */
export function FileRoleHint({ relPath, projectId }: { relPath: string; projectId: string | null }) {
  const { t } = useI18n();
  const role = fileRoleFor(relPath);
  const key = roleHintKey(projectId, relPath);
  const [expanded, setExpanded] = useState(() => memory.firstShowing(key));
  // The showing of the previous file ends when another file becomes active (not on unmount: React's development
  // double-mount would otherwise count as a showing).
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current !== key) {
      memory.markShown(previous.current);
      previous.current = key;
    }
    setExpanded(memory.firstShowing(key));
  }, [key]);
  if (!role || !expanded) return null;
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
