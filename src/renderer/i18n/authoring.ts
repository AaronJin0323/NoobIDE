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
} as const;

export const authoringEn: Record<keyof typeof authoringZhCN, string> = {
  'command.toggleEmmet': 'Expand Emmet abbreviations with Tab',
  'emmet.action': 'Expand Emmet abbreviation',
  'emmet.hint':
    'Emmet expanded the abbreviation into code. To turn this off, use Edit › “Expand Emmet abbreviations with Tab”.',
  'emmet.hint.dismiss': 'Got it',
};
