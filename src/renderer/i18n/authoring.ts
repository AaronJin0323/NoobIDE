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
};
