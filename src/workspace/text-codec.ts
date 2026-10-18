/**
 * Text decoding rules for files the editor opens (S03, PLAN §7): UTF-8 only in v1, BOM and line endings preserved,
 * binary and non-UTF-8 files refused so a save can never destroy them.
 */
export type Eol = '\n' | '\r\n';

const BOM = [0xef, 0xbb, 0xbf] as const;

export type DecodeResult =
  | { readonly ok: true; readonly text: string; readonly bom: boolean; readonly eol: Eol; readonly mixedEol: boolean }
  | { readonly ok: false; readonly reason: 'binary' | 'not-utf8' };

export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
}

/** The dominant line ending; LF for files without line breaks (PLAN §7: LF for new content). */
export function detectEol(text: string): Eol {
  const { crlf, lf } = countEols(text);
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Counts line feeds by scanning with indexOf: no match arrays are built (`text.match(/\n/g)` allocates one entry per
 * line, which for a 5 MB file costs ~5× the time on main and grows into hundreds of ms for short lines). A lone `\r`
 * is not a line ending here, as before.
 */
function countEols(text: string): { crlf: number; lf: number } {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 0x0d) crlf += 1;
    else lf += 1;
  }
  return { crlf, lf };
}

/** Both CRLF and LF occur. The editor holds one line ending, so saving such a file unifies them (decision 0011). */
export function hasMixedEol(text: string): boolean {
  const { crlf, lf } = countEols(text);
  return crlf > 0 && lf > 0;
}

export function decodeText(bytes: Uint8Array): DecodeResult {
  // A NUL byte never appears in UTF-8 text files; treat it as binary (images, fonts, archives).
  if (bytes.includes(0)) return { ok: false, reason: 'binary' };
  const bom = hasBom(bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return { ok: false, reason: 'not-utf8' };
  }
  return { ok: true, text, bom, eol: detectEol(text), mixedEol: hasMixedEol(text) };
}

export function encodeText(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set(BOM, 0);
  out.set(body, 3);
  return out;
}

// ── S07.4: other encodings open read-only ───────────────────────────────────────────────────────────────────────

export type DisplayDecodeResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly bom: boolean;
      readonly eol: Eol;
      /** WHATWG encoding label, e.g. `utf-8`, `utf-16le`, `gb18030`, `windows-1252`. */
      readonly encoding: string;
      /** Only UTF-8 files can be saved in v1; anything else is shown read-only so a save cannot re-encode it. */
      readonly editable: boolean;
      /** Legacy encodings carry no marker: the label is a best guess (only shown, never used to write). */
      readonly guessed: boolean;
    }
  | { readonly ok: false; readonly reason: 'binary' };

/**
 * Control characters other than tab, line feed, form feed, carriage return and escape are rare in text. Only applied
 * to content that is not valid UTF-8 (valid UTF-8 without NUL is always text) and only on samples big enough for a
 * ratio to mean anything.
 */
function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.length < 64) return false;
  let control = 0;
  for (const b of sample) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) control += 1;
  }
  return control / sample.length > 0.1;
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * GB18030 decodes almost any byte sequence, so it is chosen only when the result looks like Chinese text: most
 * non-ASCII characters are common CJK ideographs or CJK punctuation. Otherwise Windows-1252 (Latin) is the guess.
 */
function looksChinese(text: string): boolean {
  let nonAscii = 0;
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) continue;
    nonAscii += 1;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) cjk += 1;
  }
  return nonAscii > 0 && cjk / nonAscii >= 0.9;
}

/**
 * Decodes any file the editor may show (S07.4, PLAN §7). UTF-8 (± BOM) is editable. UTF-16 with a BOM and legacy
 * text are shown read-only; for legacy text the encoding is a labelled best guess (GB18030 for Chinese-looking
 * text, which covers GBK/GB2312 of Chinese Windows, else Windows-1252). NUL bytes without a UTF-16 BOM, or many
 * control characters in non-UTF-8 content, mean binary and are refused.
 */
export function decodeForDisplay(bytes: Uint8Array): DisplayDecodeResult {
  const utf16 =
    bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : null;
  if (utf16) {
    const text = tryDecode(utf16, bytes.subarray(2));
    if (text === null) return { ok: false, reason: 'binary' };
    return { ok: true, text, bom: true, eol: detectEol(text), encoding: utf16, editable: false, guessed: false };
  }
  if (bytes.includes(0)) return { ok: false, reason: 'binary' };
  const utf8 = decodeText(bytes);
  if (utf8.ok) {
    const { text, bom, eol } = utf8; // mixed line endings are reported by the caller (hasMixedEol)
    return { ok: true, text, bom, eol, encoding: 'utf-8', editable: true, guessed: false };
  }
  if (looksBinary(bytes)) return { ok: false, reason: 'binary' };
  const gb = tryDecode('gb18030', bytes);
  const [encoding, text] =
    gb !== null && looksChinese(gb) ? ['gb18030', gb] : ['windows-1252', tryDecode('windows-1252', bytes)];
  if (text === null) return { ok: false, reason: 'binary' };
  return { ok: true, text, bom: false, eol: detectEol(text), encoding, editable: false, guessed: true };
}
