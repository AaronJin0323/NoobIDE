/**
 * Messages of S52 complete file management: move, copy/paste/duplicate, multi-select, import and the image viewer.
 * Spread into zh-CN.ts / en.ts like the other feature files.
 */
export const fileManagementZhCN = {
  // --- S52.1 move ---
  'menu.moveTo': '移动到…',
  'move.title': '移动“{name}”',
  'move.titleMany': '移动 {n} 项',
  'move.filter': '筛选文件夹',
  'move.filterPlaceholder': '输入文件夹名称',
  'move.folders': '要移动到的文件夹',
  'move.root': '{name}（项目文件夹）',
  'move.loading': '正在列出文件夹…',
  'move.none': '没有符合的文件夹。',
  'move.truncated': '文件夹太多，只列出了前面一部分。输入名称可以筛选。',
  'move.confirm': '移动到这里',
  'move.cancel': '取消',
  'move.sameFolder': '已经在这个文件夹里了。',
  'move.keys': '↑ ↓ 选择文件夹 · Enter 移动 · Esc 取消',
  'move.dropInto': '松开鼠标，移动到“{folder}”',
  'move.done': '已移动到“{folder}”。',
  'move.partial': '有 {n} 项没有移动：',
  'op.notAFolder': '目标不是文件夹。',
} as const;

export const fileManagementEn: Record<keyof typeof fileManagementZhCN, string> = {
  'menu.moveTo': 'Move to…',
  'move.title': 'Move “{name}”',
  'move.titleMany': 'Move {n} items',
  'move.filter': 'Filter folders',
  'move.filterPlaceholder': 'Type a folder name',
  'move.folders': 'Folder to move into',
  'move.root': '{name} (project folder)',
  'move.loading': 'Listing folders…',
  'move.none': 'No folder matches.',
  'move.truncated': 'There are many folders; only the first ones are listed. Type a name to filter.',
  'move.confirm': 'Move here',
  'move.cancel': 'Cancel',
  'move.sameFolder': 'Already in this folder.',
  'move.keys': '↑ ↓ choose a folder · Enter move · Esc cancel',
  'move.dropInto': 'Release to move into “{folder}”',
  'move.done': 'Moved to “{folder}”.',
  'move.partial': 'Not moved ({n}):',
  'op.notAFolder': 'The destination is not a folder.',
};
