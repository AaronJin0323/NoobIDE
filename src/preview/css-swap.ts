/**
 * S54.2/S54.3: updating linked stylesheets of the running preview without a reload (docs/decisions/0037). Main
 * process only; structural Electron types keep it unit-testable.
 *
 * Over the page guard's existing DevTools protocol session (decision 0016), with the DOM domain borrowed from the
 * element picker's counter (decision 0030): `CSS.enable` reports every stylesheet of the document
 * (`CSS.styleSheetAdded`), the sheets a `<link>` of the main frame loads from a saved file get the file's text with
 * `CSS.setStyleSheetText`, and the domains are disabled again. Nothing runs in the page, no element or attribute
 * changes, no request is made and no IPC is added. Anything the swap cannot do is a reason for a full reload.
 */
import { readFile, stat } from 'node:fs/promises';
import type { PreviewReloadReason } from '../shared/ipc/preview-contract';
import type { Locale } from '../renderer/i18n/index';
import { resolveInRoot } from './request-path';

/** Why a save reloaded the page instead of swapping its styles (decision 0037's fallback table). */
export type CssReloadReason = PreviewReloadReason;

export const CSS_SWAP_LIMITS = {
  /** A saved stylesheet larger than this is reloaded instead of swapped. */
  maxBytes: 1024 * 1024,
  /** One protocol command is waited for at most this long. */
  commandTimeoutMs: 2_000,
  /** The whole swap (enable, match, set, disable). */
  totalTimeoutMs: 5_000,
} as const;

/** Whether a project path is a stylesheet (only `.css`; case-insensitive like the static server's MIME map). */
export function isCssPath(relPath: string): boolean {
  return /\.css$/iu.test(relPath);
}

/** Project paths are compared with '/' separators (relPath comes portable; be lenient with Windows separators). */
export function portablePath(relPath: string): string {
  return relPath.replace(/\\/gu, '/').replace(/^\/+/u, '');
}

export type CssSyntaxKind = 'unclosed-block' | 'unexpected-close' | 'unclosed-comment' | 'unclosed-string';

export interface CssSyntaxIssue {
  readonly kind: CssSyntaxKind;
  /** 1-based line where the problem starts. */
  readonly line: number;
}

export interface CssScan {
  readonly syntax: CssSyntaxIssue | null;
  /** An `@import` rule (outside comments and strings). */
  readonly hasImport: boolean;
}

/**
 * A small CSS tokenizer: comments, strings (with escapes), braces. It finds what breaks the structure of a
 * stylesheet — an unclosed `{`, a stray `}`, an unclosed comment or string — not every grammar error (an unknown
 * property is the static checks' job, and CSS skips it anyway).
 */
export function scanCss(text: string): CssScan {
  let line = 1;
  const open: number[] = [];
  let hasImport = false;
  let syntax: CssSyntaxIssue | null = null;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const start = line;
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let j = i; j < stop; j += 1) if (text[j] === '\n') line += 1;
      if (end === -1) return { syntax: syntax ?? { kind: 'unclosed-comment', line: start }, hasImport };
      i = stop;
    } else if (c === '"' || c === "'") {
      const start = line;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') {
          if (text[j + 1] === '\n') line += 1; // an escaped newline continues the string
          j += 2;
          continue;
        }
        if (d === '\n') break; // an unescaped newline ends a string badly
        if (d === c) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) syntax ??= { kind: 'unclosed-string', line: start };
      i = j;
    } else if (c === '\\') {
      i += 2; // an escaped character in an identifier
    } else if (c === '{') {
      open.push(line);
      i += 1;
    } else if (c === '}') {
      if (open.length === 0) syntax ??= { kind: 'unexpected-close', line };
      else open.pop();
      i += 1;
    } else if (c === '@' && /^@import\b/iu.test(text.slice(i, i + 8))) {
      hasImport = true;
      i += 7;
    } else {
      i += 1;
    }
  }
  const unclosed = open[open.length - 1];
  if (unclosed !== undefined) syntax ??= { kind: 'unclosed-block', line: unclosed };
  return { syntax, hasImport };
}

/** The `CSS.styleSheetAdded` header fields the swap reads. */
export interface SheetHeader {
  readonly styleSheetId: string;
  readonly sourceURL: string;
  readonly frameId: string;
  /** Backend id of the owning `<link>` / `<style>`; absent for a sheet loaded by `@import`. */
  readonly ownerNode?: number;
  readonly isInline?: boolean;
}

export function parseSheetHeader(value: unknown): SheetHeader | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.styleSheetId !== 'string' || typeof v.sourceURL !== 'string' || typeof v.frameId !== 'string') {
    return null;
  }
  // A `/*# sourceURL=… */` comment lets page CSS claim any URL: such a sheet is not the file it names.
  if (v.hasSourceURL === true) return null;
  return {
    styleSheetId: v.styleSheetId,
    sourceURL: v.sourceURL,
    frameId: v.frameId,
    ...(typeof v.ownerNode === 'number' ? { ownerNode: v.ownerNode } : {}),
    ...(v.isInline === true ? { isInline: true } : {}),
  };
}

/** The project path a stylesheet URL of the preview's own server maps to (query and hash ignored). */
export function projectPathOfSheet(sourceURL: string, origin: string): string | null {
  try {
    const url = new URL(sourceURL);
    if (url.origin !== origin) return null;
    return portablePath(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}

export type SheetMatch =
  | { readonly ok: true; readonly sheets: ReadonlyMap<string, readonly string[]> }
  | { readonly ok: false; readonly reason: CssReloadReason };

/**
 * Which sheets to replace for each saved file. Every file must be loaded by at least one `<link>` of the main frame;
 * a matching sheet in another frame (`frame`) or without an owner node (pulled in by `@import`: `import`) means a
 * reload, as does a file no sheet loads (`not-linked`).
 */
export function matchSheets(
  headers: readonly SheetHeader[],
  paths: readonly string[],
  origin: string,
  mainFrameId: string,
): SheetMatch {
  const sheets = new Map<string, string[]>();
  for (const raw of paths) {
    const path = portablePath(raw);
    const matching = headers.filter((h) => !h.isInline && projectPathOfSheet(h.sourceURL, origin) === path);
    if (matching.some((h) => h.frameId !== mainFrameId)) return { ok: false, reason: 'frame' };
    if (matching.some((h) => h.ownerNode === undefined)) return { ok: false, reason: 'import' };
    if (matching.length === 0) return { ok: false, reason: 'not-linked' };
    sheets.set(
      path,
      matching.map((h) => h.styleSheetId),
    );
  }
  return { ok: true, sheets };
}

export interface SwapDebugger {
  isAttached(): boolean;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): void;
  off(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): void;
}

export interface SavedStylesheet {
  readonly relPath: string;
  /** The file's text as saved (read from disk by the caller). */
  readonly text: string;
}

export type SwapOutcome =
  | { readonly ok: true; readonly sheets: number }
  | {
      readonly ok: false;
      readonly reason: CssReloadReason;
      readonly file?: string;
      readonly line?: number;
      readonly kind?: CssSyntaxKind;
    };

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The checks on the saved text alone (before the page is asked anything). */
export function precheckStylesheets(files: readonly SavedStylesheet[]): SwapOutcome | null {
  const scans = files.map((file) => ({ file, scan: scanCss(file.text) }));
  for (const { file, scan } of scans) {
    if (scan.syntax) {
      return { ok: false, reason: 'syntax', file: file.relPath, line: scan.syntax.line, kind: scan.syntax.kind };
    }
  }
  const imports = scans.find(({ scan }) => scan.hasImport);
  return imports ? { ok: false, reason: 'import', file: imports.file.relPath } : null;
}

/**
 * Replaces the saved stylesheets' text in the page. `useDom` runs the work while the DOM domain is on (the element
 * picker's counter, so a pick in progress keeps it). Never throws: every failure is `{ ok: false, reason }`.
 */
export async function swapStylesheets(
  dbg: SwapDebugger | null,
  files: readonly SavedStylesheet[],
  options: {
    readonly origin: string;
    readonly useDom: <T>(work: () => Promise<T>) => Promise<T>;
    readonly limits?: { readonly [K in keyof typeof CSS_SWAP_LIMITS]: number };
  },
): Promise<SwapOutcome> {
  const limits = options.limits ?? CSS_SWAP_LIMITS;
  const blocked = precheckStylesheets(files);
  if (blocked) return blocked;
  if (!dbg || !dbg.isAttached()) return { ok: false, reason: 'failed' };
  const send = (method: string, params?: object) =>
    withTimeout(dbg.sendCommand(method, params), limits.commandTimeoutMs);
  const headers: SheetHeader[] = [];
  const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
    // Only the page itself (child targets of the guard come with a session id).
    if (sessionId || method !== 'CSS.styleSheetAdded') return;
    const header = parseSheetHeader((params as { header?: unknown } | null)?.header);
    if (header) headers.push(header);
  };
  let abandoned = false; // the total time ran out: stop changing the page (main reloads it)
  const work = async (): Promise<SwapOutcome> => {
    dbg.on('message', onMessage);
    let cssOn = false;
    try {
      const tree = (await send('Page.getFrameTree')) as { frameTree?: { frame?: { id?: unknown } } };
      const mainFrameId = tree.frameTree?.frame?.id;
      if (typeof mainFrameId !== 'string') return { ok: false, reason: 'failed' };
      // CSS.enable reports every existing stylesheet before it answers.
      cssOn = true;
      await send('CSS.enable');
      const match = matchSheets(
        headers,
        files.map((f) => f.relPath),
        options.origin,
        mainFrameId,
      );
      if (!match.ok) return match;
      let count = 0;
      for (const file of files) {
        for (const styleSheetId of match.sheets.get(portablePath(file.relPath)) ?? []) {
          if (abandoned) return { ok: false, reason: 'failed' };
          await send('CSS.setStyleSheetText', { styleSheetId, text: file.text });
          count += 1;
        }
      }
      return { ok: true, sheets: count };
    } finally {
      dbg.off('message', onMessage);
      if (cssOn) await send('CSS.disable').catch(() => undefined);
    }
  };
  try {
    return await withTimeout(options.useDom(work), limits.totalTimeoutMs);
  } catch {
    abandoned = true;
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Reads the saved stylesheets from disk, inside the project root only (realpath-checked like the static server), at
 * most `maxBytes` each, as strict UTF-8 without a byte order mark. A file the server would refuse (a dotfile, outside
 * the root) cannot be linked by the page (`not-linked`); one that cannot be read or is not UTF-8 (a GBK file is
 * decoded by the page's own charset rules on a reload) is `failed`. Either way the caller reloads.
 */
export async function readSavedStylesheets(
  root: string,
  relPaths: readonly string[],
  maxBytes: number = CSS_SWAP_LIMITS.maxBytes,
): Promise<
  | { readonly ok: true; readonly files: SavedStylesheet[] }
  | { readonly ok: false; readonly reason: 'not-linked' | 'failed'; readonly file: string }
> {
  const files: SavedStylesheet[] = [];
  for (const relPath of relPaths) {
    const file = portablePath(relPath);
    const segments = file.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return { ok: false, reason: 'not-linked', file };
    const found = await resolveInRoot(root, { segments, directory: false });
    if (!found.ok) return { ok: false, reason: found.code === 'forbidden' ? 'not-linked' : 'failed', file };
    try {
      if ((await stat(found.value)).size > maxBytes) return { ok: false, reason: 'failed', file };
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(found.value));
      const bom = text.charCodeAt(0) === 0xfeff;
      files.push({ relPath: file, text: bom ? text.slice(1) : text });
    } catch {
      return { ok: false, reason: 'failed', file };
    }
  }
  return { ok: true, files };
}

const SYNTAX_DETAIL: Record<Locale, Record<CssSyntaxKind, string>> = {
  'zh-CN': {
    'unclosed-block': '有一个 { 没有对应的 }',
    'unexpected-close': '多了一个 }',
    'unclosed-comment': '注释 /* 没有用 */ 结束',
    'unclosed-string': '引号里的文字没有结束',
  },
  en: {
    'unclosed-block': 'a { has no matching }',
    'unexpected-close': 'there is an extra }',
    'unclosed-comment': 'a /* comment is not closed with */',
    'unclosed-string': 'a quoted text is not closed',
  },
};

/**
 * The IDE's own record for Problems when a swap fell back to a reload because of the CSS itself or a failure
 * (decision 0037). Names the file and line only — never CSS text (AGENTS.md: logs never contain source code).
 */
export function swapProblemMessage(
  locale: Locale,
  outcome: {
    readonly reason: 'syntax' | 'failed';
    readonly file: string;
    readonly kind?: CssSyntaxKind;
    readonly line?: number;
  },
): string {
  if (outcome.reason === 'syntax') {
    const detail = SYNTAX_DETAIL[locale][outcome.kind ?? 'unclosed-block'];
    return locale === 'zh-CN'
      ? `NoobIDE：${outcome.file} 第 ${outcome.line ?? 1} 行有 CSS 语法错误（${detail}），样式没能直接更新，预览已重新加载。`
      : `NoobIDE: CSS syntax error in ${outcome.file} line ${outcome.line ?? 1} (${detail}); the styles could not be updated in place, so the preview reloaded.`;
  }
  return locale === 'zh-CN'
    ? `NoobIDE：没能直接换上 ${outcome.file} 的新样式，预览已重新加载。`
    : `NoobIDE: the new styles of ${outcome.file} could not be applied in place, so the preview reloaded.`;
}
