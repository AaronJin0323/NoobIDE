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

function countEols(text: string): { crlf: number; lf: number } {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  return { crlf, lf: (text.match(/\n/g)?.length ?? 0) - crlf };
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
