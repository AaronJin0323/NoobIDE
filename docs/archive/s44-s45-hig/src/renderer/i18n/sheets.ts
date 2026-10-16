/**
 * S45.4 messages of the shared sheet anatomy: the one-line descriptions under sheet titles and the questions asked
 * before a destructive action (the action itself is named with its verb). Spread into zh-CN.ts / en.ts.
 */
export const sheetsZhCN = {
  'wizard.description': '选一个模板，起个名字，NoobIDE 会为你建好文件夹。',
  'history.backupNote': '历史不能代替你自己的备份。',
  'recovery.discardQuestion': '丢弃后，这份修改将无法找回。',
  'recovery.clearQuestion': '清除后，这些未保存的修改将无法找回。',
} as const;

export const sheetsEn: Record<keyof typeof sheetsZhCN, string> = {
  'wizard.description': 'Pick a template and a name; NoobIDE makes the folder for you.',
  'history.backupNote': 'History is not a replacement for your own backups.',
  'recovery.discardQuestion': 'Once discarded, these changes cannot be brought back.',
  'recovery.clearQuestion': 'Once cleared, these unsaved changes cannot be brought back.',
};
