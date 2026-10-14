import { describe, expect, it } from 'vitest';
import { decodeForDisplay, decodeText, detectEol, encodeText, hasMixedEol } from './text-codec';

const bytes = (...values: number[]) => Uint8Array.from(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe('encodings (S07.4)', () => {
  it('UTF-8 without and with BOM is editable; the BOM is reported so it can be written back', () => {
    expect(decodeForDisplay(utf8('<p>你好</p>\n'))).toEqual({
      ok: true,
      text: '<p>你好</p>\n',
      bom: false,
      eol: '\n',
      encoding: 'utf-8',
      editable: true,
    });
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('a\r\n')]);
    expect(decodeForDisplay(withBom)).toMatchObject({ ok: true, text: 'a\r\n', bom: true, editable: true });
    expect([...encodeText('a\r\n', true)]).toEqual([...withBom]);
  });

  it('GBK / GB18030 text opens read-only with its encoding named', () => {
    // 你好 in GBK
    expect(decodeForDisplay(bytes(0xc4, 0xe3, 0xba, 0xc3, 0x0a))).toEqual({
      ok: true,
      text: '你好\n',
      bom: false,
      eol: '\n',
      encoding: 'gb18030',
      editable: false,
    });
  });

  it('Windows-1252 text opens read-only', () => {
    // "café " — 0xE9 followed by a space is not valid GB18030
    expect(decodeForDisplay(bytes(0x63, 0x61, 0x66, 0xe9, 0x20))).toMatchObject({
      ok: true,
      text: 'café ',
      encoding: 'windows-1252',
      editable: false,
    });
  });

  it('UTF-16 with a BOM opens read-only (its NUL bytes are not mistaken for binary)', () => {
    expect(decodeForDisplay(bytes(0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00))).toMatchObject({
      ok: true,
      text: 'a\r\n',
      encoding: 'utf-16le',
      eol: '\r\n',
      editable: false,
    });
    expect(decodeForDisplay(bytes(0xfe, 0xff, 0x00, 0x61))).toMatchObject({
      ok: true,
      text: 'a',
      encoding: 'utf-16be',
    });
  });

  it('binaries are refused', () => {
    expect(decodeForDisplay(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x01))).toEqual({ ok: false, reason: 'binary' });
    expect(decodeForDisplay(bytes(1, 2, 3, 4, 5, 6, 7, 8, 0x41))).toEqual({ ok: false, reason: 'binary' });
    // The strict UTF-8 decoder still refuses everything that is not UTF-8.
    expect(decodeText(bytes(0xc4, 0xe3))).toEqual({ ok: false, reason: 'not-utf8' });
  });
});

describe('line endings (S07.4)', () => {
  it('keeps the dominant style of existing files', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
  });

  it('new and empty files, and files without line breaks, use LF', () => {
    expect(detectEol('')).toBe('\n');
    expect(detectEol('one line')).toBe('\n');
    expect(decodeForDisplay(new Uint8Array())).toMatchObject({ ok: true, text: '', eol: '\n', editable: true });
  });
});

describe('mixed line endings (decision 0011)', () => {
  it('flags files that mix CRLF and LF, and only those', () => {
    expect(hasMixedEol('a\r\nb\nc')).toBe(true);
    expect(hasMixedEol('a\r\nb\r\n')).toBe(false);
    expect(hasMixedEol('a\nb\n')).toBe(false);
    expect(hasMixedEol('')).toBe(false);
  });

  it('decodeText reports eol, BOM and mixed line endings', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('你好\r\n世界\n')]);
    expect(decodeText(withBom)).toEqual({ ok: true, text: '你好\r\n世界\n', bom: true, eol: '\n', mixedEol: true });
  });
});
