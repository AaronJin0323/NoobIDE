/**
 * Text decoding rules for files the editor opens (S03, PLAN §7): UTF-8 only in v1, BOM and line endings preserved,
 * binary and non-UTF-8 files refused so a save can never destroy them.
 */
export type Eol = '\n' | '\r\n';

const BOM = [0xef, 0xbb, 0xbf] as const;

export type DecodeResult =
  | { readonly ok: true; readonly text: string; readonly bom: boolean; readonly eol: Eol }
  | { readonly ok: false; readonly reason: 'binary' | 'not-utf8' };

export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
}

/** The dominant line ending; LF for files without line breaks (PLAN §7: LF for new content). */
export function detectEol(text: string): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
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
  return { ok: true, text, bom, eol: detectEol(text) };
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
    }
  | { readonly ok: false; readonly reason: 'binary' };

/** Control characters other than tab, line feed, form feed and carriage return are rare in text. */
function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodes any file the editor may show (S07.4, PLAN §7). UTF-8 (± BOM) is editable. UTF-16 with a BOM and legacy
 * single/multi-byte text (GB18030, which covers GBK/GB2312 used by Chinese Windows, then Windows-1252) are shown
 * read-only. Binary content (NUL bytes without a UTF-16 BOM, or many control characters) is refused.
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
    if (text !== null) return { ok: true, text, bom: true, eol: detectEol(text), encoding: utf16, editable: false };
    return { ok: false, reason: 'binary' };
  }
  if (looksBinary(bytes)) return { ok: false, reason: 'binary' };
  const utf8 = decodeText(bytes);
  if (utf8.ok) return { ...utf8, encoding: 'utf-8', editable: true };
  for (const label of ['gb18030', 'windows-1252']) {
    const text = tryDecode(label, bytes);
    if (text !== null) return { ok: true, text, bom: false, eol: detectEol(text), encoding: label, editable: false };
  }
  return { ok: false, reason: 'binary' };
}
