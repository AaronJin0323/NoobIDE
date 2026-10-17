/** Messages of the S52.6 image viewer tab. Spread into zh-CN.ts / en.ts like the other feature files. */
export const imageViewerZhCN = {
  'image.label': '图片“{name}”',
  'image.dimensions': '{width} × {height} 像素',
  'image.copyTag': '复制 <img> 标签',
  'image.copyPath': '复制相对路径',
  'image.relativeTo': '复制的路径相对于“{file}”。',
  'image.relativeToDefault': '复制的路径相对于项目里的 index.html。先打开一个网页文件，路径就会相对于它。',
  'image.copied': '已复制：{text}',
  'image.copyFailed': '没能复制到剪贴板。',
  'image.failed': '这张图片显示不出来：文件可能已损坏、太大，或者不是它的扩展名所说的格式。',
} as const;

export const imageViewerEn: Record<keyof typeof imageViewerZhCN, string> = {
  'image.label': 'Image “{name}”',
  'image.dimensions': '{width} × {height} pixels',
  'image.copyTag': 'Copy <img> tag',
  'image.copyPath': 'Copy relative path',
  'image.relativeTo': 'Copied paths are relative to “{file}”.',
  'image.relativeToDefault':
    'Copied paths are relative to index.html in the project. Open a web page file first and they are relative to it.',
  'image.copied': 'Copied: {text}',
  'image.copyFailed': 'Could not copy to the clipboard.',
  'image.failed': 'This image cannot be shown: the file may be damaged, too large, or not the format its ending says.',
};
