import { describe, expect, it } from 'vitest';
import { decodeText, detectEol, encodeText, hasMixedEol } from './text-codec';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('line endings (PLAN §7, decision 0011)', () => {
  it('detects the dominant line ending; LF when there is none', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
    expect(detectEol('no line break')).toBe('\n');
  });

  it('flags files that mix CRLF and LF, and only those', () => {
    expect(hasMixedEol('a\r\nb\nc')).toBe(true);
    expect(hasMixedEol('a\r\nb\r\n')).toBe(false);
    expect(hasMixedEol('a\nb\n')).toBe(false);
    expect(hasMixedEol('')).toBe(false);
  });

  it('decodeText reports eol, BOM and mixed line endings', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('你好\r\n世界\n')]);
    expect(decodeText(bytes)).toEqual({ ok: true, text: '你好\r\n世界\n', bom: true, eol: '\n', mixedEol: true });
  });

  it('encodeText restores the BOM byte for byte', () => {
    expect([...encodeText('a\r\n', true)]).toEqual([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    expect([...encodeText('a\n', false)]).toEqual([0x61, 0x0a]);
  });
});
