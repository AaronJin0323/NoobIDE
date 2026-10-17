/**
 * Messages of the HTML/CSS authoring aids (S53) and JavaScript navigation (S57). Kept in their own file and spread
 * into zh-CN.ts / en.ts, so the features touch the shared dictionaries in one line each.
 */
export const authoringZhCN = {
  // S53.1 Emmet
  'command.toggleEmmet': 'Tab 展开 Emmet 缩写',
  'emmet.action': '展开 Emmet 缩写',
  'emmet.hint': 'Emmet 已把缩写展开成代码。不想要时，可在「编辑」菜单关闭「Tab 展开 Emmet 缩写」。',
  'emmet.hint.dismiss': '知道了',
  // S53.2
  'command.wrapWithTag': '用标签包住选中的代码',
  // S53.3
  'command.editColor': '编辑光标处的颜色',
  'color.status': '颜色：{value}',
  'color.edit': '编辑颜色',
  'color.dialog.title': '编辑颜色',
  'color.dialog.none': '光标不在 CSS 颜色值上。请把光标放在颜色值上（例如 #ff0000、rgb(255, 0, 0) 或 red），再试一次。',
  'color.hue': '色相',
  'color.saturation': '饱和度',
  'color.lightness': '亮度',
  'color.degrees': '{value} 度',
  'color.value': '颜色值',
  'color.invalid': 'NoobIDE 读不懂这个颜色值',
  'color.before': '原来的颜色：{value}',
  'color.after': '新的颜色：{value}',
  'color.apply': '应用',
  'color.cancel': '取消',
  'color.close': '关闭',
  // S53.4
  'command.toggleLineComment': '切换行注释',
  'command.toggleBlockComment': '切换块注释',
  'command.toggleFormatOnSave': '保存时整理格式',
  'formatOnSave.failed': '保存时没能整理格式：格式化工具报告了错误。文件已按原样保存。',
  'formatOnSave.timeout': '保存时没能整理格式：{seconds} 秒内没有完成。文件已按原样保存。',
  'formatOnSave.dismiss': '知道了',
  // S57.1
  'command.goToDefinition': '转到定义',
  'command.findReferences': '查找所有引用',
  'command.renameSymbol': '在所有脚本里重命名',
  'nav.definitions.title': '“{name}”的定义',
  'nav.references.title': '“{name}”在项目脚本里出现的地方（{count} 处）',
  'nav.none.definition':
    '在项目的 .js 文件里找不到“{name}”的定义。浏览器自带的名字（例如 document、console）没有可以打开的文件。',
  'nav.none.references': '在项目的 .js 文件里没有找到“{name}”。',
  'nav.unsupported.inline-script':
    '转到定义、查找引用和重命名只支持项目里的 .js 文件，不支持 HTML 页面里的 <script>。把代码放进单独的 .js 文件就可以用了。',
  'nav.unsupported.not-a-script': '转到定义、查找引用和重命名只支持项目里的 JavaScript（.js）文件。',
  'nav.location': '{file} 第 {line} 行',
  'nav.close': '关闭',
  // S57: the project's scripts are still being read (status strip while the command waits; notice after the bound)
  'nav.indexing.status': '正在读取项目脚本，读完就{command}…',
  'nav.indexing.timeout': '项目的脚本还在读取中，{seconds} 秒内没有读完。请稍等一会再试一次。',
  // S57.2
  'rename.title': '重命名“{name}”',
  'rename.newName': '新名字',
  'rename.preview': '预览改动',
  'rename.apply': '全部改名并保存',
  'rename.back': '返回',
  'rename.cancel': '取消',
  'rename.close': '关闭',
  'rename.previewTitle': '把“{old}”改名为“{new}”：{files} 个文件',
  'rename.fileChanges': '{file}（{count} 处）',
  'rename.line': '第 {line} 行',
  'rename.before': '原来',
  'rename.after': '改后',
  'rename.undoHint': '每个文件都会在标签页里打开；在那个标签页按 Ctrl+Z（macOS 上是 ⌘Z）可以单独撤销它的改动。',
  'rename.refused.not-a-script': '只能重命名项目里 .js 文件中的名字（不支持 HTML 页面里的 <script>）。',
  'rename.refused.not-renamable': '这里没有可以重命名的名字。',
  'rename.refused.built-in': '“{name}”是浏览器自带的名字，不能改。',
  'rename.refused.incomplete-project':
    '项目里的脚本太多或太大，语言服务没有全部读到，可能会漏掉用到的地方，所以不改名。',
  'rename.refused.indexing': '项目的脚本还在读取中，现在改名可能会漏掉用到的地方。请稍等一会再试一次。',
  'rename.refused.used-in-html': '“{name}”也写在 HTML 页面里（{detail}），语言服务看不到那里，所以不改名。',
  'rename.refused.unknown-file': '有用到的地方在 NoobIDE 不能安全修改的文件里，所以不改名。',
  'rename.refused.invalid-name':
    '“{detail}”不能当作 JavaScript 名字：只能用字母、数字、_ 和 $，不能以数字开头，也不能是关键字。',
  'rename.refused.same-name': '新名字和原来的一样。',
  'rename.refused.property':
    '属性和方法（例如 obj.count）不能在所有脚本里自动改名：JavaScript 不能确定哪些地方指的是同一个属性。',
  'rename.refused.name-taken':
    '“{detail}”里已经用到了这个新名字（browser 表示浏览器自带的名字），改名可能会改变代码的意思，所以不改名。',
  'rename.refused.pages-unknown': '有的 HTML 页面读不出来，无法确认它们有没有用到这个名字，所以不改名。',
  'rename.result.partial': '改名了，但有文件没有保存成功',
  'rename.status.renamed': '已改名并保存',
  'rename.status.save-failed': '已改名，但保存失败：改动留在它的标签页里，标签页会说明原因',
  'rename.status.changed': '没有改：预览之后这个文件变了（在磁盘上或编辑器里）',
  'rename.status.blocked': '没有改：这个文件现在不能修改（和磁盘上的版本冲突、已删除或只读）',
  'rename.status.unreadable': '没有改：打不开这个文件',
  'rename.status.skipped': '没有改：另一个文件不能改，所以所有文件都保持原样',
  'rename.result.ok': '改名完成',
  'rename.result.refused': '没有改名',
} as const;

export const authoringEn: Record<keyof typeof authoringZhCN, string> = {
  'command.toggleEmmet': 'Expand Emmet abbreviations with Tab',
  'emmet.action': 'Expand Emmet abbreviation',
  'emmet.hint':
    'Emmet expanded the abbreviation into code. To turn this off, use Edit › “Expand Emmet abbreviations with Tab”.',
  'emmet.hint.dismiss': 'Got it',
  'command.wrapWithTag': 'Wrap selection with tag',
  'command.editColor': 'Edit colour at cursor',
  'color.status': 'Colour: {value}',
  'color.edit': 'Edit colour',
  'color.dialog.title': 'Edit colour',
  'color.dialog.none':
    'The cursor is not on a CSS colour value. Put it on one (such as #ff0000, rgb(255, 0, 0) or red) and try again.',
  'color.hue': 'Hue',
  'color.saturation': 'Saturation',
  'color.lightness': 'Lightness',
  'color.degrees': '{value} degrees',
  'color.value': 'Colour value',
  'color.invalid': 'NoobIDE cannot read this colour value',
  'color.before': 'Current colour: {value}',
  'color.after': 'New colour: {value}',
  'color.apply': 'Apply',
  'color.cancel': 'Cancel',
  'color.close': 'Close',
  'command.toggleLineComment': 'Toggle line comment',
  'command.toggleBlockComment': 'Toggle block comment',
  'command.toggleFormatOnSave': 'Format on save',
  'formatOnSave.failed': 'Could not format on save: the formatter reported an error. The file was saved as it was.',
  'formatOnSave.timeout':
    'Could not format on save: formatting did not finish within {seconds} seconds. The file was saved as it was.',
  'formatOnSave.dismiss': 'Got it',
  'command.goToDefinition': 'Go to definition',
  'command.findReferences': 'Find all references',
  'command.renameSymbol': 'Rename in all scripts',
  'nav.definitions.title': 'Definitions of “{name}”',
  'nav.references.title': 'Where “{name}” is used in the project’s scripts ({count})',
  'nav.none.definition':
    'No definition of “{name}” in the project’s .js files. Names that come with the browser (such as document or console) have no file to open.',
  'nav.none.references': 'No uses of “{name}” found in the project’s .js files.',
  'nav.unsupported.inline-script':
    'Go to definition, find references and rename work in the project’s .js files only, not in an HTML page’s <script>. Move the code into its own .js file to use them.',
  'nav.unsupported.not-a-script':
    'Go to definition, find references and rename work in the project’s JavaScript (.js) files only.',
  'nav.location': '{file}, line {line}',
  'nav.close': 'Close',
  'nav.indexing.status': 'Reading the project’s scripts, then {command}…',
  'nav.indexing.timeout':
    'The project’s scripts are still being read and did not finish within {seconds} seconds. Wait a moment and try again.',
  'rename.title': 'Rename “{name}”',
  'rename.newName': 'New name',
  'rename.preview': 'Preview changes',
  'rename.apply': 'Rename and save all',
  'rename.back': 'Back',
  'rename.cancel': 'Cancel',
  'rename.close': 'Close',
  'rename.previewTitle': 'Rename “{old}” to “{new}” in {files} files',
  'rename.fileChanges': '{file} ({count})',
  'rename.line': 'Line {line}',
  'rename.before': 'Before',
  'rename.after': 'After',
  'rename.undoHint': 'Each file opens in a tab; Ctrl+Z (⌘Z on macOS) in that tab undoes its change on its own.',
  'rename.refused.not-a-script':
    'Only names in the project’s .js files can be renamed (not in an HTML page’s <script>).',
  'rename.refused.not-renamable': 'There is no name here that can be renamed.',
  'rename.refused.built-in': '“{name}” comes with the browser and cannot be renamed.',
  'rename.refused.incomplete-project':
    'The project has too many or too large scripts for the language service to read them all, so uses could be missed. Nothing was renamed.',
  'rename.refused.indexing':
    'The project’s scripts are still being read; a rename now could miss a use. Wait a moment and try again.',
  'rename.refused.used-in-html':
    '“{name}” is also written in HTML pages ({detail}), which the language service cannot see. Nothing was renamed.',
  'rename.refused.unknown-file': 'A use is in a file NoobIDE cannot change safely. Nothing was renamed.',
  'rename.refused.invalid-name':
    '“{detail}” cannot be a JavaScript name: use letters, digits, _ and $, do not start with a digit, and do not use a keyword.',
  'rename.refused.same-name': 'The new name is the same as the old one.',
  'rename.refused.property':
    'Properties and methods (such as obj.count) cannot be renamed in all scripts: JavaScript cannot tell for sure which uses mean the same property.',
  'rename.refused.name-taken':
    'The new name is already used in “{detail}” (browser: a name that comes with the browser), so renaming could change what the code means. Nothing was renamed.',
  'rename.refused.pages-unknown':
    'Some HTML pages could not be read, so NoobIDE cannot tell whether they use this name. Nothing was renamed.',
  'rename.result.partial': 'Renamed, but some files could not be saved',
  'rename.status.renamed': 'Renamed and saved',
  'rename.status.save-failed': 'Renamed, but the save failed: the change is kept in its tab, which says why',
  'rename.status.changed': 'Not changed: the file changed after the preview (on disk or in the editor)',
  'rename.status.blocked': 'Not changed: the file cannot be changed now (conflict with the disk, deleted or read-only)',
  'rename.status.unreadable': 'Not changed: the file could not be opened',
  'rename.status.skipped': 'Not changed: another file was refused, so every file was left as it was',
  'rename.result.ok': 'Rename done',
  'rename.result.refused': 'Nothing was renamed',
};
