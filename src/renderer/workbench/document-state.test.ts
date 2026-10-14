import { describe, expect, it } from 'vitest';
import type { FileContent, OpenedProject } from '../../shared/ipc/contract';
import {
  INITIAL_DOCUMENT_STATE,
  documentReducer,
  hasUnsavedChanges,
  saveState,
  type DocumentAction,
} from './document-state';

const project: OpenedProject = {
  projectId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f',
  name: '中文 路径 项目',
  rootPath: 'D:\\网页 练习\\中文 路径 项目',
  files: [{ relPath: 'index.html', uri: 'file:///D:/x/index.html' }],
  truncated: false,
};
const content: FileContent = { text: '<p>你好</p>\n', eol: '\n', bom: false, uri: 'file:///D:/x/index.html' };

const run = (...actions: DocumentAction[]) => actions.reduce(documentReducer, INITIAL_DOCUMENT_STATE);
const loaded = (): DocumentAction[] => [
  { type: 'projectOpened', project },
  { type: 'docLoaded', relPath: 'index.html', content },
];

describe('document and save state (S03.3, S03.4)', () => {
  it('no file open means no save state', () => {
    expect(saveState(INITIAL_DOCUMENT_STATE)).toBeNull();
    expect(saveState(run({ type: 'projectOpened', project }))).toBeNull();
  });

  it('a freshly opened file is saved; an edit makes it unsaved', () => {
    expect(saveState(run(...loaded()))).toBe('clean');
    expect(saveState(run(...loaded(), { type: 'edited' }))).toBe('dirty');
  });

  it('a successful save of the current revision is clean', () => {
    const s = run(...loaded(), { type: 'edited' }, { type: 'saveStarted' });
    expect(saveState(s)).toBe('saving');
    expect(saveState(documentReducer(s, { type: 'saveSucceeded', revision: s.savingRevision ?? -1 }))).toBe('clean');
  });

  it('typing during a save leaves the document unsaved after the save finishes', () => {
    const saving = run(...loaded(), { type: 'edited' }, { type: 'saveStarted' });
    const typed = documentReducer(saving, { type: 'edited' });
    const done = documentReducer(typed, { type: 'saveSucceeded', revision: saving.savingRevision ?? -1 });
    expect(saveState(done)).toBe('dirty');
    expect(hasUnsavedChanges(done)).toBe(true);
  });

  it('a failed save is reported, keeps the document unsaved and recovers on the next success', () => {
    const failed = run(
      ...loaded(),
      { type: 'edited' },
      { type: 'saveStarted' },
      { type: 'saveFailed', code: 'permission-denied', message: 'EACCES' },
    );
    expect(saveState(failed)).toBe('failed');
    expect(failed.saveError).toEqual({ code: 'permission-denied', message: 'EACCES' });
    expect(hasUnsavedChanges(failed)).toBe(true);
    const retried = documentReducer(documentReducer(failed, { type: 'saveStarted' }), {
      type: 'saveSucceeded',
      revision: failed.revision,
    });
    expect(saveState(retried)).toBe('clean');
    expect(retried.saveError).toBeNull();
  });

  it('opening another file starts from a clean slate; a file that cannot be opened is reported', () => {
    const s = run(
      ...loaded(),
      { type: 'edited' },
      { type: 'docFailed', relPath: 'logo.png', code: 'unsupported-encoding' },
    );
    expect(s.doc).toBeNull();
    expect(s.docError).toEqual({ relPath: 'logo.png', code: 'unsupported-encoding' });
    expect(hasUnsavedChanges(s)).toBe(false);
  });

  it('edits without a document are ignored', () => {
    expect(run({ type: 'edited' })).toEqual(INITIAL_DOCUMENT_STATE);
  });
});
