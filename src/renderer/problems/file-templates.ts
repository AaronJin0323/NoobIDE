/**
 * S55.3: the small starting text of a file created by the "create the missing file" quick fix. It goes into the new
 * (empty) file as an ordinary editor edit, so it is undoable and saved like typing. Plain, valid and quiet: a page
 * created from it reports no beginner problem itself.
 */
import type { CreateFileAction } from './fix-model';

export type TemplateLocale = 'zh-CN' | 'en';

const nameOf = (path: string) => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

/** Text inserted as-is into an HTML page; the name comes from the file name the user wrote. */
const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export function newFileTemplate(action: Pick<CreateFileAction, 'path' | 'template'>, locale: TemplateLocale): string {
  const name = nameOf(action.path);
  switch (action.template) {
    case 'html':
      return [
        '<!doctype html>',
        `<html lang="${locale}">`,
        '  <head>',
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        `    <title>${escapeHtml(name)}</title>`,
        '  </head>',
        '  <body>',
        `    <h1>${escapeHtml(name)}</h1>`,
        '  </body>',
        '</html>',
        '',
      ].join('\n');
    case 'css':
      return locale === 'zh-CN' ? `/* ${name}：在这里写样式。 */\n` : `/* ${name}: write your styles here. */\n`;
    case 'js':
      return locale === 'zh-CN' ? `// ${name}：在这里写脚本。\n` : `// ${name}: write your script here.\n`;
  }
}
