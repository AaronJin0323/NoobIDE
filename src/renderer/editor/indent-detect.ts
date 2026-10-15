/**
 * Indentation detection and resolution (S43.1, decision 0032 "Indentation"). NoobIDE's own pure heuristic replaces
 * Monaco's built-in `detectIndentation` so that the guess is explainable (it carries a confidence and the number of
 * lines it is based on) and so that comments, `<pre>` blocks and template literals do not fool it.
 *
 * - `detectIndentation` guesses tabs vs spaces and the indent width of one file from its code lines only. It is a
 *   single pass over the text with plain character scanning (no backtracking regular expressions), fast enough to run
 *   on every file the project index reads.
 * - `projectConvention` turns the confident guesses of a project's files into a project style.
 * - `resolveIndentation` applies the fallback order: override > high guess > project > low guess > default.
 * - `reindentPasted` rewrites the leading whitespace of pasted lines into the file's style (whitespace only).
 *
 * Monaco-free and DOM-free: unit-tested with the fixtures in tests/fixtures/indentation/.
 */

export type IndentLanguage = 'html' | 'css' | 'javascript' | string;

export interface IndentGuess {
  readonly insertSpaces: boolean;
  /** Width of one indent unit (2 | 4, 8 only when clearly used); 4 for tab-indented files. */
  readonly tabSize: number;
  readonly confidence: 'high' | 'low' | 'none';
  /** Both tab- and space-indented lines carry real weight (each at least a third of the indented lines). */
  readonly mixed: boolean;
  /** Number of indented code lines the guess is based on. */
  readonly evidence: number;
}

export interface IndentStyle {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
}

export type IndentSource = 'override' | 'detected' | 'project' | 'default';

export interface ResolvedIndent extends IndentStyle {
  readonly source: IndentSource;
  readonly mixed: boolean;
}

/** The bundled templates and the formatter use 2 spaces. */
export const DEFAULT_INDENT: IndentStyle = { insertSpaces: true, tabSize: 2 };

/** Assumed width of a tab in tab-indented files (a tab carries no width of its own). */
const TAB_FILE_SIZE = 4;
const MIN_EVIDENCE = 2;
const HIGH_EVIDENCE = 6;
const MAX_DELTA = 32;

const TAB = 9;
const SPACE = 32;

// ---------------------------------------------------------------------------------------------------------------
// Lexical state: which lines are code. Best-effort, line-oriented scanning.
// ---------------------------------------------------------------------------------------------------------------

/** JavaScript scanner state. `stack` holds -1 for "inside a template literal" and n > 0 for code inside `${`. */
interface JsState {
  block: boolean;
  stack: number[];
}

/** HTML scanner mode. `raw` is a `<pre>` / `<textarea>` body, closed by `</rawTag`. */
type HtmlMode = 'text' | 'comment' | 'raw' | 'script' | 'style';

interface ScanState {
  readonly html: boolean;
  mode: HtmlMode;
  rawTag: string;
  js: JsState;
  /** CSS block comment (stand-alone CSS or an HTML `<style>` body). */
  cssBlock: boolean;
  /** Stand-alone CSS file (otherwise stand-alone JavaScript when not HTML). */
  readonly css: boolean;
}

const inTemplate = (js: JsState): boolean => js.stack.length > 0 && js.stack[js.stack.length - 1] === -1;

/** True when the line starts inside something whose indentation is not code (comment, raw text, template body). */
function startsInsideNonCode(s: ScanState): boolean {
  if (s.html) {
    if (s.mode === 'comment' || s.mode === 'raw') return true;
    if (s.mode === 'script') return s.js.block || inTemplate(s.js);
    if (s.mode === 'style') return s.cssBlock;
    return false;
  }
  if (s.css) return s.cssBlock;
  return s.js.block || inTemplate(s.js);
}

/** True when the line is in a script/style context (where a leading `*` is a JSDoc continuation line). */
function inCodeContext(s: ScanState): boolean {
  return !s.html || s.mode === 'script' || s.mode === 'style';
}

/** Scans a quoted string starting after the opening quote; returns the index after the closing quote, or `end`. */
function skipString(line: string, from: number, end: number, quote: number): number {
  let i = from;
  while (i < end) {
    const c = line.charCodeAt(i);
    if (c === 92 /* \ */) i += 2;
    else if (c === quote) return i + 1;
    else i++;
  }
  return end;
}

/** Advances the JavaScript state over line[from, end). */
function scanJs(line: string, from: number, end: number, js: JsState): void {
  let i = from;
  while (i < end) {
    const c = line.charCodeAt(i);
    if (js.block) {
      const close = line.indexOf('*/', i);
      if (close === -1 || close >= end) return;
      js.block = false;
      i = close + 2;
      continue;
    }
    if (inTemplate(js)) {
      if (c === 92 /* \ */) i += 2;
      else if (c === 96 /* ` */) {
        js.stack.pop();
        i++;
      } else if (c === 36 /* $ */ && line.charCodeAt(i + 1) === 123 /* { */) {
        js.stack.push(1);
        i += 2;
      } else i++;
      continue;
    }
    if (c === 47 /* / */) {
      const n = line.charCodeAt(i + 1);
      if (n === 47) return; // line comment
      if (n === 42 /* * */) {
        js.block = true;
        i += 2;
        continue;
      }
      i++;
    } else if (c === 39 /* ' */ || c === 34 /* " */) {
      i = skipString(line, i + 1, end, c);
    } else if (c === 96 /* ` */) {
      js.stack.push(-1);
      i++;
    } else if (c === 123 /* { */) {
      const top = js.stack.length - 1;
      if (top >= 0) js.stack[top] = (js.stack[top] ?? 0) + 1;
      i++;
    } else if (c === 125 /* } */) {
      const top = js.stack.length - 1;
      if (top >= 0) {
        const depth = (js.stack[top] ?? 1) - 1;
        if (depth <= 0) js.stack.pop();
        else js.stack[top] = depth;
      }
      i++;
    } else i++;
  }
}

/** Advances the CSS block-comment state over line[from, end). */
function scanCss(line: string, from: number, end: number, s: ScanState): void {
  let i = from;
  while (i < end) {
    if (s.cssBlock) {
      const close = line.indexOf('*/', i);
      if (close === -1 || close >= end) return;
      s.cssBlock = false;
      i = close + 2;
      continue;
    }
    const c = line.charCodeAt(i);
    if (c === 47 /* / */ && line.charCodeAt(i + 1) === 42 /* * */) {
      s.cssBlock = true;
      i += 2;
    } else if (c === 39 || c === 34) i = skipString(line, i + 1, end, c);
    else i++;
  }
}

const lowerAscii = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);

/** Case-insensitive (ASCII) search for a lower-case `needle`; never allocates a lower-cased copy of the line. */
function indexOfCI(line: string, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  const last = line.length - needle.length;
  for (let i = from; i <= last; i++) {
    if (lowerAscii(line.charCodeAt(i)) !== first) continue;
    let k = 1;
    while (k < needle.length && lowerAscii(line.charCodeAt(i + k)) === needle.charCodeAt(k)) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

const isNameChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45;

/** Advances the HTML state over one line. */
function scanHtml(line: string, s: ScanState): void {
  let pos = 0;
  const len = line.length;
  while (pos < len) {
    switch (s.mode) {
      case 'comment': {
        const close = line.indexOf('-->', pos);
        if (close === -1) return;
        s.mode = 'text';
        pos = close + 3;
        break;
      }
      case 'raw': {
        const close = indexOfCI(line, `</${s.rawTag}`, pos);
        if (close === -1) return;
        s.mode = 'text';
        pos = close + 2 + s.rawTag.length;
        break;
      }
      case 'script':
      case 'style': {
        const close = indexOfCI(line, s.mode === 'script' ? '</script' : '</style', pos);
        const end = close === -1 ? len : close;
        if (s.mode === 'script') scanJs(line, pos, end, s.js);
        else scanCss(line, pos, end, s);
        if (close === -1) return;
        s.mode = 'text';
        s.js = { block: false, stack: [] };
        s.cssBlock = false;
        pos = close + 2;
        break;
      }
      case 'text': {
        const lt = line.indexOf('<', pos);
        if (lt === -1) return;
        if (line.startsWith('<!--', lt)) {
          s.mode = 'comment';
          pos = lt + 4;
          break;
        }
        let e = lt + 1;
        while (e < len && isNameChar(line.charCodeAt(e))) e++;
        const nameLen = e - lt - 1;
        pos = e;
        if (nameLen < 3 || nameLen > 8) break;
        let name = '';
        for (let k = lt + 1; k < e; k++) name += String.fromCharCode(lowerAscii(line.charCodeAt(k)));
        if (name !== 'pre' && name !== 'textarea' && name !== 'script' && name !== 'style') break;
        const gt = line.indexOf('>', e);
        // An opening tag whose attributes continue on the next line: enter the body anyway (best effort).
        pos = gt === -1 ? len : gt + 1;
        if (name === 'script') s.mode = 'script';
        else if (name === 'style') s.mode = 'style';
        else {
          s.mode = 'raw';
          s.rawTag = name;
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------------------

/** Chooses the indent width from the histogram of positive indentation increases (and absolute indents as a tie-break). */
function pickWidth(deltas: Int32Array, notMultipleOf4: number, multipleOf4: number): number {
  const score = (w: number): number => {
    let total = 0;
    for (let d = w; d <= MAX_DELTA; d += w) total += (deltas[d] ?? 0) * (d === w ? 2 : 1);
    return total;
  };
  const exact2 = deltas[2] ?? 0;
  const exact4 = deltas[4] ?? 0;
  const exact8 = deltas[8] ?? 0;
  if (exact8 > 0 && exact8 > exact2 + exact4) return 8;
  const s2 = score(2);
  const s4 = score(4);
  if (s4 > s2) return 4;
  if (s2 > s4) return 2;
  if (multipleOf4 > 0 && notMultipleOf4 === 0) return 4;
  return 2;
}

/** Guesses the indentation style of one file from its code lines (decision 0032). */
export function detectIndentation(text: string, languageId: IndentLanguage): IndentGuess {
  const html = languageId === 'html';
  const s: ScanState = {
    html,
    css: !html && languageId === 'css',
    mode: 'text',
    rawTag: '',
    js: { block: false, stack: [] },
    cssBlock: false,
  };
  const deltas = new Int32Array(MAX_DELTA + 1);
  let tabLines = 0;
  let spaceLines = 0;
  let notMultipleOf4 = 0;
  let multipleOf4 = 0;
  /** Indentation (in spaces) of the previous counted code line, or -1 when unknown (tab line / none yet). */
  let prev = -1;

  const len = text.length;
  let start = 0;
  while (start <= len) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = len;
    let end = nl;
    if (end > start && text.charCodeAt(end - 1) === 13) end--;
    const line = start === 0 && end === len ? text : text.slice(start, end);
    start = nl + 1;

    const skip = startsInsideNonCode(s);
    const codeContext = inCodeContext(s);
    // Advance the lexical state for the next line.
    if (html) scanHtml(line, s);
    else if (s.css) scanCss(line, 0, line.length, s);
    else scanJs(line, 0, line.length, s.js);
    if (skip) continue;

    let i = 0;
    let spaces = 0;
    let allSpaces = true;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === SPACE) spaces++;
      else if (c === TAB) allSpaces = false;
      else break;
      i++;
    }
    if (i === line.length) continue; // blank line
    // JSDoc / block-comment continuation line (` * …`, aligned by one space).
    if (codeContext && line.charCodeAt(i) === 42 /* * */) continue;

    if (i === 0) {
      prev = 0;
      continue;
    }
    if (line.charCodeAt(0) === TAB) {
      tabLines++;
      prev = -1;
      continue;
    }
    spaceLines++;
    if (!allSpaces) {
      prev = -1;
      continue;
    }
    if (spaces % 4 === 0) multipleOf4++;
    else notMultipleOf4++;
    if (prev >= 0 && spaces > prev && spaces - prev <= MAX_DELTA)
      deltas[spaces - prev] = (deltas[spaces - prev] ?? 0) + 1;
    prev = spaces;
  }

  const evidence = tabLines + spaceLines;
  if (evidence < MIN_EVIDENCE) {
    return { ...DEFAULT_INDENT, confidence: 'none', mixed: false, evidence };
  }
  const mixed = tabLines * 3 >= evidence && spaceLines * 3 >= evidence;
  const insertSpaces = spaceLines >= tabLines;
  const majority = Math.max(tabLines, spaceLines);
  const clearMajority = majority * 3 >= evidence * 2;
  const confidence = evidence < HIGH_EVIDENCE || (mixed && !clearMajority) ? 'low' : 'high';
  const tabSize = insertSpaces ? pickWidth(deltas, notMultipleOf4, multipleOf4) : TAB_FILE_SIZE;
  return { insertSpaces, tabSize, confidence, mixed, evidence };
}

// ---------------------------------------------------------------------------------------------------------------
// Project convention and fallbacks
// ---------------------------------------------------------------------------------------------------------------

/** Majority of high-confidence guesses; needs >= 2 agreeing files (same insertSpaces AND tabSize, ties -> null). */
export function projectConvention(guesses: readonly IndentGuess[]): IndentStyle | null {
  const counts = new Map<string, { style: IndentStyle; n: number }>();
  for (const g of guesses) {
    if (g.confidence !== 'high') continue;
    const key = `${g.insertSpaces ? 's' : 't'}${g.tabSize}`;
    const entry = counts.get(key);
    if (entry) entry.n++;
    else counts.set(key, { style: { insertSpaces: g.insertSpaces, tabSize: g.tabSize }, n: 1 });
  }
  let best: { style: IndentStyle; n: number } | null = null;
  let tie = false;
  for (const entry of counts.values()) {
    if (!best || entry.n > best.n) {
      best = entry;
      tie = false;
    } else if (entry.n === best.n) tie = true;
  }
  if (!best || tie || best.n < 2) return null;
  return best.style;
}

/** override > high guess > project > low guess > DEFAULT_INDENT. */
export function resolveIndentation(input: {
  guess: IndentGuess;
  override?: IndentStyle | null | undefined;
  project?: IndentStyle | null | undefined;
}): ResolvedIndent {
  const { guess, override, project } = input;
  const mixed = guess.mixed;
  const from = (style: IndentStyle, source: IndentSource): ResolvedIndent => ({
    insertSpaces: style.insertSpaces,
    tabSize: style.tabSize,
    source,
    mixed,
  });
  if (override) return from(override, 'override');
  if (guess.confidence === 'high') return from(guess, 'detected');
  if (project) return from(project, 'project');
  if (guess.confidence === 'low') return from(guess, 'detected');
  return from(DEFAULT_INDENT, 'default');
}

// ---------------------------------------------------------------------------------------------------------------
// Paste re-indentation
// ---------------------------------------------------------------------------------------------------------------

const leadingWhitespace = (line: string): number => {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== SPACE && c !== TAB) break;
    i++;
  }
  return i;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Text whose whitespace can carry meaning: `<pre>` / `<textarea>` content, template literals (string values), block
 * and HTML comments (JSDoc's one-space alignment). A paste containing any of them is never re-indented.
 */
const WHITESPACE_SENSITIVE = /`|<pre[\s>]|<textarea[\s>]|\/\*|<!--|^[ \t]*\*/im;

export interface ReindentOptions {
  /**
   * The paste started at column 1, so its first line's indentation belongs to the structure and is converted too.
   * Otherwise the first line follows the cursor and is left as it is.
   */
  readonly includeFirstLine?: boolean;
}

/**
 * Rewrites only the LEADING whitespace of `pasted` lines into `target` style, preserving relative nesting. Returns
 * null when nothing would change or when a change would not be safe: whitespace-sensitive text (above), or a space
 * indentation whose unit cannot be told (e.g. 3-space code). Line endings (\r\n or \n) are preserved exactly;
 * non-whitespace characters are never changed.
 */
export function reindentPasted(pasted: string, target: IndentStyle, options: ReindentOptions = {}): string | null {
  // Lines at even indexes, their line breaks at odd indexes.
  const parts = pasted.split(/(\r?\n)/);
  if (parts.length < 3) return null;
  if (WHITESPACE_SENSITIVE.test(pasted)) return null;
  const first = options.includeFirstLine ? 0 : 2;

  // The pasted text's own style, from its non-blank lines after the first.
  let tabLines = 0;
  let spaceLines = 0;
  const deltas = new Int32Array(MAX_DELTA + 1);
  let unitGcd = 0;
  const spaceIndents: number[] = [];
  let prev = -1;
  let hasDelta = false;
  for (let p = first; p < parts.length; p += 2) {
    const line = parts[p] ?? '';
    const ws = leadingWhitespace(line);
    if (ws === line.length) continue;
    if (ws === 0) {
      prev = 0;
      continue;
    }
    if (line.charCodeAt(0) === TAB) {
      tabLines++;
      prev = -1;
      continue;
    }
    spaceLines++;
    let spaces = 0;
    while (spaces < ws && line.charCodeAt(spaces) === SPACE) spaces++;
    if (spaces !== ws) {
      prev = -1;
      continue;
    }
    unitGcd = gcd(spaces, unitGcd);
    spaceIndents.push(spaces);
    if (prev >= 0 && spaces > prev && spaces - prev <= MAX_DELTA) {
      deltas[spaces - prev] = (deltas[spaces - prev] ?? 0) + 1;
      hasDelta = true;
    }
    prev = spaces;
  }
  if (tabLines + spaceLines === 0) return null;

  const sourceTabs = tabLines > spaceLines;
  let unit = 1;
  if (!sourceTabs) {
    unit = hasDelta ? pickWidth(deltas, 0, 0) : unitGcd;
    // Nearly every space indentation must be whole levels of the unit (a few alignment lines are fine); otherwise
    // the levels would be a guess, e.g. 3-space code read as 2.
    const whole = spaceIndents.filter((spaces) => spaces % unit === 0).length;
    if (unit < 2 || whole < spaceIndents.length * 0.8) return null;
  }
  if (sourceTabs && !target.insertSpaces) return null;
  if (!sourceTabs && target.insertSpaces && unit === target.tabSize) return null;

  const targetUnit = target.insertSpaces ? ' '.repeat(Math.max(1, target.tabSize)) : '\t';
  const out = parts.slice();
  for (let p = first; p < parts.length; p += 2) {
    const line = parts[p] ?? '';
    const ws = leadingWhitespace(line);
    if (ws === 0 || ws === line.length) continue;
    let levels: number;
    let rest = 0;
    if (sourceTabs) {
      let k = 0;
      while (k < ws && line.charCodeAt(k) === TAB) k++;
      levels = k;
      // Alignment after the tabs (spaces; a stray tab counts as one level's worth of columns).
      for (let j = k; j < ws; j++) rest += line.charCodeAt(j) === TAB ? TAB_FILE_SIZE : 1;
    } else {
      let cols = 0;
      for (let j = 0; j < ws; j++) cols += line.charCodeAt(j) === TAB ? unit : 1;
      levels = Math.floor(cols / unit);
      rest = cols % unit;
    }
    out[p] = targetUnit.repeat(levels) + ' '.repeat(rest) + line.slice(ws);
  }
  const result = out.join('');
  return result === pasted ? null : result;
}

/** One line's new leading whitespace (1-based line, length of the whitespace it replaces). */
export interface IndentEdit {
  readonly line: number;
  readonly oldLength: number;
  readonly text: string;
}

/**
 * "Convert the whole file" (S43.2): rewrites every line's leading whitespace from the file's style `from` into `to`,
 * level by level (4 spaces → 2 spaces, tabs → spaces, spaces → tabs). Alignment that is not a whole level stays as
 * spaces. Returns only the lines that change, so the edit touches nothing else; blank lines are left alone.
 */
export function convertIndentation(text: string, from: IndentStyle, to: IndentStyle): IndentEdit[] {
  const fromUnit = Math.max(1, from.tabSize);
  const toUnit = to.insertSpaces ? ' '.repeat(Math.max(1, to.tabSize)) : '\t';
  const edits: IndentEdit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const ws = leadingWhitespace(line);
    if (ws === 0 || ws === line.length) continue;
    let cols = 0;
    for (let j = 0; j < ws; j++) cols += line.charCodeAt(j) === TAB ? fromUnit : 1;
    const levels = Math.floor(cols / fromUnit);
    const next = toUnit.repeat(levels) + ' '.repeat(cols % fromUnit);
    if (next !== line.slice(0, ws)) edits.push({ line: i + 1, oldLength: ws, text: next });
  }
  return edits;
}
