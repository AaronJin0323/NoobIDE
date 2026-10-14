import { describe, expect, it } from 'vitest';
import type { FileContent, OpenedProject } from '../../shared/ipc/contract';
import {
  INITIAL_DOCUMENT_STATE,
  activeSaveStatus,
  activeTab,
  cycleTab,
  documentReducer,
  type DocumentAction,
} from './document-state';
import { INITIAL_SAVE, saveReducer } from './save-machine';

const project: OpenedProject = {
  projectId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f',
  name: '中文 路径 项目',
  rootPath: 'D:\\网页 练习\\中文 路径 项目',
  files: [{ relPath: 'index.html', uri: 'file:///D:/x/index.html' }],
  truncated: false,
};
const file = (name: string): FileContent => ({
  text: `<p>${name}</p>\n`,
  eol: '\n',
  bom: false,
  mixedEol: false,
  uri: `file:///D:/x/${encodeURIComponent(name)}`,
  version: { mtimeMs: 1, size: 1, hash: '0'.repeat(64) },
});

const run = (...actions: DocumentAction[]) => actions.reduce(documentReducer, INITIAL_DOCUMENT_STATE);
const opened = (...names: string[]): DocumentAction[] => [
  { type: 'projectOpened', project },
  ...names.map((relPath): DocumentAction => ({ type: 'docLoaded', relPath, content: file(relPath) })),
];
const dirty = saveReducer(INITIAL_SAVE, { type: 'edited' });

describe('open tabs (S09.2)', () => {
  it('no file open means no save status', () => {
    expect(activeSaveStatus(INITIAL_DOCUMENT_STATE)).toBeNull();
    expect(activeSaveStatus(run({ type: 'projectOpened', project }))).toBeNull();
  });

  it('each opened file gets one tab and becomes visible; reopening an open file only shows it', () => {
    const s = run(...opened('index.html', 'style.css'), {
      type: 'docLoaded',
      relPath: 'index.html',
      content: file('x'),
    });
    expect(s.tabs.map((tab) => tab.relPath)).toEqual(['index.html', 'style.css']);
    expect(s.active).toBe('index.html');
    expect(activeTab(s)?.content.text).toBe('<p>index.html</p>\n');
    expect(activeSaveStatus(s)).toBe('clean');
  });

  it('keeps every tab its own save state', () => {
    const s = run(...opened('index.html', 'style.css'), { type: 'saveState', relPath: 'index.html', save: dirty });
    expect(s.tabs.map((tab) => tab.save.revision)).toEqual([1, 0]);
    expect(activeSaveStatus(s)).toBe('clean'); // style.css is visible
    expect(activeSaveStatus(documentReducer(s, { type: 'activate', relPath: 'index.html' }))).toBe('dirty');
  });

  it('closing the visible tab shows its right neighbour, else the left one', () => {
    let s = run(...opened('a.html', 'b.css', 'c.js'), { type: 'activate', relPath: 'b.css' });
    s = documentReducer(s, { type: 'closed', relPath: 'b.css' });
    expect(s.active).toBe('c.js');
    s = documentReducer(s, { type: 'closed', relPath: 'c.js' });
    expect(s.active).toBe('a.html');
    s = documentReducer(s, { type: 'closed', relPath: 'a.html' });
    expect(s.active).toBeNull();
    expect(s.tabs).toEqual([]);
  });

  it('closing a background tab keeps the visible one', () => {
    const s = documentReducer(run(...opened('a.html', 'b.css')), { type: 'closed', relPath: 'a.html' });
    expect(s.active).toBe('b.css');
  });

  it('Ctrl+Tab order wraps around in both directions', () => {
    const s = run(...opened('a.html', 'b.css', 'c.js'));
    expect(cycleTab(s, 1)).toBe('a.html');
    expect(cycleTab(s, -1)).toBe('b.css');
    expect(cycleTab(INITIAL_DOCUMENT_STATE, 1)).toBeNull();
  });

  it('a file that cannot be opened is reported without closing the open tabs', () => {
    const s = run(...opened('index.html'), { type: 'docFailed', relPath: 'logo.png', code: 'unsupported-encoding' });
    expect(s.docError).toEqual({ relPath: 'logo.png', code: 'unsupported-encoding' });
    expect(s.active).toBe('index.html');
    expect(documentReducer(s, { type: 'activate', relPath: 'index.html' }).docError).toBeNull();
  });

  it('activating an unknown tab and saving state for a closed tab change nothing', () => {
    const s = run(...opened('index.html'));
    expect(documentReducer(s, { type: 'activate', relPath: 'gone.css' })).toBe(s);
    expect(documentReducer(s, { type: 'saveState', relPath: 'gone.css', save: dirty }).tabs).toEqual(s.tabs);
  });

  it('opening another project closes all tabs', () => {
    const s = run(...opened('index.html'), { type: 'projectOpened', project: { ...project, name: 'b' } });
    expect(s.tabs).toEqual([]);
    expect(s.active).toBeNull();
  });
});

describe('file operations (S08.3)', () => {
  it('closing the tab after its file went to the trash keeps the project open', () => {
    const state = run(...opened('index.html'), { type: 'closed', relPath: 'index.html' });
    expect(state.tabs).toEqual([]);
    expect(state.project).toBe(project);
    expect(activeSaveStatus(state)).toBeNull();
  });
});
