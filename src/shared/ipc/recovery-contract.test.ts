import { describe, expect, it } from 'vitest';
import {
  parseBufferRef,
  parseJournalRecordRequest,
  parseJournalSavedRequest,
  parseRecoveryKeyRequest,
} from './recovery-contract';

const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const BUF = '9b2f6c1e-4d3a-4b8c-8e7f-0a1b2c3d4e5f';
const ref = { projectId: ID, relPath: '中文 路径/a b.html', bufferId: BUF };

describe('recovery contract parsers (S12)', () => {
  it('accepts well-formed requests, including Chinese paths with spaces', () => {
    expect(parseBufferRef(ref)).toEqual(ref);
    const record = { ...ref, revision: 3, text: '<p>你好</p>', bom: false };
    expect(parseJournalRecordRequest(record)).toEqual(record);
    expect(parseJournalSavedRequest({ ...ref, revision: 0 })).toEqual({ ...ref, revision: 0 });
    expect(parseRecoveryKeyRequest({ key: 'a'.repeat(32) })).toEqual({ key: 'a'.repeat(32) });
  });

  it.each([
    ['missing buffer id', parseBufferRef, { projectId: ID, relPath: 'a.html' }],
    ['buffer id that is a path', parseBufferRef, { ...ref, bufferId: '../../x' }],
    ['absolute path', parseBufferRef, { ...ref, relPath: '/etc/passwd' }],
    ['parent segment', parseBufferRef, { ...ref, relPath: 'a/../../b' }],
    ['extra field', parseBufferRef, { ...ref, rootPath: 'C:/' }],
    ['negative revision', parseJournalSavedRequest, { ...ref, revision: -1 }],
    ['NaN revision', parseJournalSavedRequest, { ...ref, revision: Number.NaN }],
    ['string revision', parseJournalRecordRequest, { ...ref, revision: '1', text: '', bom: false }],
    ['non-string text', parseJournalRecordRequest, { ...ref, revision: 1, text: 5, bom: false }],
    [
      'oversized text',
      parseJournalRecordRequest,
      { ...ref, revision: 1, text: 'x'.repeat(5 * 1024 * 1024 + 1), bom: false },
    ],
    ['key with path characters', parseRecoveryKeyRequest, { key: '../'.repeat(11) }],
    ['uppercase key', parseRecoveryKeyRequest, { key: 'A'.repeat(32) }],
    ['array payload', parseBufferRef, [ref]],
    ['null payload', parseRecoveryKeyRequest, null],
  ])('rejects %s', (_name, parse, payload) => {
    expect((parse as (p: unknown) => unknown)(payload)).toBeNull();
  });
});
