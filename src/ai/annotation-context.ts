/**
 * S41.6: the text of an Annotation chip — exactly what the AI assistant receives about one preview annotation
 * (decision 0030). Main process only, no Electron. The note is the user's words; the element's text and the code
 * excerpts come from the page and the project, so the request frames all of it as data (prompts.ts / the agent's
 * nonce frame + neutralizeData). Nothing here logs.
 */
import type {
  AnnotationContext,
  AnnotationLocation,
  AnnotationSource,
  AnnotationTarget,
} from '../shared/ipc/annotations-contract';
import { numberedExcerpt } from '../preview/source-locate';

export const ANNOTATION_CONTEXT_LIMITS = {
  htmlLines: 30,
  cssLines: 20,
  cssRulesWithExcerpt: 6,
  textChars: 8_000,
  labelNoteChars: 30,
} as const;

export type AnnotationLocale = 'zh-CN' | 'en';

const LABELS = {
  'zh-CN': {
    heading: (n: number) => `标注 ${n}`,
    note: '用户的要求',
    page: '页面',
    startPage: '（项目的首页）',
    element: '指向的元素',
    selector: '选择器',
    size: (w: number, h: number) => `在屏幕上 ${w}×${h} 像素`,
    region: (w: number, h: number, x: number, y: number) =>
      `用户画了一个区域：${w}×${h} 像素，位置 (${x}, ${y})；下面是包含这个区域的最小元素`,
    html: 'HTML 位置',
    lines: (a: number, b: number) => (a === b ? `第 ${a} 行` : `第 ${a}–${b} 行`),
    exact: '确切匹配',
    approximate: '大致匹配（页面和文件不完全一样，请核对）',
    notFound: '在 HTML 文件里没找到这个元素：它可能是脚本创建的。请根据选择器在脚本或 HTML 里找到它。',
    noFile: '读不到这个页面的 HTML 文件。',
    css: '给它设置样式的 CSS 规则',
    noCss: '给它设置样式的 CSS 规则：没有找到（可以新增一条规则）',
    more: (n: number) => `还有 ${n} 条规则（没有列出代码）`,
    label: (n: number, note: string) => `标注 ${n}：${note}`,
    instruction: '请修改上面标出的文件和行（视觉上的改动优先改列出的 CSS 规则），只改和这个要求有关的部分。',
  },
  en: {
    heading: (n: number) => `Annotation ${n}`,
    note: "The user's request",
    page: 'Page',
    startPage: "(the project's start page)",
    element: 'Element pointed at',
    selector: 'selector',
    size: (w: number, h: number) => `${w}×${h} px on screen`,
    region: (w: number, h: number, x: number, y: number) =>
      `The user drew an area of ${w}×${h} px at (${x}, ${y}); below is the smallest element that contains it`,
    html: 'HTML location',
    lines: (a: number, b: number) => (a === b ? `line ${a}` : `lines ${a}–${b}`),
    exact: 'exact match',
    approximate: 'approximate match (the page and the file differ; please check)',
    notFound:
      'This element was not found in the HTML file: a script probably creates it. Use the selector to find it in the scripts or the HTML.',
    noFile: "The page's HTML file could not be read.",
    css: 'CSS rules that style it',
    noCss: 'CSS rules that style it: none found (a new rule can be added)',
    more: (n: number) => `${n} more rule(s) (code not listed)`,
    label: (n: number, note: string) => `Annotation ${n}: ${note}`,
    instruction:
      'Change the file and lines named above (for visual changes prefer the CSS rules listed), and only what this request is about.',
  },
} as const;

const quote = (s: string) => JSON.stringify(s);

/** `<button id="send" class="cta big"> "发送"` */
export function describeTarget(target: AnnotationTarget): string {
  const attrs = [
    target.id ? `id=${quote(target.id)}` : '',
    target.classes.length ? `class=${quote(target.classes.join(' '))}` : '',
  ].filter(Boolean);
  return `<${target.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${target.text ? ` ${quote(target.text)}` : ''}`;
}

export interface AnnotationInput {
  readonly id: string;
  /** 1-based number in the project's list. */
  readonly number: number;
  readonly note: string;
  readonly target: AnnotationTarget;
  readonly source: AnnotationSource;
}

/** Text of a project file (by project-relative path) for the excerpts, or null. */
export type ReadRelText = (relPath: string) => Promise<string | null>;

export async function annotationContext(
  input: AnnotationInput,
  locale: AnnotationLocale,
  readText: ReadRelText,
): Promise<AnnotationContext> {
  const l = LABELS[locale];
  const colon = locale === 'zh-CN' ? '：' : ': ';
  const { target, source } = input;
  const round = (v: number) => Math.round(v);
  const lines: string[] = [
    l.heading(input.number),
    `${l.note}${colon}${quote(input.note)}`,
    `${l.page}${colon}${target.pagePath || l.startPage}`,
  ];
  if (target.kind === 'region' && target.region) {
    const r = target.region;
    lines.push(l.region(round(r.width), round(r.height), round(r.x), round(r.y)));
  }
  lines.push(
    `${l.element}${colon}${describeTarget(target)} (${l.selector}: ${target.selector}), ${l.size(round(target.rect.width), round(target.rect.height))}`, // prettier-ignore
  );
  const where = (loc: AnnotationLocation) => `${loc.relPath} ${l.lines(loc.startLine, loc.endLine)}`;
  if (source.html) {
    lines.push(`${l.html}${colon}${where(source.html)} (${source.html.match === 'exact' ? l.exact : l.approximate})`);
    const text = await readText(source.html.relPath);
    if (text !== null) lines.push(numberedExcerpt(text, { ...source.html, startOffset: 0, endOffset: 0 }, ANNOTATION_CONTEXT_LIMITS.htmlLines)); // prettier-ignore
  } else {
    lines.push(`${l.html}${colon}${source.state === 'no-file' ? l.noFile : l.notFound}`);
  }
  if (source.css.length === 0) lines.push(l.noCss);
  else {
    lines.push(`${l.css}${colon.trim()}`);
    for (const [i, rule] of source.css.entries()) {
      if (i >= ANNOTATION_CONTEXT_LIMITS.cssRulesWithExcerpt) {
        lines.push(l.more(source.css.length - i));
        break;
      }
      lines.push(`- ${where(rule)} (${rule.selector})`);
      const text = await readText(rule.relPath);
      if (text !== null) lines.push(numberedExcerpt(text, { ...rule, startOffset: 0, endOffset: 0 }, ANNOTATION_CONTEXT_LIMITS.cssLines)); // prettier-ignore
    }
  }
  lines.push(l.instruction);
  let text = lines.join('\n');
  if (text.length > ANNOTATION_CONTEXT_LIMITS.textChars)
    text = `${text.slice(0, ANNOTATION_CONTEXT_LIMITS.textChars)}…`;
  const primary = source.html ?? source.css[0] ?? null;
  const flatNote = input.note.replace(/\s+/g, ' ').trim();
  const shortNote =
    flatNote.length > ANNOTATION_CONTEXT_LIMITS.labelNoteChars
      ? `${flatNote.slice(0, ANNOTATION_CONTEXT_LIMITS.labelNoteChars)}…`
      : flatNote;
  return {
    id: input.id,
    label: l.label(input.number, shortNote || describeTarget(target)),
    text,
    ...(primary ? { relPath: primary.relPath, startLine: primary.startLine, endLine: primary.endLine } : {}),
    ranges: [source.html, ...source.css]
      .filter((r): r is AnnotationLocation => r !== null)
      .map((r) => ({ relPath: r.relPath, startLine: r.startLine, endLine: r.endLine })),
  };
}
