/**
 * S45.2: short copy of the file notices (disk change, session, transfer, entry page, settings, save error). Every
 * notice is a one-line title plus at most one sentence; longer explanations live in tooltips and accessible
 * descriptions. Kept in its own file and spread into zh-CN.ts / en.ts, so the feature touches the shared dictionaries
 * in one line each.
 */
export const noticesZhCN = {
  'notice.conflict.title': '“{file}”在 NoobIDE 之外被改过了',
  'notice.conflict.body': '你也有没保存的修改，两边都没有被覆盖：先比较，再选择保留哪个版本。',
  'notice.conflict.keepMine': '保留我的版本',
  'notice.conflict.keepMineHint': '用编辑器里的内容覆盖磁盘上的文件。',
  'notice.deleted.title': '“{file}”已在磁盘上被删除或移走',
  'notice.deleted.body': '内容还在编辑器里，可以重新保存到原位置，或另存一份。',
  'notice.deleted.confirmBody': '磁盘上已经没有这个文件，关闭后这些内容不会保留。',
  'notice.deleted.closeConfirm': '确定关闭',
  'notice.reloaded.title': '已载入“{file}”的新版本',
  'notice.reloaded.body': '它在 NoobIDE 之外被修改了，用“撤销”可以回到之前的内容。',
  'notice.session.title': '已重新打开上次的项目',
  'notice.transfer.title': '换到另一个系统时可能出问题',
  'notice.transfer.body': '在 Windows 和 macOS 之间转移前请留意下面几点，NoobIDE 没有改动任何文件。',
  'notice.entry.title': '已设为入口页面：{file}',
  'notice.entry.body': '下次启动预览时会先打开它。',
  'notice.save.body': '你的修改还在编辑器里，解决问题后再保存即可。',
  'notice.settings.newerBody': '能看懂的设置照常使用，但这次运行中的改动不会保存。',
} as const;

export const noticesEn: Record<keyof typeof noticesZhCN, string> = {
  'notice.conflict.title': '“{file}” changed outside NoobIDE',
  'notice.conflict.body':
    'You have unsaved changes too and neither side was overwritten: compare, then pick a version.',
  'notice.conflict.keepMine': 'Keep mine',
  'notice.conflict.keepMineHint': 'Overwrite the file on disk with the text in the editor.',
  'notice.deleted.title': '“{file}” was deleted or moved on disk',
  'notice.deleted.body': 'Its text is still in the editor; save it again where it was, or save a copy.',
  'notice.deleted.confirmBody': 'The file no longer exists on disk, so its text will not be kept after closing.',
  'notice.deleted.closeConfirm': 'Close anyway',
  'notice.reloaded.title': 'Loaded the new version of “{file}”',
  'notice.reloaded.body': 'It was changed outside NoobIDE; Undo brings the previous text back.',
  'notice.session.title': 'Reopened your last project',
  'notice.transfer.title': 'This project may break on another system',
  'notice.transfer.body':
    'Check these points before moving it between Windows and macOS; NoobIDE did not change any file.',
  'notice.entry.title': 'Entry page set: {file}',
  'notice.entry.body': 'Starting the preview opens it first.',
  'notice.save.body': 'Your edits are still in the editor; save again once the cause is fixed.',
  'notice.settings.newerBody': 'Settings this version understands still apply, but changes made now are not saved.',
};
