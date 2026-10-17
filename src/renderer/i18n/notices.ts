/**
 * S50.2: short copy of the app notices (entry page, transfer report, settings file, journal health). Every notice is
 * a one-line title plus at most one sentence; longer text sits behind the "Details" disclosure. Spread into
 * zh-CN.ts / en.ts in one line each.
 */
export const noticesZhCN = {
  'notice.details': '详细信息',
  'notice.entry.title': '已设为入口页面：{file}',
  'notice.entry.body': '下次启动预览时会先打开它。',
  'notice.entry.detail': '设置保存在项目的 .noobide/project.json 里，删掉这个文件也不影响网页。',
  'notice.entry.failedTitle': '没能保存入口页面的设置',
  'notice.entry.invalidTitle': '入口页面没有修改',
  'notice.entry.invalidBody': '项目里的 .noobide/project.json 内容无法识别，为了不覆盖它，没有修改。',
  'notice.transfer.title': '换到另一个系统时可能出问题',
  'notice.transfer.body': '在 Windows 和 macOS 之间转移前请留意这些问题，NoobIDE 没有改动任何文件。',
  'notice.transfer.details': '查看 {n} 个问题',
  'notice.settings.corruptTitle': '设置文件已损坏，无法读取',
  'notice.settings.newerTitle': '设置文件来自更新版本的 NoobIDE',
  'notice.settings.newerBody': '能看懂的设置照常使用，但这次运行中的改动不会保存。',
  'notice.journal.title': '无法写入崩溃恢复副本',
  'notice.journal.body': '崩溃恢复现在没有保护你的修改，请尽快保存文件。',
} as const;

export const noticesEn: Record<keyof typeof noticesZhCN, string> = {
  'notice.details': 'Details',
  'notice.entry.title': 'Entry page set: {file}',
  'notice.entry.body': 'The preview opens it first next time.',
  'notice.entry.detail':
    'The setting is kept in the project’s .noobide/project.json; deleting that file does not affect the page.',
  'notice.entry.failedTitle': 'The entry page setting could not be saved',
  'notice.entry.invalidTitle': 'The entry page was not changed',
  'notice.entry.invalidBody': 'The project’s .noobide/project.json could not be read, so it was left as it is.',
  'notice.transfer.title': 'This project may break on another system',
  'notice.transfer.body': 'Check these issues before moving it between Windows and macOS; NoobIDE changed no files.',
  'notice.transfer.details': 'Show {n} issues',
  'notice.settings.corruptTitle': 'The settings file is damaged',
  'notice.settings.newerTitle': 'The settings file is from a newer NoobIDE',
  'notice.settings.newerBody': 'The settings this version understands are used, but changes made now are not saved.',
  'notice.journal.title': 'The crash-recovery copy could not be written',
  'notice.journal.body': 'Crash recovery is not protecting your edits right now; save your files soon.',
};
