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
};
